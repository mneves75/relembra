/**
 * The pure parts of the Windows creation step: the lock's name, the descriptors and the request
 * handed to PowerShell. The Windows tests in sqlite-windows-acl.test.ts and sqlite-crash.test.ts
 * exercise the step itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStoreUnderLock,
  requestJson,
  storeFolderSddl,
  storeLockName,
  storeLockSddl,
} from "../src/sqlite/windows-security.js";

const USER = "S-1-5-21-1-2-3-1001";
const ACCOUNTS = [USER, "S-1-5-18", "S-1-5-32-544"];

describe("the store creation lock", () => {
  test("is named for the account and the folder, as Windows compares paths", () => {
    const name = storeLockName(USER, "C:\\Users\\Me\\AppData\\relembra");
    expect(name).toMatch(/^Global\\relembra-[0-9a-f]{64}$/);
    expect(storeLockName(USER, "c:\\users\\me\\appdata\\RELEMBRA")).toBe(name);
    expect(storeLockName("S-1-5-21-1-2-3-1002", "C:\\Users\\Me\\AppData\\relembra")).not.toBe(name);
    expect(storeLockName(USER, "C:\\Users\\Me\\AppData\\relembra2")).not.toBe(name);
  });

  test("grants the accounts full control of the lock and nothing else", () => {
    expect(storeLockSddl(USER, ACCOUNTS)).toBe(
      `O:${USER}D:P(A;;0x1f0001;;;${USER})(A;;0x1f0001;;;S-1-5-18)(A;;0x1f0001;;;S-1-5-32-544)`,
    );
  });
});

describe("the store folder's descriptor", () => {
  test("is protected, auto-inherited and grants the accounts inheritable full control", () => {
    expect(storeFolderSddl(USER, ACCOUNTS)).toBe(
      `O:${USER}D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)`,
    );
  });
});

/** Printable ASCII only: JSON escapes every control character itself. */
const ASCII = /^[ -~]*$/;

describe("the request PowerShell reads from stdin", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // PowerShell decodes stdin with the console's code page, which is rarely UTF-8.
  const request = { mode: "read", paths: ["C:\\Users\\João", "C:\\Data\\memória \u{1f600}"] };

  test("is pure ASCII and parses back to the request", () => {
    // Positive control: plain JSON carries the accents as raw non-ASCII characters.
    expect(JSON.stringify(request)).not.toMatch(ASCII);
    const text = requestJson(request);
    expect(text).toMatch(ASCII);
    expect(text).toContain("Jo\\u00e3o");
    expect(JSON.parse(text)).toEqual(request);
  });

  // A stand-in for powershell.exe that keeps its stdin: what the store hands the real one.
  test.skipIf(process.platform === "win32")("is the exact text the creation step writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "relembra-ps-"));
    dirs.push(dir);
    const stdin = join(dir, "stdin.json");
    const shell = join(dir, "powershell");
    writeFileSync(shell, `#!/bin/sh\ncat > '${stdin}'\nprintf '"created"'\n`);
    chmodSync(shell, 0o700);
    const folder = "C:\\Users\\João\\.relembra";
    expect(
      createStoreUnderLock(shell, `${folder}\\relembra.db`, folder, [folder], [], USER, ACCOUNTS),
    ).toBe("created");
    const written = readFileSync(stdin, "utf8");
    expect(written).toMatch(ASCII);
    expect(JSON.parse(written)).toMatchObject({ mode: "create", folder, paths: [folder] });
  });
});
