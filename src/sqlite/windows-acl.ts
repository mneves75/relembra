/**
 * Whether another account could change the folders that hold a Windows store folder, read from
 * their access lists as SDDL (docs/specs/w-nv1/spec.md). relembra secures a new store's folder by
 * its path, which holds only while no other account can rename, delete, re-permission or pre-create
 * a folder on that path, or open the new folder before its ACL is set. Pure: the caller reads the
 * access lists with icacls.
 */
import { win32 } from "node:path";

/** One access control entry, as the rules need it. */
export interface Ace {
  readonly allow: boolean;
  /** The entry is only inherited: it gives the folder itself nothing. */
  readonly inheritOnly: boolean;
  /** Subfolders inherit the entry. */
  readonly containerInherit: boolean;
  readonly mask: number;
  /** A SID, or an SDDL alias this module does not resolve (domain-relative ones: never trusted). */
  readonly sid: string;
}

/** A folder on the path to the store folder, with its access list as `icacls /save` writes it. */
export interface ChainFolder {
  readonly path: string;
  readonly dacl: string;
  /** The folder the store folder is made in. */
  readonly holdsStoreFolder: boolean;
}

const EVERYONE = "S-1-1-0";
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const CREATOR_OWNER = "S-1-3-0";
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

/** The well-known SDDL SID aliases whose SID does not depend on a domain. */
const ALIASES: Readonly<Record<string, string>> = {
  AC: "S-1-15-2-1",
  AN: "S-1-5-7",
  AO: "S-1-5-32-548",
  AU: "S-1-5-11",
  BA: ADMINISTRATORS,
  BG: "S-1-5-32-546",
  BO: "S-1-5-32-551",
  BU: "S-1-5-32-545",
  CG: "S-1-3-1",
  CO: CREATOR_OWNER,
  ED: "S-1-5-9",
  IU: "S-1-5-4",
  LS: "S-1-5-19",
  NO: "S-1-5-32-556",
  NS: "S-1-5-20",
  NU: "S-1-5-2",
  OW: "S-1-3-4",
  PS: "S-1-5-10",
  PU: "S-1-5-32-547",
  RC: "S-1-5-12",
  RD: "S-1-5-32-555",
  RU: "S-1-5-32-554",
  SO: "S-1-5-32-549",
  SU: "S-1-5-6",
  SY: SYSTEM,
  WD: EVERYONE,
  WR: "S-1-5-33",
};

/** SDDL's two-letter access rights. */
const RIGHTS: Readonly<Record<string, number>> = {
  GA: 0x10000000,
  GX: 0x20000000,
  GW: 0x40000000,
  GR: 0x80000000,
  RC: 0x20000,
  SD: 0x10000,
  WD: 0x40000,
  WO: 0x80000,
  FA: 0x1f01ff,
  FR: 0x120089,
  FW: 0x120116,
  FX: 0x1200a0,
  KA: 0xf003f,
  KR: 0x20019,
  KW: 0x20006,
  KX: 0x20019,
  CC: 0x1,
  DC: 0x2,
  LC: 0x4,
  SW: 0x8,
  RP: 0x10,
  WP: 0x20,
  DT: 0x40,
  LO: 0x80,
  CR: 0x100,
};

const FLAGS = new Set(["OI", "CI", "NP", "IO", "ID", "SA", "FA", "TP", "CR"]);
const ALLOW_TYPES = new Set(["A", "XA", "OA", "ZA"]);
const DENY_TYPES = new Set(["D", "XD", "OD"]);
/** Entry types that may end in a condition; their allow ones count as unconditional here. */
const CALLBACK_TYPES = new Set(["XA", "XD", "ZA"]);
const GUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const DELETE = 0x10000;
const WRITE_DAC = 0x40000;
const WRITE_OWNER = 0x80000;
const DELETE_CHILD = 0x40;
const ADD_SUBDIRECTORY = 0x4;
const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;
/** Read and execute: list, read attributes and the access list, traverse, synchronize. */
const READ_EXECUTE = 0x1200a9 | 0x80000000 | 0x20000000;

/**
 * The accounts whose rights on the chain refuse nothing: the user, SYSTEM, Administrators,
 * TrustedInstaller, and CREATOR OWNER, which stands for whoever makes the folder, here the user.
 * SDDL writes the built-in Administrator account (RID 500) as `LA`; it is the user only when the
 * user is that account.
 */
export function trustedAccounts(userSid: string): ReadonlySet<string> {
  const trusted = new Set([userSid, SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER, CREATOR_OWNER]);
  if (/^S-1-5-21-[0-9-]+-500$/.test(userSid)) trusted.add("LA");
  return trusted;
}

/**
 * The entries of an SDDL access list (`D:` and its flags, then one parenthesised entry each), or
 * null for a null DACL, which grants everyone everything. Anything this parser does not know is
 * thrown, never skipped: a skipped entry could be the one that grants another account access.
 */
