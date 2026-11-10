import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStore,
  evaluatesBudget,
  percentiles,
  VARYING_HEADER_BYTES,
} from "../bench/eval-latency.js";
import { bulkCorpus, DEFAULT_SEED } from "../eval/generate.js";
import { MIGRATIONS } from "../src/sqlite/migrations.js";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "relembra-eval-bench-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("bulkCorpus", () => {
  test("gives exactly the requested count, deterministically, from the eval's templates", () => {
    const a = bulkCorpus({ seed: DEFAULT_SEED, memories: 402 });
    expect(a.memories).toHaveLength(402);
    expect(bulkCorpus({ seed: DEFAULT_SEED, memories: 402 })).toEqual(a);
    expect(bulkCorpus({ seed: DEFAULT_SEED + 1, memories: 402 })).not.toEqual(a);
    expect(a.queries).toHaveLength(10);
    expect(new Set(a.memories.map((m) => m.text)).size).toBe(402);
    expect(a.memories.filter((m) => m.pinned)).toHaveLength(1);
    for (const m of a.memories) expect(new TextEncoder().encode(m.text).length).toBeLessThan(280);
  });

  // 13 onsets × 5 vowels × 13 onsets × 5 vowels × 5 codas = 21,125 names, four facts each.
  const SUPPORTED = 84_500;

  test("a count above the name space is refused at once, never looped on", () => {
    const started = performance.now();
    expect(() => bulkCorpus({ seed: DEFAULT_SEED, memories: SUPPORTED + 1 })).toThrow(RangeError);
    expect(() => bulkCorpus({ seed: DEFAULT_SEED, memories: 10 ** 9 })).toThrow(
      `memories must be at most ${SUPPORTED}`,
    );
    expect(performance.now() - started).toBeLessThan(1000);
    // Positive control: the largest supported count still generates, every text distinct.
    const largest = bulkCorpus({ seed: DEFAULT_SEED, memories: SUPPORTED });
    expect(largest.memories).toHaveLength(SUPPORTED);
    expect(new Set(largest.memories.map((m) => m.text)).size).toBe(SUPPORTED);
  });

  test("the benchmark's 20,000-memory corpus is unchanged (docs/eval/bench-2026-10-31.json)", () => {
    const { memories } = bulkCorpus({ seed: DEFAULT_SEED, memories: 20_000 });
    const text = memories.map((m) => m.text).join("\n");
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      "d05ab8090a189959b5f2de29ffe10d2a5beaf18042b6e8868d2c6681e8c39e6d",
    );
  });
});

test("the benchmark refuses an unsupported --memories before building anything", () => {
  const work = join(scratch, "refused-work");
  const run = spawnSync(
    process.execPath,
    [join(ROOT, "bench", "eval-latency.ts"), "--memories", "84501", "--work", work],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(run.signal).toBeNull();
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("--memories must be at most 84500");
  expect(readdirSync(scratch)).not.toContain("refused-work");
});

describe("the benchmark store", () => {
  test("the same seed gives a byte-identical store; another seed does not", async () => {
    const corpus = bulkCorpus({ seed: DEFAULT_SEED, memories: 300 });
    const other = bulkCorpus({ seed: DEFAULT_SEED + 1, memories: 300 });
    const a = await buildStore(join(scratch, "a", "relembra.db"), corpus.memories);
    const b = await buildStore(join(scratch, "b", "relembra.db"), corpus.memories);
    const c = await buildStore(join(scratch, "c", "relembra.db"), other.memories);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.sha256).toBe(a.sha256);
    expect(c.sha256).not.toBe(a.sha256);
    expect(c.fileSha256).not.toBe(a.fileSha256);
    // Every byte that differs between the two raw files is one storeSha256 zeroes: the header's
    // change counter or a migration time, a 6-byte integer in each schema_version row. How many
    // of a time's bytes differ depends on how far apart the builds ran: two bytes under 65 s,
    // with a carry three, as on a slow Windows runner (run 41389502801: 18).
    const fa = readFileSync(join(scratch, "a", "relembra.db"));
    const fb = readFileSync(join(scratch, "b", "relembra.db"));
    expect(fb.length).toBe(fa.length);
    const header = (i: number) =>
      VARYING_HEADER_BYTES.some(([start, end]) => i >= start && i < end);
    const differing: number[] = [];
    for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i] && !header(i)) differing.push(i);
    expect(differing.length).toBeLessThanOrEqual(6 * MIGRATIONS.length);
    expect(a.bytes).toBeGreaterThan(0);
    // Only the database file remains once the store is closed.
    expect(readdirSync(join(scratch, "a"))).toEqual(["relembra.db"]);
    // Three builds outlast bun's 5 s default on a loaded machine, and a minute on hosted Windows.
  }, process.platform === "win32" ? 180_000 : 60_000);
});

