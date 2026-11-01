import { describe, expect, test } from "bun:test";
import {
  createRelembra,
  type Memory,
  type Policy,
  type Principal,
  ScopeDeniedError,
  type Store,
} from "relembra";
import { documentTerms } from "../src/ranking.js";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

interface Context {
  readonly user: "writer" | "reader" | "both";
}

const principals: Record<Context["user"], Principal> = {
  writer: {
    id: "writer",
    readable: [SCOPE, OTHER_SCOPE],
    writable: [SCOPE, OTHER_SCOPE],
    promotable: [],
  },
  reader: { id: "reader", readable: [SCOPE], writable: [], promotable: [] },
  both: { id: "both", readable: [SCOPE, OTHER_SCOPE], writable: [], promotable: [] },
};

const policy: Policy<Context> = (context) => principals[context.user];

const reader: Context = { user: "reader" };

/** Notes each text in order (in SCOPE unless a scope is given) and returns the relembra. */
async function seed(entries: readonly (string | readonly [scope: string, text: string])[]) {
  const store = createMemoryStore();
  const relembra = createRelembra({ store, policy });
  for (const entry of entries) {
    const [scope, text] = typeof entry === "string" ? [SCOPE, entry] : entry;
    await relembra.note({ user: "writer" }, { scope, text, provenance });
  }
  return relembra;
}

/** A memory store that counts its full loads and its index reads, and records what find asked. */
function countingStore() {
  const inner = createMemoryStore();
  const reads = { live: 0, index: 0 };
  const asked: { scopes: readonly string[]; terms: readonly unknown[] }[] = [];
  const store: Store = {
    ...inner,
    liveMemories: (query) => {
      reads.live += 1;
      return inner.liveMemories(query);
    },
    findByTerms: (query) => {
      reads.index += 1;
      asked.push({ scopes: query.scopes, terms: query.terms });
      return inner.findByTerms(query);
    },
  };
  return { store, reads, asked };
}

async function findTexts(
  relembra: Awaited<ReturnType<typeof seed>>,
  query: string,
  context: Context = reader,
) {
  const results = await relembra.find(context, { query });
  return results.map((result) => result.memory.revision.text);
}

describe("find", () => {
  test("returns the memories that share a term with the query, and only those", async () => {
    const relembra = await seed(["Deploys run from the release branch.", "Lint with Biome."]);

    expect(await findTexts(relembra, "release")).toEqual(["Deploys run from the release branch."]);
    expect(await findTexts(relembra, "kubernetes")).toEqual([]);
  });

  test("refuses a scope the principal may not read, and allows one it may", async () => {
    const relembra = await seed([[OTHER_SCOPE, "The other repository uses Deno."]]);

    await expect(relembra.find(reader, { query: "deno", scope: OTHER_SCOPE })).rejects.toThrow(
      ScopeDeniedError,
    );
    const allowed = await relembra.find({ user: "both" }, { query: "deno", scope: OTHER_SCOPE });
    expect(allowed.map((result) => result.memory.scope)).toEqual([OTHER_SCOPE]);
  });
});

describe("folding (ranking-algorithm.md §1 and §4)", () => {
  test("accents fold both ways: memoria finds memória, and memória finds memoria", async () => {
    const accented = await seed(["A memória do projeto fica no SQLite."]);
    const plain = await seed(["A memoria do projeto fica no SQLite."]);

    expect(await findTexts(accented, "memoria")).toEqual(["A memória do projeto fica no SQLite."]);
    expect(await findTexts(plain, "MEMÓRIA")).toEqual(["A memoria do projeto fica no SQLite."]);
  });

  test("plurals fold: agentes finds agente, and migrações finds migração", async () => {
    const relembra = await seed(["Cada agente tem um escopo.", "A migração roda no deploy."]);

    expect(await findTexts(relembra, "agentes")).toEqual(["Cada agente tem um escopo."]);
    expect(await findTexts(relembra, "migrações")).toEqual(["A migração roda no deploy."]);
  });

  test("an exact match outranks a stem-only match when the other factors are equal", async () => {
    // Same length, and the stem-only memory is newer, so the tie-break alone would put it first.
    const relembra = await seed(["agentes do time", "agente do time"]);

    expect(await findTexts(relembra, "agentes")).toEqual(["agentes do time", "agente do time"]);
  });
});