export function parseDacl(sddl: string): Ace[] | null {
  const body = /^D:((?:P|AI|AR|NO_ACCESS_CONTROL)*)(.*)$/s.exec(sddl.trim());
  if (body === null) throw new Error(`not an SDDL access list: ${sddl}`);
  const [, controlFlags = "", rest = ""] = body;
  if (controlFlags.includes("NO_ACCESS_CONTROL")) return null;
  const aces: Ace[] = [];
  let index = 0;
  while (index < rest.length) {
    // `icacls /save` writes the SACL, the mandatory label, on the same line: it ends the DACL.
    if (rest.startsWith("S:", index)) break;
    if (rest[index] !== "(")
      throw new Error(`unexpected text in access list: ${rest.slice(index)}`);
    // A conditional entry holds parentheses of its own, so the entry ends where depth returns to 0,
    // counting none inside a quoted string, which SDDL delimits with `"` and never escapes.
    let depth = 0;
    let quoted = false;
    let end = index;
    for (; end < rest.length; end++) {
      const char = rest[end];
      if (char === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) break;
    }
    if (depth !== 0 || quoted) {
      throw new Error(`unclosed entry in access list: ${rest.slice(index)}`);
    }
    aces.push(parseAce(rest.slice(index + 1, end)));
    index = end + 1;
  }
  return aces;
}

function parseAce(text: string): Ace {
  const fields = text.split(";");
  const [type = "", flags = "", rights = "", objectGuid = "", inheritGuid = "", sid = ""] = fields;
  const allow = ALLOW_TYPES.has(type);
  if (!allow && !DENY_TYPES.has(type)) throw new Error(`unknown access entry type: (${text})`);
  // Only a callback entry may carry a condition, its seventh field; its text may hold `;` and
  // quotes of its own. Every other field is checked, so no quote can hide in one.
  const condition = fields.slice(6).join(";");
  const conditionOk = CALLBACK_TYPES.has(type)
    ? fields.length === 6 || (condition.startsWith("(") && condition.endsWith(")"))
    : fields.length === 6;
  if (fields.length < 6 || !conditionOk) throw new Error(`malformed access entry: (${text})`);
  if (![objectGuid, inheritGuid].every((guid) => guid === "" || GUID.test(guid))) {
    throw new Error(`malformed GUID in access entry: (${text})`);
  }
  const flagList: string[] = flags.match(/../g) ?? [];
  if (flagList.join("") !== flags || flagList.some((flag) => !FLAGS.has(flag))) {
    throw new Error(`unknown access entry flags: (${text})`);
  }
  if (!/^(S-1-[0-9-]+|[A-Z]{2})$/.test(sid))
    throw new Error(`unknown SID in access entry: (${text})`);
  return {
    allow,
    inheritOnly: flagList.includes("IO"),
    containerInherit: flagList.includes("CI"),
    mask: parseRights(rights, text),
    sid: ALIASES[sid] ?? sid,
  };
}

function parseRights(rights: string, text: string): number {
  if (/^0x[0-9a-fA-F]+$/.test(rights)) return Number.parseInt(rights.slice(2), 16);
  const letters: string[] = rights.match(/../g) ?? [];
  if (letters.length === 0 || letters.join("") !== rights) {
    throw new Error(`unknown access rights: (${text})`);
  }
  let mask = 0;
  for (const letter of letters) {
    const right = RIGHTS[letter];
    if (right === undefined) throw new Error(`unknown access right ${letter}: (${text})`);
    // Rights above bit 30 make a JavaScript bitwise result negative, so they are added.
    mask = (mask | right) >>> 0;
  }
  return mask;
}

/**
 * The folders whose access lists decide whether the store folder's path holds: its parent up to
 * the drive root, written as given (an 8.3 short name stays short). Never the canonical path: a
 * folder on this path that another account may swap would go unread, and the ACL steps use this
 * path. Every folder here is read where it lies, so no other account can rename or replace one
 * without a right the rules see: DELETE on it, or DELETE_CHILD on the folder above.
 */
export function storeFolderChain(storeFolder: string): string[] {
  const chain: string[] = [];
  let folder = win32.resolve(storeFolder);
  for (let up = win32.dirname(folder); up !== folder; up = win32.dirname(folder)) {
    chain.push(up);
    folder = up;
  }
  return chain;
}

/**
 * Why another account could change the path to the store folder, or undefined when none could.
 * R1 to R4 are the rules of docs/specs/w-nv1/spec.md; the first folder that breaks one is named.
 */
export function chainRefusal(
  chain: readonly ChainFolder[],
  trusted: ReadonlySet<string>,
): string | undefined {
  for (const folder of chain) {
    const aces = parseDacl(folder.dacl) ?? [
      { allow: true, inheritOnly: false, containerInherit: true, mask: 0x1f01ff, sid: EVERYONE },
    ];
    for (const ace of aces) {
      if (!ace.allow || trusted.has(ace.sid)) continue;
      const refuse = (what: string) => `${folder.path} lets another account (${ace.sid}) ${what}`;
      const own = ace.inheritOnly ? 0 : ace.mask;
      if (own & (DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL)) {
        return refuse("rename, delete or re-permission it");
      }
      if (own & DELETE_CHILD) return refuse("rename or delete the folders in it");
      if (!folder.holdsStoreFolder) continue;
      if (own & (ADD_SUBDIRECTORY | GENERIC_WRITE)) return refuse("create the store folder first");
      if (ace.containerInherit && (ace.mask & ~READ_EXECUTE) >>> 0 !== 0) {
        return refuse("open the new store folder before its ACL is set");
      }
    }
  }
  return undefined;
}
