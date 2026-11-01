/**
 * Ticket 09's latency benchmark: find, wake and brief on a deterministic SQLite store, warm and
 * cold, on Bun and on Node.
 *
 *   bun bench/eval-latency.ts [--check] [--memories 20000] [--seed 20261030] [--warmup 50]
 *                             [--warm 500] [--cold 30] [--out docs/eval] [--work eval/out/bench]
 *
 * - `--memories` is at most MAX_BULK_MEMORIES (84,500), the most `bulkCorpus` can invent.
 * - Without `--check` a run is exploratory: its numbers are informational, and it exits 1 only
 *   when the measurement itself failed. `--check` is the release check (bench/acceptance.ts): it
 *   refuses any other corpus or less sampling before doing anything, stops before the build when
 *   the inputs or runtimes (scripts/evidence.ts) are unusable or the corpus is not the pinned one,
 *   and exits 1 unless the recorded attempt passes the verdict.
 * - The store is built twice from `bulkCorpus` through the library, with an injected clock and
 *   ids, and the two must be byte-identical, or the run fails. The comparison zeroes SQLite's
 *   file change counter and each migration's wall-clock time (VARYING_HEADER_BYTES, storeSha256);
 *   every other byte must match. The raw file hashes are recorded too.
 * - Warm: one process per runtime (bench/eval-worker.ts), one open store, `--warmup` unmeasured
 *   then `--warm` measured calls per surface.
 * - Cold: one process per call, `--cold` measured after 3 unmeasured, timed around the spawn
 *   (process start, store open, one call, close). The OS page cache stays warm: "cold" means a new
 *   process, not a cold disk.
 * - The machine may be shared, so `uptime` is recorded before and after; so are the inputs and
 *   runtimes, which must not change in between.
 * Each attempt writes bench.json (every raw sample included) and bench.md into a directory of its
 * own under `--out`, which no later attempt reuses, also when it fails; the store is removed at
 * the end.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Environment, environment, load, ROOT, today } from "../eval/environment.js";
import { type BulkMemory, bulkCorpus, DEFAULT_SEED, MAX_BULK_MEMORIES } from "../eval/generate.js";
import { identityChanges, type Snapshot, snapshot, snapshotProblems } from "../scripts/evidence.js";
import { createRelembra, type Principal } from "../src/index.js";
import { openSqliteStore } from "../src/sqlite/index.js";
import {
  MODES,
  nearestRank,
  OPS,
  type Op,
  RELEASE,
  RUNTIMES,
  type RuntimeName,
  strictOptionErrors,
  strictVerdict,
  type Verdict,
} from "./acceptance.js";

const SCOPE = "bench";
/** Ticket 19's budget (IMPLEMENTATION-PLAN §6): warm find p95 on 20,000 memories, both runtimes. */
const FIND_BUDGET_MS = RELEASE.findP95Ms;

/** Whether a run measures ticket 19's budget at all: only on the corpus it is defined on. */
export function evaluatesBudget(memories: number, seed: number): boolean {
  return memories === RELEASE.memories && seed === RELEASE.seed;
}

const WORKER = join(import.meta.dirname, "eval-worker.ts");
const WORKER_COMMAND: Record<RuntimeName, readonly string[]> = {
  bun: [process.execPath, WORKER],
  // Node runs the TypeScript sources directly through the same hook as `bun run test:node`.
  node: ["node", "--import", join(ROOT, "test", "sqlite-node-resolve.ts"), WORKER],
};

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * The two places a relembra SQLite file differs between two builds of the same corpus, neither
 * of them data:
 * - SQLite's file change counter and its copy, the version-valid-for number (header offsets 24
 *   and 92, 4 bytes each), which count how often the file was rewritten by checkpoints and vary
 *   from build to build;
 * - each migration's `applied_at`, which src/sqlite/migrations.ts takes from `Date.now()`, the one
 *   wall-clock value no Clock port reaches.
 */
export const VARYING_HEADER_BYTES: readonly (readonly [number, number])[] = [
  [24, 28],
  [92, 96],
];

