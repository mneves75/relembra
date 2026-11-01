/**
 * The release workflow stages on npm only the archive a published GitHub release vouches for:
 * the asset SHA256SUMS names, with those bytes, whose manifest passes the publish checks at the
 * tag's version, under the dist-tag the manifest declares.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagePlan } from "../scripts/stage-release.ts";

const SHA = "a".repeat(64);
const manifest = {
  name: "relembra",
  version: "1.0.0-beta.2",
  repository: { type: "git", url: "git+https://github.com/mneves75/relembra.git" },
  publishConfig: { access: "public", tag: "beta" },
};
const sums = `${"b".repeat(64)}  relembra-darwin-arm64\n${SHA}  relembra-1.0.0-beta.2.tgz\n`;
const good = { tag: "v1.0.0-beta.2", sums, archiveSha256: SHA, manifest };

describe("stage plan", () => {
  test("a prerelease the release vouches for stages under its declared tag (positive control)", () => {
    expect(stagePlan(good)).toEqual({ archive: "relembra-1.0.0-beta.2.tgz", distTag: "beta" });
  });

  test("a stable release without a declared tag stages as latest", () => {
    const stable = { ...manifest, version: "1.0.0", publishConfig: { access: "public" } };
    const plan = stagePlan({
      tag: "v1.0.0",
      sums: `${SHA}  relembra-1.0.0.tgz\n`,
      archiveSha256: SHA,
      manifest: stable,
    });
    expect(plan).toEqual({ archive: "relembra-1.0.0.tgz", distTag: "latest" });
  });

  test("refuses a tag that is not v<semver>", () => {
    expect(stagePlan({ ...good, tag: "1.0.0-beta.2" })).toEqual({
      problems: ["tag 1.0.0-beta.2 is not v<version>"],
    });
  });

  test("refuses an archive SHA256SUMS does not name", () => {
    expect(stagePlan({ ...good, sums: `${"b".repeat(64)}  relembra-darwin-arm64\n` })).toEqual({
      problems: ["SHA256SUMS has no entry for relembra-1.0.0-beta.2.tgz"],
    });
  });

  test("refuses an archive the release does not carry", () => {
    expect(stagePlan({ ...good, archiveSha256: undefined })).toEqual({
      problems: ["the release has no asset relembra-1.0.0-beta.2.tgz"],
    });
  });

  test("refuses bytes other than the ones SHA256SUMS names", () => {
    expect(stagePlan({ ...good, archiveSha256: "c".repeat(64) })).toEqual({
      problems: [`relembra-1.0.0-beta.2.tgz has sha256 ${"c".repeat(64)}, SHA256SUMS says ${SHA}`],
    });
  });

  test("refuses an archive whose manifest is another package or another version", () => {
    expect(stagePlan({ ...good, manifest: { ...manifest, name: "other" } })).toEqual({
      problems: ["the archive's package is other, not relembra"],
    });
    expect(stagePlan({ ...good, manifest: { ...manifest, version: "1.0.0-beta.1" } })).toEqual({
      problems: ["package.json version 1.0.0-beta.1 differs from RELEMBRA_VERSION 1.0.0-beta.2"],
    });
  });

  test("refuses a manifest the publish checks refuse", () => {
    const latest = { ...manifest, publishConfig: { access: "public", tag: "latest" } };
    expect(stagePlan({ ...good, manifest: latest })).toEqual({
      problems: ["a prerelease must publish under a dist-tag other than latest"],
    });
  });
});

describe("stage-release command", () => {
  const script = join(import.meta.dir, "..", "scripts", "stage-release.ts");

  function release(tamper: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "relembra-stage-"));
    const src = join(dir, "src", "package");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify(manifest));
    const assets = join(dir, "assets");
    mkdirSync(assets);
    const archive = join(assets, "relembra-1.0.0-beta.2.tgz");
    const tar = spawnSync("tar", ["-czf", archive, "-C", join(dir, "src"), "package"]);
    expect(tar.status).toBe(0);
    const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(
      join(assets, "SHA256SUMS"),
      `${tamper ? "d".repeat(64) : hash}  relembra-1.0.0-beta.2.tgz\n`,
    );
    return dir;
  }

  test("prints the archive and dist-tag for a release that vouches for it", () => {
    const dir = release(false);
    try {
      const run = spawnSync(process.execPath, [script, "v1.0.0-beta.2", join(dir, "assets")], {
        encoding: "utf8",
      });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(
        `tarball=${join(dir, "assets", "relembra-1.0.0-beta.2.tgz")}\ndist-tag=beta\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits non-zero and prints no plan when the bytes differ from SHA256SUMS", () => {
    const dir = release(true);
    try {
      const run = spawnSync(process.execPath, [script, "v1.0.0-beta.2", join(dir, "assets")], {
        encoding: "utf8",
      });
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("SHA256SUMS says");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
