/**
 * scripts/bun-toolchain.sh installs the pinned Bun only when its package's sha512 matches the pin
 * and the unpacked executable reports the pinned revision. A fake package served from disk
 * (file:// through RELEMBRA_BUN_REGISTRY) stands in for npm.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "bun-toolchain.sh");
const VERSION = "9.9.9-canary.1";
const REVISION = "9.9.9-canary.1+abcdef012";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A registry directory holding @oven/bun-test-x64 with a `bun` that prints `revision`. */
function registry(revision = REVISION): { root: string; integrity: string } {
  const root = mkdtempSync(join(tmpdir(), "relembra-bun-registry-"));
  dirs.push(root);
  const work = join(root, "work");
  mkdirSync(join(work, "package", "bin"), { recursive: true });
  writeFileSync(join(work, "package", "bin", "bun"), `#!/bin/sh\necho '${revision}'\n`, {
    mode: 0o755,
  });
  const dir = join(root, "@oven", "bun-test-x64", "-");
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, `bun-test-x64-${VERSION}.tgz`);
  const tar = spawnSync("tar", ["-czf", archive, "-C", work, "package"]);
  if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  return { root, integrity };
}

function pin(integrity: string): string {
  const dir = mkdtempSync(join(tmpdir(), "relembra-bun-pin-"));
  dirs.push(dir);
  const file = join(dir, "pin.txt");
  writeFileSync(
    file,
    `# test pin\nversion ${VERSION}\nrevision ${REVISION}\ntest-x64 ${integrity}\n`,
  );
  return file;
}

function run(pinFile: string, registryRoot: string, platform = "test-x64") {
  const parent = mkdtempSync(join(tmpdir(), "relembra-bun-out-"));
  dirs.push(parent);
  const dest = join(parent, "bun");
  const result = spawnSync("bash", [script, platform, dest], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEMBRA_BUN_PIN: pinFile,
      RELEMBRA_BUN_REGISTRY: `file://${registryRoot}`,
    },
  });
  return { ...result, dest };
}

describe("pinned Bun toolchain", () => {
  test("installs a package whose sha512 and revision match the pin (positive control)", () => {
    const { root, integrity } = registry();
    const result = run(pin(integrity), root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(result.dest, "package", "bin"));
    expect(existsSync(join(result.dest, "package", "bin", "bun"))).toBe(true);
    expect(existsSync(join(result.dest, "bun.tgz"))).toBe(false);
  });

  test("refuses a package whose bytes differ from the pin", () => {
    const { root } = registry();
    const other = registry("other");
    const result = run(pin(other.integrity), root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the pinned sha512");
    expect(existsSync(join(result.dest, "package"))).toBe(false);
  });

  test("refuses an executable that reports another revision", () => {
    const { root, integrity } = registry("9.9.9-canary.1+0000000");
    const result = run(pin(integrity), root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the pin says 9.9.9-canary.1+abcdef012");
  });

  test("refuses a platform the pin does not name", () => {
    const { root, integrity } = registry();
    const result = run(pin(integrity), root, "test-arm64");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no pin for platform test-arm64");
  });

  test("the repository's pin names every release platform", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "build", "bun-toolchain.txt")).text();
    const keys = text
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(" ")[0]);
    expect(keys).toEqual([
      "version",
      "revision",
      "darwin-aarch64",
      "linux-x64",
      "linux-aarch64",
      "windows-x64",
      "windows-aarch64",
    ]);
  });
});
