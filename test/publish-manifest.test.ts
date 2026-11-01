/**
 * The manifest npm publishes: public, the version the library reports, the repository npm's
 * provenance and trusted publishing match against, and a prerelease never tagged `latest`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishProblems } from "../scripts/publish-manifest.ts";
import { RELEMBRA_VERSION } from "../src/version.js";

const good = {
  name: "relembra",
  version: "1.0.0-beta.1",
  repository: { type: "git", url: "git+https://github.com/mneves75/relembra.git" },
  publishConfig: { access: "public", tag: "beta" },
};

describe("publish manifest", () => {
  test("the repository's own package.json passes, at the version the library reports", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(manifest.version).toBe(RELEMBRA_VERSION);
    expect(publishProblems(manifest, RELEMBRA_VERSION)).toEqual([]);
  });

  test("a correct prerelease manifest passes (positive control)", () => {
    expect(publishProblems(good, "1.0.0-beta.1")).toEqual([]);
  });

  test("refuses a private package", () => {
    expect(publishProblems({ ...good, private: true }, "1.0.0-beta.1")).toEqual([
      "package.json is private",
    ]);
  });

  test("refuses a version the library does not report", () => {
    expect(publishProblems(good, "0.4.0")).toEqual([
      "package.json version 1.0.0-beta.1 differs from RELEMBRA_VERSION 0.4.0",
    ]);
  });

  test("refuses another repository, which provenance would not match", () => {
    const other = { ...good, repository: { type: "git", url: "https://github.com/x/relembra" } };
    expect(publishProblems(other, "1.0.0-beta.1")).toEqual([
      "repository.url is not git+https://github.com/mneves75/relembra.git",
    ]);
  });

  test("refuses a prerelease that would become latest, or a non-public publish", () => {
    expect(
      publishProblems({ ...good, publishConfig: { access: "public" } }, "1.0.0-beta.1"),
    ).toEqual(["a prerelease must publish under a dist-tag other than latest"]);
    expect(
      publishProblems(
        { ...good, publishConfig: { access: "restricted", tag: "latest" } },
        "1.0.0-beta.1",
      ),
    ).toEqual([
      "publishConfig.access is not public",
      "a prerelease must publish under a dist-tag other than latest",
    ]);
  });

  test("refuses a top-level tag, which npm prefers over publishConfig.tag and --tag", () => {
    expect(publishProblems({ ...good, tag: "latest" }, "1.0.0-beta.1")).toEqual([
      "package.json has a top-level tag, which overrides publishConfig.tag",
    ]);
  });

  test("a stable version may publish as latest", () => {
    const stable = { ...good, version: "1.0.0", publishConfig: { access: "public" } };
    expect(publishProblems(stable, "1.0.0")).toEqual([]);
  });
});
