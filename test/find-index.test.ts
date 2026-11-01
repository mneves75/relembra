/**
 * Ticket 19's property test: on random corpora, with deletes, retractions, supersessions,
 * summaries, redactions and sweeps interleaved, find through the term index ranks exactly as
 * the full-scan ranker (rank(), kept as the oracle) over the same live memories: the same
 * memories, in the same order, with every score the same IEEE 754 double.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRelembra,
  exportJsonl,
  importJsonl,
  importOptmem,
  type Memory,
  PlanChangedError,
  type Principal,
  type Store,
  SummarySupersedeError,
} from "relembra";
import { openPostgresStore } from "relembra/postgres";
import { openSqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "relembra/testing";
import { type Ranked, rank } from "../src/ranking.js";
import { bunClient, describePostgres, dropSchema, freshSchema, pool } from "./postgres-support.js";
import { tempDir } from "./sqlite-support.js";

const A = "prop/a";
const B = "prop/b";
const C = "prop/c";
const HOUR = 3_600_000;

/** Words that exercise folding, stems, stop words and the stop-word stem collisions of §3–§4. */
const WORDS = [
  "agent",
  "agents",
  "agente",
  "agentes",
  "Migração",
  "migrações",
  "migracao",
  "memória",
  "MEMORIA",
  "release",
  "releases",
  "query",
  "queries",
  "canal",
  "canais",
  "papel",
  "papéis",
  "item",
  "itens",
  "servidor",
  "servidores",
  "does",
  "dao",
  "daos",
  "doe",
  "the",
  "thes",
  "de",
  "do",
  "elas",
  "ela",
  "pelos",
  "pelo",
  "is",
  "this",
  "these",
  "7",
  "42",
  "v0.1",
  "snake_case",
  "Ação",
  "acao",
  "café",
  "x",
  "notas",
  "nota",
  "class",
  "bus",
  "ﬁle",
  "𝒜gent",
];
const STOP_ONLY = [
  "the",
  "de",
  "do",
  "elas",
  "ela",
  "pelos",
  "pelo",
  "is",
  "this",
  "these",
  "does",
];
const SEPARATORS = [" ", " ", ", ", ". ", "-", " #", "; "];

/** mulberry32: a small seeded generator, so every corpus is reproducible from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]) => items[int(items.length)] as T;
  return { next, int, pick };
}

type Rng = ReturnType<typeof random>;

function text(rng: Rng): string {
  const parts: string[] = [];
  const words = rng.int(13);
  for (let i = 0; i < words; i++) {
    parts.push(rng.pick(WORDS));
    parts.push(rng.pick(SEPARATORS));
  }
  return parts.join("") || "!!";
}

function query(rng: Rng): string {
  const kind = rng.next();
  if (kind < 0.1)
    return Array.from({ length: 1 + rng.int(3) }, () => rng.pick(STOP_ONLY)).join(" ");
  if (kind < 0.2) {
    // Past the 32-term cap: corpus words mixed with words no memory holds.
    return Array.from({ length: 33 + rng.int(10) }, (_, i) =>
      rng.next() < 0.5 ? rng.pick(WORDS) : `w${i}`,
    ).join(" ");
  }
  if (kind < 0.25) return rng.pick(["!!", "", "absent words", "x"]);
  return Array.from({ length: 1 + rng.int(4) }, () => rng.pick(WORDS)).join(rng.pick(SEPARATORS));
}

/** Readers by context: each scope alone, pairs, all three, and a policy listing a scope twice. */
const READERS: Record<string, readonly string[]> = {
  a: [A],
  b: [B],
  ab: [A, B],
  aab: [A, A, B],
  abc: [A, B, C],
};

const OWNER: Principal = {
  id: "owner",
  readable: [A, B, C],
  writable: [A, B, C],
  promotable: [],
  owned: [A, B, C],
};

