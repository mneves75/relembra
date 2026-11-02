/**
 * Windows has no file modes, so a new store's folder gets an ACL of its own (src/sqlite/database.ts,
 * restrictFolderToOwner): only the user, SYSTEM and Administrators, nothing inherited. Read back
 * with icacls. The ACL tests run on Windows only; elsewhere the mode checks in sqlite.test.ts
 * cover the store.
 *
 * Bun's mkdirSync and mkdtempSync give a folder an explicit owner-only ACL, so a folder they make
 * would pass these tests with or without relembra's ACL. The tests use a parent that grants
 * Everyone read to everything made in it, and folders made by cmd, which inherit that grant.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerOnly, restrictFolderToOwner, windowsSystem32 } from "../src/sqlite/database.js";
import { windowsSid, windowsTool } from "./platform-support.js";

const WINDOWS = process.platform === "win32";
const EVERYONE_READS = "*S-1-1-0:(OI)(CI)R";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const acl = (path: string) => windowsTool("icacls.exe", [path]);

/** The grant lines icacls lists for `path`, the path itself removed. */
const grants = (path: string) =>
  acl(path)
    .split(/\r?\n/)
    .map((line) => line.replace(path, "").trim())
    .filter((line) => line.includes(":("));

/** A temporary folder whose ACL lets Everyone read whatever is made in it. */
function leakyParent(): string {
  const parent = mkdtempSync(join(tmpdir(), "relembra-acl-"));
  dirs.push(parent);
  windowsTool("icacls.exe", [parent, "/grant", EVERYONE_READS]);
  return parent;
}

/**
 * The owner of the folder `name` in `parent`, as `dir /q` names it (`BUILTIN\Users`). Windows
 * PowerShell's Get-Acl hung at times on the arm runner (run 41391564103), so no test runs it.
 * `dir /q` cuts a long owner name to its column, which then runs into the folder's name with no
 * space (run 41392460250), so the owner is what lies between `<DIR>` and the name, and a caller
 * compares it by prefix.
 */
function ownerOf(parent: string, name: string): string {
  const listing = windowsTool("cmd.exe", ["/d", "/c", "dir", "/q", "/a:d", parent]);
  const line = listing
    .split(/\r?\n/)
    .find((entry) => entry.includes("<DIR>") && entry.endsWith(name));
  if (line === undefined) throw new Error(`dir /q did not list ${name}:\n${listing}`);
  return line.slice(line.indexOf("<DIR>") + "<DIR>".length, -name.length).trim();
}

/** A folder made by cmd, so it inherits its parent's ACL as any program's folder would. */
function plainFolder(path: string): string {
  windowsTool("cmd.exe", ["/d", "/c", "mkdir", path]);
  return path;
}

/** The store's folder and file grant the user, SYSTEM and Administrators, and nobody else. */
function expectOwnerOnly(home: string, store: string) {
  const folder = grants(home);
  expect(folder.join("\n")).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users|\(I\)/);
  expect(folder).toHaveLength(3);
  const file = grants(store);
  expect(file.join("\n")).not.toContain("Everyone");
  expect(file).toHaveLength(3);
  expect(file.every((line) => line.includes("(I)"))).toBe(true);
}

describe("the System32 folder whoami and icacls run from", () => {
  test("SystemRoot names it when it is a drive path", () => {
    expect(windowsSystem32("D:\\Win")).toBe("D:\\Win\\System32");
  });

  test("an unset, empty or relative SystemRoot is C:\\Windows, never the working directory", () => {
    for (const root of [undefined, "", "Windows", ".\\Windows", "\\Windows"]) {
      expect({ root, system32: windowsSystem32(root) }).toEqual({
        root,
        system32: "C:\\Windows\\System32",
      });
    }
  });
});

