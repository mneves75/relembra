/**
 * Installs a relembra tarball into a fresh directory outside the repository and runs
 * scripts/pack-smoke-consumer.js there with the runtime running this script:
 * `node scripts/pack-smoke.ts` tests Node, `bun scripts/pack-smoke.ts` tests Bun.
 *
 *   node scripts/pack-smoke.ts                    # builds and packs the checkout first
 *   node scripts/pack-smoke.ts --tarball FILE     # tests FILE as it is: nothing is built or packed
 *
 * With --tarball, the archive's sha256 is printed and must be the same after the run, so the
 * gate (scripts/ci.sh) can test one retained archive with both runtimes. Exits non-zero when any
 * step fails.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
// Under `npm run`, the parent npm exports its config as npm_config_* variables, which a nested npm
// reads as command-line flags; npm 11 then refuses some (allow-scripts) in a project install.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const at = process.argv.indexOf("--tarball");
const given = at < 0 ? undefined : process.argv[at + 1];
if (at >= 0 && (given === undefined || !statSync(given, { throwIfNoEntry: false })?.isFile())) {
  console.error(`--tarball needs an existing file: ${given ?? "(none given)"}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "relembra-pack-"));
try {
  let tarball: string;
  if (given === undefined) {
    execFileSync("npm", ["run", "build"], { cwd: repo, env, stdio: "inherit" });
    // --ignore-scripts: the build ran above, and prepack output would corrupt the JSON on stdout.
    const out = execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", work],
      { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    tarball = join(work, packResult(out).filename);
  } else {
    tarball = resolve(given);
  }
  const before = sha256(tarball);

  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "relembra-consumer", private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", tarball],
    { cwd: consumer, env, stdio: "inherit" },
  );
  copyFileSync(join(repo, "scripts", "pack-smoke-consumer.js"), join(consumer, "smoke.js"));
  execFileSync(process.execPath, ["smoke.js"], { cwd: consumer, stdio: "inherit" });
  if (given !== undefined) {
    const after = sha256(tarball);
    if (after !== before) {
      console.error(`${tarball} changed during the smoke test: ${before}, now ${after}`);
      process.exitCode = 1;
    } else {
      console.log(`tested ${tarball}, sha256 ${before}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** npm 11 prints an array of pack results; npm 12 prints an object keyed by package name. */
function packResult(json: string): { readonly filename: string } {
  const parsed: unknown = JSON.parse(json);
  const [result] = Array.isArray(parsed) ? parsed : Object.values(parsed as object);
  return result;
}
