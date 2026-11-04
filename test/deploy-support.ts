/**
 * The fixture for scripts/deploy.sh's tests: a release-ready checkout with a bare origin, a passed
 * release check, a security gate record, and GitHub as a `gh` shim first on PATH that serves
 * fixtures and logs every call. A `curl` shim serves the site. Nothing here reaches the network.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const repoRoot = join(import.meta.dir, "..");
export const script = join(repoRoot, "scripts", "deploy.sh");
export const VERSION = "1.2.3-test.1";
export const TAG = `v${VERSION}`;
/** The hosted run the fixture serves as `gh run view 7`. */
export const RUN = "7";
export const RUN_FIELDS = "headSha,status,conclusion,jobs,workflowName,event,headBranch";

const dirs: string[] = [];
/** For afterEach: removes every temporary directory the fixtures made. */
export function cleanupFixtures(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");
export const sri = (bytes: Buffer) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

const GH_SHIM = `#!/usr/bin/env bash
# A gh that serves fixtures from $GH_FIXTURES and appends every invocation to $GH_LOG. Marker
# files in $GH_FIXTURES make a step fail: fail-release-create, fail-draft-download, fail-edit
# (GitHub did not apply it), fail-edit-applied (GitHub applied it and then the connection broke),
# fail-watch-<run id>.
set -u
printf '%s\\n' "$*" >>"$GH_LOG"
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
    notes=$(value --notes-file "$@")
    for arg in "$@"; do [ -f "$arg" ] && [ "$arg" != "$notes" ] && cp "$arg" "$GH_FIXTURES/published/"; done
    echo "https://github.com/example/relembra/releases/tag/$3" ;;
  "release download")
    case " $* " in *"/draft "*) [ -f "$GH_FIXTURES/fail-draft-download" ] && { echo "HTTP 502" >&2; exit 1; } ;; esac
    dir=$(value --dir "$@"); mkdir -p "$dir"; cp "$GH_FIXTURES/published/"* "$dir/" ;;
  "release edit")
    [ -f "$GH_FIXTURES/fail-edit-applied" ] && { touch "$GH_FIXTURES/state-published"; echo "read: connection reset" >&2; exit 1; }
    [ -f "$GH_FIXTURES/fail-edit" ] && { echo "HTTP 500" >&2; exit 1; }
    touch "$GH_FIXTURES/state-published" ;;
  "release view")
    if [ -f "$GH_FIXTURES/state-published" ]; then cat "$GH_FIXTURES/release-view.json"; else cat "$GH_FIXTURES/release-view-draft.json"; fi ;;
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

export interface Fixture {
  readonly repo: string;
  readonly fixtures: string;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
  readonly commit: string;
  readonly attempt: string;
  readonly binary: Buffer;
  readonly archive: Buffer;
}

export interface Options {
  readonly version?: string;
  readonly gateVerdict?: string;
  readonly noGateRecord?: boolean;
  /** A directory name for the checkout's parent, to test quoting (spaces). */
  readonly parent?: string;
}

/** `gh run view` for the fixture's main run, as the workflow's push to main would report it. */
export function runView(commit: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headSha: commit,
    status: "completed",
    conclusion: "success",
    workflowName: "ci",
    event: "push",
    headBranch: "main",
    jobs: ["check", "cli binary (ubuntu-latest)", "bun (windows-latest)", "node (26)"].map(
      (name) => ({ name, conclusion: "success" }),
    ),
    ...overrides,
  });
}

/** A release-ready checkout: committed inputs, a bare origin, a passed release check, a gate record. */
export function fixture(options: Options = {}): Fixture {
  const version = options.version ?? VERSION;
  // Resolved: the script prints the checkout's real path, and macOS's temp dir is a symlink.
  const top = realpathSync(mkdtempSync(join(tmpdir(), "relembra-deploy-")));
  dirs.push(top);
  const base = options.parent === undefined ? top : join(top, options.parent);
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
  const record = join(attempt, "bench", "bench-test", "bench.json");
  writeFileSync(record, '{"check":{"passed":true}}\n');
  const manifestPath = join(attempt, "gate", "manifest.json");
  writeFileSync(
    manifestPath,
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
  // What scripts/check-release.sh writes last, after its final checks passed.
  writeFileSync(
    join(attempt, "release-check.json"),
    JSON.stringify({
      passed: true,
      manifest: manifestPath,
      manifestSha256: sha256(readFileSync(manifestPath)),
      benchmark: record,
      finishedAt: "2026-11-04T05:24:00Z",
    }),
  );

  if (!options.noGateRecord) {
    const gate = join(repo, ".scratch", "security-gate", commit);
    mkdirSync(gate, { recursive: true });
    writeFileSync(
      join(gate, "production.json"),
      JSON.stringify({
        schema: 1,
        unit: ".",
        target: "production",
        commit,
        tree,
        verdict: options.gateVerdict ?? "waived",
        open_blockers: 0,
        independent_acceptance: "pass",
        waivers: [
          { id: "SEC-20", owner: "owner", reason: "r", expires: "2999-01-01T00:00:00Z" },
          { id: "W-NV1", owner: "owner", reason: "r", expires: "2999-01-01T00:00:00Z" },
        ],
      }),
    );
  }

  // GitHub, as fixtures: the main run, its artifacts, the two workflow runs, the release.
  const fixtures = join(base, "gh");
  mkdirSync(fixtures);
  writeFileSync(join(fixtures, `run-view-${RUN}.json`), runView(commit));
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
  const run = (databaseId: number, event: string, createdAt: string) => ({
    databaseId,
    headSha: commit,
    event,
    createdAt,
    status: "completed",
    conclusion: "success",
  });
  writeFileSync(
    join(fixtures, "run-list-release.yml.json"),
    JSON.stringify([
      run(900, "release", "2999-01-01T00:00:00Z"),
      run(800, "release", "2000-01-01T00:00:00Z"),
    ]),
  );
  const line = (text: string) => `stage on npm\tStage it on npm\t2026-11-04T05:52:17Z ${text}`;
  writeFileSync(
    join(fixtures, "log-900.txt"),
    [
      line("npm notice name: relembra"),
      line(`npm notice version: ${version}`),
      line(`npm notice shasum: ${sha1(archive)}`),
      line(`npm notice integrity: ${sri(archive).slice(0, 20)}[...]${sri(archive).slice(-12)}`),
      line(`+ relembra@${version} (staged with id d039c1e8-0000-4000-8000-000000000001)`),
      line(`npm notice stage package relembra@${version} has been staged with tag beta`),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtures, "run-list-pages.yml.json"),
    JSON.stringify([run(901, "workflow_dispatch", "2999-01-01T00:00:00Z")]),
  );
  const view = {
    tagName: `v${version}`,
    isDraft: false,
    isPrerelease: version.includes("-"),
    publishedAt: "2026-11-04T05:51:59Z",
    url: `https://github.com/example/relembra/releases/tag/v${version}`,
  };
  writeFileSync(join(fixtures, "release-view.json"), JSON.stringify(view));
  writeFileSync(
    join(fixtures, "release-view-draft.json"),
    JSON.stringify({ ...view, isDraft: true, publishedAt: null }),
  );
  writeFileSync(
    join(fixtures, "page.html"),
    `<html><body>Version ${version}. Install ${version}.</body></html>`,
  );

  const bin = join(top, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_SHIM);
  writeFileSync(join(bin, "curl"), CURL_SHIM);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  const log = join(top, "gh.log");
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

