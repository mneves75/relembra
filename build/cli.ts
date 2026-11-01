/**
 * Builds the relembra CLI for the native target as a Bun AOT binary (IMPLEMENTATION-PLAN §4.6):
 * bin/relembra, plus bin/relembra.sha256 in `sha256sum` format for install.sh. Skips the build
 * when bin/relembra.stamp shows the same Bun, sources and script, and the binary and its sha256
 * file are still the ones that build wrote; `--force` builds anyway.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin");
const OUT = join(BIN, "relembra");
const STAMP = `${OUT}.stamp`;
const SUMS = `${OUT}.sha256`;

/**
 * --compile --aot --trim: the build §4.6 names. The executable must not read configuration from
 * the directory it runs in: a project's .env could set RELEMBRA_SCOPE or RELEMBRA_HOME, and its
 * bunfig.toml could preload code. Both autoloads default to on, so both are turned off.
 */
export const BUILD_FLAGS = [
  "build",
  "--compile",
  "--aot",
  "--trim",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
] as const;

/**
 * The build flags this Bun's `bun build --help` does not list. Bun ignores an unknown build flag
 * and still exits 0 (stable 1.4.4 has no --aot or --trim), so a missing one would silently make a
 * different executable; the build refuses instead.
 */
export function missingBuildFlags(help: string): string[] {
  return BUILD_FLAGS.filter((flag) => flag.startsWith("--")).filter(
    (flag) => !new RegExp(`(^|\\s)${flag}(\\s|=|$)`, "m").test(help),
  );
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** A hash over the flags and everything the binary is built from. */
function inputsHash(): string {
  const hash = createHash("sha256");
  hash.update(`${BUILD_FLAGS.join(" ")}\n`);
  const inputs = [...files(join(ROOT, "src")), join(ROOT, "build", "cli.ts")].sort();
  for (const file of inputs) {
    hash.update(`${relative(ROOT, file)}\n`);
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** bin/relembra.sha256: one `sha256sum` line, as install.sh checks it. */
function sumsOf(digest: string): string {
  return `${digest}  relembra\n`;
}

/**
 * bin/relembra.stamp: the Bun that built the binary, by version and revision (a stable and a canary
 * Bun share a version), the inputs, and the binary's own sha256, so a binary changed or replaced
 * after the build is never taken for it.
 */
function stampOf(inputs: string, digest: string): string {
  return `bun ${Bun.version} ${Bun.revision}\ninputs ${inputs}\nsha256 ${digest}\n`;
}

function main(): number {
  const force = process.argv.includes("--force");
  const inputs = inputsHash();
  if (!force && existsSync(OUT) && existsSync(SUMS) && existsSync(STAMP)) {
    const digest = sha256(OUT);
    if (
      readFileSync(STAMP, "utf8") === stampOf(inputs, digest) &&
      readFileSync(SUMS, "utf8") === sumsOf(digest)
    ) {
      console.log(`bin/relembra is up to date (${process.platform}-${process.arch})`);
      return 0;
    }
  }
  const help = spawnSync(process.execPath, ["build", "--help"], { encoding: "utf8" });
  const missing =
    help.status === 0 ? missingBuildFlags(help.stdout) : ["(bun build --help failed)"];
  if (missing.length > 0) {
    console.error(
      `bun ${Bun.version} does not support ${missing.join(", ")}; build with a Bun that has them (v0.1.0 used 1.4.4-canary.1+da867c60b)`,
    );
    return 1;
  }
  mkdirSync(BIN, { recursive: true });
  const build = spawnSync(
    process.execPath,
    [...BUILD_FLAGS, `--outfile=${OUT}`, join(ROOT, "src", "cli", "main.ts")],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (build.status !== 0) {
    console.error(`bun build failed (exit ${build.status})`);
    return 1;
  }
  const digest = sha256(OUT);
  writeFileSync(SUMS, sumsOf(digest));
  writeFileSync(STAMP, stampOf(inputs, digest));
  console.log(`built bin/relembra for ${process.platform}-${process.arch}, sha256 ${digest}`);
  return 0;
}

if (import.meta.main) process.exit(main());
