/**
 * scripts/deploy.sh is docs/RELEASE.md's "Publication" section as a program. `hmo` (homologação)
 * does every step that writes nothing outside the checkout: it binds HEAD to the local release
 * check, the hosted CI run and the security gate record, downloads and checks the hosted binaries,
 * and lays out the release assets with SHA256SUMS and notes. `prd` publishes that plan: tag,
 * draft release, publication, the npm stage and Pages runs, and a check of what was published.
 *
 * The fixture (test/deploy-support.ts) stands in for GitHub with a `gh` shim and a bare origin.
 * test/deploy-contract.test.ts holds the review's cases: what must be refused and how a failed
 * step is reported.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupFixtures,
  deploy,
  editRecord,
  type Fixture,
  fixture,
  ghCalls,
  git,
  hmo,
  pathEnv,
  planDir,
  prd,
  RUN,
  RUN_FIELDS,
  recordPath,
  runView,
  sha1,
  sha256,
  sri,
  TAG,
  VERSION,
} from "./deploy-support.js";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

afterEach(cleanupFixtures);
// Each test spawns the script, which spawns git, node and bun many times; on a loaded runner
// (two cores, parallel workers) a run takes well over Bun's 5 s default.
setDefaultTimeout(60_000);

describe.skipIf(NO_RELEASE_TOOLING)("scripts/deploy.sh hmo", () => {
  test("lays out the seven assets, SHA256SUMS and notes bound to the gate (positive control)", () => {
    const f = fixture();
    const run = hmo(f);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const dir = planDir(f);
    expect(run.stdout).toContain(`hmo ready: ${dir}`);
    expect(readdirSync(dir).sort()).toEqual([
      "SHA256SUMS",
      "dl",
      "notes.md",
      "plan.json",
      `relembra-${VERSION}.tgz`,
      "relembra-darwin-arm64",
      "relembra-linux-arm64",
      "relembra-linux-x64",
      "relembra-windows-arm64.exe",
      "relembra-windows-x64.exe",
    ]);
    // The macOS asset is the locally gated binary, the other four the hosted builds, by bytes.
    expect(readFileSync(join(dir, "relembra-darwin-arm64")).equals(f.binary)).toBe(true);
    expect(readFileSync(join(dir, "relembra-linux-arm64"), "utf8")).toContain("linux-aarch64");
    expect(readFileSync(join(dir, "relembra-windows-x64.exe"), "utf8")).toContain("windows-x64");
    expect(readFileSync(join(dir, `relembra-${VERSION}.tgz`)).equals(f.archive)).toBe(true);
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    const names = sums
      .trimEnd()
      .split("\n")
      .map((line) => {
        const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
        if (match === null) throw new Error(`malformed SHA256SUMS line: ${line}`);
        expect(sha256(readFileSync(join(dir, match[2] as string)))).toBe(match[1] as string);
        return match[2] as string;
      });
    expect(names).toEqual([
      "relembra-darwin-arm64",
      "relembra-linux-x64",
      "relembra-linux-arm64",
      "relembra-windows-x64.exe",
      "relembra-windows-arm64.exe",
      `relembra-${VERSION}.tgz`,
    ]);
    const notes = readFileSync(join(dir, "notes.md"), "utf8");
    expect(notes).toContain("Stores are created private from birth.");
    expect(notes).toContain("- Windows: the descriptor is set at creation.");
    expect(notes).not.toContain("## Unreleased");
    expect(notes).not.toContain("First.");
    expect(notes).toContain("Security gate: WAIVED (SEC-20, W-NV1)");
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    expect(plan).toMatchObject({
      version: VERSION,
      tag: TAG,
      commit: f.commit,
      run: RUN,
      prerelease: true,
      verdict: "waived",
      waivers: ["SEC-20", "W-NV1"],
      binarySha256: sha256(f.binary),
      archiveSha256: sha256(f.archive),
      sumsSha256: sha256(sums),
      tagMessage: `${TAG}; security gate: WAIVED SEC-20 W-NV1`,
    });
    // Every asset's bytes are bound in the plan, not only in SHA256SUMS.
    expect(Object.keys(plan.assets).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(plan.assets[name as string]).toBe(sha256(readFileSync(join(dir, name as string))));
    }
    expect(ghCalls(f)).toEqual([
      `run view ${RUN} --json ${RUN_FIELDS}`,
      `run download ${RUN} --dir ${join(dir, "dl")} --pattern relembra-cli-*`,
    ]);
    // The checkout and the remote are untouched: hmo writes nothing outside .scratch/deploy.
    expect(git(f.repo, "status", "--short")).toBe("");
    expect(git(f.repo, "ls-remote", "--tags", "origin")).toBe("");
  });

  test("accepts a release commit whose inputs equal the gated candidate's (a squash)", () => {
    const f = fixture();
    git(f.repo, "commit", "-q", "--allow-empty", "-m", "chore(release): squash");
    git(f.repo, "push", "-q", "origin", "main");
    const commit = git(f.repo, "rev-parse", "HEAD");
    writeFileSync(join(f.fixtures, `run-view-${RUN}.json`), runView(commit));
    const record = join(f.repo, ".scratch", "security-gate", commit);
    mkdirSync(record);
    const previous = JSON.parse(readFileSync(recordPath(f), "utf8"));
    writeFileSync(join(record, "production.json"), JSON.stringify({ ...previous, commit }));
    const run = hmo(f);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(planDir(f), "plan.json"), "utf8")).commit).toBe(commit);
  });

  test("usage", () => {
    const f = fixture();
    expect(deploy(f, []).status).toBe(2);
    expect(deploy(f, ["hmo"]).status).toBe(2);
    expect(deploy(f, ["hmo", "--run", RUN]).status).toBe(2);
    expect(deploy(f, ["staging"]).status).toBe(2);
  });

  /** A committed change to one tracked file, pushed, with the hosted run moved to the new HEAD. */
  function commitChange(f: Fixture, path: string, content: string, message: string): void {
    writeFileSync(join(f.repo, path), content);
    git(f.repo, "commit", "-q", "-am", message);
    git(f.repo, "push", "-q", "origin", "main");
    writeFileSync(
      join(f.fixtures, `run-view-${RUN}.json`),
      runView(git(f.repo, "rev-parse", "HEAD")),
    );
  }

  const refusals: [string, (f: Fixture) => void, string][] = [
    [
      "a tag of that name on the remote",
      (f) => {
        git(f.repo, "tag", TAG);
        git(f.repo, "push", "-q", "origin", TAG);
        git(f.repo, "tag", "-d", TAG);
      },
      `tag ${TAG} already exists on origin`,
    ],
    [
      "a dirty working tree",
      (f) =>
        writeFileSync(join(f.repo, "src", "version.ts"), "export const RELEMBRA_VERSION = 'x';\n"),
      "the working tree has changes",
    ],
    [
      "HEAD ahead of origin/main",
      (f) => git(f.repo, "commit", "-q", "--allow-empty", "-m", "not pushed"),
      "HEAD is not origin/main",
    ],
    [
      "a CI run on another commit",
      (f) => writeFileSync(join(f.fixtures, `run-view-${RUN}.json`), runView("0".repeat(40))),
      `run ${RUN} is for 0000000, not HEAD`,
    ],
    [
      "a CI run with a failed job",
      (f) =>
        writeFileSync(
          join(f.fixtures, `run-view-${RUN}.json`),
          runView(f.commit, {
            conclusion: "failure",
            jobs: [{ name: "bun (windows-latest)", conclusion: "failure" }],
          }),
        ),
      `run ${RUN}: job bun (windows-latest) is failure`,
    ],
    [
      "a CI run still in progress",
      (f) =>
        writeFileSync(
          join(f.fixtures, `run-view-${RUN}.json`),
          runView(f.commit, {
            status: "in_progress",
            conclusion: "",
            jobs: [{ name: "bun (windows-latest)", conclusion: null }],
          }),
        ),
      `run ${RUN} is in_progress`,
    ],
    [
      "a run that is not the ci push to main",
      (f) =>
        writeFileSync(
          join(f.fixtures, `run-view-${RUN}.json`),
          runView(f.commit, { event: "pull_request", headBranch: "feature" }),
        ),
      `run ${RUN} is a pull_request of ci on feature, not the ci push to main`,
    ],
    [
      "a hosted binary whose checksum file disagrees",
      (f) =>
        writeFileSync(
          join(f.fixtures, "artifacts", "relembra-cli-linux-x64", "relembra.sha256"),
          `${"a".repeat(64)}  relembra\n`,
        ),
      "relembra-cli-linux-x64",
    ],
    [
      "no security gate record for HEAD's tree",
      (f) => rmSync(join(f.repo, ".scratch", "security-gate"), { recursive: true }),
      "no security gate record for tree",
    ],
    [
      "a gate record for another tree",
      (f) =>
        editRecord(f, (r) => {
          r.tree = "1".repeat(40);
        }),
      "no security gate record for tree",
    ],
    [
      "a blocked gate verdict",
      (f) =>
        editRecord(f, (r) => {
          r.verdict = "blocked";
        }),
      "security gate verdict is blocked",
    ],
    [
      "a gate without independent acceptance",
      (f) =>
        editRecord(f, (r) => {
          r.independent_acceptance = "blocked";
        }),
      "independent acceptance is blocked",
    ],
    [
      "an expired waiver",
      (f) =>
        editRecord(f, (r) => {
          const [first] = r.waivers ?? [];
          if (first) first.expires = "2026-01-01T00:00:00Z";
        }),
      "waiver SEC-20 expired 2026-01-01T00:00:00Z",
    ],
    [
      "a binary that is not the gated one",
      (f) => writeFileSync(join(f.repo, "bin", "relembra"), "rebuilt since the gate\n"),
      "bin/relembra is not the binary the release check tested",
    ],
    [
      "a release check that did not finish",
      (f) => rmSync(join(f.attempt, "release-check.json")),
      "release check did not finish",
    ],
    [
      "a gate manifest changed after the release check",
      (f) => {
        const path = join(f.attempt, "gate", "manifest.json");
        writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
      },
      "gate/manifest.json changed after the release check",
    ],
    [
      "a release check on other inputs",
      (f) =>
        commitChange(
          f,
          "src/version.ts",
          `export const RELEMBRA_VERSION = "${VERSION}"; // changed\n`,
          "change after the gate",
        ),
      "inputs changed since the release check",
    ],
    [
      "a version the library does not report",
      (f) =>
        commitChange(
          f,
          "src/version.ts",
          'export const RELEMBRA_VERSION = "9.9.9";\n',
          "bump one of two",
        ),
      `src/version.ts says 9.9.9, package.json ${VERSION}`,
    ],
    [
      "a CHANGELOG without the version's section",
      (f) => commitChange(f, "CHANGELOG.md", "# Changelog\n\n## Unreleased\n", "drop the section"),
      `CHANGELOG.md has no "## [${VERSION}]" section`,
    ],
  ];
  for (const [name, arrange, message] of refusals) {
    test(`refuses ${name}, writing no plan`, () => {
      const f = fixture();
      arrange(f);
      const remoteBefore = git(f.repo, "ls-remote", "origin");
      const run = hmo(f);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(message);
      expect(existsSync(join(planDir(f), "plan.json"))).toBe(false);
      expect(git(f.repo, "ls-remote", "origin")).toBe(remoteBefore);
    });
  }

  // The CI run is read into a temporary file; a refusal there must not leave it behind. A mktemp
  // shim puts every temporary file in one fresh directory and logs it (a bare mktemp on macOS
  // ignores TMPDIR).
  for (const shell of ["bash", "/bin/bash"]) {
    test.skipIf(shell !== "bash" && !existsSync(shell))(
      `a refusal while reading the CI run leaves no temporary file (${shell})`,
      () => {
        const realMktemp = spawnSync("sh", ["-c", "command -v mktemp"], { encoding: "utf8" });
        const f = fixture();
        writeFileSync(join(f.fixtures, `run-view-${RUN}.json`), runView("0".repeat(40)));
        const top = join(f.fixtures, "..");
        const tmp = join(top, "tmp");
        const shim = join(top, "mktemp-shim");
        const made = join(top, "mktemp.log");
        mkdirSync(tmp);
        mkdirSync(shim);
        writeFileSync(
          join(shim, "mktemp"),
          `#!/bin/sh\nf=$('${realMktemp.stdout.trim()}' '${tmp}/tmp.XXXXXX') || exit 1\necho "$f" >>'${made}'\necho "$f"\n`,
        );
        chmodSync(join(shim, "mktemp"), 0o755);
        const run = hmo(f, pathEnv(f, [shim], []), shell);
        expect(run.stderr).toContain(`run ${RUN} is for 0000000, not HEAD`);
        expect(run.status).toBe(1);
        // Positive control: the script made its temporary files through the shim.
        expect(readFileSync(made, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
        expect(readdirSync(tmp)).toEqual([]);
      },
    );
  }

  test("refuses a plan directory that already exists", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    const again = hmo(f);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(`${planDir(f)} already exists`);
  });
});

