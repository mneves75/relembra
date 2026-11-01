/**
 * The manifest of one scripts/ci.sh attempt: every required step with its real exit code, the
 * candidate's identity before and after (scripts/evidence.ts), and the hashes of the artifacts the
 * steps tested. The list of required steps is here, and only here.
 *
 *   bun scripts/gate-manifest.ts record DIR NAME FILE   # FILE's sha256, taken before it is used
 *   bun scripts/gate-manifest.ts finish DIR             # writes DIR/manifest.json; exit 0 on "pass"
 *   bun scripts/gate-manifest.ts pin MANIFEST           # prints a passed manifest's sha256
 *   bun scripts/gate-manifest.ts artifacts MANIFEST SHA # MANIFEST must still have that sha256;
 *                                                       # rechecks its tested bytes, prints them
 *   bun scripts/gate-manifest.ts bench SNAPSHOT RECORD  # exit 0 when a passed strict benchmark
 *                                                       # record measured SNAPSHOT's candidate
 *
 * DIR is the attempt directory scripts/ci.sh made. For each step it holds NAME.cmd (written when
 * the step starts), NAME.rc (`<exit code> <seconds>`, written when it ends) and NAME.log. A step
 * with no .cmd never started (skipped); one with a .cmd and no .rc did not finish (missing); an
 * .rc that does not parse failed. Only a parsed exit code of 0 passes: nothing is inferred from an
 * absent or unreadable file.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type Attempt, strictVerdict } from "../bench/acceptance.js";
import { identityChanges, type Snapshot, snapshotProblems } from "./evidence.js";

/** In the order scripts/ci.sh runs them. */
export const REQUIRED_STEPS = [
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
] as const;
/** Hashed by `record` before any step uses them, and again by `finish`. */
export const REQUIRED_ARTIFACTS = ["cli", "package"] as const;

export interface Step {
  readonly name: string;
  readonly status: "pass" | "fail" | "missing" | "skipped";
  readonly exitCode: number | null;
  readonly seconds: number | null;
  readonly command: string | null;
  readonly log: string | null;
}

export interface Artifact {
  readonly name: string;
  readonly path: string | null;
  readonly sha256Before: string | null;
  readonly sha256After: string | null;
  readonly verified: boolean;
}

export interface Output {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
}

export interface Manifest {
  readonly verdict: "pass" | "fail";
  readonly complete: true;
  readonly date: string;
  readonly attempt: string;
  readonly candidate: { readonly commit: string | null; readonly digest: string | null } | null;
  readonly runtimes: Snapshot["runtimes"] | null;
  readonly identity: { readonly before: string; readonly after: string };
  readonly steps: readonly Step[];
  readonly artifacts: readonly Artifact[];
  readonly outputs: readonly Output[];
  readonly failures: readonly string[];
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha256 = (path: string) => digest(readFileSync(path));

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function stepOf(dir: string, name: string): Step {
  const cmd = join(dir, `${name}.cmd`);
  const rc = join(dir, `${name}.rc`);
  const log = join(dir, `${name}.log`);
  if (!existsSync(cmd)) {
    return { name, status: "skipped", exitCode: null, seconds: null, command: null, log: null };
  }
  const command = readFileSync(cmd, "utf8").trimEnd();
  const logPath = existsSync(log) ? log : null;
  if (!existsSync(rc)) {
    return { name, status: "missing", exitCode: null, seconds: null, command, log: logPath };
  }
  const parsed = /^(\d+) (\d+)\n?$/.exec(readFileSync(rc, "utf8"));
  if (parsed === null) {
    return { name, status: "fail", exitCode: null, seconds: null, command, log: logPath };
  }
  const exitCode = Number(parsed[1]);
  const status = exitCode === 0 ? "pass" : "fail";
  return { name, status, exitCode, seconds: Number(parsed[2]), command, log: logPath };
}

/** artifacts.tsv: one `<name>\t<absolute path>\t<sha256>` line per recorded artifact. */
function recorded(dir: string): { name: string; path: string; sha256: string }[] {
  const file = join(dir, "artifacts.tsv");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", path = "", digest = ""] = line.split("\t");
      return { name, path, sha256: digest };
    });
}

