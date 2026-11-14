/**
 * Property: exporting a random store and importing the export into an empty one reproduces every
 * memory (id, scope, status, links) with its text byte for byte; importing it again, or importing
 * the copy's own export back, adds nothing; and no redacted text is in any export.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createRelembra,
  exportJsonl,
  ImportError,
  importJsonl,
  type Memory,
  type Principal,
  type Store,
} from "relembra";
import { openSqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { tempDir } from "./sqlite-support.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";
import { describeStore } from "./transfer-support.js";

const owner: Principal = {
  id: "owner",
  readable: [SCOPE, OTHER_SCOPE],
  writable: [SCOPE, OTHER_SCOPE],
  promotable: [],
  pinnable: [SCOPE, OTHER_SCOPE],
  owned: [SCOPE, OTHER_SCOPE],
  trustCeiling: "owner",
};
const importer: Principal = {
  id: "importer",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  owned: [SCOPE],
};

/** mulberry32: a small seeded PRNG, so every corpus can be rebuilt from its seed. */
function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)] as T;
    },
    chance: (p: number) => next() < p,
  };
}

/** Words chosen to stress encoding: accents (composed and combining), emoji, JSON and XML specials. */
const WORDS = [
  "deploy",
  "migração",
  "configuração",
  "café",
  "naïve",
  "日本語",
  "😀",
  "👩🏽‍💻",
  "1️⃣",
  '"quoted"',
  "back\\slash",
  "a/b",
  "<tag>",
  "&amp;",
  "it's",
  "{json:1}",
  "100%",
  "ünïcödé",
  "Ωμέγα",
  " nbsp",
];

function randomText(random: ReturnType<typeof prng>, serial: number): string {
  let text = `#${serial}`;
  const words = 1 + random.int(40);
  for (let i = 0; i < words; i++) {
    const next = `${text} ${random.pick(WORDS)}`;
    if (Buffer.byteLength(next) > 280) break;
    text = next;
  }
  return text;
}

/** Whether `jsonl` holds `text` as a whole JSON string, escaped as an export writes it. */
const holds = (jsonl: string, text: string) => jsonl.includes(JSON.stringify(text));

/**
 * Builds a random store through the public API: notes, pins, supersedes, summaries, retractions,
 * redactions. Returns the texts of the SCOPE memories it redacted.
 */
async function randomCorpus(store: Store, seed: number): Promise<string[]> {
  const random = prng(seed);
  let n = 0;
  const relembra = createRelembra<Principal>({
    store,
    policy: (principal) => principal,
    ids: { memoryId: () => `s${seed}-${++n}`, opId: () => `s${seed}-op-${++n}` },
    clock: { now: () => 1_700_000_000_000 + n },
  });
  const live: Memory[] = [];
  const all: Memory[] = [];
  const redactedTexts = new Map<string, string>();
  const operations = 10 + random.int(50);
  for (let i = 0; i < operations; i++) {
    const roll = random.int(10);
    const target = live.length > 0 ? random.pick(live) : undefined;
    const drop = (memory: Memory) => live.splice(live.indexOf(memory), 1);
    if (roll < 5 || target === undefined) {
      const scope = random.chance(0.85) ? SCOPE : OTHER_SCOPE;
      const trust = random.pick(["owner", "agent", "untrusted"] as const);
      const memory = await relembra.note(owner, {
        scope,
        text: randomText(random, i),
        provenance: { ...provenance, trust },
        pinned: trust !== "untrusted" && random.chance(0.2),
      });
      live.push(memory);
      all.push(memory);
    } else if (roll === 5) {
      await relembra.retract(owner, { memoryId: target.id });
      drop(target);
    } else if (roll === 6) {
      // Only a plain, unpinned memory: the library refuses to supersede a summary
      // (SummarySupersedeError), and the owner supersedes here without touching pins.
      const plain = live.filter((m) => !m.pinned && m.sources === undefined);
      if (plain.length === 0) continue;
      const replaced = random.pick(plain);
      const replacement = await relembra.supersede(owner, {
        memoryId: replaced.id,
        text: randomText(random, i),
        provenance: { ...provenance, trust: "agent" },
      });
      drop(replaced);
      live.push(replacement);
      all.push(replacement);
    } else if (roll === 7) {
      const sources = live.filter((m) => m.scope === target.scope).slice(0, 1 + random.int(3));
      const summary = await relembra.submitSummary(owner, {
        scope: target.scope,
        sources: sources.map((m) => ({ memoryId: m.id, revision: m.revision.number })),
        text: randomText(random, i),
        provenance,
      });
      live.push(summary);
      all.push(summary);
    } else if (roll >= 8) {
      const victim = random.pick(all);
      const before = await exportJsonl(store, owner, { scope: SCOPE });
      const { redacted, derived } = await relembra.redact(owner, { memoryId: victim.id });
      for (const id of [...redacted, ...derived]) {
        const gone = live.find((m) => m.id === id);
        if (gone !== undefined) drop(gone);
        const memory = all.find((m) => m.id === id);
        if (memory === undefined || memory.scope !== SCOPE || redactedTexts.has(id)) continue;
        // Positive control: the export held this text until the redaction.
        expect({ seed, id, held: holds(before, memory.revision.text) }).toEqual({
          seed,
          id,
          held: true,
        });
        redactedTexts.set(id, memory.revision.text);
      }
    }
    // A retraction or supersession also retracts the summaries derived from the memory: re-read.
    const served = new Set(
      (await store.liveMemories({ scopes: [SCOPE, OTHER_SCOPE] })).map((m) => m.id),
    );
    for (const memory of [...live]) if (!served.has(memory.id)) drop(memory);
  }
  return [...redactedTexts.values()];
}

