/**
 * scripts/ci.sh and scripts/check-release.sh, run as scripts in disposable repositories. Each
 * repository holds copies of the real gate scripts; PATH holds fake tools (bun, node, npm,
 * gitleaks, zizmor, docker) that do what the real ones would, or the failure a test plants. The
 * fake bun hands scripts/evidence.ts and scripts/gate-manifest.ts to the real Bun, and the fake
 * node hands `-e` to the real Node, so identity and the manifest are the real ones.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RELEASE } from "../bench/acceptance.js";
import type { Snapshot } from "../scripts/evidence.js";
import { benchProblems } from "../scripts/gate-manifest.js";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

const ROOT = join(import.meta.dir, "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "relembra-gate-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const which = (name: string) =>
  spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
const REAL_GIT = which("git");
const REAL_NODE = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();

const STEPS = [
  "identity",
  "install",
  "lint",
  "typecheck",
  "gitleaks",
  "zizmor",
  "cli",
  "tests",
  "node",
  "pack",
  "sbom",
  "eval",
  "identity-after",
];

function write(path: string, text: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

/** One shell snippet per faked call; each default succeeds and leaves what the real tool would. */
const DEFAULTS = {
  install: "exit 0",
  lint: "exit 0",
  typecheck: "exit 0",
  gitleaks: "exit 0",
  zizmor: "exit 0",
  cli: `mkdir -p bin && printf 'fake relembra\\n' >bin/relembra && '${REAL_NODE}' -e 'const c = require("node:crypto"), f = require("node:fs"); f.writeFileSync("bin/relembra.sha256", c.createHash("sha256").update(f.readFileSync("bin/relembra")).digest("hex") + "  relembra\\n")'`,
  tests: `echo "tests REQUIRE=$RELEMBRA_REQUIRE_BINARY BINARY=$RELEMBRA_BINARY URL=$RELEMBRA_POSTGRES_URL" >>"$LOG"`,
  nodeTests: "exit 0",
  packCheck: "exit 0",
  nodeConsumer: "exit 0",
  bunConsumer: "exit 0",
  eval: `mkdir -p "$4" && echo '{}' >"$4/results-fake.json"`,
  // A passing strict record naming the candidate as it is now (bench_record, below).
  bench: 'bench_record "$4"',
  // Runs before the real `gate-manifest.ts finish`; a planted `exit 0` skips it.
  finish: ":",
};
/** A commit landing between the gate and the benchmark: clean, and another candidate. */
const GAP_COMMIT = `printf ' ' >>src/a.ts && git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false commit -qam gap`;
type Plan = Partial<typeof DEFAULTS>;

/**
 * A complete strict benchmark record with planted samples, no timing: the pinned corpus, the
 * release sampling, both runtimes, an intact store. `identity` is filled in when it is written.
 */
function plantedRecord(options: { findMs?: number; samples?: boolean } = {}) {
  const set = (n: number, ms: number) => Array.from({ length: n }, () => ms);
  const runtime = () => ({
    warm: {
      find: set(RELEASE.warm, options.findMs ?? 10),
      wake: set(RELEASE.warm, 12),
      brief: set(RELEASE.warm, 14),
    },
    cold: {
      find: set(RELEASE.cold, 90),
      wake: set(RELEASE.cold, 95),
      brief: set(RELEASE.cold, 99),
    },
  });
  return {
    complete: true,
    parameters: {
      memories: RELEASE.memories,
      seed: RELEASE.seed,
      warm: { warmup: RELEASE.warmup, measured: RELEASE.warm },
      cold: { warmup: 3, measured: RELEASE.cold },
    },
    corpus: { textSha256: RELEASE.corpusSha256 },
    store: { identicalRebuild: true, unchangedByReads: true, integrity: "ok" },
    samples: options.samples === false ? {} : { bun: runtime(), node: runtime() },
    identity: { before: null as Snapshot | null, after: null as Snapshot | null },
    errors: [] as string[],
    check: { passed: true, failures: [] as string[] },
  };
}