/** Records FILE's sha256 under NAME, once; FILE must be a regular file. */
export function record(dir: string, name: string, file: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${name} is not an artifact name`);
  const path = resolve(file);
  if (/[\t\n]/.test(path)) throw new Error(`${path} has a tab or a newline`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) throw new Error(`${path} is not a regular file`);
  if (recorded(dir).some((entry) => entry.name === name)) {
    throw new Error(`${name} is already recorded`);
  }
  appendFileSync(join(dir, "artifacts.tsv"), `${name}\t${path}\t${sha256(path)}\n`);
}

function artifactOf(dir: string, name: string, failures: string[]): Artifact {
  const entries = recorded(dir).filter((entry) => entry.name === name);
  const entry = entries[0];
  if (entry === undefined || entries.length > 1) {
    failures.push(`${name}: ${entry === undefined ? "not recorded" : "recorded more than once"}`);
    return { name, path: null, sha256Before: null, sha256After: null, verified: false };
  }
  return checkArtifact(name, entry.path, entry.sha256, failures);
}

function checkArtifact(name: string, path: string, before: string, failures: string[]): Artifact {
  const after = existsSync(path) ? sha256(path) : null;
  let verified = after === before;
  if (after === null) failures.push(`${name}: ${path} is gone`);
  else if (!verified) {
    failures.push(`${name}: changed after it was recorded (${before}, now ${after})`);
  }
  // The binary's checksum file, as install.sh checks it, must name the tested binary.
  if (name === "cli" && verified) {
    const sums = `${path}.sha256`;
    if (!existsSync(sums) || readFileSync(sums, "utf8") !== `${after}  ${basename(path)}\n`) {
      failures.push(`cli: ${sums} does not name the tested binary`);
      verified = false;
    }
  }
  return { name, path, sha256Before: before, sha256After: after, verified };
}

interface Verified {
  /** The sha256 of the manifest bytes read, which are the bytes parsed; null when unreadable. */
  readonly sha256: string | null;
  readonly problems: readonly string[];
  /** `<name>: <path> (sha256 <hash>)` per artifact that passed; meaningful only without problems. */
  readonly lines: readonly string[];
}

/**
 * The tested artifacts a passed gate manifest names, rechecked on disk. Read-only: the gate's
 * original hashes are never replaced with the bytes present at release end. With `pinned`, the
 * manifest's own sha256 must still be the one it had right after the gate, so a manifest rewritten
 * since, however consistent, names nothing. The package's directory must hold that one archive.
 */
function verifiedArtifacts(path: string, pinned?: string): Verified {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { sha256: null, problems: [`${path} is not a passed gate manifest`], lines: [] };
  }
  const own = digest(bytes);
  if (pinned !== undefined && own !== pinned) {
    const problem = `${path} is not the pinned gate manifest (sha256 ${own}, pinned ${pinned})`;
    return { sha256: own, problems: [problem], lines: [] };
  }
  let m: Manifest | undefined;
  try {
    m = JSON.parse(bytes.toString("utf8")) as Manifest;
  } catch {
    m = undefined;
  }
  if (m?.verdict !== "pass" || m.complete !== true || !Array.isArray(m.artifacts)) {
    return { sha256: own, problems: [`${path} is not a passed gate manifest`], lines: [] };
  }
  const failures: string[] = [];
  const lines: string[] = [];
  for (const name of REQUIRED_ARTIFACTS) {
    const entries = m.artifacts.filter((a) => a?.name === name);
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      entry?.verified !== true ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      typeof entry.sha256Before !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256Before) ||
      entry.sha256After !== entry.sha256Before
    ) {
      failures.push(`${name}: no verified original artifact in ${path}`);
      continue;
    }
    if (!checkArtifact(name, entry.path, entry.sha256Before, failures).verified) continue;
    // The gate packs into an empty directory and requires one archive there; a second one added
    // since could be taken for the tested package.
    if (name === "package") {
      const dir = dirname(entry.path);
      const archives = readdirSync(dir)
        .filter((file) => file.endsWith(".tgz"))
        .sort();
      if (archives.length !== 1 || archives[0] !== basename(entry.path)) {
        failures.push(`package: ${dir} holds ${archives.join(", ")}, not the tested archive alone`);
        continue;
      }
    }
    lines.push(`${name}: ${entry.path} (sha256 ${entry.sha256Before})`);
  }
  return { sha256: own, problems: failures, lines };
}

/** The SBOM and the eval results the gate keeps, hashed; each must exist. */
function outputsOf(dir: string, failures: string[]): Output[] {
  const outputs: Output[] = [];
  const sbom = join(dir, "relembra.cdx.json");
  if (existsSync(sbom) && readJson(sbom) !== undefined) {
    outputs.push({ name: "sbom", path: sbom, sha256: sha256(sbom) });
  } else failures.push("sbom: no readable relembra.cdx.json");
  const evalDir = join(dir, "eval");
  const results = existsSync(evalDir) ? readdirSync(evalDir).sort() : [];
  if (results.length === 0) failures.push("eval: no results");
  for (const file of results) {
    const path = join(evalDir, file);
    outputs.push({ name: `eval/${file}`, path, sha256: sha256(path) });
  }
  return outputs;
}

export function manifest(dir: string): Manifest {
  const failures: string[] = [];
  const steps = REQUIRED_STEPS.map((name) => stepOf(dir, name));
  for (const s of steps) {
    if (s.status === "skipped") failures.push(`${s.name}: skipped`);
    else if (s.status === "missing") failures.push(`${s.name}: did not finish`);
    else if (s.status === "fail") {
      failures.push(
        `${s.name}: ${s.exitCode === null ? "unreadable exit code" : `exit ${s.exitCode}`}`,
      );
    }
  }
  const beforePath = join(dir, "identity-before.json");
  const afterPath = join(dir, "identity-after.json");
  const before = readJson(beforePath) as Snapshot | undefined;
  const after = readJson(afterPath) as Snapshot | undefined;
  if (before?.inputs === undefined) failures.push("no identity before the gate");
  else failures.push(...snapshotProblems(before).map((problem) => `before: ${problem}`));
  if (after?.inputs === undefined) failures.push("no identity after the gate");
  else failures.push(...snapshotProblems(after).map((problem) => `after: ${problem}`));
  if (before?.inputs !== undefined && after?.inputs !== undefined) {
    failures.push(...identityChanges(before, after).map((c) => `changed during the gate: ${c}`));
  }
  const artifacts = REQUIRED_ARTIFACTS.map((name) => artifactOf(dir, name, failures));
  const outputs = outputsOf(dir, failures);
  return {
    verdict: failures.length === 0 ? "pass" : "fail",
    complete: true,
    date: new Date().toISOString(),
    attempt: resolve(dir),
    candidate:
      before?.inputs === undefined
        ? null
        : { commit: before.inputs.commit, digest: before.inputs.digest },
    runtimes: before?.runtimes ?? null,
    identity: { before: beforePath, after: afterPath },
    steps,
    artifacts,
    outputs,
    failures,
  };
}

/**
 * Why a strict benchmark record is not a pass on the candidate the gate snapshot names. The
 * record's own passed flag is required and never enough: the strict verdict (bench/acceptance.ts)
 * runs again on its raw samples, corpus, store, errors and identity. A malformed snapshot or
 * record is a problem, never a pass.
 */
export function benchProblems(gate: Snapshot, record: unknown): string[] {
  try {
    const problems = snapshotProblems(gate).map((problem) => `gate snapshot: ${problem}`);
    if (record === null || typeof record !== "object") return [...problems, "no record"];
    const r = record as Attempt & { complete?: unknown; check?: { passed?: unknown } | null };
    if (r.complete !== true) problems.push("the record is not complete");
    if (r.check?.passed !== true) problems.push("the strict check did not pass");
    problems.push(...strictVerdict(r).failures.map((failure) => `strict verdict: ${failure}`));
    for (const when of ["before", "after"] as const) {
      const measured = r.identity?.[when];
      if (measured?.inputs === undefined) problems.push(`no identity ${when} the benchmark`);
      else {
        problems.push(
          ...identityChanges(gate, measured).map(
            (c) => `measured another candidate (${when}): ${c}`,
          ),
        );
      }
    }
    return problems;
  } catch (error) {
    return [
      `malformed snapshot or record: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

function table(m: Manifest): string {
  const rows = m.steps.map((s) => {
    const result =
      s.status === "pass"
        ? "pass"
        : s.status === "fail"
          ? `FAIL (exit ${s.exitCode ?? "?"})`
          : s.status.toUpperCase();
    return `${s.name.padEnd(15)} ${String(s.seconds ?? "-").padStart(6)}  ${result}`;
  });
  return [`\n${"step".padEnd(15)} ${"seconds".padStart(6)}  result`, ...rows].join("\n");
}

function main(argv: readonly string[]): number {
  const [command, ...args] = argv;
  if (command === "record" && args.length === 3) {
    const [dir, name, file] = args as [string, string, string];
    record(dir, name, file);
    return 0;
  }
  if (command === "finish" && args.length === 1) {
    const dir = args[0] as string;
    const m = manifest(dir);
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
    process.stdout.write(`${table(m)}\n`);
    for (const s of m.steps) {
      if (s.status === "pass" || s.status === "skipped" || s.log === null) continue;
      const lines = readFileSync(s.log, "utf8").trimEnd().split("\n").slice(-30);
      process.stdout.write(`\n--- ${s.name} (last 30 lines of ${s.log})\n${lines.join("\n")}\n`);
    }
    for (const failure of m.failures) process.stdout.write(`${failure}\n`);
    process.stdout.write(`verdict: ${m.verdict}\n`);
    return m.verdict === "pass" ? 0 : 1;
  }
  if (command === "bench" && args.length === 2) {
    const [snapshotPath, recordPath] = args as [string, string];
    const gate = readJson(snapshotPath) as Snapshot | undefined;
    const problems =
      gate?.inputs === undefined
        ? [`${snapshotPath} is not a snapshot`]
        : benchProblems(gate, existsSync(recordPath) ? (readJson(recordPath) ?? null) : null);
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "pin" && args.length === 1) {
    const verified = verifiedArtifacts(args[0] as string);
    for (const problem of verified.problems) process.stderr.write(`${problem}\n`);
    if (verified.problems.length > 0 || verified.sha256 === null) return 1;
    process.stdout.write(`${verified.sha256}\n`);
    return 0;
  }
  if (command === "artifacts" && args.length === 2) {
    const [path, pinned] = args as [string, string];
    if (!/^[a-f0-9]{64}$/.test(pinned)) {
      process.stderr.write(`${pinned} is not a pinned sha256\n`);
      return 1;
    }
    const verified = verifiedArtifacts(path, pinned);
    for (const problem of verified.problems) process.stderr.write(`${problem}\n`);
    if (verified.problems.length > 0) return 1;
    process.stdout.write(`${verified.lines.join("\n")}\n`);
    return 0;
  }
  process.stderr.write(
    "usage: gate-manifest.ts record DIR NAME FILE | finish DIR | pin MANIFEST | artifacts MANIFEST SHA256 | bench SNAPSHOT RECORD\n",
  );
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
