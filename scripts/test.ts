/**
 * The whole test suite in two lanes at once. Files that reach Postgres run one after another in
 * one process: they share one server, and the VACUUM FULL, lock-timeout and migration-race tests
 * time out when other files load it at the same time. Every other file runs in parallel workers.
 * The parallel lane is plain `bun test --parallel` minus the Postgres files, so Bun's own
 * discovery decides what runs and no test file is left out. Arguments go to both lanes (for
 * example `--bail`). Exit 0 only when both lanes pass.
 *
 *   scripts/with-postgres.sh env RELEMBRA_REQUIRE_BINARY=1 bun run test:all
 */
import { readFileSync } from "node:fs";

/** A test file is in the Postgres lane when it mentions any of these. */
const POSTGRES = /postgres-support|postgres-fixture|RELEMBRA_POSTGRES_URL/;
/** Bun's default test file names. Hidden directories and node_modules are skipped, as Bun does. */
const TEST_FILES = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}");

const postgres = [...TEST_FILES.scanSync(".")]
  .filter((file) => !file.split("/").includes("node_modules"))
  .filter((file) => POSTGRES.test(readFileSync(file, "utf8")))
  .sort();
// On Windows each new store uses the system PowerShell to read and create private directories,
// so a test that makes several stores outlasts Bun's 5 s default on a
// loaded hosted runner. A test's own timeout still applies.
const extra = [
  ...(process.platform === "win32" ? ["--timeout=20000"] : []),
  ...process.argv.slice(2),
];

async function lane(name: string, args: string[]): Promise<number> {
  const began = performance.now();
  const child = Bun.spawn([process.execPath, "test", ...args, ...extra], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Each lane prints whole, so the two never interleave.
  process.stdout.write(out);
  process.stderr.write(err);
  const seconds = ((performance.now() - began) / 1000).toFixed(1);
  console.log(`lane ${name}: ${code === 0 ? "pass" : `FAIL (exit ${code})`} in ${seconds} s`);
  return code;
}

console.log(`${postgres.length} Postgres files in series, every other test file in parallel`);
const codes = await Promise.all([
  lane("parallel", ["--parallel", ...postgres.map((file) => `--path-ignore-patterns=${file}`)]),
  // `bun test` with no file argument would run every file: no Postgres file, no lane.
  postgres.length > 0
    ? lane(
        "postgres",
        postgres.map((file) => `./${file}`),
      )
    : Promise.resolve(0),
]);
process.exit(codes.every((code) => code === 0) ? 0 : 1);
