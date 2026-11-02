/**
 * Windows has no file modes, so a new store's folder gets an ACL of its own (src/sqlite/database.ts,
 * restrictFolderToOwner): only the user, SYSTEM and Administrators, nothing inherited. Read back
 * with icacls. Runs on Windows only; elsewhere the mode checks in sqlite.test.ts cover the store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerOnly } from "../src/sqlite/database.js";

const WINDOWS = process.platform === "win32";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** icacls's listing for a path. */
function acl(path: string): string {
  const system32 = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
  const run = spawnSync(join(system32, "icacls.exe"), [path], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`icacls: ${run.stderr || run.stdout}`);
  return run.stdout;
}

/** The user's SID, as whoami prints it. */
function sid(): string {
  const system32 = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
  const run = spawnSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
  });
  return /"(S-1-[0-9-]+)"\s*$/.exec(run.stdout)?.[1] ?? "";
}

describe.skipIf(!WINDOWS)("Windows store ACL", () => {
  test("a plain temporary folder inherits its ACL (positive control)", () => {
    const dir = mkdtempSync(join(tmpdir(), "relembra-acl-plain-"));
    dirs.push(dir);
    expect(acl(dir)).toContain("(I)");
  });

  test("a new store's folder and file grant only the user, SYSTEM and Administrators", () => {
    const parent = mkdtempSync(join(tmpdir(), "relembra-acl-"));
    dirs.push(parent);
    const home = join(parent, "home");
    const store = join(home, "relembra.db");
    createOwnerOnly(store);
    const folder = acl(home);
    expect(folder).not.toContain("(I)");
    const user = sid();
    expect(user).toMatch(/^S-1-5-21-/);
    // icacls prints names; /save would print SIDs, but names are what a person audits. The three
    // grants, and nothing else, are on the folder: one line each, plus the summary line.
    const grants = folder
      .split(/\r?\n/)
      .map((line) => line.replace(home, "").trim())
      .filter((line) => line.includes(":("));
    expect(grants).toHaveLength(3);
    expect(folder).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users/);
    // The store file inherits exactly those three.
    const file = acl(store)
      .split(/\r?\n/)
      .map((line) => line.replace(store, "").trim())
      .filter((line) => line.includes(":("));
    expect(file).toHaveLength(3);
    expect(file.every((line) => line.includes("(I)"))).toBe(true);
  });

  test("an existing store's folder is left as it is", () => {
    const parent = mkdtempSync(join(tmpdir(), "relembra-acl-again-"));
    dirs.push(parent);
    const store = join(parent, "relembra.db");
    createOwnerOnly(store);
    const before = acl(parent);
    createOwnerOnly(store);
    expect(acl(parent)).toBe(before);
  });
});