test("ticket 19's budget is judged only on 20,000 memories from the pinned seed", () => {
  expect(evaluatesBudget(20_000, DEFAULT_SEED)).toBe(true);
  for (const [memories, seed] of [
    [1, DEFAULT_SEED],
    [19_999, DEFAULT_SEED],
    [20_001, DEFAULT_SEED],
    [20_000, DEFAULT_SEED + 1],
  ] as const) {
    expect(evaluatesBudget(memories, seed)).toBe(false);
  }
});

test("percentiles are nearest-rank", () => {
  const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
  expect(percentiles(samples)).toMatchObject({
    runs: 100,
    p50: 50,
    p95: 95,
    p99: 99,
    min: 1,
    max: 100,
  });
  expect(percentiles([7])).toMatchObject({ p50: 7, p95: 7, p99: 7 });
});

test.skipIf(NO_RELEASE_TOOLING)(
  "a small run measures every surface on both runtimes and writes its record",
  () => {
    const out = join(scratch, "bench");
    // A directory the run did not create, at the name the benchmark once derived and deleted: the
    // run must leave it alone and remove only what it made.
    const work = join(scratch, "work");
    const foreign = join(work, `seed-${DEFAULT_SEED}-n200`);
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "keep.txt"), "not the benchmark's\n");
    const run = spawnSync(
      process.execPath,
      [
        join(ROOT, "bench", "eval-latency.ts"),
        "--memories",
        "200",
        "--warmup",
        "2",
        "--warm",
        "30",
        "--cold",
        "30",
        "--out",
        out,
        "--work",
        work,
      ],
      { encoding: "utf8", timeout: 240_000 },
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(existsSync(join(foreign, "keep.txt"))).toBe(true);
    expect(readdirSync(work)).toEqual([`seed-${DEFAULT_SEED}-n200`]);
    // One directory per attempt, dated by the bench process; bun test runs in UTC, so its own
    // today() can differ.
    const attempts = readdirSync(out).filter((name) => /^bench-\d{4}-\d{2}-\d{2}-/.test(name));
    expect(attempts).toHaveLength(1);
    const base = join(out, attempts[0] as string, "bench");
    const record = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
      store: {
        sha256: string;
        identicalRebuild: boolean;
        unchangedByReads: boolean;
        integrity: string | null;
      };
      budget: { evaluated: boolean; met: boolean | null };
      load: { before: { uptime: string }; after: { uptime: string } };
      results: Record<string, Record<string, Record<string, { runs: number; p95: number }>>>;
      samples: Record<string, Record<string, Record<string, number[]>>>;
      identity: {
        before: { inputs: { available: boolean; commit: string | null } };
        after: { inputs: { commit: string | null } } | null;
      };
      check: unknown;
      errors: string[];
    };
    // Exploratory: recorded with its identity and raw samples, never judged as a release run.
    expect(record.check).toBeNull();
    expect(record.errors).toEqual([]);
    expect(record.identity.before.inputs.available).toBe(true);
    expect(record.identity.after?.inputs.commit).toBe(record.identity.before.inputs.commit);
    expect(record.store.identicalRebuild).toBe(true);
    // Ticket 19's budget is for 20,000 memories on the pinned seed: a small run does not judge it.
    expect(record.budget).toMatchObject({ evaluated: false, met: null });
    expect(readFileSync(`${base}.md`, "utf8")).toContain("not evaluated");
    expect(record.store.unchangedByReads).toBe(true);
    expect(record.store.integrity).toBe("ok");
    expect(record.load.before.uptime).toContain("load");
    for (const runtime of ["bun", "node"]) {
      for (const mode of ["warm", "cold"]) {
        for (const op of ["find", "wake", "brief"]) {
          expect(record.results[runtime]?.[mode]?.[op]?.runs).toBe(30);
          expect(record.results[runtime]?.[mode]?.[op]?.p95).toBeGreaterThan(0);
          expect(record.samples[runtime]?.[mode]?.[op]).toHaveLength(30);
        }
      }
    }
    expect(readFileSync(`${base}.md`, "utf8")).toContain(record.store.sha256);
  },
  300_000,
);