/** Ranked results as text: ids, seqs and every score's IEEE 754 bits. */
function exactly(results: readonly Ranked[]): string {
  const bits = new DataView(new ArrayBuffer(8));
  return results
    .map(({ memory, score }) => {
      bits.setFloat64(0, score);
      return `${memory.id} ${memory.seq} ${bits.getBigUint64(0).toString(16).padStart(16, "0")}`;
    })
    .join("\n");
}

/**
 * Builds one random corpus in `store` from `seed`, checking every reader against the oracle
 * after random steps and at the end. Returns how many find results it compared; throws on the
 * first difference.
 */
async function runCorpus(seed: number, store: Store): Promise<number> {
  const rng = random(seed);
  let now = 0;
  let next = 0;
  const relembra = createRelembra<string>({
    store,
    policy: (context) =>
      context === "owner"
        ? OWNER
        : { id: context, readable: READERS[context] ?? [], writable: [], promotable: [] },
    clock: { now: () => now },
    ids: { memoryId: () => `m-${++next}`, opId: () => `op-${++next}` },
    retention: [{ scope: C, maxAgeDays: 1 }],
  });
  const provenance = { agent: "prop", harness: "test", model: "none", host: "test" };
  let compared = 0;

  const check = async () => {
    for (const [reader, scopes] of Object.entries(READERS)) {
      const live = await store.liveMemories({ scopes: [...new Set(scopes)] });
      for (let i = 0; i < 3; i++) {
        const q = query(rng);
        const found = await relembra.find(reader, { query: q, limit: 100 });
        const expected = rank(q, live).slice(0, 100);
        const where = `seed ${seed}, reader ${reader}, query ${JSON.stringify(q)}`;
        expect(exactly(found), where).toBe(exactly(expected));
        expect(found, where).toEqual(expected);
        compared += found.length;
      }
    }
  };
  const live = async (scope?: string) =>
    (await store.liveMemories({ scopes: scope === undefined ? [A, B, C] : [scope] })) as Memory[];

  const steps = 20 + rng.int(41);
  for (let step = 0; step < steps; step++) {
    now += HOUR * (1 + rng.int(12));
    const roll = rng.next();
    const memories = await live();
    if (roll < 0.5 || memories.length === 0) {
      await relembra.note("owner", { scope: rng.pick([A, B, C]), text: text(rng), provenance });
    } else if (roll < 0.6) {
      await relembra.retract("owner", { memoryId: rng.pick(memories).id });
    } else if (roll < 0.7) {
      // A summary cannot be superseded (SummarySupersedeError); its sources can.
      const notes = memories.filter((m) => m.sources === undefined);
      if (notes.length === 0) continue;
      const target = rng.pick(notes);
      await relembra.supersede("owner", { memoryId: target.id, text: text(rng), provenance });
    } else if (roll < 0.78) {
      const scope = rng.pick(memories).scope;
      const inScope = await live(scope);
      const sources = [...new Set(Array.from({ length: 1 + rng.int(3) }, () => rng.pick(inScope)))];
      await relembra.submitSummary("owner", {
        scope,
        sources: sources.map((m) => ({ memoryId: m.id, revision: m.revision.number })),
        text: text(rng),
        provenance,
      });
    } else if (roll < 0.86) {
      await relembra.redact("owner", { memoryId: rng.pick(memories).id });
    } else if (roll < 0.9) {
      await relembra.sweep(now);
    } else {
      await check();
    }
  }
  await check();
  return compared;
}

const SEEDS = 300;
const SQLITE_SEEDS = 40;
const LONG = 600_000;