describe("tokens (ranking-algorithm.md §2)", () => {
  test("#3274 yields 3274", async () => {
    const relembra = await seed(["Fix for issue #3274 landed."]);

    expect(await findTexts(relembra, "3274")).toEqual(["Fix for issue #3274 landed."]);
    expect(await findTexts(relembra, "#3274")).toEqual(["Fix for issue #3274 landed."]);
  });

  test("snake_case yields snake and case", async () => {
    const relembra = await seed(["Columns use snake_case."]);

    expect(await findTexts(relembra, "snake")).toEqual(["Columns use snake_case."]);
    expect(await findTexts(relembra, "case")).toEqual(["Columns use snake_case."]);
  });

  test("v0.1 yields v0 and 1", async () => {
    const relembra = await seed(["Release v0.1 ships today.", "Release v01 is a typo."]);

    expect(await findTexts(relembra, "v0")).toEqual(["Release v0.1 ships today."]);
    expect(await findTexts(relembra, "1")).toEqual(["Release v0.1 ships today."]);
  });

  test("single-character tokens are dropped, except digits", async () => {
    const relembra = await seed(["Plan x waits for step 7."]);

    expect(await findTexts(relembra, "x")).toEqual([]);
    // Positive controls: a digit and a longer token from the same memory are found.
    expect(await findTexts(relembra, "7")).toEqual(["Plan x waits for step 7."]);
    expect(await findTexts(relembra, "plan")).toEqual(["Plan x waits for step 7."]);
  });
});

describe("characters are code points, not UTF-16 units (ranking-algorithm.md §2 and §4)", () => {
  // U+20000 is one letter that takes two UTF-16 code units.
  const wide = String.fromCodePoint(0x20000);

  test("a single supplementary-plane letter is dropped like a single BMP letter", async () => {
    const relembra = await seed([`Glyph ${wide} here.`, "Glyph 中 here.", `Pair ${wide}${wide}.`]);

    expect(await findTexts(relembra, wide)).toEqual([]);
    expect(await findTexts(relembra, "中")).toEqual([]);
    // Positive control: two supplementary letters are a two-character token, kept.
    expect(await findTexts(relembra, `${wide}${wide}`)).toEqual([`Pair ${wide}${wide}.`]);
  });

  test("the 4-character stem threshold counts code points", async () => {
    const relembra = await seed([`Short ${wide}a.`, "Short xa.", `Long ${wide}ba.`, "Long xyba."]);

    // Three code points (four UTF-16 units): too short to stem, so no stem match.
    expect(await findTexts(relembra, `${wide}as`)).toEqual([]);
    expect(await findTexts(relembra, "xas")).toEqual([]);
    // Positive controls: four code points stem, in both planes.
    expect(await findTexts(relembra, `${wide}bas`)).toEqual([`Long ${wide}ba.`]);
    expect(await findTexts(relembra, "xybas")).toEqual(["Long xyba."]);
  });
});

describe("stop words (ranking-algorithm.md §3)", () => {
  const corpus = ["Read the docs first.", "This is the way.", "Docs live here."];

  test("stop words in a query are ignored when it has other tokens", async () => {
    const relembra = await seed(corpus);

    // "This is the way." shares only the stop word "the" with the query.
    expect(await findTexts(relembra, "the docs")).not.toContain("This is the way.");
    expect(await findTexts(relembra, "the docs")).toEqual(await findTexts(relembra, "docs"));
  });

  test("Portuguese stop words are ignored too", async () => {
    const relembra = await seed(["Escopo para os agentes.", "Nota para o deploy."]);

    expect(await findTexts(relembra, "para os agentes")).toEqual(["Escopo para os agentes."]);
  });

  test("a query made only of stop words keeps them, and matches them in memories", async () => {
    const relembra = await seed(corpus);

    // Both hold "the" once in four tokens, a tie, so the newer comes first. "Docs live here." has no
    // "the" and is not returned.
    expect(await findTexts(relembra, "the")).toEqual(["This is the way.", "Read the docs first."]);
  });
});