/** The fake tools for one test, in a directory outside its repository; returns PATH. */
function tools(dir: string, planned: Plan = {}, realBun = false, record = plantedRecord()): string {
  const p = { ...DEFAULTS, ...planned };
  const bin = join(dir, "bin");
  const head = `#!/bin/sh\nLOG='${join(dir, "calls.log")}'\n`;
  // bench_record's writer: the planted record with the checkout's snapshot as its identity.
  write(join(dir, "record.json"), JSON.stringify(record));
  write(
    join(dir, "make-record.ts"),
    `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { snapshot } = await import(join(process.cwd(), "scripts", "evidence.ts"));
const [out, passed] = process.argv.slice(2);
const record = JSON.parse(readFileSync(${JSON.stringify(join(dir, "record.json"))}, "utf8"));
const now = snapshot(process.cwd());
record.identity = { before: now, after: now };
if (passed === "false") record.check.passed = false;
writeFileSync(out, JSON.stringify(record, null, 2) + "\\n");
`,
  );
  if (realBun) {
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
  } else {
    write(
      join(bin, "bun"),
      `${head}case "$1 $2" in "scripts/gate-manifest.ts finish") ${p.finish} ;; esac
case "$1" in scripts/evidence.ts|scripts/gate-manifest.ts) exec '${process.execPath}' "$@" ;; esac
# bench_record OUT [passed]: the record bench/eval-latency.ts --check writes, identity included.
bench_record() {
  mkdir -p "$1/bench-fake" || exit 1
  '${process.execPath}' '${join(dir, "make-record.ts")}' "$1/bench-fake/bench.json" "\${2:-true}"
}
echo "bun $*" >>"$LOG"
case "$*" in
  "install --frozen-lockfile") ${p.install} ;;
  "run lint") ${p.lint} ;;
  "run typecheck") ${p.typecheck} ;;
  "build/cli.ts --force") ${p.cli} ;;
  "run test:all") ${p.tests} ;;
  "run test:node") ${p.nodeTests} ;;
  "scripts/pack-smoke.ts --tarball "*) ${p.bunConsumer} ;;
  "run eval --out "*) ${p.eval} ;;
  "bench/eval-latency.ts --check "*) ${p.bench} ;;
  *) echo "unexpected: bun $*" >&2; exit 97 ;;
esac
`,
      0o755,
    );
  }
  write(
    join(bin, "node"),
    `${head}case "$1" in -e|-p) exec '${REAL_NODE}' "$@" ;; esac
echo "node $*" >>"$LOG"
case "$*" in
  "scripts/pack-check.ts") ${p.packCheck} ;;
  "scripts/pack-smoke.ts --tarball "*) ${p.nodeConsumer} ;;
  *) echo "unexpected: node $*" >&2; exit 97 ;;
esac
`,
    0o755,
  );
  write(
    join(bin, "npm"),
    `${head}echo "npm $*" >>"$LOG"
case "$*" in
  "pack --ignore-scripts --pack-destination "*) printf 'fake tarball\\n' >"$4/relembra-0.0.0.tgz" ;;
  "sbom --sbom-format cyclonedx") echo '{"bomFormat":"CycloneDX"}' ;;
  *) echo "unexpected: npm $*" >&2; exit 97 ;;
esac
`,
    0o755,
  );
  write(join(bin, "gitleaks"), `${head}echo "gitleaks $*" >>"$LOG"\n${p.gitleaks}\n`, 0o755);
  write(join(bin, "zizmor"), `${head}echo "zizmor $*" >>"$LOG"\n${p.zizmor}\n`, 0o755);
  write(
    join(bin, "docker"),
    `${head}echo "docker $*" >>"$LOG"
case "$1" in
  run|exec|rm) exit 0 ;;
  port) echo "127.0.0.1:55432" ;;
  *) exit 97 ;;
esac
`,
    0o755,
  );
  symlinkSync(REAL_GIT, join(bin, "git"));
  return `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

function git(root: string, ...args: string[]) {
  const run = spawnSync(
    REAL_GIT,
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: scratch } },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

let fixtures = 0;
/** A committed repository with the real gate scripts and one input of each kind. */
function fixture(commit = true): { dir: string; root: string } {
  const dir = join(scratch, `case-${++fixtures}`);
  const root = join(dir, "repo");
  for (const script of ["ci.sh", "check-release.sh", "with-postgres.sh"]) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    cpSync(join(ROOT, "scripts", script), join(root, "scripts", script));
    chmodSync(join(root, "scripts", script), 0o755);
  }
  // The helpers, and what gate-manifest.ts imports for the strict verdict.
  for (const path of [
    "scripts/evidence.ts",
    "scripts/gate-manifest.ts",
    "bench/acceptance.ts",
    "eval/generate.ts",
    "eval/prng.ts",
    "eval/set.ts",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path));
  }
  // Every package script a gate could call fails if it runs (the fake bun never runs them).
  const scripts = [
    "lint",
    "typecheck",
    "build:cli",
    "test:all",
    "test:node",
    "eval",
    "check:pack",
    "test:pack",
  ];
  write(
    join(root, "package.json"),
    `${JSON.stringify({ scripts: Object.fromEntries(scripts.map((s) => [s, "exit 1"])) }, null, 2)}\n`,
  );
  write(join(root, "tsconfig.json"), "{}\n");
  write(join(root, "src", "a.ts"), "export const a = 1;\n");
  write(join(root, "test", "a.test.ts"), "// a test\n");
  write(join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  if (commit) {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fixture");
  }
  return { dir, root };
}

const baseEnv = (path: string) => ({
  PATH: path,
  HOME: scratch,
  TMPDIR: process.env["TMPDIR"] ?? "/tmp",
});

function run(
  root: string,
  script: string,
  path: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync(join(root, "scripts", script), args, {
    cwd: root,
    encoding: "utf8",
    env: { ...baseEnv(path), ...env },
    timeout: 120_000,
  });
}

interface Manifest {
  verdict: string;
  complete: boolean;
  candidate: { commit: string; digest: string } | null;
  steps: {
    name: string;
    status: string;
    exitCode: number | null;
    command: string | null;
    log: string | null;
  }[];
  artifacts: {
    name: string;
    path: string | null;
    verified: boolean;
    sha256Before: string | null;
  }[];
  outputs: { name: string; path: string; sha256: string }[];
  failures: string[];
}

const attempts = (root: string) => {
  const dir = join(root, ".scratch", "ci");
  return existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((name) => join(dir, name))
    : [];
};
const manifestIn = (attempt: string) =>
  JSON.parse(readFileSync(join(attempt, "manifest.json"), "utf8")) as Manifest;
const hex = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const step = (m: Manifest, name: string) => m.steps.find((s) => s.name === name);
const calls = (dir: string) =>
  existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "";

describe.skipIf(NO_RELEASE_TOOLING)("scripts/ci.sh", () => {
  test("every required step passes: the manifest says so, with the candidate and its artifacts", () => {
    const { dir, root } = fixture();
    // Set but empty is no override and no skip.
    const ci = run(root, "ci.sh", tools(dir), [], {
      BUN_OPTIONS: "",
      RELEMBRA_SKIP_BUILD_TOOLCHAIN: "",
    });
    expect(ci.stderr).toBe("");
    expect(ci.status).toBe(0);
    const [attempt] = attempts(root);
    expect(attempt).toBeDefined();
    expect(ci.stdout).toContain(`manifest: ${attempt}/manifest.json`);
    const m = manifestIn(attempt as string);
    expect(m).toMatchObject({ verdict: "pass", complete: true, failures: [] });
    expect(m.candidate?.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(m.steps.map((s) => s.name)).toEqual(STEPS);
    for (const s of m.steps) {
      expect(s).toMatchObject({ status: "pass", exitCode: 0 });
      expect(existsSync(s.log as string)).toBe(true);
    }
    expect(m.artifacts.map((a) => [a.name, a.verified])).toEqual([
      ["cli", true],
      ["package", true],
    ]);
    expect(m.outputs.map((o) => o.name)).toEqual(["sbom", "eval/results-fake.json"]);

    const log = calls(dir);
    // Built for this candidate, never a cached binary; the tests use exactly that binary.
    expect(log).toContain("bun build/cli.ts --force");
    expect(log).toContain(
      `tests REQUIRE=1 BINARY=${root}/bin/relembra URL=postgres://postgres:relembra-test@127.0.0.1:55432/postgres`,
    );
    // One tarball, kept in the attempt directory, installed by both runtimes.
    const tarball = `${attempt}/package/relembra-0.0.0.tgz`;
    expect(m.artifacts[1]?.path).toBe(tarball);
    expect(log).toContain(`node scripts/pack-smoke.ts --tarball ${tarball}`);
    expect(log).toContain(`bun scripts/pack-smoke.ts --tarball ${tarball}`);
    expect(readFileSync(tarball, "utf8")).toBe("fake tarball\n");
  }, 60_000);

  test("generated output does not change the candidate", () => {
    const { dir, root } = fixture();
    const path = tools(dir, {
      tests:
        "mkdir -p dist docs/eval eval/out && echo x >dist/gen.js && echo x >docs/eval/r.json && echo x >eval/out/r",
    });
    const ci = run(root, "ci.sh", path);
    expect(ci.status).toBe(0);
    expect(manifestIn(attempts(root)[0] as string).verdict).toBe("pass");
  }, 60_000);

  test("a failed step fails the gate, and every attempt keeps its manifest", () => {
    const { dir, root } = fixture();
    const path = tools(dir, { lint: "echo 'lint found 1 error' >&2; exit 1" });
    const first = run(root, "ci.sh", path);
    expect(first.status).toBe(1);
    const [attempt] = attempts(root);
    const kept = readFileSync(join(attempt as string, "manifest.json"), "utf8");
    const m = manifestIn(attempt as string);
    expect(m.verdict).toBe("fail");
    expect(step(m, "lint")).toMatchObject({ status: "fail", exitCode: 1 });
    expect(step(m, "typecheck")).toMatchObject({ status: "pass", exitCode: 0 });
    expect(m.failures).toContain("lint: exit 1");
    expect(first.stdout).toContain("lint found 1 error");

    expect(run(root, "ci.sh", path).status).toBe(1);
    expect(attempts(root)).toHaveLength(2);
    expect(readFileSync(join(attempt as string, "manifest.json"), "utf8")).toBe(kept);
  }, 60_000);

  test("a manifest step that exits 0 without writing the verdict cannot pass", () => {
    // As a Bun that returns early would: the manifest is still the pending one.
    const { dir, root } = fixture();
    const ci = run(root, "ci.sh", tools(dir, { finish: "exit 0" }));
    expect(ci.status).toBe(1);
    expect(manifestIn(attempts(root)[0] as string)).toMatchObject({
      verdict: "pending",
      complete: false,
    });
  }, 60_000);

  test("a step killed before it finished is missing, never a pass", () => {
    const { dir, root } = fixture();
    // Kills the step's own wrapper, so no exit code is ever written.
    const ci = run(root, "ci.sh", tools(dir, { typecheck: 'kill -KILL "$PPID"' }));
    expect(ci.status).toBe(1);
    const m = manifestIn(attempts(root)[0] as string);
    expect(step(m, "typecheck")).toMatchObject({ status: "missing", exitCode: null });
    expect(m.failures).toContain("typecheck: did not finish");
    expect(m.verdict).toBe("fail");
  }, 60_000);

  test("a failed dependency leaves the steps after it skipped, each one explicit", () => {
    const { dir, root } = fixture();
    const ci = run(root, "ci.sh", tools(dir, { install: "exit 3" }));
    expect(ci.status).toBe(1);
    const m = manifestIn(attempts(root)[0] as string);
    expect(step(m, "install")).toMatchObject({ status: "fail", exitCode: 3 });
    for (const name of [
      "lint",
      "typecheck",
      "gitleaks",
      "zizmor",
      "cli",
      "tests",
      "node",
      "pack",
      "sbom",
      "eval",
    ]) {
      expect(step(m, name)).toMatchObject({ status: "skipped", exitCode: null, command: null });
      expect(m.failures).toContain(`${name}: skipped`);
    }
    expect(calls(dir)).not.toContain("bun run lint");
    expect(m.verdict).toBe("fail");
  }, 60_000);

  test("an input changed during the gate fails it: a test or a configuration file", () => {
    for (const [plan, file] of [
      [{ lint: "printf '// changed\\n' >>test/a.test.ts" }, "test/a.test.ts"],
      [{ typecheck: "printf ' ' >>tsconfig.json" }, "tsconfig.json"],
    ] as const) {
      const { dir, root } = fixture();
      const ci = run(root, "ci.sh", tools(dir, plan));
      expect(ci.status).toBe(1);
      const m = manifestIn(attempts(root)[0] as string);
      expect(step(m, "identity-after")).toMatchObject({ status: "fail" });
      expect(m.failures).toContain(`changed during the gate: ${file} changed`);
      expect(m.verdict).toBe("fail");
    }
  }, 60_000);

  test("an uncommitted input stops the gate before any step", () => {
    const { dir, root } = fixture();
    write(join(root, "src", "b.ts"), "export {};\n");
    const ci = run(root, "ci.sh", tools(dir));
    expect(ci.status).toBe(1);
    const m = manifestIn(attempts(root)[0] as string);
    expect(step(m, "identity")).toMatchObject({ status: "fail" });
    expect(step(m, "install")).toMatchObject({ status: "skipped" });
    expect(m.failures).toContain("before: src/b.ts is not in HEAD");
    expect(calls(dir)).toBe("");
  }, 60_000);

  test("an artifact changed after its hash was taken is not verified", () => {
    for (const [plan, name] of [
      [{ tests: "printf x >>bin/relembra" }, "cli"],
      [{ bunConsumer: 'printf x >>"$3"' }, "package"],
    ] as const) {
      const { dir, root } = fixture();
      const ci = run(root, "ci.sh", tools(dir, plan));
      expect(ci.status).toBe(1);
      const m = manifestIn(attempts(root)[0] as string);
      expect(m.artifacts.find((a) => a.name === name)?.verified).toBe(false);
      expect(m.failures.join("\n")).toContain(`${name}: changed after it was recorded`);
      expect(m.verdict).toBe("fail");
    }
  }, 60_000);

  test("an inherited skip or runtime override is refused by name before anything runs", () => {
    const { dir, root } = fixture();
    const path = tools(dir);
    for (const [name, value] of [
      ["RELEMBRA_SKIP_BUILD_TOOLCHAIN", "1"],
      ["BUN_OPTIONS", "--smol"],
      ["BUN_BE_BUN", "1"],
      ["BUN_BYTECODE_ORDER_OUT", join(dir, "order")],
      ["NODE_OPTIONS", "--max-old-space-size=4099"],
      ["NODE_PATH", "/elsewhere"],
      ["BUN_JSC_useJIT", "0"],
      ["JSC_useJIT", "0"],
    ] as const) {
      const ci = run(root, "ci.sh", path, [], { [name]: value });
      expect(ci.status).toBe(2);
      expect(ci.stderr).toContain(name);
      expect(ci.stderr).not.toContain(value);
    }
    expect(attempts(root)).toEqual([]);
    expect(calls(dir)).toBe("");
  }, 60_000);

  test("BUN_OPTIONS=--version cannot pass the gate through the real Bun's early exit", () => {
    // The real Bun: under this option every `bun` prints its version and exits 0, so the
    // fixture's package scripts, each `exit 1`, would never run and every step would "pass".
    const { dir, root } = fixture();
    const ci = run(root, "ci.sh", tools(dir, {}, true), [], { BUN_OPTIONS: "--version" });
    expect(ci.status).toBe(2);
    expect(ci.stderr).toContain("BUN_OPTIONS");
    expect(attempts(root)).toEqual([]);
  }, 60_000);

  test("the gate enters its own repository whatever CDPATH says, and refuses a non-repository", () => {
    const { dir, root } = fixture();
    // A decoy with a scripts/ directory, where `cd scripts/..` would land through CDPATH.
    const decoy = join(dir, "decoy");
    mkdirSync(join(decoy, "scripts"), { recursive: true });
    const ci = spawnSync("scripts/ci.sh", [], {
      cwd: root,
      encoding: "utf8",
      env: { ...baseEnv(tools(dir)), CDPATH: decoy },
      timeout: 120_000,
    });
    expect(ci.status).toBe(0);
    expect(attempts(root)).toHaveLength(1);
    expect(existsSync(join(decoy, ".scratch"))).toBe(false);

    const plain = fixture(false);
    const outside = run(plain.root, "ci.sh", tools(plain.dir));
    expect(outside.status).toBe(1);
    const m = manifestIn(attempts(plain.root)[0] as string);
    expect(step(m, "identity")).toMatchObject({ status: "fail" });
    expect(step(m, "install")).toMatchObject({ status: "skipped" });
    expect(m.failures.join("\n")).toContain("before: inputs unavailable");
    expect(calls(plain.dir)).toBe("");
  }, 60_000);
});

