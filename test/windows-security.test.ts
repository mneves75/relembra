/**
 * The pure parts of the Windows creation step: the lock's name and the descriptors handed to
 * PowerShell. The Windows tests in sqlite-windows-acl.test.ts and sqlite-crash.test.ts exercise
 * the step itself.
 */
import { describe, expect, test } from "bun:test";
import { storeFolderSddl, storeLockName, storeLockSddl } from "../src/sqlite/windows-security.js";

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
