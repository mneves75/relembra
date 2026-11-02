import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { StoreBusyError } from "../errors.js";
import { MIGRATIONS, migrate, SchemaTooNewError, schemaVersion } from "./migrations.js";

export { StoreBusyError };

import { walImage } from "./wal-image.js";
import {
  type ChainFolder,
  chainRefusal,
  storeFolderChain,
  trustedAccounts,
} from "./windows-acl.js";

/** Thrown when an existing store file, or its -wal or -shm file, grants group or others access. */
export class StoreFileModeError extends Error {
  override readonly name = "StoreFileModeError";
  readonly mode: number;
  constructor(path: string, mode: number) {
    super(`store file ${path} has mode ${mode.toString(8)}; relembra requires 600 or stricter`);
    this.mode = mode;
  }
}

/**
 * Thrown when the store path, or its -wal or -shm file, is a symbolic link or anything else that is
 * not a regular file: a link could send SQLite's writes to a file the mode checks never saw.
 */
export class StoreFileTypeError extends Error {
  override readonly name = "StoreFileTypeError";
  constructor(path: string) {
    super(`store file ${path} is not a regular file; relembra refuses symbolic links`);
  }
}

/**
 * Thrown when the store's schema version could not be read without a connection that can change
 * the file: its WAL could not be replayed read-only. relembra never opens such a file for writing,
 * since it may come from a newer relembra. Open it with a newer relembra, or recover it manually.
 */
export class StoreUnverifiedError extends Error {
  override readonly name = "StoreUnverifiedError";
  constructor(path: string, options?: { cause: unknown }) {
    super(
      `could not verify the schema version of ${path} without writing to it; open it with a newer relembra or recover it manually`,
      options,
    );
  }
}

/** True for SQLITE_BUSY and its extended codes. */
export function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 5;
}

/** The largest busy timeout SQLite keeps: PRAGMA busy_timeout takes a 32-bit signed int. */
const MAX_BUSY_TIMEOUT_MS = 2_147_483_647;

/** Refuses a busy timeout that would make waits unbounded or meaningless. */
export function checkBusyTimeout(busyTimeoutMs: number): number {
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
  ) {
    throw new RangeError(`busyTimeoutMs must be an integer from 0 to ${MAX_BUSY_TIMEOUT_MS}`);
  }
  return busyTimeoutMs;
}

/** Whether file modes say who may read a file: every platform but Windows. */
export const OWNER_MODES = process.platform !== "win32";

/**
 * Creates missing directories as 0700 and a missing file as 0600, then checks the files with
 * checkOwnerOnly. A symbolic link at the path is refused before anything is created, so no file
 * appears behind it.
 */
export function createOwnerOnly(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (isSymbolicLink(path)) throw new StoreFileTypeError(path);
  // Windows ignores the modes: before a new store's first byte, its folder gets an ACL of its own,
  // so the store and the -wal and -shm files SQLite makes beside it inherit owner-only access.
  if (!OWNER_MODES && !existsSync(path)) {
    restrictFolderToOwner(dirname(path));
    // A sidecar without its store was put there by someone: it keeps its own ACL, and Windows
    // opens a file by its full path whatever the folder grants, so SQLite would write into a file
    // another account can read. Checked after the ACL, when no other account can add one. A
    // sidecar beside a store that exists by now belongs to another process that created the
    // store first (its folder got the same three grants), so it is no plant.
    for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      if (hasEntry(sidecar) && !hasEntry(path)) {
        throw new Error(`${sidecar} exists without its store; no store is created beside it`);
      }
    }
  }
  try {
    // O_EXCL never follows a link, so a link made since the check fails here with EEXIST.
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkOwnerOnly(path);
}

/**
 * Windows' System32 folder under `systemRoot` (%SystemRoot%). An empty or relative value falls
 * back to `C:\Windows`: a relative executable path would be resolved against the working
 * directory, which may be a repository's.
 */