describe.skipIf(NO_RELEASE_TOOLING)("scripts/gate-manifest.ts", () => {
  const manifestCli = (...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, "scripts", "gate-manifest.ts"), ...args], {
      encoding: "utf8",
      timeout: 30_000,
    });

  test("an empty attempt directory fails: every required step skipped, nothing inferred", () => {
    const attempt = join(scratch, "empty-attempt");
    mkdirSync(attempt);
    const finish = manifestCli("finish", attempt);
    expect(finish.status).toBe(1);
    const m = manifestIn(attempt);
    expect(m.verdict).toBe("fail");
    expect(m.steps.map((s) => [s.name, s.status, s.exitCode])).toEqual(
      STEPS.map((name) => [name, "skipped", null]),
    );
    expect(m.failures).toContain("no identity before the gate");
    expect(m.failures).toContain("cli: not recorded");
  });

  test("an exit code file it cannot read is a failure, not a pass", () => {
    const attempt = join(scratch, "garbled-attempt");
    mkdirSync(attempt);
    writeFileSync(join(attempt, "lint.cmd"), "bun run lint\n");
    writeFileSync(join(attempt, "lint.rc"), "zero\n");
    manifestCli("finish", attempt);
    expect(step(manifestIn(attempt), "lint")).toMatchObject({ status: "fail", exitCode: null });
  });

  test("record refuses a second hash under one name and anything but a regular file", () => {
    const attempt = join(scratch, "record-attempt");
    mkdirSync(attempt);
    const file = join(attempt, "artifact");
    writeFileSync(file, "bytes\n");
    expect(manifestCli("record", attempt, "cli", file).status).toBe(0);
    expect(manifestCli("record", attempt, "cli", file).status).toBe(1);
    expect(manifestCli("record", attempt, "package", attempt).status).toBe(1);
    expect(manifestCli("record", attempt, "package", join(attempt, "absent")).status).toBe(1);
    expect(readFileSync(join(attempt, "artifacts.tsv"), "utf8").split("\n")).toHaveLength(2);
  });

  /** A passed manifest naming a tested binary (with its checksum file) and one package archive. */
  function gated(name: string) {
    const dir = join(scratch, name);
    const cli = join(dir, "bin", "relembra");
    const pkg = join(dir, "package", "relembra-0.0.0.tgz");
    write(cli, "tested binary\n");
    write(`${cli}.sha256`, `${hex("tested binary\n")}  relembra\n`);
    write(pkg, "tested package\n");
    const entry = (artifact: string, path: string, text: string) => ({
      name: artifact,
      path,
      sha256Before: hex(text),
      sha256After: hex(text),
      verified: true,
    });
    const manifest = {
      verdict: "pass",
      complete: true,
      artifacts: [
        entry("cli", cli, "tested binary\n"),
        entry("package", pkg, "tested package\n"),
      ] as const,
    };
    return { dir, cli, pkg, manifest, path: join(dir, "manifest.json") };
  }
  /** Writes the manifest (JSON, or raw text as given) and returns the sha256 of its bytes. */
  const writeManifest = (path: string, value: unknown) => {
    const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(path, text);
    return hex(text);
  };

  test("pin prints a passed manifest's sha256; artifacts then accepts it and names its bytes", () => {
    const g = gated("pinned-ok");
    const pinned = writeManifest(g.path, g.manifest);
    const pin = manifestCli("pin", g.path);
    expect(pin.stderr).toBe("");
    expect(pin.status).toBe(0);
    expect(pin.stdout).toBe(`${pinned}\n`);
    const check = manifestCli("artifacts", g.path, pinned);
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(`cli: ${g.cli} (sha256 ${hex("tested binary\n")})`);
    expect(check.stdout).toContain(`package: ${g.pkg} (sha256 ${hex("tested package\n")})`);
    // A file that is not an archive beside the package is not a second package.
    writeFileSync(join(g.dir, "package", "notes.txt"), "notes\n");
    expect(manifestCli("artifacts", g.path, pinned).status).toBe(0);
  });

  test("artifacts refuses a manifest other than the pinned one, though its own hashes agree", () => {
    const g = gated("pinned-forged");
    const pinned = writeManifest(g.path, g.manifest);
    const forged = join(g.dir, "forged", "relembra-0.0.0.tgz");
    write(forged, "forged package\n");
    const [cli, pkg] = g.manifest.artifacts;
    const rewritten = {
      ...g.manifest,
      artifacts: [
        cli,
        {
          ...pkg,
          path: forged,
          sha256Before: hex("forged package\n"),
          sha256After: hex("forged package\n"),
        },
      ],
    };
    const forgedSha = writeManifest(g.path, rewritten);
    const check = manifestCli("artifacts", g.path, pinned);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      `is not the pinned gate manifest (sha256 ${forgedSha}, pinned ${pinned})`,
    );
    expect(check.stdout).toBe("");
    // Positive control: the forgery is otherwise consistent, so only the pin rejects it.
    expect(manifestCli("artifacts", g.path, forgedSha).status).toBe(0);
    // A pin that is not a sha256, or no pin at all, is refused.
    expect(manifestCli("artifacts", g.path, "abc").status).toBe(1);
    expect(manifestCli("artifacts", g.path, forgedSha.toUpperCase()).status).toBe(1);
    expect(manifestCli("artifacts", g.path).status).toBe(2);
  });

  test("a malformed manifest fails pin, and artifacts even when pinned to its exact bytes", () => {
    const g = gated("pinned-malformed");
    const [cli, pkg] = g.manifest.artifacts;
    const notPassed = "is not a passed gate manifest";
    const noArtifact = (name: string) => `${name}: no verified original artifact`;
    for (const [what, value, reason] of [
      ["not JSON", "{", notPassed],
      ["a failed verdict", { ...g.manifest, verdict: "fail" }, notPassed],
      ["not complete", { ...g.manifest, complete: false }, notPassed],
      ["no artifact list", { ...g.manifest, artifacts: {} }, notPassed],
      ["a duplicate entry", { ...g.manifest, artifacts: [cli, cli, pkg] }, noArtifact("cli")],
      ["a missing entry", { ...g.manifest, artifacts: [cli] }, noArtifact("package")],
      [
        "a malformed hash",
        { ...g.manifest, artifacts: [cli, { ...pkg, sha256Before: "x" }] },
        noArtifact("package"),
      ],
      [
        "before and after disagreeing",
        { ...g.manifest, artifacts: [{ ...cli, sha256After: hex("other\n") }, pkg] },
        noArtifact("cli"),
      ],
      [
        "an unverified entry",
        { ...g.manifest, artifacts: [cli, { ...pkg, verified: false }] },
        noArtifact("package"),
      ],
      [
        "an empty path",
        { ...g.manifest, artifacts: [{ ...cli, path: "" }, pkg] },
        noArtifact("cli"),
      ],
    ] as const) {
      const pinned = writeManifest(g.path, value);
      const pin = manifestCli("pin", g.path);
      expect(pin.status, what).toBe(1);
      expect(pin.stdout, what).toBe("");
      const check = manifestCli("artifacts", g.path, pinned);
      expect(check.status, what).toBe(1);
      expect(check.stderr, what).toContain(reason);
    }
    // Positive control: the same file, well formed again, passes both.
    const pinned = writeManifest(g.path, g.manifest);
    expect(manifestCli("pin", g.path).stdout).toBe(`${pinned}\n`);
    expect(manifestCli("artifacts", g.path, pinned).status).toBe(0);
  });

  test("artifacts rechecks the bytes: changed package, or a second archive beside it, fail", () => {
    const g = gated("pinned-files");
    const pinned = writeManifest(g.path, g.manifest);
    const extra = join(g.dir, "package", "a-extra.tgz");
    writeFileSync(extra, "extra\n");
    const second = manifestCli("artifacts", g.path, pinned);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("a-extra.tgz");
    expect(second.stdout).toBe("");
    rmSync(extra);
    expect(manifestCli("artifacts", g.path, pinned).status).toBe(0);
    writeFileSync(g.pkg, "changed\n");
    const changed = manifestCli("artifacts", g.path, pinned);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("package: changed after it was recorded");
  });
});