describe("BM25 scores (ranking-algorithm.md §5)", () => {
  /*
   * Worked by hand, k1 = 1.2, b = 0.75:
   *
   *   D1 "Bun builds the CLI binary x" -> bun builds cli binary   (|d| 4; "the" stop, "x" dropped)
   *   D2 "The CLI build uses Node and Bun." -> cli build uses node bun   (|d| 5)
   *   D3 "Memória dos agentes." -> memoria agentes   (|d| 2)
   *   N = 3, avgdl = 11/3. Query "build cli".
   *
   *   cli, exact:  df 2, idf = ln(1 + 1.5/2.5) = ln 1.6       = 0.47000362924573563
   *   build, exact: df 1, idf = ln(1 + 2.5/1.5) = ln(8/3)     = 0.98082925301172630
   *   build, stem:  df 2 (builds -> build in D1), idf = ln 1.6
   *
   *   tf(f = 1, |d| = 4) = 2.2 / (1 + 1.2 (0.25 + 0.75 * 12/11)) = 0.96414342629482060
   *   tf(f = 1, |d| = 5) = 2.2 / (1 + 1.2 (0.25 + 0.75 * 15/11)) = 0.87050359712230220
   *
   *   D1 = ln 1.6 * tf4 (cli exact) + 0.5 * ln 1.6 * tf4 (build stem only) = 0.6797263642079762
   *   D2 = ln 1.6 * tf5 + ln(8/3) * tf5                                  = 1.262955242828438
   *   D3 = 0, so it is not returned.
   */
  const corpus = [
    "Bun builds the CLI binary x",
    "The CLI build uses Node and Bun.",
    "Memória dos agentes.",
  ];
  const expected = [
    ["The CLI build uses Node and Bun.", 1.262955242828438],
    ["Bun builds the CLI binary x", 0.6797263642079762],
  ] as const;

  async function scores(query: string) {
    const relembra = await seed(corpus);
    const results = await relembra.find(reader, { query });
    return results.map((result) => [result.memory.revision.text, result.score] as const);
  }

  function expectScores(actual: readonly (readonly [string, number])[]) {
    expect(actual.map(([text]) => text)).toEqual(expected.map(([text]) => text));
    actual.forEach(([, score], i) => {
      expect(Math.abs(score - (expected[i]?.[1] ?? Number.NaN))).toBeLessThan(1e-9);
    });
  }

  test("match the hand-computed values to 1e-9", async () => {
    expectScores(await scores("build cli"));
  });

  test("count each distinct query token once", async () => {
    expectScores(await scores("cli build cli BUILD"));
  });
});

describe("scope (ranking-algorithm.md §5 and §6)", () => {
  const inScope = ["Deploy the API with Bun.", "Deploy notes live in the wiki."];
  const outOfScope: readonly (readonly [string, string])[] = [
    [OTHER_SCOPE, "Deploy scripts for the other repository."],
    [OTHER_SCOPE, "Bun deploy checklist."],
  ];

  async function scored(relembra: Awaited<ReturnType<typeof seed>>, context: Context) {
    const results = await relembra.find(context, { query: "deploy bun" });
    return results.map((result) => [result.memory.revision.text, result.score] as const);
  }

  test("a memory the principal may not read never counts in N, df or the results", async () => {
    const mixed = await seed([...inScope, ...outOfScope]);
    const alone = await seed(inScope);

    const readerMixed = await scored(mixed, reader);
    // Same texts, same order and the very same scores as a store that never held the others.
    expect(readerMixed).toEqual(await scored(alone, reader));
    expect(readerMixed.map(([text]) => text)).toEqual(inScope);

    // Positive control: a principal that reads both scopes sees them, and they move the scores.
    const bothMixed = await scored(mixed, { user: "both" });
    expect(bothMixed.map(([text]) => text)).toEqual(
      expect.arrayContaining(outOfScope.map(([, text]) => text)),
    );
    const scoreOf = (rows: typeof readerMixed, text: string) =>
      rows.find(([candidate]) => candidate === text)?.[1];
    expect(scoreOf(bothMixed, inScope[0] ?? "")).not.toBe(scoreOf(readerMixed, inScope[0] ?? ""));
  });

  test("an explicit scope narrows the candidates to that scope", async () => {
    const relembra = await seed([...inScope, ...outOfScope]);

    const results = await relembra.find({ user: "both" }, { query: "deploy", scope: SCOPE });
    expect(results.map((result) => result.memory.scope)).toEqual([SCOPE, SCOPE]);
  });
});