export function windowsSystem32(systemRoot: string | undefined): string {
  const root =
    systemRoot !== undefined && win32.isAbsolute(systemRoot) && /^[A-Za-z]:/.test(systemRoot)
      ? systemRoot
      : "C:\\Windows";
  return win32.join(root, "System32");
}

/** Runs a System32 tool; any failure is thrown with its output. */
function runSystemTool(systemRoot: string | undefined, exe: string, args: string[]): string {
  const result = spawnSync(win32.join(windowsSystem32(systemRoot), exe), args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`${exe} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

let userSid: string | undefined;

/**
 * The logon account's SID, from the process token as whoami prints it. Thrown when none. The
 * account cannot change while the process runs, so whoami runs once: the CLI's scope and a new
 * store's ACL both ask.
 */
export function windowsUserSid(systemRoot: string | undefined): string {
  if (userSid !== undefined) return userSid;
  // `"HOST\user","S-1-5-21-..."`: the SID is the last quoted field.
  const printed = runSystemTool(systemRoot, "whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(printed)?.[1];
  if (sid === undefined) throw new Error("whoami did not print the user's SID");
  userSid = sid;
  return sid;
}

/**
 * Windows: makes the current user the folder's owner, then replaces its ACL with full control for
 * the user, SYSTEM and the Administrators group only, inherited by everything in it. An owner may
 * always rewrite an ACL, so a folder another account made would otherwise give that account its
 * access back; `/setowner` fails, and no store is created, unless the user may take ownership.
 * `/inheritance:r` with the three `/grant:r` then drops what the folder inherited, in one change
 * that never widens access: another process may already have made the store here (two first
 * opens at once), and a step that restored the parent's grants, as `/reset` does, would let the
 * store inherit them for a moment. An explicit grant to anyone else is refused, not dropped: the
 * ACL is read back and must hold one entry per account in storeFolderAccounts, and no other.
 * Accounts are named by SID, so no account name or system language is involved. Any failure is
 * thrown: a store is never created in a folder others may read.
 */
export function restrictFolderToOwner(dir: string): void {
  // icacls follows a junction or symbolic link: the owner and ACL of its target would change.
  if (lstatSync(dir).isSymbolicLink())
    throw new Error(`${dir} is a link; no store is created in it`);
  const systemRoot = process.env["SystemRoot"];
  const sid = windowsUserSid(systemRoot);
  checkFolderChain(systemRoot, dir, sid);
  const accounts = storeFolderAccounts(sid);
  runSystemTool(systemRoot, "icacls.exe", [dir, "/setowner", `*${sid}`]);
  runSystemTool(systemRoot, "icacls.exe", [
    dir,
    "/inheritance:r",
    ...accounts.flatMap((who) => ["/grant:r", `*${who}:(OI)(CI)F`]),
  ]);
  // icacls prints one `name:(flags)` entry per line; the path, on the first, holds no `:(`.
  const entries = runSystemTool(systemRoot, "icacls.exe", [dir])
    .split(/\r?\n/)
    .filter((line) => line.includes(":("));
  if (entries.length !== accounts.length) {
    throw new Error(
      `${dir} grants another account access (${entries.length} entries, not ${accounts.length}); no store is created in it: remove those grants or use another folder`,
    );
  }
}

/**
 * Windows: refuses a store folder whose path another account could change (docs/specs/w-nv1/spec.md).
 * The ACL steps work on the folder's path, so they hold only while no other account can rename,
 * delete or re-permission a folder above it, make the store folder first, or open it before its
 * ACL is set. Every folder from the store folder's parent up to the drive root, on the path as
 * given (storeFolderChain), is read as SDDL with `icacls /save`, which names accounts by SID, and
 * judged by chainRefusal. A link on the path is refused: icacls would read its target, and whoever
 * may change the link may point it elsewhere. Owners are not read, since no stock tool prints one
 * as a SID: an ancestor another account owns, whose access list does not name that account, is
 * not detected.
 */
function checkFolderChain(systemRoot: string | undefined, dir: string, sid: string): void {
  const folders = storeFolderChain(dir);
  for (const folder of folders) {
    if (lstatSync(folder).isSymbolicLink()) {
      throw new Error(
        `${folder} is a link; no store is created under it: use a path without links`,
      );
    }
  }
  if (folders.length === 0) return;
  const chain: ChainFolder[] = [];
  const scratch = privateScratch(systemRoot, sid);
  try {
    for (const [index, folder] of folders.entries()) {
      chain.push({
        path: folder,
        dacl: savedDacl(systemRoot, folder, scratch),
        holdsStoreFolder: index === 0,
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const refusal = chainRefusal(chain, trustedAccounts(sid));
  if (refusal !== undefined) {
    throw new Error(
      `${refusal}; no store is created under it: remove that grant or keep the store in a folder only you can change, such as your profile`,
    );
  }
}

/**
 * A folder under TEMP that only the user can open, for the `icacls /save` files the chain check
 * trusts. TEMP may let another account write in it: Node's mkdtemp gives the folder TEMP's
 * inherited ACL (Bun's gives it an owner-only one), so the folder is made the user's, and its ACL
 * replaced by the user alone, read back on stdout, which no other account can change. A folder
 * another account swapped in keeps that account's own entries, so it holds more than one, or it
 * refuses `/setowner`. A handle another account kept from before cannot open the files, which
 * inherit the user-only ACL, nor make one first, since each has a random name. TEMP must still
 * keep other accounts from deleting or renaming its entries; the default, under the profile, does.
 */
function privateScratch(systemRoot: string | undefined, sid: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "relembra-acl-"));
  try {
    runSystemTool(systemRoot, "icacls.exe", [scratch, "/setowner", `*${sid}`]);
    runSystemTool(systemRoot, "icacls.exe", [
      scratch,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
    ]);
    const entries = runSystemTool(systemRoot, "icacls.exe", [scratch])
      .split(/\r?\n/)
      .filter((line) => line.includes(":("));
    if (entries.length !== 1) {
      throw new Error(
        `${scratch} grants another account access (${entries.length} entries, not 1); no store is created: point TEMP at a folder only you can change`,
      );
    }
    return scratch;
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A folder's access list as SDDL. `icacls <folder> /save <file>` writes the folder's name on one
 * line (none for a drive root) and its access list on the next, in UTF-16 or the console's
 * encoding; parseDacl drops the SACL that follows it on that line.
 */
function savedDacl(systemRoot: string | undefined, folder: string, scratch: string): string {
  // A fresh random name for each save, so no account can make the file first.
  const file = join(scratch, randomBytes(16).toString("hex"));
  runSystemTool(systemRoot, "icacls.exe", [folder, "/save", file]);
  const bytes = readFileSync(file);
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || bytes[1] === 0;
  const lines = (utf16 ? bytes.toString("utf16le") : bytes.toString("utf8"))
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  // A drive root has no name, so its file holds the access list alone.
  const dacl = lines.at(-1);
  if (lines.length > 2 || dacl === undefined || !dacl.startsWith("D:")) {
    throw new Error(
      `icacls /save did not write one access list for ${folder}: ${lines.join(" | ")}`,
    );
  }
  return dacl.trim();
}

/**
 * The accounts a store folder grants full control: the user, SYSTEM and Administrators, each once.
 * A process running as LocalSystem is SYSTEM itself, so its folder holds two entries; counting
 * three would let a foreign grant pass as the third.
 */
export function storeFolderAccounts(userSid: string): string[] {
  return [...new Set([userSid, "S-1-5-18", "S-1-5-32-544"])];
}

/**
 * The store file must exist. It and any -wal or -shm file must be regular files (lstat never
 * follows a symbolic link) that grant group and others nothing. A loose file is refused, never
 * chmodded: someone else may already have read it.
 */
export function checkOwnerOnly(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(file);
    } catch (error) {
      // Only a sidecar may be missing: SQLite creates it later, with the store file's mode.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && file !== path) continue;
      throw error;
    }
    if (!stats.isFile()) throw new StoreFileTypeError(file);
    // Windows has no mode bits: Node and Bun report 0o666 for every writable file, whatever its
    // access control list grants. There the store relies on its folder's ACL, which under the
    // user profile grants only the user, SYSTEM and Administrators (docs/CLI.md, Windows).
    if (OWNER_MODES) {
      const mode = Number(stats.mode) & 0o777;
      if ((mode & 0o077) !== 0) throw new StoreFileModeError(file, mode);
    }
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Whether a directory entry exists at `path`: a link counts, even one whose target is missing. */
function hasEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * True for SQLITE_CANTOPEN (14) and SQLITE_READONLY (8), with their extended codes: what a
 * read-only connection answers when only a write-capable one could proceed, for example
 * SQLITE_READONLY_RECOVERY for a -shm that needs recovery while another connection holds it.
 */
function needsWriter(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && ((code & 0xff) === 14 || (code & 0xff) === 8);
}

/**
 * True for SQLITE_CORRUPT (11) and SQLITE_NOTADB (26), with their extended codes: what a read that
 * takes no locks answers when it meets pages another process is still writing.
 */
function isTorn(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && ((code & 0xff) === 11 || (code & 0xff) === 26);
}

/**
 * The schema version, read without any connection that can change a file.
 * - With a -wal or -shm present, commits may sit in the WAL: the connection is read-only with the
 *   -shm opened read-only too (`readonly_shm`), so it neither checkpoints, nor deletes the WAL,
 *   nor writes read marks.
 * - With neither, the main file holds every commit. A read-only connection to a WAL store would
 *   fail there, and Node's SQLite leaves an empty -wal behind when it does, so the file is read as
 *   `immutable`, which takes no locks and creates nothing. Without locks the read can meet pages
 *   that another process is still writing (creating and migrating the file, or switching it to
 *   WAL), and SQLite then reports the file as malformed (SQLITE_CORRUPT or SQLITE_NOTADB). So such
 *   a read is retried, choosing the connection again each time since the writer may have created
 *   the sidecars meanwhile, with a synchronous backoff until `busyTimeoutMs` has passed. A file
 *   still malformed then is refused with SQLite's own error: after that long it is most likely
 *   damaged, not busy. The retries and a later read's busy_timeout are separate waits, since
 *   SQLite applies busy_timeout to each lock wait on its own, so opening can take about twice
 *   `busyTimeoutMs`: with 1,000 ms the worst case measured 2,033 ms. A read that holds locks (the
 *   sidecar case) is not retried this way: that connection takes locks, so a malformed result
 *   there is not a torn read. A torn read can also return an older version than the writer
 *   commits; the checks on the write-capable connection, and migrate() under the write lock,
 *   catch that.
 * - When only a write-capable connection could read it (the -shm is missing or needs recovery),
 *   the committed WAL frames are replayed over the main file's bytes in memory and the version is
 *   read from that image. A write-capable handle never opens a file whose version is unverified:
 *   closing one checkpoints the WAL into the main file and deletes the WAL and -shm.
 */
function readOnlySchemaVersion(path: string, busyTimeoutMs: number): number {
  const deadline = Date.now() + busyTimeoutMs;
  for (let delay = 1; ; delay = Math.min(delay * 2, 32)) {
    // A -wal without its -shm: only a writer could rebuild the index, so the version comes from
    // the image straight away. A read-only connection would refuse it on POSIX, but on Windows it
    // creates the -shm or answers SQLITE_PROTOCOL.
    if (existsSync(`${path}-wal`) && !existsSync(`${path}-shm`)) return imageSchemaVersion(path);
    const sidecars = existsSync(`${path}-wal`) || existsSync(`${path}-shm`);
    const parameters = sidecars ? "mode=ro&readonly_shm=1" : "mode=ro&immutable=1";
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(`${pathToFileURL(path).href}?${parameters}`, { readOnly: true });
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      return schemaVersion(db);
    } catch (error) {
      if (needsWriter(error)) return imageSchemaVersion(path);
      if (sidecars || !isTorn(error) || Date.now() >= deadline) throw error;
    } finally {
      // Closed even after a failed read: Node keeps the file locked otherwise.
      db?.close();
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
}

/**
 * The schema version of the store as its committed WAL frames leave it, read from an in-memory
 * image. Refuses with StoreUnverifiedError when the image cannot be built or read: the WAL is
 * malformed, or the runtime's node:sqlite has no `deserialize` (Node before 24.22 and 26.1).
 */
function imageSchemaVersion(path: string): number {
  const wal = existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : new Uint8Array();
  const image = walImage(readFileSync(path), wal);
  if (image === undefined) throw new StoreUnverifiedError(path);
  const memory = new DatabaseSync(":memory:");
  try {
    if (typeof memory.deserialize !== "function") throw new StoreUnverifiedError(path);
    const copy = new Uint8Array(image);
    // Header bytes 18 and 19 say WAL (2); the in-memory image has no WAL, so it reads as rollback.
    if (copy.length >= 20) copy.fill(1, 18, 20);
    memory.deserialize(copy);
    return schemaVersion(memory);
  } catch (error) {
    if (error instanceof StoreUnverifiedError) throw error;
    throw new StoreUnverifiedError(path, { cause: error });
  } finally {
    memory.close();
  }
}

/**
 * Switches the file to WAL. SQLite answers SQLITE_BUSY to this pragma without calling the busy
 * handler while another connection is switching the same new file, so it is retried here, with a
 * synchronous backoff (opening is synchronous), until `timeoutMs` has passed.
 */
function switchToWal(db: DatabaseSync, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 1; ; delay = Math.min(delay * 2, 32)) {
    try {
      const { journal_mode: mode } = db.prepare("PRAGMA journal_mode = WAL").get() as {
        journal_mode?: unknown;
      };
      if (mode !== "wal")
        throw new Error(`could not switch the store to WAL (got ${String(mode)})`);
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

/** Whether the store file's header says WAL (bytes 18 and 19 are 2). A new, empty file does not. */
function walInHeader(path: string): boolean {
  const header = readFileSync(path).subarray(0, 20);
  return header.length === 20 && header[18] === 2 && header[19] === 2;
}

/**
 * Switches a rollback-journal (or new) file to WAL only after checking its schema version, under
 * one exclusive lock that no upgrader can commit through. BEGIN EXCLUSIVE takes the lock; with the
 * journal mode read inside it, a file that is already WAL (another process switched it) is left to
 * the normal path. Otherwise the version is read, and the connection turns to exclusive locking
 * mode before COMMIT, so the lock is kept after it, through the journal-mode switch, until the
 * connection closes. A newer version is refused with the file unchanged: a rollback-journal
 * connection that wrote nothing leaves no journal. Exclusive mode is never set on a WAL file,
 * which other processes may be using, and the connection closes without checkpointing a WAL that
 * another process left.
 */
function switchToWalVerified(path: string, busyTimeoutMs: number): void {
  const db = new DatabaseSync(path, { defensive: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec("BEGIN EXCLUSIVE");
    let version: number;
    let mode: unknown;
    try {
      ({ journal_mode: mode } = db.prepare("PRAGMA journal_mode").get() as {
        journal_mode?: unknown;
      });
      version = schemaVersion(db);
      if (mode !== "wal") db.exec("PRAGMA locking_mode = EXCLUSIVE");
    } finally {
      db.exec("COMMIT");
    }
    if (version > MIGRATIONS.length) throw new SchemaTooNewError(version, MIGRATIONS.length);
    if (mode !== "wal") switchToWal(db, busyTimeoutMs);
  } finally {
    // A file another process switched to WAL meanwhile may hold its commits in the WAL, a newer
    // schema among them: this close must not checkpoint them. After this connection's own switch
    // it still holds the exclusive lock, so no holder can open and the close is a plain one.
    closeKeepingWal(db, path);
  }
}

/**
 * Opens the file defensively, refuses a newer schema before changing anything, then switches to
 * WAL with synchronous=FULL and migrates. Busy errors on the way become StoreBusyError.
 */
export function openDatabase(path: string, busyTimeoutMs: number): DatabaseSync {
  // A store written by a newer relembra is refused before a write-capable handle exists: closing
  // one checkpoints a crashed writer's WAL into the main file and deletes the WAL and SHM. An
  // unverifiable version is refused too (StoreUnverifiedError).
  let stored: number;
  try {
    stored = readOnlySchemaVersion(path, busyTimeoutMs);
  } catch (error) {
    if (isBusy(error)) throw new StoreBusyError(busyTimeoutMs, { cause: error });
    throw error;
  }
  if (stored > MIGRATIONS.length) {
    throw new SchemaTooNewError(stored, MIGRATIONS.length);
  }
  try {
    if (!walInHeader(path)) switchToWalVerified(path, busyTimeoutMs);
  } catch (error) {
    if (isBusy(error)) throw new StoreBusyError(busyTimeoutMs, { cause: error });
    throw error;
  }
  // Defensive mode blocks writes that can corrupt the file (writable_schema, schema_version).
  const db = new DatabaseSync(path, { defensive: true });
  try {
    // Opening is synchronous, so SQLite's own busy handler may wait here.
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // Again, for a writer that committed a newer schema since the probe; migrate() checks once
    // more when it owns the write lock.
    const version = schemaVersion(db);
    if (version > MIGRATIONS.length) throw new SchemaTooNewError(version, MIGRATIONS.length);
    switchToWal(db, busyTimeoutMs);
    // Every commit is synced to disk, not only at checkpoints (Bun's WAL default is NORMAL).
    db.exec("PRAGMA synchronous = FULL");
    // Deleted content is overwritten with zeros, so a redacted memory's text does not stay in
    // the file's free space (the store truncates the WAL after a redaction for the old pages).
    db.exec("PRAGMA secure_delete = ON");
    const { secure_delete: secureDelete } = db.prepare("PRAGMA secure_delete").get() as {
      secure_delete?: unknown;
    };
    if (secureDelete !== 1) throw new Error("this SQLite cannot turn on secure_delete");
    migrate(db);
    // After opening, waits happen asynchronously (the store's busy retry), so a writer never
    // blocks the event loop while another handle in the same process holds the lock.
    db.exec("PRAGMA busy_timeout = 0");
    // SQLite has created the -wal and -shm files by now: check them, and the store file, again.
    checkOwnerOnly(path);
    return db;
  } catch (error) {
    // Refusing a newer schema must leave its file as it is; any other failure closes as usual.
    if (error instanceof SchemaTooNewError) closeKeepingWal(db, path);
    else db.close();
    if (isBusy(error)) throw new StoreBusyError(busyTimeoutMs, { cause: error });
    throw error;
  }
}

/**
 * Closes a write-capable connection that is refusing the file without letting that close change
 * it. The last connection to close a WAL store checkpoints the WAL into the main file and deletes
 * the WAL and -shm: for a newer schema that another process committed after the read-only probe,
 * that would rewrite a file this relembra refuses. So a read-only connection (with a read-only
 * -shm, which neither checkpoints nor deletes anything when it closes) holds the WAL open while
 * the writable one closes, and closes after it.
 */
function closeKeepingWal(db: DatabaseSync, path: string): void {
  let holder: DatabaseSync | undefined;
  try {
    holder = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&readonly_shm=1`, {
      readOnly: true,
    });
    // A read maps the -shm and takes its shared lock, which marks this connection as open.
    holder.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    // No holder could open (no WAL yet, for one): the close below is then the only one.
    holder?.close();
    holder = undefined;
  }
  try {
    db.close();
  } finally {
    holder?.close();
  }
}