/**
 * The sha256 of the store file with the bytes VARYING_HEADER_BYTES names and every migration's
 * `applied_at` zeroed. Each `applied_at` is read through SQL, then found in the file as the
 * 6-byte big-endian integer SQLite stores, and must occur exactly as many times as rows hold it.
 * Nothing is written through SQLite, so no page is rearranged: every other byte is hashed as
 * written.
 */
function storeSha256(path: string): string {
  const before = sha256(readFileSync(path));
  // A read-only open of a WAL database needs its -shm file; a plain open that only reads leaves
  // the database file as it was, which the hash below checks.
  const db = new DatabaseSync(path);
  let times: number[];
  try {
    const rows = db.prepare("SELECT applied_at FROM schema_version").all() as {
      applied_at: number;
    }[];
    times = rows.map((row) => row.applied_at);
  } finally {
    db.close();
  }
  const bytes = Buffer.from(readFileSync(path));
  if (sha256(bytes) !== before) throw new Error("reading the migration times changed the store");
  for (const [start, end] of VARYING_HEADER_BYTES) bytes.fill(0, start, end);
  const counts = new Map<number, number>();
  for (const time of times) counts.set(time, (counts.get(time) ?? 0) + 1);
  for (const [time, count] of counts) {
    // SQLite stores an integer in [2^31, 2^47) in 6 bytes; Date.now() is in that range.
    if (!Number.isSafeInteger(time) || time < 2 ** 31 || time >= 2 ** 47) {
      throw new Error(`an applied_at of ${time} is not a 6-byte integer`);
    }
    const encoded = Buffer.alloc(6);
    encoded.writeUIntBE(time, 0, 6);
    const found: number[] = [];
    for (let at = bytes.indexOf(encoded); at >= 0; at = bytes.indexOf(encoded, at + 1)) {
      found.push(at);
    }
    // Two migrations in the same millisecond store the value twice: once per row, never more.
    if (found.length !== count) {
      throw new Error(`applied_at ${time} is in the file ${found.length} times, not ${count}`);
    }
    for (const at of found) bytes.fill(0, at, at + 6);
  }
  return sha256(bytes);
}

/**
 * SQLite's `PRAGMA integrity_check` of the store: "ok", or what it found (or why it could not run).
 * It only reads. A read-only open of a WAL database needs a -shm file the closed store no longer
 * has, so it opens as storeSha256 does; the caller hashes the file afterwards.
 */