describe("order (ranking-algorithm.md §5 and §6)", () => {
  test("equal scores put the newer memory first", async () => {
    const relembra = createRelembra({ store: createMemoryStore(), policy });
    const note = (text: string) =>
      relembra.note({ user: "writer" }, { scope: SCOPE, text, provenance });
    const older = await note("Cache keys include the lockfile hash.");
    await note("Unrelated.");
    const newer = await note("Cache keys include the lockfile hash.");

    const results = await relembra.find(reader, { query: "lockfile" });

    expect(results[0]?.score).toBe(results[1]?.score ?? Number.NaN);
    expect(results.map((result) => result.memory.id)).toEqual([newer.id, older.id]);
    expect(newer.seq).toBeGreaterThan(older.seq);
  });

  test("equal scores and equal store sequence fall back to memory id, ascending", async () => {
    const memory = (id: string): Memory => ({
      id,
      scope: SCOPE,
      seq: 7,
      pinned: false,
      notedAt: 0,
      status: "live",
      revision: {
        number: 1,
        text: "Same text in every memory.",
        at: 0,
        provenance: { ...provenance, trust: "agent", opId: `op-${id}` },
      },
    });
    // A host store that hands back ties in a scrambled order.
    const scrambled = [memory("m-b"), memory("m-c"), memory("m-a")];
    const store: Store = {
      transaction: () => Promise.reject(new Error("read-only stub")),
      recall: async () => [],
      liveMemories: async () => scrambled,
      erasures: async () => [],
      settlements: async () => [],
      pendingErasures: async () => [],
      pendingErasureCount: async () => ({ work: 0, carriers: 0 }),
      recordExposure: async () => [],
      events: async () => [],
      async findByTerms({ terms, choose }) {
        const indexed = scrambled.map((m) => ({ m, doc: documentTerms(m.revision.text) }));
        const none = { all: 0, kept: 0 };
        const chosen = choose({
          memories: indexed.length,
          lengthAll: indexed.reduce((sum, { doc }) => sum + doc.lengthAll, 0),
          lengthKept: indexed.reduce((sum, { doc }) => sum + doc.lengthKept, 0),
          postings: indexed.map(({ m, doc }) => ({
            memoryId: m.id,
            seq: m.seq,
            lengthAll: doc.lengthAll,
            lengthKept: doc.lengthKept,
            exact: terms.map((t) => doc.exact.get(t.exact) ?? none),
            stem: terms.map((t) => doc.stems.get(t.stem) ?? none),
          })),
        });
        return chosen.map((id) => scrambled.find((m) => m.id === id) as Memory);
      },
    };
    const relembra = createRelembra({ store, policy });

    const results = await relembra.find(reader, { query: "text" });

    expect(results.map((result) => result.memory.id)).toEqual(["m-a", "m-b", "m-c"]);
  });

  test("the same store and query always give the same order and scores", async () => {
    const relembra = await seed([
      "Retries back off exponentially.",
      "Retries stop after five attempts.",
      "Retries are logged.",
      "Retries are logged.",
      "Timeouts are not retries.",
    ]);

    const first = await relembra.find(reader, { query: "retries logged" });
    for (let run = 0; run < 20; run++) {
      expect(await relembra.find(reader, { query: "retries logged" })).toEqual(first);
    }
    expect(first).toHaveLength(5);
  });
});