/** Exports SCOPE of `source`, imports it into the empty `target`, and checks the property. */
async function checkRoundTrip(
  source: Store,
  target: Store,
  seed: number,
  redactedTexts: readonly string[],
): Promise<void> {
  const jsonl = await exportJsonl(source, owner, { scope: SCOPE });
  const leaked = (file: string) => redactedTexts.filter((text) => holds(file, text));
  expect({ seed, leaked: leaked(jsonl) }).toEqual({ seed, leaked: [] });
  const lines = jsonl.split("\n").length - 2;
  const first = await importJsonl(target, importer, jsonl);
  // A replayed retraction or redaction cascades to derived summaries itself, so the file's own
  // cascade lines find their work done: every line is imported or skipped, none refused.
  expect(first.imported + first.skipped).toBe(lines);
  expect(first.refused).toEqual([]);
  // The same events, about the same memories; a cascade may visit derived summaries in another order.
  const kindsOf = async (store: Store) =>
    (await store.events({ scopes: [SCOPE] })).map((e) => `${e.kind} ${e.memoryId}`).sort();
  expect(await kindsOf(target)).toEqual(await kindsOf(source));

  const before = await describeStore(source, [SCOPE]);
  const after = await describeStore(target, [SCOPE]);
  // Equal strings, so equal bytes.
  expect({ seed, memories: after }).toEqual({ seed, memories: before });
  // Nothing of another scope came across.
  expect(await target.events({ scopes: [OTHER_SCOPE] })).toEqual([]);

  expect(await importJsonl(target, importer, jsonl)).toEqual({
    imported: 0,
    skipped: lines,
    refused: [],
  });
  // The copy's own export, imported back into the source, is already there.
  const back = await exportJsonl(target, importer, { scope: SCOPE });
  expect({ seed, leaked: leaked(back) }).toEqual({ seed, leaked: [] });
  expect(await importJsonl(source, owner, back)).toMatchObject({ imported: 0 });
}

