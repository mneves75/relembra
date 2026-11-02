/**
 * Picks the archive a published GitHub release stages on npm, and refuses one the release does
 * not vouch for: the asset SHA256SUMS names, with those bytes, whose manifest passes the publish
 * checks at the tag's version. .github/workflows/release.yml runs it (docs/RELEASE.md):
 *
 *   node scripts/stage-release.ts <tag> <directory holding the release's assets>
 *
 * On success it prints `tarball=<path>` and `dist-tag=<tag>` for $GITHUB_OUTPUT.
 *
 * It binds the staged bytes to the release exactly (sha256) and catches release mistakes: a wrong
 * version, a private package, a prerelease bound for `latest`. It is not the defence against a
 * crafted archive: whoever can publish a release writes both the archive and SHA256SUMS, so the
 * defence is the owner's approval after `npm stage view`, which shows what npm itself read.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Manifest, publishProblems } from "./publish-manifest.ts";

export interface StageInput {
  readonly tag: string;
  readonly sums: string;
  /** The sha256 of the archive's bytes, or undefined when the release has no such asset. */
  readonly archiveSha256: string | undefined;
  /** The archive's entry paths, as `tar -tzf` lists them. */
  readonly entries: readonly string[];
  readonly manifest: Manifest & { readonly name?: unknown };
}

export type StagePlan =
  | { readonly archive: string; readonly distTag: string }
  | { readonly problems: string[] };

export function archiveName(tag: string): string | undefined {
  const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag)?.[1];
  return version === undefined ? undefined : `relembra-${version}.tgz`;
}

/** Why the entries are not npm pack's layout, or undefined when they are. */
export function layoutProblem(entries: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split("/");
    if (parts.length > 1 && parts.at(-1) === "") parts.pop(); // a directory entry
    const canonical =
      parts[0] === "package" &&
      parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\"));
    if (!canonical) return `has an entry outside package/ or not canonical: ${entry}`;
    const path = parts.join("/");
    if (seen.has(path)) return `has two entries for ${path}`;
    seen.add(path);
  }
  return seen.has("package/package.json") ? undefined : "has no package/package.json";
}

export function stagePlan(input: StageInput): StagePlan {
  const archive = archiveName(input.tag);
  if (archive === undefined) return { problems: [`tag ${input.tag} is not v<version>`] };
  const version = input.tag.slice(1);
  const listed = input.sums
    .split("\n")
    .map((line) => /^([0-9a-f]{64}) {2}(\S+)$/.exec(line))
    .filter((match) => match?.[2] === archive);
  if (listed.length !== 1) return { problems: [`SHA256SUMS has no entry for ${archive}`] };
  const expected = listed[0]?.[1];
  if (input.archiveSha256 === undefined) {
    return { problems: [`the release has no asset ${archive}`] };
  }
  if (input.archiveSha256 !== expected) {
    return {
      problems: [`${archive} has sha256 ${input.archiveSha256}, SHA256SUMS says ${expected}`],
    };
  }
  // npm unpacks with the first path component stripped and each path normalized, so
  // `other/package.json` or `package/./package.json` would overwrite the manifest checked here.
  // Accept only npm pack's layout: canonical paths under package/, each written once.
  const layout = layoutProblem(input.entries);
  if (layout !== undefined) return { problems: [`${archive} ${layout}`] };
  if (input.manifest.name !== "relembra") {
    return { problems: [`the archive's package is ${String(input.manifest.name)}, not relembra`] };
  }
  const problems = publishProblems(input.manifest, version);
  if (problems.length > 0) return { problems };
  const tag = input.manifest.publishConfig?.tag;
  return { archive, distTag: typeof tag === "string" ? tag : "latest" };
}

function main(tag: string | undefined, dir: string | undefined): number {
  if (tag === undefined || dir === undefined) {
    process.stderr.write("usage: node scripts/stage-release.ts <tag> <assets directory>\n");
    return 2;
  }
  const archive = archiveName(tag);
  const path = archive === undefined ? undefined : join(dir, archive);
  const present = path !== undefined && existsSync(path);
  // tar reads the archive by its bare name in its folder: GNU tar takes "C:\..." for host:path.
  const entries = present
    ? execFileSync("tar", ["-tzf", basename(path)], { cwd: dir, encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
    : [];
  // Only a canonical layout has exactly one member that tar can extract as the manifest.
  const readable = present && layoutProblem(entries) === undefined;
  const plan = stagePlan({
    tag,
    sums: readFileSync(join(dir, "SHA256SUMS"), "utf8"),
    entries,
    archiveSha256: present
      ? createHash("sha256").update(readFileSync(path)).digest("hex")
      : undefined,
    manifest: readable
      ? JSON.parse(
          execFileSync("tar", ["-xzOf", basename(path), "package/package.json"], {
            cwd: dir,
            encoding: "utf8",
          }),
        )
      : {},
  });
  if ("problems" in plan) {
    for (const problem of plan.problems) process.stderr.write(`stage-release: ${problem}\n`);
    return 1;
  }
  process.stdout.write(`tarball=${join(dir, plan.archive)}\ndist-tag=${plan.distTag}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv[2], process.argv[3]);