describe("find through the term index ranks exactly as the full scan", () => {
  test(
    `memory store, ${SEEDS} random corpora`,
    async () => {
      let compared = 0;
      for (let seed = 1; seed <= SEEDS; seed++)
        compared += await runCorpus(seed, createMemoryStore());
      // The corpora are not trivially empty: thousands of ranked results were compared.
      expect(compared).toBeGreaterThan(10_000);
    },
    LONG,
  );

  test(
    `sqlite store, ${SQLITE_SEEDS} random corpora`,
    async () => {
      const dir = tempDir();
      let compared = 0;
      try {
        for (let seed = 1; seed <= SQLITE_SEEDS; seed++) {
          const store = openSqliteStore({ path: join(dir.path, `seed-${seed}.db`) });
          try {
            compared += await runCorpus(seed, store);
          } finally {
            await store.close();
          }
        }
      } finally {
        dir.remove();
      }
      expect(compared).toBeGreaterThan(1_000);
    },
    LONG,
  );

  test("negative control: an index that confuses the two §3 lengths is caught", async () => {
    // The same memory store, with the read find gets swapped to the other mode's lengths.
    const inner = createMemoryStore();
    const flawed: Store = {
      ...inner,
      findByTerms: (q) =>
        inner.findByTerms({
          ...q,
          choose: (index) =>
            q.choose({
              ...index,
              lengthKept: index.lengthAll,
              postings: index.postings.map((p) => ({ ...p, lengthKept: p.lengthAll })),
            }),
        }),
    };
    const error = await runCorpus(1, flawed).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    // The comparison failed, not something else (a guard refusal, a bug in the test).
    expect(error?.message).toContain("seed 1, reader");
    // Positive control: the same seed on the unchanged store passes.
    expect(await runCorpus(1, createMemoryStore())).toBeGreaterThan(0);
  });
});

const POSTGRES_SEEDS = 12;

describePostgres("find through the Postgres term index ranks exactly as the full scan", () => {
  test(
    `postgres store, ${POSTGRES_SEEDS} random corpora`,
    async () => {
      const sql = pool();
      let compared = 0;
      try {
        for (let seed = 1; seed <= POSTGRES_SEEDS; seed++) {
          const schema = freshSchema("relembra_find");
          try {
            compared += await runCorpus(
              seed,
              await openPostgresStore({ client: bunClient(sql), schema }),
            );
          } finally {
            await dropSchema(sql, schema);
          }
        }
      } finally {
        await sql.close();
      }
      expect(compared).toBeGreaterThan(300);
    },
    LONG,
  );
});

/** Each store kind, opened fresh; `done` closes it and deletes its file. */
const KINDS: readonly [string, () => { store: Store; done: () => Promise<void> }][] = [
  ["memory store", () => ({ store: createMemoryStore(), done: async () => {} })],
  [
    "sqlite store",
    () => {
      const dir = tempDir();
      const store = openSqliteStore({ path: join(dir.path, "paths.db") });
      return {
        store,
        done: async () => {
          await store.close();
          dir.remove();
        },
      };
    },
  ],
];

const PATH_OWNER: Principal = {
  id: "owner",
  readable: [A, C],
  writable: [A, C],
  promotable: [],
  owned: [A, C],
  trustCeiling: "owner",
};
const PATH_PROVENANCE = { agent: "paths", harness: "test", model: "none", host: "test" };
const PATH_QUERIES = [
  "release",
  "agents canal",
  "migração",
  "summary release",
  "café",
  "build make",
  "configuração projeto",
  "tests code",
  "the do",
];

/**
 * Asserts find equals the full scan over the scopes' live memories for every query, score bits
 * included, and returns the rankings as one string, so a caller can see whether a write moved
 * them.
 */
async function sameAsScan(
  find: (query: string) => Promise<readonly Ranked[]>,
  store: Store,
  scopes: readonly string[],
  where: string,
): Promise<string> {
  const live = await store.liveMemories({ scopes });
  const rankings: string[] = [];
  for (const q of PATH_QUERIES) {
    const found = await find(q);
    const expected = rank(q, live).slice(0, 100);
    expect(exactly(found), `${where}, query ${JSON.stringify(q)}`).toBe(exactly(expected));
    expect(found, `${where}, query ${JSON.stringify(q)}`).toEqual(expected);
    rankings.push(exactly(found));
  }
  return rankings.join("\n--\n");
}