describe("export then import reproduces a random store", () => {
  const seeds = Array.from({ length: 40 }, (_, i) => 1_000 + i);
  for (const seed of seeds) {
    test(`memory store, seed ${seed}`, async () => {
      const source = createMemoryStore();
      const redacted = await randomCorpus(source, seed);
      await checkRoundTrip(source, createMemoryStore(), seed, redacted);
    });
  }

  for (const seed of seeds.slice(0, 5)) {
    test(`sqlite store, seed ${seed}`, async () => {
      const dir = tempDir();
      const source = openSqliteStore({ path: join(dir.path, "source", "relembra.db") });
      const target = openSqliteStore({ path: join(dir.path, "target", "relembra.db") });
      try {
        const redacted = await randomCorpus(source, seed);
        await checkRoundTrip(source, target, seed, redacted);
      } finally {
        await source.close();
        await target.close();
        dir.remove();
      }
      // Bun's 5 s default: the first sqlite seed took 5.4 s on a hosted Windows runner.
    }, 30_000);
  }

  test("the corpora exercise every event kind, redacted forms included", async () => {
    const kinds = new Set<string>();
    let redactedTexts = 0;
    for (const seed of seeds) {
      const store = createMemoryStore();
      redactedTexts += (await randomCorpus(store, seed)).length;
      for (const event of await store.events({ scopes: [SCOPE] })) {
        kinds.add("redacted" in event ? `${event.kind}:redacted` : event.kind);
      }
    }
    expect([...kinds].sort()).toEqual([
      "note",
      "note:redacted",
      "redact",
      "retract",
      "summarize",
      "summarize:redacted",
      "supersede",
    ]);
    // The leak check in checkRoundTrip has texts to look for.
    expect(redactedTexts).toBeGreaterThan(0);
  });

  test("random overlapping imports: every successful import leaves an export that re-imports into an empty store", async () => {
    let overlapping = 0;
    for (const seed of seeds) {
      const source = createMemoryStore();
      await randomCorpus(source, seed);
      const [header, ...events] = (await exportJsonl(source, owner, { scope: SCOPE }))
        .split("\n")
        .slice(0, -1);
      const ids = [...new Set(events.map((line) => JSON.parse(line).memoryId as string))];
      const random = prng(seed * 7919);
      const target = createMemoryStore();
      let succeeded = 0;
      for (let round = 0; round < 6; round++) {
        // A file of some memories' lines, in their order: a partial export of the same history.
        const kept = new Set(ids.filter(() => random.chance(round === 5 ? 1 : 0.5)));
        const lines = events.filter((line) => kept.has(JSON.parse(line).memoryId));
        const file = `${[header, ...lines].join("\n")}\n`;
        // A partial file is refused whole when it lacks what a line needs (ImportError): any other
        // error is a fault.
        const report = await importJsonl(target, importer, file).catch((error: unknown) => {
          if (error instanceof ImportError) return undefined;
          throw error;
        });
        if (report === undefined) continue;
        if (succeeded > 0 && report.skipped > 0 && report.imported > 0) overlapping++;
        succeeded++;
        const copy = createMemoryStore();
        const again = await exportJsonl(target, importer, { scope: SCOPE });
        const reimported = await importJsonl(copy, importer, again).catch(
          (error: unknown) => error,
        );
        expect({ seed, round, reimported }).toMatchObject({
          seed,
          round,
          reimported: { refused: [] },
        });
        expect(await describeStore(copy, [SCOPE])).toEqual(await describeStore(target, [SCOPE]));
      }
      // Some rounds import; about half are refused, as the direct path would refuse them. A
      // supersede or summary whose replacement or sources neither the file nor the store holds is
      // malformed; one naming a memory an earlier file already changed is a conflict.
      expect({ seed, succeeded: succeeded > 0 }).toEqual({ seed, succeeded: true });
    }
    // Positive control: the generator does produce imports that overlap what the store holds.
    expect(overlapping).toBeGreaterThan(10);
  }, 60_000);

  test("positive control: a corrupted copy is caught", async () => {
    const source = createMemoryStore();
    await randomCorpus(source, 7);
    const jsonl = await exportJsonl(source, owner, { scope: SCOPE });
    const target = createMemoryStore();
    // Drop one character from the first memory's text on its way through.
    const tampered = jsonl.replace(/"text":"#(\d)/, '"text":"#');
    await importJsonl(target, importer, tampered);
    expect(await describeStore(target, [SCOPE])).not.toEqual(await describeStore(source, [SCOPE]));
  });
});
