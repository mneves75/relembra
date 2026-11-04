/**
 * Windows new-store directories are created private, with owner SIDs read directly through
 * .NET. Independent icacls observations check the resulting access. Windows-only filesystem
 * tests complement the POSIX mode checks in sqlite.test.ts.
 *
 * Bun's mkdirSync and mkdtempSync give a folder an explicit owner-only ACL, so a folder they make
 * would pass these tests with or without relembra's ACL. The tests use a parent that grants
 * Everyone read to everything made in it, and folders made by cmd, which inherit that grant.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerOnly, storeFolderAccounts, windowsSystem32 } from "../src/sqlite/database.js";
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

describe("the accounts a store folder grants", () => {
  test("a user's folder grants the user, SYSTEM and Administrators", () => {
    expect(storeFolderAccounts("S-1-5-21-1-2-3-1001")).toEqual([
      "S-1-5-21-1-2-3-1001",
      "S-1-5-18",
      "S-1-5-32-544",
    ]);
  });

  test("LocalSystem is SYSTEM: two accounts, so a foreign grant cannot pass as a third", () => {
    expect(storeFolderAccounts("S-1-5-18")).toEqual(["S-1-5-18", "S-1-5-32-544"]);
  });
});

describe.skipIf(!WINDOWS)("Windows store ACL", () => {
  test("positive control: a folder made in the leaky parent inherits Everyone's read", () => {
    const home = plainFolder(join(leakyParent(), "home"));
    expect(acl(home)).toMatch(/Everyone:\(I\)/);
  });

  test("a new store folder under inheritable Everyone read grants only the three", () => {
    const home = join(leakyParent(), "home");
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
    const before = acl(home);
    expect(() => createOwnerOnly(store)).toThrow(/already exists/);
    expect(existsSync(store)).toBe(false);
    expect(acl(home)).toBe(before);
  });

  test("opening an existing store never restores inherited grants", () => {
    const home = join(leakyParent(), "home");
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    createOwnerOnly(store);
    expectOwnerOnly(home, store);
  });

  test("a home relembra makes itself, in the leaky parent, grants only the three", () => {
    const home = join(leakyParent(), "home");
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    expectOwnerOnly(home, store);
  });

  test("a preexisting folder with an open writable handle is refused without changing its ACL", () => {
    const home = plainFolder(join(leakyParent(), "home"));
    const held = join(home, "held.txt");
    const handle = openSync(held, "wx");
    const before = acl(home);
    const store = join(home, "relembra.db");
    try {
      expect(existsSync(held)).toBe(true);
      expect(() => createOwnerOnly(store)).toThrow(/already exists/);
      expect(existsSync(store)).toBe(false);
      expect(acl(home)).toBe(before);
    } finally {
      closeSync(handle);
    }
  });

  test("creating nested private folders does not depend on TEMP or TMP being writable", () => {
    const parent = leakyParent();
    const unavailable = join(parent, "missing-temp");
    const previous = { TEMP: process.env["TEMP"], TMP: process.env["TMP"] };
    process.env["TEMP"] = unavailable;
    process.env["TMP"] = unavailable;
    try {
      expect(() => mkdtempSync(join(tmpdir(), "control-"))).toThrow();
      // Control: whether Windows PowerShell's own startup makes a missing TEMP (CI run
      // 41762474475 found it present after a store was created). Measured with no store involved,
      // so what relembra adds to it, if anything, is told apart from what PowerShell does.
      windowsTool("WindowsPowerShell\\v1.0\\powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "exit 0",
      ]);
      const powershellMakesTemp = existsSync(unavailable);
      if (powershellMakesTemp) rmSync(unavailable, { recursive: true, force: true });
      const home = join(parent, "new", "nested");
      const store = join(home, "relembra.db");
      createOwnerOnly(store);
      expectOwnerOnly(home, store);
      expect(grants(join(parent, "new"))).toHaveLength(3);
      expect(existsSync(unavailable)).toBe(powershellMakesTemp);
      // Nothing of relembra's in it: no folder, no store or sidecar.
      const left = powershellMakesTemp ? readdirSync(unavailable, { withFileTypes: true }) : [];
      expect(
        left
          .filter((entry) => entry.isDirectory() || /\.db$|-wal$|-shm$|-journal$/.test(entry.name))
          .map((entry) => entry.name),
      ).toEqual([]);
    } finally {
      for (const key of ["TEMP", "TMP"] as const) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("a folder name containing PowerShell syntax is data", () => {
    const home = join(leakyParent(), "home'; throw 'injected");
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    expectOwnerOnly(home, store);
  });

  test("an ancestor owned by another account is refused even without a grant to it", () => {
    const parent = leakyParent();
    const home = plainFolder(join(parent, "home"));
    // BUILTIN\Users stands in for another account: an owner may always rewrite the ACL.
    windowsTool("icacls.exe", [home, "/setowner", "*S-1-5-32-545"]);
    // Positive control: the owner really changed.
    expect(ownerOf(parent, "home")).toBe("BUILTIN\\Users");
    expect(acl(home)).not.toContain("BUILTIN\\Users:");
    const before = acl(home);
    const store = join(home, "new", "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(/owned by another account \(S-1-5-32-545\)/);
    expect(existsSync(store)).toBe(false);
    expect(acl(home)).toBe(before);
    expect(ownerOf(parent, "home")).toBe("BUILTIN\\Users");
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

  // The path to the store folder (docs/specs/w-nv1/spec.md): BUILTIN\Users stands in for another
  // account. Each grant is read back first, so a refusal is the rule's and not an empty ACL's.
  const USERS = "*S-1-5-32-545";
  const refusedFor = (folder: string, grant: string, shown: RegExp) => {
    windowsTool("icacls.exe", [folder, "/grant", `${USERS}:${grant}`]);
    expect(acl(folder)).toMatch(shown);
  };

  test("R1: a folder above the store folder that another account may re-permission is refused", () => {
    const above = leakyParent();
    const parent = plainFolder(join(above, "parent"));
    refusedFor(above, "(WDAC)", /BUILTIN\\Users:\(WDAC\)/);
    const store = join(parent, "home", "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(
      /\(S-1-5-32-545\) rename, delete or re-permission it/,
    );
    expect(existsSync(store)).toBe(false);
  });

  test("R2: a folder above the store folder whose entries another account may delete is refused", () => {
    const above = leakyParent();
    const parent = plainFolder(join(above, "parent"));
    refusedFor(above, "(DC)", /BUILTIN\\Users:\(DC\)/);
    const store = join(parent, "home", "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(
      /\(S-1-5-32-545\) rename or delete the folders in it/,
    );
    expect(existsSync(store)).toBe(false);
  });

  test("R3: a parent where another account may make folders is refused", () => {
    const parent = leakyParent();
    refusedFor(parent, "(AD)", /BUILTIN\\Users:\(AD\)/);
    const store = join(parent, "home", "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(/\(S-1-5-32-545\) create the store folder first/);
    expect(existsSync(store)).toBe(false);
  });

  test("R4: a parent that gives another account write on new folders is refused", () => {
    const parent = leakyParent();
    refusedFor(parent, "(OI)(CI)(IO)(M)", /BUILTIN\\Users:\(OI\)\(CI\)\(IO\)\(M\)/);
    const store = join(parent, "home", "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(/\(S-1-5-32-545\) open the new store folder/);
    expect(existsSync(store)).toBe(false);
  });

  test("an empty parent where another account may write attributes is refused", () => {
    const parent = leakyParent();
    refusedFor(parent, "(WA)", /BUILTIN\\Users:\(WA\)/);
    const store = join(parent, "home", "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(/attributes or turn it into a reparse point/);
    expect(existsSync(join(parent, "home"))).toBe(false);
  });

  test("a junction above the store folder is refused, its target untouched", () => {
    const parent = leakyParent();
    const target = plainFolder(join(parent, "target"));
    const link = join(parent, "link");
    windowsTool("cmd.exe", ["/d", "/c", "mklink", "/J", link, target]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const store = join(link, "home", "relembra.db");
    expect(() => createOwnerOnly(store)).toThrow(/link is a link/);
    expect(existsSync(join(target, "home", "relembra.db"))).toBe(false);
  });

  test("a sidecar without its store is refused before the store's first byte", () => {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const home = plainFolder(join(leakyParent(), "home"));
      const store = join(home, "relembra.db");
      writeFileSync(`${store}${suffix}`, "");
      expect(() => createOwnerOnly(store)).toThrow(/already exists/);
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
    expect(() => createOwnerOnly(store)).toThrow(/already exists/);
    expect(existsSync(store)).toBe(false);
  });

  test("an existing store's folder is left as it is", () => {
    const home = join(leakyParent(), "home");
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    const before = acl(home);
    createOwnerOnly(store);
    expect(acl(home)).toBe(before);
  });
});