const DAY = 86_400_000;
const OPTMEM_LOG = readFileSync(join(import.meta.dir, "fixtures", "optmem", "memory", "LOG.txt"));

describe("find equals the full scan after every write path", () => {
  for (const [kind, open] of KINDS) {
    test(`${kind}: redact, retract, supersede and sweep approved with a preview's expect`, async () => {
      const { store, done } = open();
      try {
        let now = 0;
        let next = 0;
        const relembra = createRelembra<null>({
          store,
          policy: () => PATH_OWNER,
          clock: { now: () => now },
          ids: { memoryId: () => `m-${++next}`, opId: () => `op-${++next}` },
          retention: [{ scope: C, maxAgeDays: 1 }],
        });
        const note = (scope: string, text: string) =>
          relembra.note(null, { scope, text, provenance: PATH_PROVENANCE });
        const scan = (where: string) =>
          sameAsScan((q) => relembra.find(null, { query: q, limit: 100 }), store, [A, C], where);
        const expired = await note(C, "release café agents, swept by retention");
        now = 3 * DAY;
        const m1 = await note(A, "release agents migração");
        const m2 = await note(A, "release servidor canal");
        const m3 = await note(A, "agents canal memória");
        const m4 = await note(A, "migração release notes");
        const summarize = (sources: readonly Memory[], text: string) =>
          relembra.submitSummary(null, {
            scope: A,
            sources: sources.map((m) => ({ memoryId: m.id, revision: m.revision.number })),
            text,
            provenance: PATH_PROVENANCE,
          });
        const first = await summarize([m1, m2], "summary release agents canal");
        let before = await scan("start");

        // Each approved write must move the rankings, so a missed index update shows.
        const approved = async (name: string, write: () => Promise<unknown>) => {
          await write();
          const after = await scan(name);
          expect(after, `${name} changed nothing find returns`).not.toBe(before);
          before = after;
        };
        // Retract m3, approved with its preview: m3 alone (no summary derives from it).
        const retractPlan = await relembra.redactionPreview(null, { memoryId: m3.id });
        expect(retractPlan.map((m) => m.id)).toEqual([m3.id]);
        await approved("retract", () =>
          relembra.retract(null, { memoryId: m3.id, expect: retractPlan }),
        );
        // Supersede m1: its preview lists m1 and the live summary, which liveDerived retracts.
        const supersedePlan = await relembra.redactionPreview(null, { memoryId: m1.id });
        expect(supersedePlan.length).toBe(2);
        await approved("supersede", () =>
          relembra.supersede(null, {
            memoryId: m1.id,
            text: "release agents migração, revised",
            provenance: PATH_PROVENANCE,
            expect: supersedePlan,
          }),
        );
        // A stale approval aborts and writes nothing: a summary of m2 appears after the preview.
        const stale = await relembra.redactionPreview(null, { memoryId: m2.id });
        const late = await summarize([m2], "summary release servidor");
        before = await scan("late summary");
        await expect(
          relembra.redact(null, { memoryId: m2.id, expect: stale }),
        ).rejects.toBeInstanceOf(PlanChangedError);
        expect(await scan("refused redact")).toBe(before);
        // The summary-supersede refusal writes nothing either.
        await expect(
          relembra.supersede(null, {
            memoryId: late.id,
            text: "summary replaced",
            provenance: PATH_PROVENANCE,
          }),
        ).rejects.toBeInstanceOf(SummarySupersedeError);
        expect(await scan("refused supersede")).toBe(before);
        // Positive control: the fresh plan redacts m2 and both summaries derived from it (the
        // first, retracted by the supersede, included).
        const redactPlan = await relembra.redactionPreview(null, { memoryId: m2.id });
        expect(redactPlan.map((m) => m.id).sort()).toEqual([m2.id, first.id, late.id].sort());
        await approved("redact", () =>
          relembra.redact(null, { memoryId: m2.id, expect: redactPlan }),
        );
        // Sweep, approved with sweepPreview: the memory noted in C three days ago.
        const sweepPlan = await relembra.sweepPreview(now);
        expect(sweepPlan.map((m) => m.id)).toEqual([expired.id]);
        await approved("sweep", () => relembra.sweep(now, { expect: sweepPlan }));
        // m4 was never touched and is still found.
        expect(before).toContain(m4.id);
      } finally {
        await done();
      }
    });

    test(`${kind}: a JSONL import and an OptMem import`, async () => {
      const source = open();
      const target = open();
      try {
        let next = 0;
        const writer = createRelembra<null>({
          store: source.store,
          policy: () => PATH_OWNER,
          ids: { memoryId: () => `j-${++next}`, opId: () => `jop-${++next}` },
        });
        const note = (text: string) =>
          writer.note(null, { scope: A, text, provenance: PATH_PROVENANCE });
        const a = await note("release agents migração");
        const b = await note("release servidor canal");
        const c = await note("agents canal memória");
        await note("the do");
        await writer.submitSummary(null, {
          scope: A,
          sources: [a, b].map((m) => ({ memoryId: m.id, revision: m.revision.number })),
          text: "summary release agents",
          provenance: PATH_PROVENANCE,
        });
        await writer.retract(null, { memoryId: c.id });
        await writer.supersede(null, {
          memoryId: b.id,
          text: "release servidor canal, revised",
          provenance: PATH_PROVENANCE,
        });
        await writer.redact(null, { memoryId: a.id });
        const jsonl = await exportJsonl(source.store, PATH_OWNER, { scope: A });

        let local = 0;
        const reader = createRelembra<null>({
          store: target.store,
          policy: () => PATH_OWNER,
          ids: { memoryId: () => `t-${++local}`, opId: () => `top-${++local}` },
        });
        const scan = (where: string) =>
          sameAsScan((q) => reader.find(null, { query: q, limit: 100 }), target.store, [A], where);
        // The target holds a memory of its own first, so the import adds to existing statistics.
        await reader.note(null, {
          scope: A,
          text: "release tests code",
          provenance: PATH_PROVENANCE,
        });
        const own = await scan("before the imports");
        await importJsonl(target.store, PATH_OWNER, jsonl);
        const afterJsonl = await scan("JSONL import");
        expect(afterJsonl).not.toBe(own);
        // The live imported memories are found: the replacement and the stop-word-only one.
        expect(afterJsonl).toMatch(/\bj-\d+ /);
        // Importing the same file again adds nothing.
        await importJsonl(target.store, PATH_OWNER, jsonl);
        expect(await scan("JSONL import again")).toBe(afterJsonl);

        const optmem = {
          scope: A,
          store: "fixture",
          log: OPTMEM_LOG,
          clock: { now: () => 1_700_000_000_000 },
          provenance: PATH_PROVENANCE,
        };
        const report = await importOptmem(target.store, PATH_OWNER, optmem);
        expect(report.imported).toBe(6);
        const afterOptmem = await scan("OptMem import");
        expect(afterOptmem).not.toBe(afterJsonl);
        // Redact one imported record, then import again: it is skipped, and stays out of find.
        const live = await target.store.liveMemories({ scopes: [A] });
        const imported = live.find((m) => m.revision.text.includes("The build runs with make"));
        expect(imported).toBeDefined();
        await reader.redact(null, { memoryId: (imported as Memory).id });
        const afterRedact = await scan("imported memory redacted");
        expect(afterRedact).not.toBe(afterOptmem);
        await importOptmem(target.store, PATH_OWNER, optmem);
        expect(await scan("OptMem import again")).toBe(afterRedact);
      } finally {
        await source.done();
        await target.done();
      }
    });
  }
});