describe.skipIf(NO_RELEASE_TOOLING)("benchProblems", () => {
  const runtime = (path: string) => ({
    path,
    version: "1",
    sqlite: "3.54.0",
    sha256: "e".repeat(64),
  });
  const GATE: Snapshot = {
    inputs: {
      available: true,
      clean: true,
      commit: "a".repeat(40),
      digest: "b".repeat(64),
      files: { "src/a.ts": `100644 ${"c".repeat(40)}` },
      dirty: [],
      untracked: [],
      errors: [],
    },
    runtimes: { available: true, bun: runtime("/bun"), node: runtime("/node"), errors: [] },
  };
  const measured = (options: Parameters<typeof plantedRecord>[0] = {}) => ({
    ...plantedRecord(options),
    identity: { before: GATE, after: GATE },
  });

  test("a complete passed record of the gated candidate, with valid samples, is a pass", () => {
    expect(benchProblems(GATE, measured())).toEqual([]);
  });

  test("the passed flag alone is never trusted: the strict verdict reruns on the record", () => {
    // Complete, passed and the right identity, and nothing measured.
    const bare = {
      complete: true,
      check: { passed: true },
      identity: { before: GATE, after: GATE },
    };
    expect(benchProblems(GATE, bare).length).toBeGreaterThan(0);
    expect(benchProblems(GATE, measured({ samples: false })).join("\n")).toContain(
      "strict verdict: bun warm find: no samples",
    );
    expect(benchProblems(GATE, measured({ findMs: 50.004 })).join("\n")).toContain(
      "strict verdict: bun warm find p95 is 50.004 ms, over the 50 ms budget",
    );
  });

  test("a gate snapshot that is not clean evidence, or a malformed record, fails", () => {
    const dirty = { ...GATE, inputs: { ...GATE.inputs, clean: false, untracked: ["src/b.ts"] } };
    expect(
      benchProblems(dirty, { ...measured(), identity: { before: dirty, after: dirty } }),
    ).toContain("gate snapshot: src/b.ts is not in HEAD");
    for (const malformed of [
      null,
      "record",
      { complete: true, check: { passed: true }, parameters: 1 },
    ]) {
      expect(benchProblems(GATE, malformed).length).toBeGreaterThan(0);
    }
    expect(benchProblems({} as Snapshot, measured()).length).toBeGreaterThan(0);
  });
});