export function deploy(f: Fixture, args: readonly string[], env = f.env, shell = "bash") {
  return spawnSync(shell, [script, ...args], { cwd: f.repo, encoding: "utf8", env });
}
export const hmo = (f: Fixture, env = f.env, shell = "bash") =>
  deploy(f, ["hmo", "--run", RUN, "--release-check", f.attempt], env, shell);
export const prd = (f: Fixture, env = f.env, shell = "bash") => deploy(f, ["prd"], env, shell);
export const planDir = (f: Fixture, version = VERSION) =>
  join(f.repo, ".scratch", "deploy", version);
export const ghCalls = (f: Fixture) => readFileSync(f.log, "utf8").split("\n").filter(Boolean);
export const tagged = (f: Fixture) => git(f.repo, "ls-remote", "--tags", "origin") !== "";

export const recordPath = (f: Fixture) =>
  join(f.repo, ".scratch", "security-gate", f.commit, "production.json");
export interface Waiver {
  id: string;
  expires?: string;
}
export interface GateRecord {
  target: string;
  commit: string;
  tree: string;
  verdict: string;
  independent_acceptance: string;
  waivers?: Waiver[];
}
export function editRecord(f: Fixture, edit: (record: GateRecord) => void): void {
  const record = JSON.parse(readFileSync(recordPath(f), "utf8")) as GateRecord;
  edit(record);
  writeFileSync(recordPath(f), JSON.stringify(record));
}
export interface Artifact {
  name: string;
  path: string;
  sha256Before: string;
  sha256After: string;
  verified: boolean;
}
export const manifestPath = (f: Fixture) => join(f.attempt, "gate", "manifest.json");
/** Edits the manifest and keeps release-check.json's hash of it in step, as a rerun would. */
export function editManifest(
  f: Fixture,
  edit: (manifest: { artifacts: Artifact[] }) => void,
): void {
  const manifest = JSON.parse(readFileSync(manifestPath(f), "utf8"));
  edit(manifest);
  writeFileSync(manifestPath(f), JSON.stringify(manifest));
  const marker = join(f.attempt, "release-check.json");
  const record = JSON.parse(readFileSync(marker, "utf8"));
  record.manifestSha256 = sha256(readFileSync(manifestPath(f)));
  writeFileSync(marker, JSON.stringify(record));
}
/** Rewrites SHA256SUMS so it agrees with whatever bytes are in the plan now. */
export function regenerateSums(dir: string): void {
  const lines = readFileSync(join(dir, "SHA256SUMS"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => line.split("  ")[1] as string)
    .map((name) => `${sha256(readFileSync(join(dir, name)))}  ${name}`);
  writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

/** The env with PATH rebuilt: `first` prepended, and every directory holding one of `hide` removed. */
export function pathEnv(f: Fixture, first: string[], hide: string[]): NodeJS.ProcessEnv {
  const inherited = f.env["PATH"] ?? "";
  const kept = inherited
    .split(":")
    .filter((dir) => dir !== "" && !hide.some((name) => existsSync(join(dir, name))));
  return { ...f.env, PATH: [...first, ...kept].join(":") };
}

/** hmo then prd, with the given env and shell; the statuses and both runs' stderr. */
export function fullRun(f: Fixture, env: NodeJS.ProcessEnv, shell = "bash") {
  const h = hmo(f, env, shell);
  if (h.status !== 0) return { hmo: h.status, prd: null, stderr: h.stderr };
  const p = prd(f, env, shell);
  return { hmo: h.status, prd: p.status, stderr: `${h.stderr}${p.stderr}` };
}