export function storeIntegrity(path: string): string {
  try {
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
      return rows.map((row) => row.integrity_check).join("\n");
    } finally {
      db.close();
    }
  } catch (error) {
    return `could not run: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface BuiltStore {
  /** The store file's hash with its change counter and migration times zeroed (storeSha256). */
  readonly sha256: string;
  /** The raw file's hash, migration times included. */
  readonly fileSha256: string;
  readonly bytes: number;
}

/**
 * Notes `memories` into a new SQLite store at `path` (which must not exist) with the clock at each
 * memory's `at` and counter ids, closes it, and hashes the file.
 */
export async function buildStore(
  path: string,
  memories: readonly BulkMemory[],
): Promise<BuiltStore> {
  if (existsSync(path)) throw new Error(`${path} exists; the benchmark builds a new store`);
  const writer: Principal = {
    id: "bench-loader",
    readable: [],
    writable: [SCOPE],
    promotable: [],
    pinnable: [SCOPE],
    trustCeiling: "owner",
  };
  let now = 0;
  let n = 0;
  const pad = (i: number) => String(i).padStart(6, "0");
  const store = openSqliteStore({ path });
  try {
    const relembra = createRelembra<null>({
      store,
      policy: () => writer,
      clock: { now: () => now },
      ids: { memoryId: () => `bench-${pad(++n)}`, opId: () => `op-${pad(n)}` },
    });
    const provenance = { agent: "bench", harness: "eval", model: "none", host: "bench" };
    for (const memory of memories) {
      now = memory.at;
      await relembra.note(null, {
        scope: SCOPE,
        text: memory.text,
        provenance: { ...provenance, trust: "owner" },
        pinned: memory.pinned,
      });
    }
  } finally {
    await store.close();
  }
  return {
    sha256: storeSha256(path),
    fileSha256: sha256(readFileSync(path)),
    bytes: statSync(path).size,
  };
}

export interface Percentiles {
  readonly runs: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

/** Nearest-rank percentiles, in milliseconds rounded to 0.01, for display only. */
export function percentiles(samples: readonly number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (ms: number) => Math.round(ms * 100) / 100;
  return {
    runs: sorted.length,
    p50: round(nearestRank(sorted, 50)),
    p95: round(nearestRank(sorted, 95)),
    p99: round(nearestRank(sorted, 99)),
    min: round(sorted[0] as number),
    max: round(sorted[sorted.length - 1] as number),
    mean: round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length),
  };
}

function worker(runtime: RuntimeName, args: readonly string[]): string {
  const [command, ...prefix] = WORKER_COMMAND[runtime] as [string, ...string[]];
  const result = spawnSync(command, [...prefix, ...args], { encoding: "utf8", cwd: ROOT });
  if (result.error !== undefined) {
    throw new Error(`${runtime} worker ${args[0]} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${runtime} worker ${args[0]} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

interface Options {
  readonly check: boolean;
  readonly memories: number;
  readonly seed: number;
  readonly warmup: number;
  readonly warm: number;
  readonly cold: number;
  readonly out: string;
  readonly work: string;
}

function parseOptions(argv: readonly string[]): Options {
  const check = argv.includes("--check");
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  // Under --check, strictOptionErrors refuses everything but the release run, with its reasons.
  const int = (name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const raw = value(name);
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(parsed) || (!check && parsed < min)) {
      throw new Error(`${name} must be ≥ ${min}`);
    }
    if (!check && parsed > max) throw new Error(`${name} must be at most ${max}`);
    return parsed;
  };
  const options = {
    check,
    memories: int("--memories", 20_000, 1, MAX_BULK_MEMORIES),
    seed: int("--seed", DEFAULT_SEED),
    warmup: int("--warmup", 50, 0),
    warm: int("--warm", 500, 30),
    cold: int("--cold", 30, 30),
    out: value("--out") ?? join(ROOT, "docs", "eval"),
    work: value("--work") ?? join(ROOT, "eval", "out", "bench"),
  };
  const refused = check ? strictOptionErrors(options) : [];
  if (refused.length > 0) throw new Error(`--check needs the release run: ${refused.join("; ")}`);
  return options;
}

type SampleSets = Partial<Record<Op, unknown>>;
type Load = ReturnType<typeof load>;

/** One attempt as recorded; the verdict (bench/acceptance.ts) reads the fields it names. */
interface BenchRecord {
  date: string;
  command: string;
  /** False until the attempt finished, so a record left by a killed process says so. */
  complete: boolean;
  parameters: {
    seed: number;
    memories: number;
    scope: string;
    warm: { warmup: number; measured: number };
    cold: { warmup: number; measured: number };
    findLimit: number;
    wakeBudgetBytes: number;
    briefBudgetBytes: number;
    queries: readonly string[];
  };
  corpus: { generator: string; textSha256: string } | null;
  store: {
    path: string;
    bytes: number;
    sha256: string;
    fileSha256: { first: string; rebuild: string };
    buildMs: number;
    identicalRebuild: boolean;
    unchangedByReads: boolean;
    integrity: string | null;
  } | null;
  load: { before: Load; after: Load | null };
  environment: Environment;
  identity: { before: Snapshot; after: Snapshot | null };
  budget: {
    name: string;
    thresholdMs: number;
    /** Rounded for display; `met` is judged on rawP95Ms. */
    measuredMs: Record<RuntimeName, number | null>;
    rawP95Ms: Record<RuntimeName, number | null>;
    evaluated: boolean;
    /** null: not evaluated, because the corpus is not the one the budget is defined on. */
    met: boolean | null;
  } | null;
  results: Partial<
    Record<
      RuntimeName,
      { warm: Partial<Record<Op, Percentiles>>; cold: Partial<Record<Op, Percentiles>> }
    >
  >;
  /** Every measured millisecond, by runtime, mode and operation. */
  samples: Partial<Record<RuntimeName, { warm?: SampleSets; cold?: SampleSets }>>;
  errors: string[];
  /** The release verdict; null for an exploratory run. */
  check: Verdict | null;
}