describe.skipIf(NO_RELEASE_TOOLING)("scripts/deploy.sh prd", () => {
  test("tags, publishes, follows the npm stage and Pages, and checks what was published", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    writeFileSync(f.log, "");
    const run = prd(f);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const dir = planDir(f);
    // The annotated tag names the gate verdict, and it is on the remote.
    expect(git(f.repo, "rev-parse", `${TAG}^{commit}`)).toBe(f.commit);
    expect(git(f.repo, "tag", "-l", "--format=%(contents:subject)", TAG)).toBe(
      `${TAG}; security gate: WAIVED SEC-20 W-NV1`,
    );
    expect(git(f.repo, "ls-remote", "--tags", "origin")).toContain(`refs/tags/${TAG}`);
    const calls = ghCalls(f);
    expect(calls[0]).toBe(
      `release create ${TAG} --verify-tag --draft --prerelease --title ${TAG} --notes-file ${join(dir, "notes.md")} ` +
        [
          "relembra-darwin-arm64",
          "relembra-linux-x64",
          "relembra-linux-arm64",
          "relembra-windows-x64.exe",
          "relembra-windows-arm64.exe",
          "SHA256SUMS",
          `relembra-${VERSION}.tgz`,
        ]
          .map((name) => join(dir, name))
          .join(" "),
    );
    // The draft's assets are downloaded and checked before anything becomes public.
    expect(calls[1]).toBe(`release download ${TAG} --dir ${join(dir, "draft")}`);
    expect(calls[2]).toBe(`release edit ${TAG} --draft=false`);
    expect(calls[3]).toBe(
      `release view ${TAG} --json tagName,isDraft,isPrerelease,publishedAt,url`,
    );
    expect(calls.slice(4)).toEqual([
      "run list --workflow release.yml --event release --json databaseId,headSha,event,createdAt,status,conclusion --limit 10",
      "run watch 900 --exit-status",
      "run view 900 --log",
      "workflow run pages.yml --ref main",
      "run list --workflow pages.yml --event workflow_dispatch --json databaseId,headSha,event,createdAt,status,conclusion --limit 10",
      "run watch 901 --exit-status",
      `release download ${TAG} --dir ${join(dir, "published")}`,
      `curl -fsS -o ${join(dir, "page.html")} -w %{http_code} https://example.test/relembra/`,
    ]);
    expect(readdirSync(join(dir, "published")).sort()).toEqual([
      "SHA256SUMS",
      `relembra-${VERSION}.tgz`,
      "relembra-darwin-arm64",
      "relembra-linux-arm64",
      "relembra-linux-x64",
      "relembra-windows-arm64.exe",
      "relembra-windows-x64.exe",
    ]);
    const published = JSON.parse(readFileSync(join(dir, "published.json"), "utf8"));
    expect(published).toMatchObject({
      tag: TAG,
      commit: f.commit,
      publishedAt: "2026-11-04T05:51:59Z",
      releaseUrl: `https://github.com/example/relembra/releases/tag/${TAG}`,
      releaseRun: "900",
      stageId: "d039c1e8-0000-4000-8000-000000000001",
      distTag: "beta",
      archiveSha1: sha1(f.archive),
      archiveIntegrity: sri(f.archive),
      pagesRun: "901",
      siteStatus: "200",
      siteVersionMentions: 2,
    });
    expect(run.stdout).toContain(`published: ${TAG}`);
    expect(run.stdout).toContain("npm stage approve d039c1e8-0000-4000-8000-000000000001");
  });

  test("a stable version is not a prerelease", () => {
    const f = fixture({ version: "1.2.3" });
    expect(hmo(f).status).toBe(0);
    writeFileSync(f.log, "");
    const run = prd(f);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(ghCalls(f)[0]).toStartWith("release create v1.2.3 --verify-tag --draft --title v1.2.3 ");
  });

  test("refuses to publish without a plan, and a plan for another HEAD", () => {
    const f = fixture();
    const none = prd(f);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("no plan");
    expect(hmo(f).status).toBe(0);
    git(f.repo, "commit", "-q", "--allow-empty", "-m", "moved on");
    const moved = prd(f);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain("plan is for");
    expect(git(f.repo, "ls-remote", "--tags", "origin")).toBe("");
  });

  test("refuses an asset changed since hmo, before tagging", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    writeFileSync(f.log, "");
    writeFileSync(join(planDir(f), "relembra-linux-x64"), "swapped\n");
    const run = prd(f);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("relembra-linux-x64");
    expect(git(f.repo, "tag", "-l", TAG)).toBe("");
    expect(ghCalls(f)).toEqual([]);
  });

  test("when the draft cannot be created, names the rollback and leaves nothing published", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    writeFileSync(join(f.fixtures, "fail-release-create"), "");
    const run = prd(f);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("HTTP 422");
    expect(run.stderr).toContain(`git push --delete origin ${TAG}`);
    expect(run.stderr).toContain(`git tag -d ${TAG}`);
    expect(existsSync(join(f.fixtures, "state-published"))).toBe(false);
    expect(existsSync(join(planDir(f), "published.json"))).toBe(false);
  });

  test("a staged archive that is not the release's is reported after publication", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    writeFileSync(
      join(f.fixtures, "log-900.txt"),
      [
        `stage on npm\tStage it on npm\tZ npm notice shasum: ${"0".repeat(40)}`,
        `stage on npm\tStage it on npm\tZ + relembra@${VERSION} (staged with id 11111111-0000-4000-8000-000000000001)`,
        `stage on npm\tStage it on npm\tZ npm notice stage package relembra@${VERSION} has been staged with tag beta`,
      ].join("\n"),
    );
    const run = prd(f);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `npm staged shasum ${"0".repeat(40)}, the archive's is ${sha1(f.archive)}`,
    );
    expect(run.stderr).toContain("npm stage reject 11111111-0000-4000-8000-000000000001");
    expect(existsSync(join(f.fixtures, "state-published"))).toBe(true);
  });

  test("gives up when no workflow run appears in time", { timeout: 20_000 }, () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    writeFileSync(join(f.fixtures, "run-list-release.yml.json"), "[]");
    const run = prd(f);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no release.yml run for");
  });
});
