import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelembra, type Principal } from "relembra";
import { DEFAULT_SEED, generate } from "../eval/generate.js";
import { mulberry32 } from "../eval/prng.js";
import {
  assertDistinctTexts,
  CATEGORIES,
  type CorpusMemory,
  type EvalPrincipal,
  type FindProbe,
  readSet,
  writeSet,
} from "../eval/set.js";
import { createMemoryStore } from "../src/testing/memory-store.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "relembra-eval-"));
}

function filesOf(dir: string): Record<string, Buffer> {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name))]));
}

function digest(dir: string): string {
  const hash = createHash("sha256");
  for (const [name, bytes] of Object.entries(filesOf(dir)).sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(name).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

describe("mulberry32", () => {
  test("is deterministic, in [0, 1), and seed-dependent", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    const next = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("matches the published reference output", () => {
    // mulberry32(1): reference values of the canonical algorithm.
    const next = mulberry32(1);
    expect([next(), next(), next()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
  });
});

describe("generate", () => {
  test("the same seed gives byte-identical files; another seed does not", () => {
    const dirs = [tempDir(), tempDir(), tempDir()] as const;
    try {
      writeSet(dirs[0], generate({ seed: DEFAULT_SEED }));
      writeSet(dirs[1], generate({ seed: DEFAULT_SEED }));
      writeSet(dirs[2], generate({ seed: DEFAULT_SEED + 1 }));
      expect(filesOf(dirs[1])).toEqual(filesOf(dirs[0]));
      expect(filesOf(dirs[2])).not.toEqual(filesOf(dirs[0]));
      expect(readSet(dirs[0])).toEqual(generate({ seed: DEFAULT_SEED }));
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corpus with two memories of one text, or a text equal to a canary, is refused", () => {
    const corpus = generate({ seed: DEFAULT_SEED }).corpus;
    // Positive control: the generated corpus has neither, so it passes.
    expect(() => assertDistinctTexts(corpus)).not.toThrow();
    const [first, second] = corpus as [CorpusMemory, CorpusMemory];
    const duplicate = [first, { ...second, text: first.text }];
    expect(() => assertDistinctTexts(duplicate)).toThrow(
      `memories ${first.key} and ${second.key} have the same text`,
    );
    const planted = corpus.find((m) => m.canary !== undefined) as CorpusMemory;
    const echo = [planted, { ...first, text: planted.canary as string }];
    expect(() => assertDistinctTexts(echo)).toThrow(
      `memory ${first.key}'s text is the canary of ${planted.key}`,
    );
  });

  test("the default seed's output is pinned (eval/README.md records this digest)", () => {
    const dir = tempDir();
    try {
      writeSet(dir, generate({ seed: DEFAULT_SEED }));
      expect(digest(dir)).toBe(PINNED_DIGEST);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const PINNED_DIGEST = "12ec6da20ccb5f977efdbfc9da38312d113107310086f74e4064128616c08d0a";

describe("the synthetic set", () => {
  const set = generate({ seed: DEFAULT_SEED });
  const byKey = new Map(set.corpus.map((m) => [m.key, m]));
  const memory = (key: string): CorpusMemory => {
    const found = byKey.get(key);
    if (found === undefined) throw new Error(`unknown key ${key}`);
    return found;
  };
  const superseded = new Set(set.corpus.flatMap((m) => (m.supersedes ? [m.supersedes] : [])));
  const live = (m: CorpusMemory) => m.state === "live" && !superseded.has(m.key);
  const finds = set.probes.filter((p): p is FindProbe => p.kind === "find");

  test("has two language sets, every category in each, and wake probes", () => {
    const sets = [...new Set(set.probes.map((p) => p.set))].sort();
    expect(sets).toEqual(["en", "pt"]);
    for (const name of sets) {
      const categories = new Set(finds.filter((p) => p.set === name).map((p) => p.category));
      expect([...categories].sort()).toEqual([...CATEGORIES].sort());
      expect(set.probes.some((p) => p.set === name && p.kind === "wake")).toBe(true);
    }
  });

  test("keys and canaries are unique; texts are curated memories", () => {
    expect(byKey.size).toBe(set.corpus.length);
    expect(new Set(set.probes.map((p) => p.key)).size).toBe(set.probes.length);
    const canaries = set.corpus.flatMap((m) => (m.canary ? [m.canary] : []));
    expect(new Set(canaries).size).toBe(canaries.length);
    for (const m of set.corpus) {
      expect(new TextEncoder().encode(m.text).length).toBeLessThanOrEqual(280);
      expect(m.text).not.toMatch(/[\n\r]/);
      if (m.canary) expect(m.text).toContain(m.canary);
      if (m.supersedes) expect(memory(m.supersedes).scope).toBe(m.scope);
    }
    // Planted memories carry canaries: hidden, poisoned and pinned out-of-scope ones.
    for (const m of set.corpus.filter((m) => m.state !== "live" || m.poison)) {
      expect(m.canary).toBeDefined();
    }
  });

  test("every probe references existing keys that fit its category", () => {
    for (const p of set.probes) {
      if (p.kind === "wake") {
        expect(p.principal.readable).toContain(p.scope);
        expect(p.expect.length).toBeGreaterThan(0);
        for (const key of p.expect) {
          const m = memory(key);
          expect(m.scope).toBe(p.scope);
          expect(live(m)).toBe(true);
          expect(m.poison).toBeUndefined();
        }
        continue;
      }
      const visible = (m: CorpusMemory) => live(m) && p.principal.readable.includes(m.scope);
      if (p.gold === "absent") {
        expect(["abstention", "scope"]).toContain(p.category);
      } else {
        expect(p.gold.length).toBeGreaterThan(0);
        for (const key of p.gold) expect(visible(memory(key))).toBe(true);
      }
      if (p.category === "abstention") {
        expect(p.relevant).toBeDefined();
        if (Array.isArray(p.relevant)) {
          for (const key of p.relevant) expect(memory(key).state).not.toBe("live");
        }
      }
      if (p.category === "scope") {
        expect(p.control).toBeDefined();
        for (const key of p.control?.expect ?? []) {
          const m = memory(key);
          expect(p.principal.readable).not.toContain(m.scope);
          expect(p.control?.principal.readable).toContain(m.scope);
          expect(live(m)).toBe(true);
        }
      }
      if (p.category === "contradiction") {
        const gold = p.gold === "absent" ? [] : p.gold;
        expect(gold.some((key) => memory(key).supersedes !== undefined)).toBe(true);
      }
      if (p.category === "poisoning") {
        const gold = p.gold === "absent" ? [] : p.gold;
        for (const key of gold) {
          const m = memory(key);
          expect(m.poison).toBe(true);
          expect(["agent", "untrusted"]).toContain(m.trust);
          expect(m.pinned).toBe(false);
        }
      }
    }
  });

  test("is answerable by the specified ranking over live readable memories", async () => {
    // Positive control for the floors: relembra's own find, over exactly the memories a correct
    // candidate would serve, puts every gold answer in the top 5 and abstains where it must.
    const writer: Principal = {
      id: "writer",
      readable: [],
      writable: [...new Set(set.corpus.map((m) => m.scope))],
      promotable: [],
      trustCeiling: "owner",
    };
    const relembra = createRelembra<EvalPrincipal | "writer">({
      store: createMemoryStore(),
      policy: (context) =>
        context === "writer"
          ? writer
          : {
              id: context.id,
              readable: context.readable,
              writable: context.writable,
              promotable: context.promotable,
            },
    });
    for (const m of set.corpus.filter(live)) {
      await relembra.note("writer", {
        scope: m.scope,
        text: m.text,
        provenance: { agent: "gen", harness: "eval", model: "none", host: "test", trust: m.trust },
      });
    }
    const idText = async (principal: EvalPrincipal, query: string) =>
      (await relembra.find(principal, { query, limit: 10 })).map((r) => r.memory.revision.text);
    for (const p of finds) {
      const got = await idText(p.principal, p.query);
      if (p.gold !== "absent") {
        const gold = p.gold.map((key) => memory(key).text);
        const rank = got.findIndex((text) => gold.includes(text));
        expect({ probe: p.key, rank }).toEqual({ probe: p.key, rank: expect.any(Number) });
        expect(rank).toBeGreaterThanOrEqual(0);
        expect(rank).toBeLessThan(5);
      } else if (p.relevant === "any") {
        expect({ probe: p.key, got }).toEqual({ probe: p.key, got: [] });
      }
      if (p.control) {
        const control = await idText(p.control.principal, p.query);
        for (const key of p.control.expect) expect(control).toContain(memory(key).text);
      }
    }
  });
});
