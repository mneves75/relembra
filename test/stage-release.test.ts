/**
 * The release workflow stages on npm only the archive a published GitHub release vouches for:
 * the asset SHA256SUMS names, with those bytes, whose manifest passes the publish checks at the
 * tag's version, under the dist-tag the manifest declares.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { stagePlan } from "../scripts/stage-release.ts";

const SHA = "a".repeat(64);
const manifest = {
  name: "relembra",
  version: "1.0.0-beta.2",
  repository: { type: "git", url: "git+https://github.com/mneves75/relembra.git" },
  publishConfig: { access: "public", tag: "beta" },
};
const sums = `${"b".repeat(64)}  relembra-darwin-arm64\n${SHA}  relembra-1.0.0-beta.2.tgz\n`;
const entries = ["package/package.json", "package/dist/index.js"];
const good = { tag: "v1.0.0-beta.2", sums, archiveSha256: SHA, entries, manifest };

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
      entries,
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

  test("refuses an archive npm would unpack differently from what was checked", () => {
    const refused = (extra: string[], why: string) =>
      expect(stagePlan({ ...good, entries: [...entries, ...extra] })).toEqual({
        problems: [`relembra-1.0.0-beta.2.tgz ${why}`],
      });
    const odd = "has an entry outside package/ or not canonical:";
    refused(["other/package.json"], `${odd} other/package.json`);
    refused(["package/./package.json"], `${odd} package/./package.json`);
    refused(["package//package.json"], `${odd} package//package.json`);
    refused(["package/dist/../package.json"], `${odd} package/dist/../package.json`);
    refused(["package\\package.json"], `${odd} package\\package.json`);
    refused(["package/package.json"], "has two entries for package/package.json");
    expect(stagePlan({ ...good, entries: ["package/dist/index.js"] })).toEqual({
      problems: ["relembra-1.0.0-beta.2.tgz has no package/package.json"],
    });
    // Directory entries, as tar lists them, are part of npm pack's layout.
    expect(stagePlan({ ...good, entries: ["package/", "package/dist/", ...entries] })).toEqual({
      archive: "relembra-1.0.0-beta.2.tgz",
      distTag: "beta",
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

/** A gzipped ustar archive with these exact entry names, which tar itself would normalize. */
function tgz(files: ReadonlyArray<readonly [string, string]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of files) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    const field = (offset: number, value: string) => header.write(value, offset, "ascii");
    field(0, name);
    field(100, "0000644\0");
    field(108, "0000000\0");
    field(116, "0000000\0");
    field(124, `${body.length.toString(8).padStart(11, "0")}\0`);
    field(136, "00000000000\0");
    field(148, "        ");
    field(156, "0");
    field(257, "ustar\0");
    field(263, "00");
    const sum = header.reduce((total, byte) => total + byte, 0);
    field(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("stage-release command", () => {
  const script = join(import.meta.dir, "..", "scripts", "stage-release.ts");
  const real = JSON.stringify(manifest);
  const other = JSON.stringify({ ...manifest, version: "9.9.9" });

  function run(files: ReadonlyArray<readonly [string, string]>, tamper = false) {
    const dir = mkdtempSync(join(tmpdir(), "relembra-stage-"));
    try {
      const archive = tgz(files);
      const hash = tamper ? "d".repeat(64) : createHash("sha256").update(archive).digest("hex");
      writeFileSync(join(dir, "relembra-1.0.0-beta.2.tgz"), archive);
      writeFileSync(join(dir, "SHA256SUMS"), `${hash}  relembra-1.0.0-beta.2.tgz\n`);
      const result = spawnSync(process.execPath, [script, "v1.0.0-beta.2", dir], {
        encoding: "utf8",
      });
      return { ...result, archive: join(dir, "relembra-1.0.0-beta.2.tgz") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("prints the archive and dist-tag for a release that vouches for it", () => {
    const result = run([["package/package.json", real]]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`tarball=${result.archive}\ndist-tag=beta\n`);
  });

  test("exits non-zero and prints no plan when the bytes differ from SHA256SUMS", () => {
    const result = run([["package/package.json", real]], true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SHA256SUMS says");
  });

  test("refuses a second manifest npm would unpack over the checked one", () => {
    for (const alias of ["other/package.json", "package/./package.json"]) {
      const result = run([
        ["package/package.json", real],
        [alias, other],
      ]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`not canonical: ${alias}`);
    }
  });
});
