/**
 * The release check of `bench/eval-latency.ts --check`, apart from any timing: a pure verdict on a
 * recorded attempt, so planted values prove every way it can fail.
 *
 * An attempt passes only when it measured the pinned corpus with at least the release's sampling,
 * holds every raw sample of both runtimes as a finite nonnegative number, built the same store
 * twice, left it unchanged by the reads and passing SQLite's integrity check, recorded no error,
 * had available and clean inputs and
 * runtimes before and after that did not change in between, and kept warm find's raw nearest-rank
 * p95 at or under the budget on both runtimes. Rounding is for display only and never judged.
 */
import { DEFAULT_SEED } from "../eval/generate.js";
import { identityChanges, type Snapshot, snapshotProblems } from "../scripts/evidence.js";

export const RUNTIMES = ["bun", "node"] as const;
export type RuntimeName = (typeof RUNTIMES)[number];
export const MODES = ["warm", "cold"] as const;
export type Mode = (typeof MODES)[number];
export const OPS = ["find", "wake", "brief"] as const;
export type Op = (typeof OPS)[number];

/** Ticket 19's budget and the run it is defined on (IMPLEMENTATION-PLAN §6). */
export const RELEASE = {
  memories: 20_000,
  seed: DEFAULT_SEED,
  /** sha256 of the corpus texts joined by "\n" (docs/eval/bench-2026-10-31.json). */
  corpusSha256: "d05ab8090a189959b5f2de29ffe10d2a5beaf18042b6e8868d2c6681e8c39e6d",
  warmup: 50,
  warm: 500,
  coldWarmup: 3,
  cold: 30,
  findP95Ms: 50,
} as const;

/** The nearest-rank `p`th percentile of `samples`, unrounded. */
export function nearestRank(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

export interface StrictOptions {
  readonly memories: number;
  readonly seed: number;
  readonly warmup: number;
  readonly warm: number;
  readonly cold: number;
}

function samplingProblem(value: unknown, label: string, minimum: number): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    const shown =
      typeof value === "number" ? String(value) : (JSON.stringify(value) ?? "undefined");
    return `${label} ${shown} is not an integer`;
  }
  if (value < minimum) return `${label} ${value} is below ${minimum}`;
  return null;
}

/** Why options cannot make a release run; none for the release's own. Checked before any work. */
export function strictOptionErrors(o: StrictOptions): string[] {
  const errors: string[] = [];
  if (o.memories !== RELEASE.memories) {
    errors.push(`--memories ${o.memories} is not ${RELEASE.memories}`);
  }
  if (o.seed !== RELEASE.seed) errors.push(`--seed ${o.seed} is not ${RELEASE.seed}`);
  for (const name of ["warmup", "warm", "cold"] as const) {
    const problem = samplingProblem(o[name], `--${name}`, RELEASE[name]);
    if (problem !== null) errors.push(problem);
  }
  return errors;
}

/** What the verdict reads from a benchmark record; the record has these fields under these names. */
export interface Attempt {
  readonly parameters: {
    readonly memories: number;
    readonly seed: number;
    readonly warm: { readonly warmup: number; readonly measured: number };
    readonly cold: { readonly warmup: number; readonly measured: number };
  };
  readonly corpus: { readonly textSha256: string } | null;
  readonly store: {
    readonly identicalRebuild: boolean;
    readonly unchangedByReads: boolean;
    /** SQLite's integrity check after the reads: "ok", what it found, or null when not run. */
    readonly integrity: string | null;
  } | null;
  /** Raw milliseconds by runtime, mode and operation, as measured; anything else is a failure. */
  readonly samples: Partial<
    Record<RuntimeName, Partial<Record<Mode, Partial<Record<Op, unknown>>>>>
  >;
  readonly identity: { readonly before: Snapshot | null; readonly after: Snapshot | null };
  readonly errors: readonly string[];
}

export interface Verdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/** Why one sample set is not `expected` finite nonnegative numbers; null when it is. */
function sampleProblem(samples: unknown, expected: number): string | null {
  if (!Array.isArray(samples)) return "no samples";
  if (samples.length !== expected) return `${samples.length} samples, not ${expected}`;
  for (let i = 0; i < expected; i++) {
    const ms: unknown = samples[i];
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      const shown = typeof ms === "number" ? String(ms) : (JSON.stringify(ms) ?? "undefined");
      return `sample ${i} is ${shown}, not a finite nonnegative number`;
    }
  }
  return null;
}

export function strictVerdict(a: Attempt): Verdict {
  const p = a.parameters;
  const failures = strictOptionErrors({
    memories: p.memories,
    seed: p.seed,
    warmup: p.warm.warmup,
    warm: p.warm.measured,
    cold: p.cold.measured,
  });
  const coldWarmupProblem = samplingProblem(p.cold.warmup, "cold warm-up", RELEASE.coldWarmup);
  if (coldWarmupProblem !== null) failures.push(coldWarmupProblem);
  if (a.corpus === null) failures.push("no corpus was generated");
  else if (a.corpus.textSha256 !== RELEASE.corpusSha256) {
    failures.push(`corpus sha256 ${a.corpus.textSha256} is not ${RELEASE.corpusSha256}`);
  }
  failures.push(...a.errors);
  if (a.store === null) failures.push("no store was built");
  else {
    if (a.store.identicalRebuild !== true) {
      failures.push("two builds of the corpus gave different stores");
    }
    if (a.store.unchangedByReads !== true) failures.push("the reads changed the store");
    if (a.store.integrity !== "ok") {
      failures.push(`store integrity check: ${a.store.integrity ?? "not run"}`);
    }
  }
  for (const runtime of RUNTIMES) {
    for (const mode of MODES) {
      for (const op of OPS) {
        const samples = a.samples[runtime]?.[mode]?.[op];
        const problem = sampleProblem(samples, mode === "warm" ? p.warm.measured : p.cold.measured);
        if (problem !== null) {
          failures.push(`${runtime} ${mode} ${op}: ${problem}`);
        } else if (mode === "warm" && op === "find") {
          const p95 = nearestRank(samples as number[], 95);
          if (p95 > RELEASE.findP95Ms) {
            failures.push(
              `${runtime} warm find p95 is ${p95} ms, over the ${RELEASE.findP95Ms} ms budget`,
            );
          }
        }
      }
    }
  }
  const { before, after } = a.identity;
  if (before === null) failures.push("no identity before the run");
  else failures.push(...snapshotProblems(before).map((problem) => `before the run: ${problem}`));
  if (after === null) failures.push("no identity after the run");
  else failures.push(...snapshotProblems(after).map((problem) => `after the run: ${problem}`));
  if (before !== null && after !== null) {
    failures.push(
      ...identityChanges(before, after).map((change) => `changed during the run: ${change}`),
    );
  }
  return { passed: failures.length === 0, failures };
}