describe.skipIf(NO_RELEASE_TOOLING)("scripts/check-release.sh", () => {
  const releases = (root: string) =>
    readdirSync(join(root, ".scratch", "release"))
      .sort()
      .map((name) => join(root, ".scratch", "release", name));

  test("runs the gate, then the strict benchmark, and prints where everything is kept", () => {
    const { dir, root } = fixture();
    const path = tools(dir);
    const first = run(root, "check-release.sh", path);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const [release] = releases(root);
    expect(manifestIn(join(release as string, "gate")).verdict).toBe("pass");
    expect(first.stdout).toContain(`gate manifest: ${release}/gate/manifest.json`);
    expect(first.stdout).toContain(`benchmark: ${release}/bench/bench-fake/bench.json`);
    const gateManifest = readFileSync(join(release as string, "gate/manifest.json"));
    expect(first.stdout).toContain(`gate manifest sha256: ${hex(gateManifest)}`);
    expect(first.stdout).toContain(`package: ${release}/gate/package/relembra-0.0.0.tgz (sha256 `);
    // The marker scripts/deploy.sh reads: written last, naming the pinned manifest and the record.
    expect(
      JSON.parse(readFileSync(join(release as string, "release-check.json"), "utf8")),
    ).toMatchObject({
      passed: true,
      manifest: `${release}/gate/manifest.json`,
      manifestSha256: hex(gateManifest),
      benchmark: `${release}/bench/bench-fake/bench.json`,
    });
    const log = calls(dir);
    // The benchmark runs after the gate, in this run's own directories.
    expect(log.indexOf("bench/eval-latency.ts")).toBeGreaterThan(log.indexOf("run eval"));
    expect(log).toContain(
      `bun bench/eval-latency.ts --check --out ${release}/bench --work ${release}/work`,
    );
    // Each invocation has its own directory.
    expect(run(root, "check-release.sh", path).status).toBe(0);
    expect(releases(root)).toHaveLength(2);
  }, 120_000);

  test("stops at a failed gate, a failed benchmark, or a record that is not a strict pass", () => {
    for (const [plan, where, reason, record] of [
      [{ eval: "exit 1" }, "gate", "eval: exit 1", plantedRecord()],
      [{ bench: "exit 1" }, "benchmark", "", plantedRecord()],
      // Exit 0, as an early exit would, with no record or one that did not pass.
      [{ bench: "exit 0" }, "benchmark", "no record", plantedRecord()],
      [{ bench: 'bench_record "$4" false' }, "benchmark", "did not pass", plantedRecord()],
      // Marked passed, and still not a release: no samples, or warm find over the budget.
      [{}, "benchmark", "bun warm find: no samples", plantedRecord({ samples: false })],
      [{}, "benchmark", "over the 50 ms budget", plantedRecord({ findMs: 50.004 })],
    ] as const) {
      const { dir, root } = fixture();
      const release = run(root, "check-release.sh", tools(dir, plan, false, record));
      expect(release.status).toBe(1);
      expect(release.stderr).toContain(`release check FAILED: ${where}`);
      expect(`${release.stdout}${release.stderr}`).toContain(reason);
      if (where === "gate") expect(calls(dir)).not.toContain("bench/eval-latency.ts");
    }
  }, 180_000);

  for (const when of ["before", "after"] as const) {
    for (const [name, change, reason] of [
      ["binary mutation", "printf changed >bin/relembra", "cli: changed after it was recorded"],
      [
        "checksum mutation",
        "printf changed >bin/relembra.sha256",
        "does not name the tested binary",
      ],
      [
        "package mutation",
        'printf changed >"$4/../gate/package/relembra-0.0.0.tgz"',
        "package: changed after it was recorded",
      ],
      ["binary deletion", "rm bin/relembra", "is gone"],
      ["checksum deletion", "rm bin/relembra.sha256", "does not name the tested binary"],
      ["package deletion", 'rm "$4/../gate/package/relembra-0.0.0.tgz"', "is gone"],
    ] as const) {
      test(`rejects ${name} ${when} the benchmark record without rewriting gate evidence`, () => {
        const { dir, root } = fixture();
        const preserve =
          'mkdir -p "$4" && cp "$4/../gate/manifest.json" "$4/../manifest-original.json" && cp "$4/../gate/artifacts.tsv" "$4/../artifacts-original.tsv"';
        const bench =
          when === "before"
            ? `${preserve} && ${change} && bench_record "$4"`
            : `${preserve} && bench_record "$4" && ${change}`;
        const release = run(root, "check-release.sh", tools(dir, { bench }));
        expect(release.status, `${release.stdout}\n${release.stderr}`).toBe(1);
        expect(release.stderr).toContain("release check FAILED: artifacts");
        expect(release.stderr).toContain(reason);
        expect(release.stdout).not.toContain("release check passed");
        const attempt = releases(root)[0] as string;
        expect(readFileSync(join(attempt, "gate/manifest.json"), "utf8")).toBe(
          readFileSync(join(attempt, "manifest-original.json"), "utf8"),
        );
        expect(readFileSync(join(attempt, "gate/artifacts.tsv"), "utf8")).toBe(
          readFileSync(join(attempt, "artifacts-original.tsv"), "utf8"),
        );
        expect(manifestIn(join(attempt, "gate")).verdict).toBe("pass");
      }, 60_000);
    }
  }

  test("rejects a second archive added beside the tested one, and never names it", () => {
    const { dir, root } = fixture();
    // Sorts before relembra-0.0.0.tgz, so a glob's first match would be the untested one.
    const bench = 'bench_record "$4" && printf extra >"$4/../gate/package/a-extra.tgz"';
    const release = run(root, "check-release.sh", tools(dir, { bench }));
    expect(release.status, `${release.stdout}\n${release.stderr}`).toBe(1);
    expect(release.stderr).toContain("release check FAILED: artifacts");
    expect(release.stderr).toContain("a-extra.tgz");
    expect(release.stdout).not.toContain("release check passed");
    expect(release.stdout).not.toContain("a-extra.tgz");
    // The tested archive itself is intact: only the extra file fails it.
    const attempt = releases(root)[0] as string;
    const m = manifestIn(join(attempt, "gate"));
    expect(m.verdict).toBe("pass");
    const tested = m.artifacts.find((a) => a.name === "package");
    expect(hex(readFileSync(tested?.path as string))).toBe(tested?.sha256Before as string);
  }, 60_000);

  test("rejects a gate manifest rewritten during the benchmark to name forged bytes", () => {
    const { dir, root } = fixture();
    // Points the package entry at a forged archive, with that archive's own hash before and after.
    const forge = `const c = require("node:crypto"), f = require("node:fs"); const [m, p] = process.argv.slice(1); const j = JSON.parse(f.readFileSync(m, "utf8")); const a = j.artifacts.find((x) => x.name === "package"); const h = c.createHash("sha256").update(f.readFileSync(p)).digest("hex"); a.path = p; a.sha256Before = h; a.sha256After = h; f.writeFileSync(m, JSON.stringify(j, null, 2) + "\\n");`;
    const bench = `bench_record "$4" && printf forged >"$4/../forged.tgz" && node -e '${forge}' "$4/../gate/manifest.json" "$4/../forged.tgz"`;
    const release = run(root, "check-release.sh", tools(dir, { bench }));
    expect(release.status, `${release.stdout}\n${release.stderr}`).toBe(1);
    expect(release.stderr).toContain("release check FAILED: artifacts");
    expect(release.stderr).toContain("is not the pinned gate manifest");
    expect(release.stdout).not.toContain("release check passed");
    expect(release.stdout).not.toContain("forged.tgz");
    // Positive control: the rewrite happened, and the forged entry is self-consistent.
    const attempt = releases(root)[0] as string;
    const forged = manifestIn(join(attempt, "gate")).artifacts.find((a) => a.name === "package");
    expect(forged?.path).toBe(`${attempt}/bench/../forged.tgz`);
    expect(hex(readFileSync(forged?.path as string))).toBe(forged?.sha256Before as string);
  }, 60_000);

  test("one candidate across the gate, the gap and the benchmark, or no release", () => {
    for (const [bench, where] of [
      // Clean and stable on its own, but not the commit the gate passed.
      [`${GAP_COMMIT} && bench_record "$4"`, "benchmark"],
      // Back on the gated commit by the end: only the record shows what was measured.
      [`${GAP_COMMIT} && bench_record "$4" && git reset -q --hard HEAD~1`, "benchmark"],
      // Measured the gated candidate, then changed before the final check.
      [`bench_record "$4" && printf ' ' >>src/a.ts`, "candidate"],
    ] as const) {
      const { dir, root } = fixture();
      const release = run(root, "check-release.sh", tools(dir, { bench }));
      expect(release.status).toBe(1);
      expect(release.stderr).toContain(`release check FAILED: ${where}`);
      expect(release.stderr).toContain("src/a.ts changed");
    }
  }, 180_000);

  test("an inherited override stops it in the gate, before any Bun runs", () => {
    const { dir, root } = fixture();
    const release = run(root, "check-release.sh", tools(dir, {}, true), [], {
      BUN_OPTIONS: "--version",
    });
    expect(release.status).toBe(1);
    expect(release.stderr).toContain("BUN_OPTIONS");
    expect(release.stderr).toContain("release check FAILED: gate");
  }, 60_000);
});
