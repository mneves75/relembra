import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// build/cli.ts skips the build when bin/relembra.stamp matches. A skipped build must still leave a
// binary and a bin/relembra.sha256 that belong together and to these sources, because install.sh
// trusts that pair. Each test runs the real build/cli.ts on a one-line CLI in a throwaway project,
// so the repository's own bin/ is never touched. Each test creates its own project and builds
// any prerequisite it needs, independently of the other tests.

// Stable Bun has no --aot, so CI's stable-Bun jobs cannot build; see test/build-flags.test.ts.
const { RELEMBRA_SKIP_BUILD_TOOLCHAIN } = process.env;
const SKIP = RELEMBRA_SKIP_BUILD_TOOLCHAIN === "1";
if (SKIP) console.warn("build cache test SKIPPED: RELEMBRA_SKIP_BUILD_TOOLCHAIN=1");

const TIMEOUT = 120_000;
let root = "";
const bin = () => join(root, "bin", "relembra");
const sums = () => `${bin()}.sha256`;
const stamp = () => `${bin()}.stamp`;
const main = () => join(root, "src", "cli", "main.ts");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function build(): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, [join(root, "build", "cli.ts")], {
    cwd: root,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

/**
 * Changes the binary's bytes by writing a new file and renaming it into place, as an update does.
 * Writing into the file itself fails on Linux with ETXTBSY while the probe that just ran it has not
 * fully released it.
 */
function changeBinary(): void {
  const next = `${bin()}.next`;
  writeFileSync(next, Buffer.concat([readFileSync(bin()), Buffer.from("x")]), { mode: 0o755 });
  renameSync(next, bin());
}

/** A real build: exit 0, a sha256 file in `sha256sum` format that matches, a binary that runs. */
function expectBuilt(result: { status: number | null; out: string }): void {
  expect(result.out).toContain("built bin/relembra");
  expect(result.status).toBe(0);
  expect(readFileSync(sums(), "utf8")).toBe(`${sha256(bin())}  relembra\n`);
  expect(spawnSync(bin(), { cwd: root, encoding: "utf8" }).stdout).toBe("probe\n");
}

describe.skipIf(SKIP)("the CLI build cache", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "relembra-build-cache-"));
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    mkdirSync(join(root, "build"));
    writeFileSync(main(), 'console.log("probe");\n');
    copyFileSync(join(import.meta.dir, "..", "build", "cli.ts"), join(root, "build", "cli.ts"));
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test(
    "a first build writes the binary and its sha256 file",
    () => {
      expectBuilt(build());
    },
    TIMEOUT,
  );

  // The positive control for every rebuild below: nothing changed, so nothing is rebuilt.
  test(
    "an unchanged build is skipped and leaves every file as it was",
    () => {
      expectBuilt(build());
      const before = [sha256(bin()), readFileSync(sums(), "utf8"), readFileSync(stamp(), "utf8")];
      const result = build();
      expect(result.out).toContain("bin/relembra is up to date");
      expect(result.status).toBe(0);
      expect([sha256(bin()), readFileSync(sums(), "utf8"), readFileSync(stamp(), "utf8")]).toEqual(
        before,
      );
    },
    TIMEOUT,
  );

  test(
    "a binary changed after the build is rebuilt",
    () => {
      expectBuilt(build());
      changeBinary();
      expectBuilt(build());
    },
    TIMEOUT,
  );

  test(
    "a sha256 file that does not match the binary is rebuilt",
    () => {
      expectBuilt(build());
      writeFileSync(sums(), "deadbeef  relembra\n");
      expectBuilt(build());
    },
    TIMEOUT,
  );

  test(
    "a sha256 file that names another file is rebuilt",
    () => {
      expectBuilt(build());
      writeFileSync(sums(), `${sha256(bin())}  other\n`);
      expectBuilt(build());
    },
    TIMEOUT,
  );

  test(
    "a binary replaced together with a matching sha256 file is rebuilt",
    () => {
      expectBuilt(build());
      changeBinary();
      writeFileSync(sums(), `${sha256(bin())}  relembra\n`);
      expectBuilt(build());
    },
    TIMEOUT,
  );

  // A stable and a canary Bun share Bun.version; only Bun.revision tells them apart.
  test(
    "a build stamped by another Bun revision is rebuilt",
    () => {
      expectBuilt(build());
      const recorded = readFileSync(stamp(), "utf8");
      expect(recorded).toContain(Bun.revision);
      writeFileSync(stamp(), recorded.replace(Bun.revision, "0".repeat(Bun.revision.length)));
      expectBuilt(build());
    },
    TIMEOUT,
  );

  test(
    "a failed rebuild exits nonzero",
    () => {
      expectBuilt(build());
      writeFileSync(main(), 'import "./missing.ts";\n');
      const result = build();
      expect(result.out).toContain("bun build failed");
      expect(result.status).not.toBe(0);
    },
    TIMEOUT,
  );
});
