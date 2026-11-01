import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { BUILD_FLAGS, missingBuildFlags } from "../build/cli.js";

// Stable Bun 1.4.4 has no --aot or --trim and ignores unknown flags, so a build with it exits 0
// and writes a different (non-AOT, untrimmed) executable. The build refuses such a Bun instead.

const STABLE_1_4_4_EXCERPT = `
      --compile                       Generate a standalone Bun executable containing your bundled code. Implies --production
      --compile-exec-argv=<val>       Prepend arguments to the standalone executable's execArgv
      --no-compile-autoload-dotenv    Disable autoloading of .env files in standalone executable
      --no-compile-autoload-bunfig    Disable autoloading of bunfig.toml in standalone executable
`;

test("a Bun whose build help lacks --aot and --trim is refused", () => {
  expect(missingBuildFlags(STABLE_1_4_4_EXCERPT)).toEqual(["--aot", "--trim"]);
});

test("a flag only counts as itself, not as the prefix of a longer one", () => {
  const help = "      --aot-huge-heap   x\n      --trim-locales=<val>   y\n      --compile   z\n";
  expect(missingBuildFlags(help)).toEqual([
    "--aot",
    "--trim",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
  ]);
});

// The release toolchain check. CI's stable-Bun test jobs set RELEMBRA_SKIP_BUILD_TOOLCHAIN=1: they
// run the suite, not the build, and stable Bun has no --aot. The `cli` job runs this test on the
// Bun that builds the binary.
const { RELEMBRA_SKIP_BUILD_TOOLCHAIN } = process.env;
const SKIP_TOOLCHAIN = RELEMBRA_SKIP_BUILD_TOOLCHAIN === "1";
if (SKIP_TOOLCHAIN) console.warn("build toolchain test SKIPPED: RELEMBRA_SKIP_BUILD_TOOLCHAIN=1");

(SKIP_TOOLCHAIN ? test.skip : test)("the Bun running these tests lists every build flag", () => {
  const help = spawnSync(process.execPath, ["build", "--help"], { encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(missingBuildFlags(help.stdout)).toEqual([]);
  expect(BUILD_FLAGS).toContain("--aot");
});