const isTimes = (samples: unknown): samples is number[] =>
  Array.isArray(samples) &&
  samples.length > 0 &&
  samples.every((ms) => typeof ms === "number" && Number.isFinite(ms));

/** Builds the store twice, then measures it, filling `record` as it goes. */
async function measure(options: Options, record: BenchRecord): Promise<void> {
  // A release run that cannot pass stops here, before the costly build.
  if (options.check && snapshotProblems(record.identity.before).length > 0) return;
  const corpus = bulkCorpus({ seed: options.seed, memories: options.memories });
  record.corpus = {
    generator: "bulkCorpus in eval/generate.ts",
    textSha256: sha256(corpus.memories.map((m) => m.text).join("\n")),
  };
  record.parameters.queries = corpus.queries;
  if (options.check && record.corpus.textSha256 !== RELEASE.corpusSha256) return;

  // A directory of this run's own: it removes only what it made, never a directory it found.
  mkdirSync(options.work, { recursive: true });
  const dir = mkdtempSync(join(options.work, `seed-${options.seed}-n${options.memories}-`));
  const path = join(dir, "a", "relembra.db");
  try {
    const started = performance.now();
    const built = await buildStore(path, corpus.memories);
    const buildMs = Math.round(performance.now() - started);
    const rebuilt = await buildStore(join(dir, "b", "relembra.db"), corpus.memories);
    rmSync(join(dir, "b"), { recursive: true, force: true });
    record.store = {
      path: relative(ROOT, path),
      bytes: built.bytes,
      sha256: built.sha256,
      fileSha256: { first: built.fileSha256, rebuild: rebuilt.fileSha256 },
      buildMs,
      identicalRebuild: rebuilt.sha256 === built.sha256,
      unchangedByReads: false,
      integrity: null,
    };
    if (!record.store.identicalRebuild) {
      throw new Error(`the same seed gave two stores: ${built.sha256} and ${rebuilt.sha256}`);
    }

    const queries = corpus.queries;
    for (const runtime of RUNTIMES) {
      const warm = JSON.parse(
        worker(runtime, [
          "warm",
          path,
          String(options.warmup),
          String(options.warm),
          JSON.stringify(queries),
        ]),
      ) as SampleSets;
      const sets: { warm: SampleSets; cold: Partial<Record<Op, number[]>> } = { warm, cold: {} };
      record.samples[runtime] = sets;
      for (const op of OPS) {
        // Kept as it fills, so a worker that fails part-way leaves what was measured.
        const samples: number[] = [];
        sets.cold[op] = samples;
        for (let i = -RELEASE.coldWarmup; i < options.cold; i++) {
          const query = queries[(i + RELEASE.coldWarmup) % queries.length] as string;
          const begun = performance.now();
          worker(runtime, ["cold", path, op, query]);
          if (i >= 0) samples.push(performance.now() - begun);
        }
      }
    }
  } finally {
    // Outside any timed call; the hash comes last, so it also covers the integrity check's read.
    if (record.store !== null && existsSync(path)) {
      record.store.integrity = storeIntegrity(path);
      record.store.unchangedByReads = sha256(readFileSync(path)) === record.store.fileSha256.first;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Display percentiles, the budget and, under --check, the verdict, from the raw samples. */
function judge(options: Options, record: BenchRecord): void {
  for (const runtime of RUNTIMES) {
    const sets = record.samples[runtime];
    if (sets === undefined) continue;
    const results = { warm: {}, cold: {} } as NonNullable<BenchRecord["results"][RuntimeName]>;
    for (const mode of MODES) {
      for (const op of OPS) {
        const samples = sets[mode]?.[op];
        if (isTimes(samples)) results[mode][op] = percentiles(samples);
      }
    }
    record.results[runtime] = results;
  }
  const raw = {} as Record<RuntimeName, number | null>;
  const shown = {} as Record<RuntimeName, number | null>;
  for (const runtime of RUNTIMES) {
    const find = record.samples[runtime]?.warm?.find;
    raw[runtime] = isTimes(find) ? nearestRank(find, 95) : null;
    shown[runtime] = record.results[runtime]?.warm.find?.p95 ?? null;
  }
  const evaluated = evaluatesBudget(options.memories, options.seed);
  record.budget = {
    name: "ticket 19: warm find p95 on 20,000 memories, both runtimes",
    thresholdMs: FIND_BUDGET_MS,
    measuredMs: shown,
    rawP95Ms: raw,
    evaluated,
    met: evaluated
      ? RUNTIMES.every((runtime) => {
          const p95 = raw[runtime];
          return p95 !== null && p95 <= FIND_BUDGET_MS;
        })
      : null,
  };
  record.check = options.check ? strictVerdict(record) : null;
}

async function main(options: Options): Promise<number> {
  const started = new Date();
  const time = [started.getHours(), started.getMinutes(), started.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join("");
  mkdirSync(options.out, { recursive: true });
  // This attempt's own directory: a later attempt, failed or not, never writes into it.
  const attempt = mkdtempSync(join(options.out, `bench-${today(started)}-${time}-`));
  const record: BenchRecord = {
    date: started.toISOString(),
    command: `bun bench/eval-latency.ts ${process.argv.slice(2).join(" ")}`.trim(),
    complete: false,
    parameters: {
      seed: options.seed,
      memories: options.memories,
      scope: SCOPE,
      warm: { warmup: options.warmup, measured: options.warm },
      cold: { warmup: RELEASE.coldWarmup, measured: options.cold },
      findLimit: 10,
      wakeBudgetBytes: 9500,
      briefBudgetBytes: 4000,
      queries: [],
    },
    corpus: null,
    store: null,
    load: { before: load(), after: null },
    environment: environment(),
    identity: { before: snapshot(ROOT), after: null },
    budget: null,
    results: {},
    samples: {},
    errors: [],
    check: null,
  };
  const json = join(attempt, "bench.json");
  const write = () => writeFileSync(json, `${JSON.stringify(record, null, 2)}\n`);
  write();
  try {
    await measure(options, record);
  } catch (error) {
    record.errors.push(error instanceof Error ? error.message : String(error));
  }
  record.identity.after = snapshot(ROOT);
  record.load.after = load();
  judge(options, record);
  record.complete = true;
  write();
  const md = join(attempt, "bench.md");
  writeFileSync(md, markdown(record));
  process.stdout.write(`${markdown(record)}\nwritten: ${md}, ${json}\n`);
  const reasons = record.check === null ? record.errors : record.check.failures;
  for (const reason of reasons) process.stderr.write(`${reason}\n`);
  return reasons.length === 0 ? 0 : 1;
}

function describeIdentity(s: Snapshot | null): string {
  if (s === null) return "not taken";
  const { inputs, runtimes } = s;
  const problems = snapshotProblems(s);
  const named = inputs.available ? `commit \`${inputs.commit}\`, inputs \`${inputs.digest}\`` : "";
  const bun = runtimes.bun === null ? "" : `Bun ${runtimes.bun.version}`;
  const node = runtimes.node === null ? "" : `Node ${runtimes.node.version}`;
  const what = [named, bun, node].filter((part) => part !== "").join("; ");
  return `${what}${problems.length === 0 ? "" : ` (${problems.join("; ")})`}`;
}

function markdown(r: BenchRecord): string {
  const env = r.environment;
  const rows = RUNTIMES.flatMap((runtime) =>
    MODES.flatMap((mode) =>
      OPS.flatMap((op) => {
        const s = r.results[runtime]?.[mode][op];
        return s === undefined
          ? []
          : [
              `| ${runtime} | ${mode} | ${op} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.min} | ${s.max} | ${s.runs} |`,
            ];
      }),
    ),
  );
  const budget = r.budget;
  const judged =
    budget === null || budget.met === null
      ? `not evaluated (it is defined on ${RELEASE.memories} memories from seed ${RELEASE.seed})`
      : budget.met
        ? "met"
        : "not met";
  // The raw value too when rounding hides it: 50.004 shows as 50 and is over the budget.
  const ms = (runtime: RuntimeName) => {
    const shown = budget?.measuredMs[runtime] ?? null;
    const raw = budget?.rawP95Ms[runtime] ?? null;
    if (shown === null || raw === null) return "not measured";
    return raw > FIND_BUDGET_MS && shown <= FIND_BUDGET_MS
      ? `${shown} ms (raw ${raw})`
      : `${shown} ms`;
  };
  const verdict = `Warm find p95: Bun ${ms("bun")}, Node ${ms("node")}, against ticket 19's ${FIND_BUDGET_MS} ms budget: ${judged}.`;
  const check =
    r.check === null
      ? ["Exploratory run, not a release check."]
      : r.check.passed
        ? ["Release check: passed."]
        : ["Release check: failed.", "", ...r.check.failures.map((failure) => `- ${failure}`)];
  const store = r.store;
  const after =
    r.identity.after === null
      ? "not taken"
      : identityChanges(r.identity.before, r.identity.after).length === 0
        ? "the same"
        : describeIdentity(r.identity.after);
  return `${[
    `# Latency benchmark, ${r.date.slice(0, 10)}`,
    "",
    verdict,
    "",
    ...check,
    ...(r.errors.length === 0 ? [] : ["", "## Errors", "", ...r.errors.map((e) => `- ${e}`)]),
    "",
    "## Run",
    "",
    "| Item | Value |",
    "|---|---|",
    `| Command | \`${r.command}\` |`,
    `| Date | ${r.date} |`,
    `| Corpus | bulkCorpus, seed ${r.parameters.seed}, ${r.parameters.memories} memories in one scope, ${r.corpus === null ? "not generated" : `text sha256 \`${r.corpus.textSha256}\``} |`,
    ...(store === null
      ? ["| Store | not built |"]
      : [
          `| Store | SQLite, ${store.bytes} bytes, built in ${store.buildMs} ms; unchanged by the reads: ${store.unchangedByReads ? "yes" : "no"}; integrity check: ${store.integrity ?? "not run"} |`,
          `| Store sha256, change counter and migration times zeroed | \`${store.sha256}\`, ${store.identicalRebuild ? "the same on the rebuild" : "different on the rebuild"} |`,
          `| Raw file sha256 | first \`${store.fileSha256.first}\`, rebuild \`${store.fileSha256.rebuild}\` (${store.fileSha256.first === store.fileSha256.rebuild ? "identical" : "they differ in the change counter and migration times only"}) |`,
        ]),
    `| Queries | ${r.parameters.queries.map((q) => `\`${q}\``).join(", ")} |`,
    `| relembra | ${env.relembra.version}, commit \`${env.relembra.commit}\`${env.relembra.dirty ? " (uncommitted changes)" : ""} |`,
    `| Identity before | ${describeIdentity(r.identity.before)} |`,
    `| Identity after | ${after} |`,
    `| Machine | ${env.machine.cpu}, ${env.machine.cores} cores, ${env.machine.memoryBytes} bytes RAM, ${env.machine.os} |`,
    `| Runtimes | Bun ${env.runtimes.bun} with SQLite ${env.runtimes.sqlite}; Node ${env.runtimes.node} with SQLite ${env.runtimes.nodeSqlite} |`,
    `| Load before | \`${r.load.before.uptime}\` |`,
    `| Load after | \`${r.load.after?.uptime ?? ""}\` |`,
    "",
    "## Results (ms, nearest-rank)",
    "",
    "| runtime | mode | op | p50 | p95 | p99 | min | max | n |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n")}\n`;
}

if (import.meta.main) process.exitCode = await main(parseOptions(process.argv.slice(2)));