describe("find bounds", () => {
  test("a query with no tokens finds nothing", async () => {
    const relembra = await seed(["Lint with Biome."]);

    for (const query of ["", "   ", "!!! ...", "x y"]) {
      expect(await relembra.find(reader, { query })).toEqual([]);
    }
    // Positive control: a query with a token finds the memory.
    expect(await findTexts(relembra, "biome")).toEqual(["Lint with Biome."]);
  });

  test("a query with no tokens returns before loading any memory", async () => {
    const { store, reads } = countingStore();
    const relembra = createRelembra({ store, policy });
    await relembra.note({ user: "writer" }, { scope: SCOPE, text: "Lint with Biome.", provenance });

    for (const query of ["", "   ", "!!! ...", "x y"]) {
      expect(await relembra.find(reader, { query })).toEqual([]);
    }
    expect(reads).toEqual({ live: 0, index: 0 });
    // Positive control: a query with a token (a stop word only, by the §3 fallback) reads.
    expect(await relembra.find(reader, { query: "with" })).toHaveLength(1);
    expect(reads).toEqual({ live: 0, index: 1 });
  });

  test("find reads the term index for its terms, and never every live memory", async () => {
    const { store, reads, asked } = countingStore();
    // A host policy that lists a scope twice.
    const twice: Principal = { ...principals.both, readable: [SCOPE, OTHER_SCOPE, SCOPE] };
    const relembra = createRelembra({
      store,
      policy: (context: Context) => (context.user === "writer" ? principals.writer : twice),
    });
    await relembra.note({ user: "writer" }, { scope: SCOPE, text: "Lint with Biome.", provenance });

    expect(await relembra.find(reader, { query: "Agentes de BIOME, biome" })).toHaveLength(1);
    expect(reads).toEqual({ live: 0, index: 1 });
    // Each readable scope once, and the query's distinct terms with their stems, in query order.
    expect(asked).toEqual([
      {
        scopes: [SCOPE, OTHER_SCOPE],
        terms: [
          { exact: "agentes", stem: "agente" },
          { exact: "biome", stem: "biome" },
        ],
      },
    ]);
    // Positive control: brief still ranks every live memory, so it loads them.
    await relembra.brief(reader, { topic: "biome" });
    expect(reads).toEqual({ live: 1, index: 1 });
  });

  test("only the first 32 distinct query terms are scored, in query order", async () => {
    // Thirty-three distinct terms; repeats and stop words do not count toward the cap.
    const terms = Array.from({ length: 33 }, (_, i) => `term${String(i + 1).padStart(2, "0")}`);
    const query = `the ${terms[0]} ${terms.join(" and ")} ${terms[1]}`;
    const relembra = await seed([`Only ${terms[32]} here.`, `Only ${terms[31]} here.`]);

    // The 32nd term is scored; the 33rd is past the cap.
    expect(await findTexts(relembra, query)).toEqual([`Only ${terms[31]} here.`]);
    // Positive control: the 33rd term alone finds its memory.
    expect(await findTexts(relembra, terms[32] as string)).toEqual([`Only ${terms[32]} here.`]);
  });

  test("a query longer than 1,000 characters is refused", async () => {
    const relembra = await seed(["Lint with Biome."]);
    const padded = (length: number) => `biome ${"z".repeat(length - 6)}`;

    await expect(relembra.find(reader, { query: padded(1_001) })).rejects.toThrow(RangeError);
    expect(await relembra.find(reader, { query: padded(1_000) })).toHaveLength(1);
  });

  test("returns at most 10 results by default, and honours a limit from 1 to 100", async () => {
    const relembra = await seed(
      Array.from({ length: 12 }, (_, i) => `Fact ${i + 1} about caching.`),
    );

    expect(await relembra.find(reader, { query: "caching" })).toHaveLength(10);
    expect(await relembra.find(reader, { query: "caching", limit: 1 })).toHaveLength(1);
    expect(await relembra.find(reader, { query: "caching", limit: 100 })).toHaveLength(12);
  });

  test("a limit that is not an integer from 1 to 100 is refused", async () => {
    const relembra = await seed(["Lint with Biome."]);

    for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(relembra.find(reader, { query: "biome", limit })).rejects.toThrow(RangeError);
    }
  });
});
