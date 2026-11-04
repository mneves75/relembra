/**
 * The review's cases for scripts/deploy.sh, written from docs/RELEASE.md and the release request:
 * what hmo must refuse, what prd must not publish, what a failed prd step must report, and
 * portability. The first round of these found that prd checked SHA256SUMS against itself, that a
 * refusal inside `$(...)` left only a subshell, and that waiver expiry was compared as text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Artifact,
  cleanupFixtures,
  editManifest,
  editRecord,
  type Fixture,
  fixture,
  fullRun,
  ghCalls,
  git,
  hmo,
  pathEnv,
  planDir,
  prd,
  RUN,
  regenerateSums,
  runView,
  sha256,
  TAG,
  tagged,
  VERSION,
} from "./deploy-support.js";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

afterEach(cleanupFixtures);

describe.skipIf(NO_RELEASE_TOOLING)("contract: hmo refuses a candidate it must not accept", () => {
  test("positive control: the unmodified fixture is accepted", () => {
    const f = fixture();
    const run = hmo(f);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  const refusals: [string, (f: Fixture) => void, string][] = [
    [
      "a manifest whose cli artifact is not verified",
      (f) =>
        editManifest(f, (m) => {
          (m.artifacts[0] as Artifact).verified = false;
        }),
      "no verified cli",
    ],
    [
      "a manifest whose package hash changed between before and after",
      (f) =>
        editManifest(f, (m) => {
          (m.artifacts[1] as Artifact).sha256After = "e".repeat(64);
        }),
      "no verified package",
    ],
    [
      "a gate record whose target is not production",
      (f) =>
        editRecord(f, (r) => {
          r.target = "staging";
        }),
      "no security gate record for tree",
    ],
    [
      "a waived gate record with no waivers array",
      (f) =>
        editRecord(f, (r) => {
          delete r.waivers;
        }),
      "waived with no waivers",
    ],
    [
      "a waiver with no expiry",
      (f) =>
        editRecord(f, (r) => {
          const [first] = r.waivers ?? [];
          if (first) delete first.expires;
        }),
      "waiver SEC-20 has no valid expiry",
    ],
    [
      // Compared as text, "3" > "2" would make a past day-first date read as the future.
      "a waiver whose expiry is a past date written day first",
      (f) =>
        editRecord(f, (r) => {
          const [first] = r.waivers ?? [];
          if (first) first.expires = "31/12/2025";
        }),
      "waiver SEC-20 has no valid expiry",
    ],
    [
      "a hosted run with zero jobs",
      (f) =>
        writeFileSync(join(f.fixtures, `run-view-${RUN}.json`), runView(f.commit, { jobs: [] })),
      `run ${RUN} has no jobs`,
    ],
    [
      "a hosted run whose JSON has no jobs key",
      (f) => {
        const view = JSON.parse(runView(f.commit));
        delete view.jobs;
        writeFileSync(join(f.fixtures, `run-view-${RUN}.json`), JSON.stringify(view));
      },
      `run ${RUN} has no jobs`,
    ],
    [
      "a release check with no gate/identity-before.json",
      (f) => rmSync(join(f.attempt, "gate", "identity-before.json")),
      "cannot compare the inputs",
    ],
    [
      "a tag that exists only in this checkout",
      (f) => git(f.repo, "tag", TAG),
      "already exists in this checkout",
    ],
    [
      "a retained archive named for another version",
      (f) => {
        const right = join(f.attempt, "gate", "package", `relembra-${VERSION}.tgz`);
        const wrong = join(f.attempt, "gate", "package", "relembra-9.9.9.tgz");
        copyFileSync(right, wrong);
        rmSync(right);
        editManifest(f, (m) => {
          (m.artifacts[1] as Artifact).path = wrong;
        });
      },
      "relembra-9.9.9.tgz, not relembra-1.2.3-test.1.tgz",
    ],
    [
      "a release check whose marker says it did not pass",
      (f) =>
        writeFileSync(
          join(f.attempt, "release-check.json"),
          JSON.stringify({ passed: false, manifestSha256: "0".repeat(64) }),
        ),
      "release check did not pass",
    ],
    [
      // A checksum file that names other files, each correct, vouches for nothing about relembra.
      "a hosted artifact whose checksum file names another file",
      (f) => {
        const dir = join(f.fixtures, "artifacts", "relembra-cli-linux-x64");
        writeFileSync(join(dir, "other"), "x");
        writeFileSync(join(dir, "relembra.sha256"), `${sha256("x")}  other\n`);
        writeFileSync(join(dir, "relembra"), "altered binary\n");
      },
      "relembra-cli-linux-x64: relembra.sha256 has no entry for relembra",
    ],
    [
      // Date.parse turns 2027-02-29 into March 1; a date that does not exist is not an expiry.
      "a waiver expiring on an impossible calendar date",
      (f) =>
        editRecord(f, (r) => {
          const [first] = r.waivers ?? [];
          if (first) first.expires = "2027-02-29T00:00:00Z";
        }),
      "waiver SEC-20 has no valid expiry",
    ],
    [
      "a waiver expiring at an hour with an offset, not UTC",
      (f) =>
        editRecord(f, (r) => {
          const [first] = r.waivers ?? [];
          if (first) first.expires = "2999-01-01T00:00:00-03:00";
        }),
      "waiver SEC-20 has no valid expiry",
    ],
  ];
  for (const [name, arrange, message] of refusals) {
    test(`refuses ${name}`, () => {
      const f = fixture();
      arrange(f);
      const run = hmo(f);
      expect(run.stderr).toContain(message);
      expect({ status: run.status, plan: existsSync(join(planDir(f), "plan.json")) }).toEqual({
        status: 1,
        plan: false,
      });
    });
  }
});

describe.skipIf(NO_RELEASE_TOOLING)("contract: prd publishes only hmo's bytes", () => {
  for (const asset of [
    "relembra-linux-x64",
    "relembra-darwin-arm64",
    `relembra-${VERSION}.tgz`,
    "relembra-windows-arm64.exe",
  ]) {
    test(`refuses ${asset} swapped after hmo with SHA256SUMS regenerated, before tagging`, () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      writeFileSync(join(planDir(f), asset), "other bytes\n");
      regenerateSums(planDir(f));
      writeFileSync(f.log, "");
      const run = prd(f);
      expect(run.stderr).toContain(asset);
      expect({ status: run.status, tagged: tagged(f), gh: ghCalls(f) }).toEqual({
        status: 1,
        tagged: false,
        gh: [],
      });
    });
  }

  test("refuses a SHA256SUMS rewritten with the same entries in another order", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    const sums = join(planDir(f), "SHA256SUMS");
    const text = readFileSync(sums, "utf8");
    writeFileSync(sums, `${text.trimEnd().split("\n").reverse().join("\n")}\n`);
    const run = prd(f);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("SHA256SUMS");
    expect(tagged(f)).toBe(false);
  });

  test("refuses a deleted notes.md, before tagging", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    rmSync(join(planDir(f), "notes.md"));
    const run = prd(f);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("notes.md is missing");
    expect(tagged(f)).toBe(false);
  });

  test("refuses HEAD moved to another commit with the same tree, pushed", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    git(f.repo, "commit", "-q", "--allow-empty", "-m", "same tree");
    git(f.repo, "push", "-q", "origin", "main");
    expect(git(f.repo, "rev-parse", "HEAD^{tree}")).toBe(git(f.repo, "rev-parse", "HEAD~1^{tree}"));
    const run = prd(f);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("plan is for");
    expect(tagged(f)).toBe(false);
  });
});

describe.skipIf(NO_RELEASE_TOOLING)(
  "contract: a failed prd step is reported with its state",
  () => {
    test("a failed draft download names the rollback and publishes nothing", () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      writeFileSync(join(f.fixtures, "fail-draft-download"), "");
      const run = prd(f);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("HTTP 502");
      expect(run.stderr).toContain("nothing is published");
      expect(run.stderr).toContain(`gh release delete ${TAG} --yes`);
      expect(run.stderr).toContain(`git push --delete origin ${TAG}`);
      expect(existsSync(join(f.fixtures, "state-published"))).toBe(false);
      expect(ghCalls(f)).not.toContainEqual(`release edit ${TAG} --draft=false`);
    });

    test("a failed edit that GitHub did not apply names the rollback", () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      writeFileSync(join(f.fixtures, "fail-edit"), "");
      const run = prd(f);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("HTTP 500");
      expect(run.stderr).toContain("nothing is published");
      expect(existsSync(join(planDir(f), "published.json"))).toBe(false);
    });

    test("a failed edit that GitHub did apply says the release is live, not that nothing is", () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      writeFileSync(join(f.fixtures, "fail-edit-applied"), "");
      const run = prd(f);
      expect(run.status).toBe(1);
      expect(existsSync(join(f.fixtures, "state-published"))).toBe(true);
      // The release is public; telling the operator to delete it and its tag would be wrong.
      expect(run.stderr).not.toContain("nothing is published");
      expect(run.stderr).toContain("the release is live");
      expect(run.stderr).toContain("release.yml");
    });

    test("no release.yml run in time stops before watching a run", { timeout: 20_000 }, () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      writeFileSync(join(f.fixtures, "run-list-release.yml.json"), "[]");
      const run = prd(f);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("no release.yml run for");
      expect(ghCalls(f)).not.toContainEqual("run watch  --exit-status");
      expect(ghCalls(f)).not.toContain("workflow run pages.yml --ref main");
    });

    test("no pages.yml run in time fails prd and writes no published.json", {
      timeout: 20_000,
    }, () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      writeFileSync(join(f.fixtures, "run-list-pages.yml.json"), "[]");
      const run = prd(f);
      expect(run.stderr).toContain("no pages.yml run for");
      expect({
        status: run.status,
        published: existsSync(join(planDir(f), "published.json")),
      }).toEqual({ status: 1, published: false });
      expect(ghCalls(f)).not.toContainEqual("run watch  --exit-status");
    });

    test("a failed release.yml run is reported with the rerun command", () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      writeFileSync(join(f.fixtures, "fail-watch-900"), "");
      const run = prd(f);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("release.yml run 900 failed");
      expect(run.stderr).toContain("gh run rerun 900");
    });

    test("a failed edit whose readback also fails is an unknown state, not a rollback", () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      writeFileSync(join(f.fixtures, "fail-edit-applied"), "");
      writeFileSync(join(f.fixtures, "fail-view"), "");
      const run = prd(f);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("state is unknown");
      expect(run.stderr).toContain(`gh release view ${TAG}`);
      expect(run.stderr).not.toContain("nothing is published");
      expect(run.stderr).not.toContain("git push --delete");
    });

    test("refuses when origin/main moved since hmo, before tagging", () => {
      const f = fixture();
      expect(hmo(f).status).toBe(0);
      // The remote advances; this checkout stays on the planned commit.
      git(f.repo, "commit", "-q", "--allow-empty", "-m", "someone else's merge");
      git(f.repo, "push", "-q", "origin", "main");
      git(f.repo, "reset", "-q", "--hard", "HEAD~1");
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.commit);
      writeFileSync(f.log, "");
      const run = prd(f);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("origin/main is now");
      expect(run.stderr).toContain("pages.yml would publish it");
      expect({ tagged: tagged(f), gh: ghCalls(f) }).toEqual({ tagged: false, gh: [] });
    });
  },
);

describe.skipIf(NO_RELEASE_TOOLING)("contract: quoting and portability", () => {
  test("a checkout under a path with spaces", () => {
    const f = fixture({ parent: "with space/and  two" });
    expect(fullRun(f, f.env)).toEqual({ hmo: 0, prd: 0, stderr: "" });
  });

  test("the shasum branch (no sha256sum on PATH)", () => {
    const f = fixture();
    const env = pathEnv(f, [], ["sha256sum"]);
    expect(spawnSync("bash", ["-c", "command -v sha256sum"], { env }).status).not.toBe(0);
    expect(fullRun(f, env)).toEqual({ hmo: 0, prd: 0, stderr: "" });
  });

  const gnu = ["/opt/homebrew/bin/gsha256sum", "/opt/homebrew/bin/gsha1sum"];
  test.skipIf(!gnu.every((p) => existsSync(p)))("GNU coreutils sha256sum and sha1sum", () => {
    const f = fixture();
    const shim = join(f.fixtures, "..", "gnu");
    mkdirSync(shim);
    for (const p of gnu) symlinkSync(p, join(shim, (p.split("/").pop() as string).slice(1)));
    const env = pathEnv(f, [shim], []);
    const which = spawnSync("bash", ["-c", "sha256sum --version"], { env, encoding: "utf8" });
    expect(which.stdout).toContain("GNU coreutils");
    expect(fullRun(f, env)).toEqual({ hmo: 0, prd: 0, stderr: "" });
  });

  // The shebang is `/usr/bin/env bash`, which on a stock Mac is bash 3.2: the script runs there.
  const system = spawnSync("/bin/bash", ["-c", 'echo "$BASH_VERSINFO"'], { encoding: "utf8" });
  test.skipIf(system.status !== 0)(`the system /bin/bash (major ${system.stdout.trim()})`, () => {
    const f = fixture({ version: "1.2.3" });
    expect(fullRun(f, f.env, "/bin/bash")).toEqual({ hmo: 0, prd: 0, stderr: "" });
  });
});
