/**
 * scripts/deploy.sh is docs/RELEASE.md's "Publication" section as a program. `hmo` (homologação)
 * does every step that writes nothing outside the checkout: it binds HEAD to the local release
 * check, the hosted CI run and the security gate record, downloads and checks the hosted binaries,
 * and lays out the release assets with SHA256SUMS and notes. `prd` publishes that plan: tag,
 * draft release, publication, the npm stage and Pages runs, and a check of what was published.
 *
 * GitHub is a `gh` shim here, first on PATH, that serves fixtures and logs every call; the
 * remote is a bare repository. Nothing in this file can reach the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

const repoRoot = join(import.meta.dir, "..");
const script = join(repoRoot, "scripts", "deploy.sh");
const VERSION = "1.2.3-test.1";
const TAG = `v${VERSION}`;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");
const sri = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

const GH_SHIM = `#!/usr/bin/env bash
# A gh that serves fixtures from $GH_FIXTURES and appends every invocation to $GH_LOG.
set -u
printf '%s\\n' "$*" >>"$GH_LOG"
opt() { local i; for ((i = 1; i <= $#; i++)); do if [ "\${!i}" = "$1" ]; then :; fi; done; }
value() { # value NAME ARGS...: the argument after NAME
  local name=$1; shift
  while [ "$#" -gt 0 ]; do if [ "$1" = "$name" ]; then printf '%s' "$2"; return; fi; shift; done
}
case "$1 $2" in
  "run view")
    case " $* " in
      *" --log "*) cat "$GH_FIXTURES/log-$3.txt" ;;
      *) cat "$GH_FIXTURES/run-view-$3.json" ;;
    esac ;;
  "run download")
    dir=$(value --dir "$@"); mkdir -p "$dir"; cp -R "$GH_FIXTURES/artifacts/." "$dir/" ;;
  "run list")
    cat "$GH_FIXTURES/run-list-$(value --workflow "$@").json" ;;
  "run watch")
    [ -f "$GH_FIXTURES/fail-watch-$3" ] && { echo "run $3 failed" >&2; exit 1; }; exit 0 ;;
  "release create")
    [ -f "$GH_FIXTURES/fail-release-create" ] && { echo "HTTP 422: Validation Failed" >&2; exit 1; }
    mkdir -p "$GH_FIXTURES/published"
    for arg in "$@"; do [ -f "$arg" ] && [ "$arg" != "$(value --notes-file "$@")" ] && cp "$arg" "$GH_FIXTURES/published/"; done
    echo "https://github.com/example/relembra/releases/tag/$3" ;;
  "release download")
    dir=$(value --dir "$@"); mkdir -p "$dir"; cp "$GH_FIXTURES/published/"* "$dir/" ;;
  "release edit") touch "$GH_FIXTURES/state-published" ;;
  "release view") cat "$GH_FIXTURES/release-view.json" ;;
  "workflow run") touch "$GH_FIXTURES/state-pages-dispatched" ;;
  *) echo "gh shim: unexpected: $*" >&2; exit 97 ;;
esac
`;

const CURL_SHIM = `#!/usr/bin/env bash
# A curl that writes $GH_FIXTURES/page.html to -o and prints the fixture's status code.
set -u
printf 'curl %s\\n' "$*" >>"$GH_LOG"
while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then cp "$GH_FIXTURES/page.html" "$2"; fi; shift; done
cat "$GH_FIXTURES/page.status" 2>/dev/null || printf '200'
`;

interface Fixture {
  readonly repo: string;
  readonly fixtures: string;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
  readonly commit: string;
  readonly attempt: string;
  readonly binary: Buffer;
  readonly archive: Buffer;
}

interface Options {
  readonly version?: string;
  readonly gateVerdict?: string;
  readonly waiverExpires?: string;
  readonly gateTree?: string;
  readonly jobConclusion?: string;
  readonly runHeadSha?: string;
  readonly noGateRecord?: boolean;
}

/** A release-ready checkout: committed inputs, a bare origin, a passed release check, a gate record. */
function fixture(options: Options = {}): Fixture {
  const version = options.version ?? VERSION;
  // Resolved: the script prints the checkout's real path, and macOS's temp dir is a symlink.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "relembra-deploy-")));
  dirs.push(base);
  const repo = join(base, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "bin"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  const manifest = {
    name: "relembra",
    version,
    repository: { type: "git", url: "git+https://github.com/mneves75/relembra.git" },
    homepage: "https://example.test/relembra/",
    publishConfig: { access: "public", tag: "beta" },
    type: "module",
  };
  writeFileSync(join(repo, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(repo, "src", "version.ts"), `export const RELEMBRA_VERSION = "${version}";\n`);
  writeFileSync(
    join(repo, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      `## [${version}] - 2026-11-04`,
      "",
      "Stores are created private from birth.",
      "",
      "### Security",
      "",
      "- Windows: the descriptor is set at creation.",
      "",
      "## [1.0.0] - 2026-01-01",
      "",
      "- First.",
      "",
      `[${version}]: https://github.com/mneves75/relembra/releases/tag/v${version}`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, ".gitignore"), "bin/\n.scratch/\n");
  for (const name of ["evidence.ts", "stage-release.ts", "publish-manifest.ts"]) {
    copyFileSync(join(repoRoot, "scripts", name), join(repo, "scripts", name));
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "release candidate");
  const remote = join(base, "remote.git");
  git(base, "clone", "-q", "--bare", repo, remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "fetch", "-q", "origin");
  git(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");
  const commit = git(repo, "rev-parse", "HEAD");
  const tree = git(repo, "rev-parse", "HEAD^{tree}");

  // The gated binary and the retained archive (npm pack's layout, the manifest it would publish).
  const binary = Buffer.from(`binary for ${version} built on this machine\n`);
  writeFileSync(join(repo, "bin", "relembra"), binary);
  const pkg = join(base, "pkg", "package");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
  const attempt = join(repo, ".scratch", "release", "release-20261104-000000-TEST");
  mkdirSync(join(attempt, "gate", "package"), { recursive: true });
  mkdirSync(join(attempt, "bench", "bench-test"), { recursive: true });
  const tgz = join(attempt, "gate", "package", `relembra-${version}.tgz`);
  const tar = spawnSync("tar", ["-czf", tgz, "-C", join(base, "pkg"), "package"]);
  if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
  const archive = readFileSync(tgz);
  const identity = spawnSync("bun", ["scripts/evidence.ts"], { cwd: repo, encoding: "utf8" });
  if (identity.status !== 0) throw new Error(`evidence.ts: ${identity.stderr}`);
  writeFileSync(join(attempt, "gate", "identity-before.json"), identity.stdout);
  writeFileSync(join(attempt, "identity-final.json"), identity.stdout);
  writeFileSync(join(attempt, "bench", "bench-test", "bench.json"), '{"check":{"pass":true}}\n');
  writeFileSync(
    join(attempt, "gate", "manifest.json"),
    JSON.stringify(
      {
        verdict: "pass",
        complete: true,
        candidate: { commit, digest: "d".repeat(64) },
        artifacts: [
          {
            name: "cli",
            path: join(repo, "bin", "relembra"),
            sha256Before: sha256(binary),
            sha256After: sha256(binary),
            verified: true,
          },
          {
            name: "package",
            path: tgz,
            sha256Before: sha256(archive),
            sha256After: sha256(archive),
            verified: true,
          },
        ],
        failures: [],
      },
      null,
      2,
    ),
  );

  if (!options.noGateRecord) {
    const record = join(repo, ".scratch", "security-gate", commit);
    mkdirSync(record, { recursive: true });
    writeFileSync(
      join(record, "production.json"),
      JSON.stringify({
        schema: 1,
        unit: ".",
        target: "production",
        commit,
        tree: options.gateTree ?? tree,
        verdict: options.gateVerdict ?? "waived",
        open_blockers: 0,
        independent_acceptance: "pass",
        waivers: [
          {
            id: "SEC-20",
            owner: "owner",
            reason: "r",
            expires: options.waiverExpires ?? "2999-01-01T00:00:00Z",
          },
          { id: "W-NV1", owner: "owner", reason: "r", expires: "2999-01-01T00:00:00Z" },
        ],
      }),
    );
  }

  // GitHub, as fixtures: the main run, its artifacts, the two workflow runs, the release.
  const fixtures = join(base, "gh");
  mkdirSync(fixtures);
  const jobs = ["check", "cli binary (ubuntu-latest)", "bun (windows-latest)", "node (26)"].map(
    (name) => ({ name, conclusion: "success" }),
  );
  if (options.jobConclusion !== undefined && jobs[2]) jobs[2].conclusion = options.jobConclusion;
  writeFileSync(
    join(fixtures, "run-view-7.json"),
    JSON.stringify({
      headSha: options.runHeadSha ?? commit,
      status: "completed",
      conclusion: options.jobConclusion === undefined ? "success" : "failure",
      jobs,
    }),
  );
  const platforms: Record<string, string> = {
    "linux-x64": "relembra",
    "linux-aarch64": "relembra",
    "windows-x64": "relembra.exe",
    "windows-aarch64": "relembra.exe",
    "darwin-aarch64": "relembra",
  };
  for (const [platform, file] of Object.entries(platforms)) {
    const dir = join(fixtures, "artifacts", `relembra-cli-${platform}`);
    mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(`binary for ${version} built on ${platform}\n`);
    writeFileSync(join(dir, file), bytes);
    writeFileSync(join(dir, "relembra.sha256"), `${sha256(bytes)}  ${file}\n`);
  }
  writeFileSync(
    join(fixtures, "run-list-release.yml.json"),
    JSON.stringify([
      {
        databaseId: 900,
        headSha: commit,
        event: "release",
        createdAt: "2999-01-01T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
      {
        databaseId: 800,
        headSha: commit,
        event: "release",
        createdAt: "2000-01-01T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
    ]),
  );
  writeFileSync(
    join(fixtures, "log-900.txt"),
    [
      "stage on npm\tStage it on npm\t2026-11-04T05:52:17Z npm notice name: relembra",
      `stage on npm\tStage it on npm\t2026-11-04T05:52:17Z npm notice version: ${version}`,
      `stage on npm\tStage it on npm\t2026-11-04T05:52:17Z npm notice shasum: ${sha1(archive)}`,
      `stage on npm\tStage it on npm\t2026-11-04T05:52:17Z npm notice integrity: ${sri(archive).slice(0, 20)}[...]${sri(archive).slice(-12)}`,
      `stage on npm\tStage it on npm\t2026-11-04T05:52:21Z + relembra@${version} (staged with id d039c1e8-0000-4000-8000-000000000001)`,
      `stage on npm\tStage it on npm\t2026-11-04T05:52:21Z npm notice stage package relembra@${version} has been staged with tag beta`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtures, "run-list-pages.yml.json"),
    JSON.stringify([
      {
        databaseId: 901,
        headSha: commit,
        event: "workflow_dispatch",
        createdAt: "2999-01-01T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
    ]),
  );
  writeFileSync(
    join(fixtures, "release-view.json"),
    JSON.stringify({
      tagName: `v${version}`,
      isDraft: false,
      isPrerelease: version.includes("-"),
      publishedAt: "2026-11-04T05:51:59Z",
      url: `https://github.com/example/relembra/releases/tag/v${version}`,
    }),
  );
  writeFileSync(
    join(fixtures, "page.html"),
    `<html><body>Version ${version}. Install ${version}.</body></html>`,
  );

  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_SHIM);
  writeFileSync(join(bin, "curl"), CURL_SHIM);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  const log = join(base, "gh.log");
  writeFileSync(log, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    GH_FIXTURES: fixtures,
    GH_LOG: log,
    RELEMBRA_DEPLOY_POLL: "0",
    RELEMBRA_DEPLOY_TIMEOUT: "1",
  };
  return { repo, fixtures, log, env, commit, attempt, binary, archive };
}

function deploy(f: Fixture, ...args: string[]) {
  return spawnSync("bash", [script, ...args], { cwd: f.repo, encoding: "utf8", env: f.env });
}

const hmo = (f: Fixture) => deploy(f, "hmo", "--run", "7", "--release-check", f.attempt);
const planDir = (f: Fixture, version = VERSION) => join(f.repo, ".scratch", "deploy", version);
const ghCalls = (f: Fixture) => readFileSync(f.log, "utf8").split("\n").filter(Boolean);

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
        return match[2];
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
      run: "7",
      prerelease: true,
      verdict: "waived",
      waivers: ["SEC-20", "W-NV1"],
      binarySha256: sha256(f.binary),
      archiveSha256: sha256(f.archive),
      tagMessage: `${TAG}; security gate: WAIVED SEC-20 W-NV1`,
    });
    expect(ghCalls(f)).toEqual([
      "run view 7 --json headSha,status,conclusion,jobs",
      `run download 7 --dir ${join(dir, "dl")} --pattern relembra-cli-*`,
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
    writeFileSync(
      join(f.fixtures, "run-view-7.json"),
      JSON.stringify({ headSha: commit, status: "completed", conclusion: "success", jobs: [] }),
    );
    const record = join(f.repo, ".scratch", "security-gate", commit);
    mkdirSync(record);
    const previous = JSON.parse(
      readFileSync(join(f.repo, ".scratch", "security-gate", f.commit, "production.json"), "utf8"),
    );
    writeFileSync(join(record, "production.json"), JSON.stringify({ ...previous, commit }));
    const run = hmo(f);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(planDir(f), "plan.json"), "utf8")).commit).toBe(commit);
  });

  test("usage", () => {
    const f = fixture();
    expect(deploy(f).status).toBe(2);
    expect(deploy(f, "hmo").status).toBe(2);
    expect(deploy(f, "hmo", "--run", "7").status).toBe(2);
    expect(deploy(f, "staging").status).toBe(2);
  });

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
      (f) =>
        writeFileSync(
          join(f.fixtures, "run-view-7.json"),
          JSON.stringify({
            headSha: "0".repeat(40),
            status: "completed",
            conclusion: "success",
            jobs: [],
          }),
        ),
      "run 7 is for 0000000, not HEAD",
    ],
    [
      "a CI run with a failed job",
      (f) =>
        writeFileSync(
          join(f.fixtures, "run-view-7.json"),
          JSON.stringify({
            headSha: f.commit,
            status: "completed",
            conclusion: "failure",
            jobs: [{ name: "bun (windows-latest)", conclusion: "failure" }],
          }),
        ),
      "run 7: job bun (windows-latest) is failure",
    ],
    [
      "a CI run still in progress",
      (f) =>
        writeFileSync(
          join(f.fixtures, "run-view-7.json"),
          JSON.stringify({
            headSha: f.commit,
            status: "in_progress",
            conclusion: "",
            jobs: [{ name: "bun (windows-latest)", conclusion: null }],
          }),
        ),
      "run 7 is in_progress",
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
      (f) => {
        const path = join(f.repo, ".scratch", "security-gate", f.commit, "production.json");
        const record = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(join(path), JSON.stringify({ ...record, tree: "1".repeat(40) }));
      },
      "no security gate record for tree",
    ],
    [
      "a blocked gate verdict",
      (f) => {
        const path = join(f.repo, ".scratch", "security-gate", f.commit, "production.json");
        const record = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify({ ...record, verdict: "blocked", open_blockers: 1 }));
      },
      "security gate verdict is blocked",
    ],
    [
      "a gate without independent acceptance",
      (f) => {
        const path = join(f.repo, ".scratch", "security-gate", f.commit, "production.json");
        const record = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify({ ...record, independent_acceptance: "blocked" }));
      },
      "independent acceptance is blocked",
    ],
    [
      "an expired waiver",
      (f) => {
        const path = join(f.repo, ".scratch", "security-gate", f.commit, "production.json");
        const record = JSON.parse(readFileSync(path, "utf8"));
        record.waivers[0].expires = "2026-01-01T00:00:00Z";
        writeFileSync(path, JSON.stringify(record));
      },
      "waiver SEC-20 expired 2026-01-01T00:00:00Z",
    ],
    [
      "a binary that is not the gated one",
      (f) => writeFileSync(join(f.repo, "bin", "relembra"), "rebuilt since the gate\n"),
      "bin/relembra is not the binary the release check tested",
    ],
    [
      "a release check that did not finish",
      (f) => rmSync(join(f.attempt, "identity-final.json")),
      "release check did not finish",
    ],
    [
      "a release check on other inputs",
      (f) => {
        writeFileSync(
          join(f.repo, "src", "version.ts"),
          `export const RELEMBRA_VERSION = "${VERSION}"; // changed\n`,
        );
        git(f.repo, "commit", "-q", "-am", "change after the gate");
        git(f.repo, "push", "-q", "origin", "main");
        writeFileSync(
          join(f.fixtures, "run-view-7.json"),
          JSON.stringify({
            headSha: git(f.repo, "rev-parse", "HEAD"),
            status: "completed",
            conclusion: "success",
            jobs: [],
          }),
        );
      },
      "inputs changed since the release check",
    ],
    [
      "a version the library does not report",
      (f) => {
        writeFileSync(
          join(f.repo, "src", "version.ts"),
          'export const RELEMBRA_VERSION = "9.9.9";\n',
        );
        git(f.repo, "commit", "-q", "-am", "bump one of two");
        git(f.repo, "push", "-q", "origin", "main");
        writeFileSync(
          join(f.fixtures, "run-view-7.json"),
          JSON.stringify({
            headSha: git(f.repo, "rev-parse", "HEAD"),
            status: "completed",
            conclusion: "success",
            jobs: [],
          }),
        );
      },
      `src/version.ts says 9.9.9, package.json ${VERSION}`,
    ],
    [
      "a CHANGELOG without the version's section",
      (f) => {
        writeFileSync(join(f.repo, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n");
        git(f.repo, "commit", "-q", "-am", "drop the section");
        git(f.repo, "push", "-q", "origin", "main");
        writeFileSync(
          join(f.fixtures, "run-view-7.json"),
          JSON.stringify({
            headSha: git(f.repo, "rev-parse", "HEAD"),
            status: "completed",
            conclusion: "success",
            jobs: [],
          }),
        );
      },
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
    const run = deploy(f, "prd");
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
    const run = deploy(f, "prd");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(ghCalls(f)[0]).toStartWith("release create v1.2.3 --verify-tag --draft --title v1.2.3 ");
  });

  test("refuses to publish without a plan, and a plan for another HEAD", () => {
    const f = fixture();
    const none = deploy(f, "prd");
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("no plan");
    expect(hmo(f).status).toBe(0);
    git(f.repo, "commit", "-q", "--allow-empty", "-m", "moved on");
    const moved = deploy(f, "prd");
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain("plan is for");
    expect(git(f.repo, "ls-remote", "--tags", "origin")).toBe("");
  });

  test("refuses an asset changed since hmo, before tagging", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    writeFileSync(f.log, "");
    writeFileSync(join(planDir(f), "relembra-linux-x64"), "swapped\n");
    const run = deploy(f, "prd");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("relembra-linux-x64");
    expect(git(f.repo, "tag", "-l", TAG)).toBe("");
    expect(ghCalls(f)).toEqual([]);
  });

  test("when the draft cannot be created, names the rollback and leaves nothing published", () => {
    const f = fixture();
    expect(hmo(f).status).toBe(0);
    writeFileSync(join(f.fixtures, "fail-release-create"), "");
    const run = deploy(f, "prd");
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
    const run = deploy(f, "prd");
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
    const run = deploy(f, "prd");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no release.yml run for");
  });
});
