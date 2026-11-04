# W-NV1: create a Windows store privately and verify its ancestry

Status: beta.4 implementation; Windows acceptance and security review pending.

## Assumptions and boundary

The owner selected “Build beta.4” after the beta.3 release (2026-11-02).
This is a security correction, without an interview. No store schema or export format changes.

- A new Windows store requires an absent leaf directory. Existing uninitialized directories
  are refused without changing their owner or ACL. Reusing one cannot revoke handles opened
  before it was private. Choose a new directory instead; no existing data is moved or deleted.
- Existing database files retain their existing open behavior. This change does not certify
  stores created by an older release, another tool, or subsequently re-permissioned.
- The current user, SYSTEM, Administrators and TrustedInstaller are trusted. CREATOR OWNER
  remains an inheritance placeholder, never a trusted actual owner.
- Existing ancestors must have been protected from untrusted accounts throughout their relevant
  lifetime. Current owner and ACL reads cannot detect historical WRITE_DAC, DELETE or
  FILE_WRITE_ATTRIBUTES handles. This boundary remains explicit: passing these checks does not
  unconditionally clear W-NV1, renew a waiver, or authorize publication.

## Decision

Use the Windows PowerShell 5.1 installed in System32 with .NET Framework filesystem APIs.
The program is constant; paths and descriptors travel as JSON over stdin, and observations
return as JSON on stdout. relembra uses no profile, interactive prompt, Get-Acl provider,
script file, compilation, icacls save file, TEMP or TMP directory (PowerShell's own startup
may create a missing TEMP; see below).

JSON uses the strongly named Framework System.Web.Extensions assembly directly. The Windows
arm64 control timed out while running ConvertFrom-Json; the security helper
therefore uses no Utility cmdlets (including New-Object or ConvertTo-Json).

The creators of one store are serialised by a named .NET mutex, `Global\relembra-<sha256>`
of the current SID and the case-folded resolved store folder, created with a private
MutexSecurity (full control for the user, SYSTEM and Administrators). Before waiting, its
owner and every entry are verified; a foreign or squatted name is refused, never
re-permissioned, so that name can at most deny creation. The wait is bounded (10 s) and an
abandoned mutex counts as acquired. The mutex is an initialization guard, not a claim about
historical ancestor handles. A long and an 8.3 spelling of one folder take two names and
refuse each other. No lockfile, TEMP file or service is added.

The empty database is created through .NET (FileMode.CreateNew) under the lock, not by the
runtime's open: files Node and Bun created in the private folder carried the three grants as
explicit entries (CI run 41689802952), a file .NET creates there carries them as inherited
entries (run 41762474475, probe `folder-inheritance-model`). The folder descriptor is
`D:PAI…`: protected, and auto-inherited as a folder set with icacls is. CreateDirectory drops
the `AI` bit (the probe read `D:P` back from a `D:PAI` request), so the same descriptor is then
set again through Directory.SetAccessControl, which adopts the model, and read back.

relembra writes nothing under TEMP or TMP. Windows PowerShell's own startup may create a
missing TEMP for its script-policy probe; the Windows test measures that with no store involved
and checks that relembra added nothing to it.

Compared with a native Node-API addon, this preserves zero runtime dependencies and Node 24.14,
Bun and AOT compatibility without another platform artifact. Direct node:ffi is unavailable
on Node 24. An emitted P/Invoke helper adds complexity without solving historical ancestry.
PowerShell absence, policy refusal, timeout or malformed output fails closed.

## Rules and ordering

1. Before creating any Windows directory, resolve a local drive path. Reject device/UNC paths
   and alternate streams in any component, and a leaf that is a link. Whether an existing
   leaf is refused is decided under the mutex (rule 6).
2. Walk the given ancestry to the drive root, identifying the deepest existing ancestor.
   Read existing directories root-first through Directory.GetAccessControl(Owner | Access).
   GetOwner(SecurityIdentifier) returns the owner's SID. GetSecurityDescriptorSddlForm(Access)
   returns the DACL. Reject all reparse points, non-directories and unreadable descriptors.
3. Reject foreign or unverifiable owners even when their SID appears in no access entry.
   Check every existing ancestor for foreign allow entries granting DELETE, WRITE_DAC,
   WRITE_OWNER, generic all, DELETE_CHILD, FILE_WRITE_ATTRIBUTES or generic write.
   Attribute writes matter because the deepest existing ancestor may be empty and convertible
   into a junction. Check that deepest ancestor for foreign add-subdirectory access as well.
   Keep beta.3's conservative refusal of inherited permissions beyond read and execute.
   Denials never cancel these conservative refusals. Unknown SDDL fails closed.
4. Re-read the existing ancestry immediately before creation; reject a changed descriptor.
   This detects observed changes, and is not a proof against historical handles.
5. Create missing components root-first using Directory.CreateDirectory(path, DirectorySecurity).
   Its SECURITY_ATTRIBUTES supplies the owner and protected DACL to CreateDirectory itself.
   Only the current user, SYSTEM and Administrators receive full control, inheritable by files
   and subdirectories, each SID once (SYSTEM may itself be the current user).
6. Under the mutex: when the database file already exists, another creator finished; verify
   that it is a regular file with exactly the three grants and that the leaf has the exact
   private descriptor, and report `exists`. Otherwise refuse any component that already
   exists, including the leaf an abandoned creator left behind. Verify every created
   component's owner, reparse status, inheritance protection, auto-inherit model and exact
   access rules.
7. Only after successful verification, and still under the mutex, refuse orphan sidecars and
   create the empty database with FileMode.CreateNew through .NET, so it inherits the verified
   grants; verify its entries. Preserve the caller's file-type refusals. Never take ownership
   of, harden, remove or silently adopt a preexisting uninitialized directory.

## Acceptance

- Cross-platform pure tests reproduce the foreign-owner bug before its fix, retain the ACL
  parsing/permission controls, and refuse missing owners and attribute-write grants.
- Real Windows x64 and arm64: fresh leaf and nested components have protected exact grants;
  the owner's SID is verified; foreign ancestor owner with no matching grant is refused;
  preexisting directories with open writable handles remain unchanged and receive no store.
- A failing mkdtemp positive control with unavailable TEMP/TMP accompanies successful store
  creation. Quoted PowerShell syntax in a directory name remains literal data.
- Existing R1–R4, junction, existing-store and sidecar scenarios remain covered with the
  stronger absent-leaf policy. General persistence fixtures use absent per-store directories,
  with raw existing-database fixtures prepared explicitly.
- Node 24.14/26, Bun and the native AOT executable run the applicable scenarios. Skipped
  Windows tests on a Mac are not Windows proof.
- Full local release gate, strict benchmark, independent adversarial review and security
  deploy gate bind the final candidate before any release. Failed attempts remain evidence.
- docs/CLI.md and CHANGELOG state the new-folder requirement and historical-ancestor boundary.
  The security gate, not a green unit test, decides the remaining W-NV1 disposition.
  Owner-only npm 2FA and merge/release authorization remain separate.

## Primary references

- [.NET Directory.GetAccessControl](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.getaccesscontrol?view=netframework-4.8.1)
- [.NET Framework Directory implementation](https://raw.githubusercontent.com/microsoft/referencesource/main/mscorlib/system/io/directory.cs):
  DirectorySecurity is converted to SECURITY_ATTRIBUTES for missing components; an existing
  directory may return successfully, requiring read-back.
- [CreateFileW sharing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew):
  attribute access is unaffected by sharing flags; restricting sharing does not revoke it.
- [Reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points):
  a directory must be empty to acquire a reparse point.