describe.skipIf(!WINDOWS)("Windows store ACL", () => {
  test("positive control: a folder made in the leaky parent inherits Everyone's read", () => {
    const home = plainFolder(join(leakyParent(), "home"));
    expect(acl(home)).toMatch(/Everyone:\(I\)/);
  });

  test("a store in a folder that inherited Everyone's read grants only the three", () => {
    const home = plainFolder(join(leakyParent(), "home"));
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    expectOwnerOnly(home, store);
    expect(windowsSid()).toMatch(/^S-1-5-21-/);
  });

  test("an existing home with an explicit grant to Everyone is refused before the store exists", () => {
    const home = plainFolder(join(leakyParent(), "home"));
    windowsTool("icacls.exe", [home, "/grant", EVERYONE_READS]);
    // Positive control: the grant is explicit, so dropping inheritance alone keeps it.
    expect(acl(home)).toMatch(/Everyone:\(OI\)/);
    const store = join(home, "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(/grants another account access \(4 entries/);
    expect(existsSync(store)).toBe(false);
  });

  test("the ACL step run again beside a store another process made keeps it owner-only", () => {
    // Two first opens at once: the second runs the ACL step after the first made the store. No
    // step may restore the leaky parent's grants, even for a moment, or the store inherits them.
    const home = plainFolder(join(leakyParent(), "home"));
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    restrictFolderToOwner(home);
    expectOwnerOnly(home, store);
  });

  test("a home relembra makes itself, in the leaky parent, grants only the three", () => {
    const home = join(leakyParent(), "home");
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    expectOwnerOnly(home, store);
  });

  test("a folder another account owns becomes the user's before the grants", () => {
    const parent = leakyParent();
    const home = plainFolder(join(parent, "home"));
    // BUILTIN\Users stands in for another account: an owner may always rewrite the ACL.
    windowsTool("icacls.exe", [home, "/setowner", "*S-1-5-32-545"]);
    // Positive control: the owner really changed.
    expect(ownerOf(parent, "home")).toBe("BUILTIN\\Users");
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    const owner = ownerOf(parent, "home");
    // whoami prints the account as `HOST\user`, the name dir /q shows, perhaps cut short.
    const account = windowsTool("whoami.exe", []).trim();
    expect({
      owner,
      named: owner.includes("\\"),
      account,
      isAccount: account.toLowerCase().startsWith(owner.toLowerCase()),
    }).toEqual({ owner, named: true, account, isAccount: true });
    expectOwnerOnly(home, store);
  });

  test("a store folder that is a junction is refused, its target untouched", () => {
    const parent = leakyParent();
    const target = plainFolder(join(parent, "target"));
    const home = join(parent, "home");
    windowsTool("cmd.exe", ["/d", "/c", "mklink", "/J", home, target]);
    // Positive control: the runtime sees the junction as a link.
    expect(lstatSync(home).isSymbolicLink()).toBe(true);
    const before = acl(target);
    const store = join(home, "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(/is a link/);
    expect(existsSync(join(target, "relembra.db"))).toBe(false);
    expect(acl(target)).toBe(before);
  });

  test("a sidecar without its store is refused before the store's first byte", () => {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const home = plainFolder(join(leakyParent(), "home"));
      const store = join(home, "relembra.db");
      writeFileSync(`${store}${suffix}`, "");
      expect(() => createOwnerOnly(store)).toThrow(/exists without its store/);
      expect(existsSync(store)).toBe(false);
    }
  });

  test("a dangling link as a sidecar is refused too, before the store's first byte", () => {
    const parent = leakyParent();
    const home = plainFolder(join(parent, "home"));
    const store = join(home, "relembra.db");
    // The target is missing, so existsSync, which follows links, would call the sidecar absent.
    symlinkSync(join(parent, "elsewhere.wal"), `${store}-wal`, "file");
    expect(existsSync(`${store}-wal`)).toBe(false);
    expect(lstatSync(`${store}-wal`).isSymbolicLink()).toBe(true);
    expect(() => createOwnerOnly(store)).toThrow(/exists without its store/);
    expect(existsSync(store)).toBe(false);
  });

  test("an existing store's folder is left as it is", () => {
    const home = plainFolder(join(leakyParent(), "home"));
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    const before = acl(home);
    createOwnerOnly(store);
    expect(acl(home)).toBe(before);
  });
});
