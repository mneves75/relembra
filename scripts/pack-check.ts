/**
 * Builds relembra, then fails when `npm pack --dry-run` would ship anything but the built library
 * and its docs: no tests, eval, scratch, database, env or fixture files, nothing outside the
 * allowlist, and every target the package exports present. It also fails when the manifest is not
 * publishable as this release (scripts/publish-manifest.ts). Run with `node scripts/pack-check.ts`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEMBRA_VERSION } from "../src/version.ts";
import { publishProblems } from "./publish-manifest.ts";

const FORBIDDEN = [
  /(^|\/)test\//,
  /(^|\/)eval\//,
  /(^|\/)\.scratch(\/|$)/,
  /\.db(-wal|-shm)?$/,
  /(^|\/)\.env/,
  /fixture/i,
  // The CLI ships as a native binary and no export points at it: its compiled sources stay out.
  /^dist\/cli\//,
];
const REQUIRED_EXPORTS = [".", "./pi-durable", "./postgres", "./sqlite", "./testing"];
const ALLOWED = [/^dist\//, /^package\.json$/, /^README\.md$/, /^LICENSE$/, /^docs\/FORMAT\.md$/];

const repo = fileURLToPath(new URL("..", import.meta.url));
execFileSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit" });
// --ignore-scripts: the build ran above, and prepack output would corrupt the JSON on stdout.
const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: repo,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const files = packResult(out).files.map((file) => file.path);

const problems = [
  ...files
    .filter((path) => FORBIDDEN.some((pattern) => pattern.test(path)))
    .map((path) => `forbidden: ${path}`),
  ...files
    .filter((path) => !ALLOWED.some((pattern) => pattern.test(path)))
    .map((path) => `not in the allowlist: ${path}`),
  ...exportProblems(files),
  ...publishProblems(
    JSON.parse(readFileSync(join(repo, "package.json"), "utf8")),
    RELEMBRA_VERSION,
  ),
];

if (problems.length > 0) {
  console.error(`npm pack would ship a bad tarball:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`pack check passed: ${files.length} files, every export present`);

/**
 * Each required subpath must be exported with `types` and `import` targets, and every target the
 * package exports must be in the tarball, so an empty `exports` or `files` cannot pass.
 */
function exportProblems(packed: readonly string[]): string[] {
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const exports: Record<string, unknown> = manifest.exports ?? {};
  const problems: string[] = [];
  for (const subpath of REQUIRED_EXPORTS) {
    const entry = exports[subpath] as Record<string, unknown> | undefined;
    for (const condition of ["types", "import"]) {
      if (typeof entry?.[condition] !== "string") {
        problems.push(`missing export: ${subpath} ${condition}`);
      }
    }
  }
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const path = value.replace(/^\.\//, "");
      if (!packed.includes(path)) problems.push(`exported but not packed: ${path}`);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(exports);
  return problems;
}

/** npm 11 prints an array of pack results; npm 12 prints an object keyed by package name. */
function packResult(json: string): { readonly files: readonly { readonly path: string }[] } {
  const parsed: unknown = JSON.parse(json);
  const [result] = Array.isArray(parsed) ? parsed : Object.values(parsed as object);
  return result;
}
