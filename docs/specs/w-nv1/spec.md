# W-NV1: refuse a Windows store folder that another account can change

Status: in progress (1.0.0-beta.3)

## Assumptions

The owner chose this approach and asked for no interview (2026-11-02). Each open decision is
assumed here:

1. **Enforce the waiver's precondition instead of switching to handles.** The store's folder is
   still secured by path with `icacls`. Before that happens, relembra reads the access lists of the
   folder's parent and of every folder above it, and refuses when another account could change
   them. Handle-based Win32 calls need FFI, which is experimental in both Bun (`bun:ffi`) and Node
   26 (`node:ffi`); the library runs on both, and AGENTS.md allows no runtime dependency.
2. **Access lists are read with `icacls <folder> /save <file>`,** which writes SDDL with SIDs, so
   no account name or system language is involved. PowerShell is not used: `Get-Acl` hung on the
   arm runner (run 41391564103), and its policies differ from one machine to another.
3. **Trusted accounts:** the user, SYSTEM (`S-1-5-18`), Administrators (`S-1-5-32-544`),
   TrustedInstaller (`S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464`), and
   CREATOR OWNER (`S-1-3-0`), which stands for whoever creates the folder, here the user.
   Every other SID counts as another account, OWNER RIGHTS (`S-1-3-4`) included. Deny entries are
   ignored, so a deny can only lead to a refusal, never let a folder pass.
4. **Owners are not read.** No tool on a stock Windows system prints a folder's owner as a SID
   without PowerShell; `dir /q` prints a localized name and cuts it short. An ancestor owned by
   another account whose access list does not name that account is not detected. That is the
   remaining risk, and docs/CLI.md states it.
5. **Behaviour change accepted:** a store folder under a shared or world-writable folder (for
   example `D:\data\relembra` beside the default access list of a drive root) is now refused at
   first open. Existing stores are not touched: the check runs only when relembra creates a store.
6. **Cost:** one `icacls` process for each folder from the parent of the store folder up to the
   root, only when a store is created. No cache: a cached verdict would outlive the access lists it
   was based on.
7. **Size:** one session, so this spec has no ticket files.

## Rules

Let P be the folder that holds the store folder, and let the chain be P and every folder above
it, on the path as given, never its canonical form. A volume root cannot be renamed, and every
folder below it can be swapped only with DELETE on it (R1) or DELETE_CHILD on the folder above
(R2), which the chain's own access lists show. So when they pass, the folders read are the ones
the ACL steps act on. Reading the canonical path instead would skip a folder on this one (Sol,
PR #7). A link anywhere on the chain is refused. An entry is "foreign" when it is an allow entry
for an untrusted SID. relembra refuses when:

| Rule | Where | Foreign entry that applies to the folder itself and grants | Why |
|---|---|---|---|
| R1 | every folder in the chain | delete, change permissions, take ownership, or generic all | the folder can be renamed, deleted or re-permissioned |
| R2 | every folder in the chain | delete child, or generic all | an entry in it, the next folder on the path, can be renamed or deleted |
| R3 | P | add a subfolder, generic write, or generic all | the store folder can be created first by someone else |
| R4 | P, entries inherited by subfolders (`CI`), inherit-only included | anything beyond read and execute | the new store folder grants it until the ACL step, long enough to open a handle that keeps it |

A null DACL counts as full control for Everyone. An access list that cannot be read, or that
holds an ACE type, right, flag, GUID or shape this parser does not know, is refused. A callback
entry's condition is skipped as one field, quoted strings included, and the entry counts as
unconditional.

## Where the access lists are written

`icacls /save` needs a file, and the check trusts what the file says. The file goes in a scratch
folder under TEMP that gets the store folder's own ACL: owned by the user (`/setowner`), full
control for the user, SYSTEM and Administrators only (`/inheritance:r /grant:r`), and checked on
stdout to hold exactly those entries. Each save gets a fresh random name. Bun's mkdtemp already
gives the folder those three entries, explicit. Node's gives it TEMP's inherited ACL until these
steps.

**Remaining condition: TEMP is trusted.** These steps act on the folder after it exists, so
TEMP, and every folder above it, must meet three conditions. The default `%LOCALAPPDATA%\Temp`
under the profile meets all three; the owner accepted this residual on 2026-11-02.

1. **TEMP gives other accounts no inherited access to folders made in it.** Sol, round 2 of
   PR #7: a handle opened before the steps keeps its access, and FILE_WRITE_ATTRIBUTES is enough
   to turn the empty folder into a junction to one that account controls, so it could forge the
   saved files.
2. **It does not let other accounts delete or rename its entries.**
3. **It is not owned by another account.**

TEMP's chain is not read: it would have to be read through files in TEMP, which the same
account could forge. Creating the folder already private, in one step, needs CreateDirectoryW
with a security descriptor, so experimental FFI in both runtimes; it was the rejected
alternative.

## Acceptance

- Pure tests, which run on every platform: SDDL parsing (letter rights, hex rights, every flag,
  conditional ACEs, a null DACL, an unknown token) and each rule, with a passing chain as the
  positive control.
- Windows tests, run in CI on windows-latest and windows-11-arm: one refusal for each rule, with
  `BUILTIN\Users` standing in for another account and a positive control for each showing the
  grant is present. Every existing Windows ACL test still passes, the leaky parent (inheritable
  read for Everyone) included.
- docs/CLI.md and CHANGELOG describe the refusal and the remaining owner risk.
- Independent review by Sol. The production security gate decides whether W-NV1 is cleared,
  before the beta.3 release (owner).
