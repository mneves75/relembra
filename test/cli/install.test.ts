import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARY, cliTest, ROOT } from "./support.js";

const INSTALL = join(ROOT, "install.sh");
/** Each test runs install.sh a few times; under load that outlasts bun's 5 s default. */
const INSTALL_TIMEOUT_MS = 60_000;
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "relembra-install-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A fake binary (a shell script) and its checksum file, as build/cli.ts writes them. */
function artifact(name = "relembra"): { binary: string; sums: string } {
  const binary = join(dir, name);
  writeFileSync(binary, "#!/bin/sh\necho installed-ok\n");
  const sums = `${binary}.sha256`;
  writeFileSync(sums, `${sha256(readFileSync(binary))}  ${name}\n`);
  return { binary, sums };
}

const install = (...args: string[]) =>
  spawnSync("sh", [INSTALL, ...args], { encoding: "utf8", timeout: 30_000 });

const dest = () => join(dir, "dest");

describe("install.sh installs a binary only after verifying its sha256", () => {
  test(
    "a good file is installed, executable and byte-identical",
    () => {
      const { binary, sums } = artifact();
      const result = install(binary, sums, dest());
      expect(result.status).toBe(0);
      const installed = join(dest(), "relembra");
      expect(readFileSync(installed).equals(readFileSync(binary))).toBe(true);
      expect(statSync(installed).mode & 0o111).not.toBe(0);
      expect(spawnSync(installed, { encoding: "utf8" }).stdout).toBe("installed-ok\n");
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "a tampered file is refused and nothing is installed",
    () => {
      const { binary, sums } = artifact();
      appendFileSync(binary, "echo tampered\n");
      const result = install(binary, sums, dest());
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("sha256");
      expect(existsSync(join(dest(), "relembra"))).toBe(false);
      expect(existsSync(dest()) ? readdirSync(dest()) : []).toEqual([]);
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "a tampered file never replaces an installed one",
    () => {
      const { binary, sums } = artifact();
      expect(install(binary, sums, dest()).status).toBe(0);
      const before = readFileSync(join(dest(), "relembra"));
      appendFileSync(binary, "echo tampered\n");
      expect(install(binary, sums, dest()).status).toBe(1);
      expect(readFileSync(join(dest(), "relembra")).equals(before)).toBe(true);
      expect(readdirSync(dest())).toEqual(["relembra"]);
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "a missing checksum file is refused",
    () => {
      const { binary } = artifact();
      const result = install(binary, join(dir, "absent.sha256"), dest());
      expect(result.status).toBe(1);
      expect(existsSync(join(dest(), "relembra"))).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "a checksum file without this binary's line, or with a malformed hash, is refused",
    () => {
      const { binary, sums } = artifact();
      writeFileSync(sums, `${sha256(readFileSync(binary))}  other-name\n`);
      expect(install(binary, sums, dest()).status).toBe(1);
      writeFileSync(sums, "not-a-hash  relembra\n");
      expect(install(binary, sums, dest()).status).toBe(1);
      writeFileSync(sums, "");
      expect(install(binary, sums, dest()).status).toBe(1);
      expect(existsSync(join(dest(), "relembra"))).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "a directory or a symlink at <dest>/relembra is refused, and nothing lands anywhere",
    () => {
      const { binary, sums } = artifact();
      const other = join(dir, "other");
      mkdirSync(other);
      mkdirSync(dest());
      // Sol's repro: a symlink to a directory got "installed" inside it as .relembra.XXXXXX.
      symlinkSync("../other", join(dest(), "relembra"));
      const viaLink = install(binary, sums, dest());
      expect(viaLink.status).toBe(1);
      expect(viaLink.stdout).not.toContain("installed");
      expect(readdirSync(other)).toEqual([]);
      expect(readdirSync(dest())).toEqual(["relembra"]);
      expect(lstatSync(join(dest(), "relembra")).isSymbolicLink()).toBe(true);
      // A symlink to a file, and a plain directory, are refused the same way.
      rmSync(join(dest(), "relembra"));
      writeFileSync(join(other, "target"), "x");
      symlinkSync(join(other, "target"), join(dest(), "relembra"));
      expect(install(binary, sums, dest()).status).toBe(1);
      expect(readFileSync(join(other, "target"), "utf8")).toBe("x");
      rmSync(join(dest(), "relembra"));
      mkdirSync(join(dest(), "relembra"));
      expect(install(binary, sums, dest()).status).toBe(1);
      expect(readdirSync(join(dest(), "relembra"))).toEqual([]);
      // Positive control: with the directory gone, the same install succeeds.
      rmSync(join(dest(), "relembra"), { recursive: true });
      expect(install(binary, sums, dest()).status).toBe(0);
      expect(lstatSync(join(dest(), "relembra")).isFile()).toBe(true);
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "usage errors exit 2",
    () => {
      expect(install().status).toBe(2);
      expect(install(join(dir, "absent")).status).toBe(2);
    },
    INSTALL_TIMEOUT_MS,
  );

  cliTest("the compiled binary and its build checksum install and run", () => {
    const result = install(BINARY, `${BINARY}.sha256`, dest());
    expect(result.status).toBe(0);
    const help = spawnSync(join(dest(), "relembra"), ["--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("relembra note");
  });
});
