/**
 * Picks the archive a published GitHub release stages on npm, and refuses one the release does
 * not vouch for: the asset SHA256SUMS names, with those bytes, whose manifest passes the publish
 * checks at the tag's version. .github/workflows/release.yml runs it (docs/RELEASE.md):
 *
 *   node scripts/stage-release.ts <tag> <directory holding the release's assets>
 *
 * On success it prints `tarball=<path>` and `dist-tag=<tag>` for $GITHUB_OUTPUT.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, publishProblems } from "./publish-manifest.ts";

export interface StageInput {
  readonly tag: string;
  readonly sums: string;
  /** The sha256 of the archive's bytes, or undefined when the release has no such asset. */
  readonly archiveSha256: string | undefined;
  readonly manifest: Manifest & { readonly name?: unknown };
}

export type StagePlan =
  | { readonly archive: string; readonly distTag: string }
  | { readonly problems: string[] };

export function archiveName(tag: string): string | undefined {
  const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag)?.[1];
  return version === undefined ? undefined : `relembra-${version}.tgz`;
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
  const plan = stagePlan({
    tag,
    sums: readFileSync(join(dir, "SHA256SUMS"), "utf8"),
    archiveSha256: present
      ? createHash("sha256").update(readFileSync(path)).digest("hex")
      : undefined,
    manifest: present
      ? JSON.parse(
          execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" }),
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
