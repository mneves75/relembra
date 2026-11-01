import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRelembra,
  exportJsonl,
  ImportError,
  importJsonl,
  type Principal,
  RELEMBRA_VERSION,
  randomIds,
  ScopeDeniedError,
  type Store,
} from "relembra";
import { openSqliteStore, type SqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { tempDir } from "./sqlite-support.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";
import { describeStore } from "./transfer-support.js";

const owner: Principal = {
  id: "owner",
  readable: [SCOPE, OTHER_SCOPE],
  writable: [SCOPE, OTHER_SCOPE],
  promotable: [],
  pinnable: [SCOPE],
  owned: [SCOPE, OTHER_SCOPE],
  trustCeiling: "owner",
};
/** Owns SCOPE only. */
const scopeOwner: Principal = {
  id: "scope-owner",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  owned: [SCOPE],
};
/** Writes SCOPE without owning it. */
const writer: Principal = { id: "writer", readable: [SCOPE], writable: [SCOPE], promotable: [] };

function open(store: Store = createMemoryStore(), prefix = "m") {
  let n = 0;
  const relembra = createRelembra<Principal>({
    store,
    policy: (principal) => principal,
    ids: { memoryId: () => `${prefix}-${++n}`, opId: () => `${prefix}-op-${++n}` },
    clock: { now: () => 1_000 + n },
  });
  const note = (
    text: string,
    options: { scope?: string; pinned?: boolean; trust?: "owner" | "agent" | "untrusted" } = {},
  ) =>
    relembra.note(owner, {
      scope: options.scope ?? SCOPE,
      text,
      provenance: { ...provenance, ...(options.trust ? { trust: options.trust } : {}) },
      pinned: options.pinned ?? false,
    });
  return { store, relembra, note };
}

const lines = (jsonl: string) =>
  jsonl
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));

describe("default memory ids", () => {
  test("are random version 4 UUIDs, so an id from another scope cannot be guessed", async () => {
    const relembra = createRelembra<Principal>({ store: createMemoryStore(), policy: (p) => p });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add((await relembra.note(owner, { scope: SCOPE, text: `Fact ${i}.`, provenance })).id);
    }
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(randomIds.memoryId()).not.toBe(randomIds.memoryId());
  });
});

describe("export", () => {
  test("the header carries the format and relembra versions, then every event in seq order", async () => {
    const { store, relembra, note } = open();
    const a = await note("The deploy runs from the release branch.");
    await note("Migrations run before the deploy.");
    await relembra.retract(owner, { memoryId: a.id });

    const jsonl = await exportJsonl(store, owner, { scope: SCOPE });
    expect(jsonl.endsWith("\n")).toBe(true);
    const [header, ...events] = lines(jsonl);
    expect(header).toEqual({
      export: "relembra",
      format: 1,
      relembra: RELEMBRA_VERSION,
      scopes: [SCOPE],
    });
    expect(events.map((e) => e.kind)).toEqual(["note", "note", "retract"]);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((x, y) => x - y));
    expect(events.every((e) => e.format === 1)).toBe(true);
    // Each line is one event exactly as the store holds it.
    expect(events).toEqual([...(await store.events({ scopes: [SCOPE] }))]);
  });

  test("the relembra version is package.json's", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(RELEMBRA_VERSION).toBe(pkg.version);
  });

  test("a redacted memory appears only in its tombstone form, while live text is exported", async () => {
    const { store, relembra, note } = open();
    const secret = await note("Nobody may read this sentence again.");
    await relembra.submitSummary(owner, {
      scope: SCOPE,
      sources: [{ memoryId: secret.id, revision: 1 }],
      text: "A summary that quotes: Nobody may read this sentence again.",
      provenance,
    });
    await note("Planted control text stays readable.");
    await relembra.redact(owner, { memoryId: secret.id });

    const jsonl = await exportJsonl(store, owner, { scope: SCOPE });
    expect(jsonl).not.toContain("Nobody may read");
    // Positive control: a live memory's text is in the same export.
    expect(jsonl).toContain("Planted control text stays readable.");
    const events = lines(jsonl).slice(1);
    expect(events.filter((e) => e.redacted === true).map((e) => e.kind)).toEqual([
      "note",
      "summarize",
    ]);
    expect(events.filter((e) => e.kind === "redact").map((e) => e.cause)).toEqual([
      "request",
      "source",
    ]);
  });

  test("only owned scopes are exported, and only the scopes asked for", async () => {
    const { store, note } = open();
    await note("In the main scope.");
    await note("In the other scope.", { scope: OTHER_SCOPE });

    const one = await exportJsonl(store, scopeOwner, {});
    expect(one).toContain("In the main scope.");
    expect(one).not.toContain("In the other scope.");
    expect(lines(one)[0].scopes).toEqual([SCOPE]);
    await expect(exportJsonl(store, scopeOwner, { scope: OTHER_SCOPE })).rejects.toThrow(
      new ScopeDeniedError("own"),
    );
    // A writer who owns nothing sees no retracted or redacted memories, so it cannot export.
    await expect(exportJsonl(store, writer, {})).rejects.toThrow(new ScopeDeniedError("own"));
    // Positive control: an owner of both exports both.
    const both = await exportJsonl(store, owner, {});
    expect(both).toContain("In the other scope.");
    expect(lines(both)[0].scopes).toEqual([SCOPE, OTHER_SCOPE]);
  });
});

describe("import of a relembra export", () => {
  test("into an empty store reproduces every memory, and importing again adds nothing", async () => {
    const source = open();
    const kept = await source.note("Kept as it was.");
    const retracted = await source.note("Retracted before the export.");
    const replaced = await source.note("Replaced by a newer fact.");
    await source.relembra.retract(owner, { memoryId: retracted.id });
    const replacement = await source.relembra.supersede(owner, {
      memoryId: replaced.id,
      text: "The newer fact.",
      provenance,
    });
    await source.relembra.submitSummary(owner, {
      scope: SCOPE,
      sources: [
        { memoryId: kept.id, revision: 1 },
        { memoryId: replacement.id, revision: 1 },
      ],
      text: "Two facts, summarized.",
      provenance,
    });
    const gone = await source.note("Redacted before the export.");
    await source.relembra.redact(owner, { memoryId: gone.id });
    const jsonl = await exportJsonl(source.store, owner, { scope: SCOPE });

    const target = open(createMemoryStore(), "t");
    const first = await importJsonl(target.store, scopeOwner, jsonl);
    expect(first).toEqual({ imported: lines(jsonl).length - 1, skipped: 0, refused: [] });
    expect(await describeStore(target.store, [SCOPE])).toEqual(
      await describeStore(source.store, [SCOPE]),
    );

    const eventsBefore = (await target.store.events({ scopes: [SCOPE] })).length;
    const second = await importJsonl(target.store, scopeOwner, jsonl);
    expect(second).toEqual({ imported: 0, skipped: lines(jsonl).length - 1, refused: [] });
    expect((await target.store.events({ scopes: [SCOPE] })).length).toBe(eventsBefore);
  });

  test("into an existing store keeps its memories and adds the export's", async () => {
    const source = open();
    await source.note("From the export.");
    const jsonl = await exportJsonl(source.store, owner, { scope: SCOPE });
    const target = open(createMemoryStore(), "t");
    await target.note("Already in the target.");

    expect(await importJsonl(target.store, scopeOwner, jsonl)).toMatchObject({ imported: 1 });
    expect((await target.relembra.recall(owner)).map((m) => m.revision.text).sort()).toEqual([
      "Already in the target.",
      "From the export.",
    ]);
  });

  test("a stale export that would resurrect a memory redacted in the target is refused, writing nothing", async () => {
    const source = open();
    const memory = await source.note("Redacted in the target later.");
    await source.note("A second fact.");
    const jsonl = await exportJsonl(source.store, owner, { scope: SCOPE });
    const target = open(createMemoryStore(), "t");
    await importJsonl(target.store, scopeOwner, jsonl);
    await target.relembra.redact(owner, { memoryId: memory.id });
    const before = await target.store.events({ scopes: [SCOPE] });

    const refusal = await importJsonl(target.store, scopeOwner, jsonl).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ImportError);
    expect(refusal).toMatchObject({ reason: "redacted-in-target", line: 2 });
    expect((refusal as Error).message).not.toContain("Redacted in the target");
    expect(await target.store.events({ scopes: [SCOPE] })).toEqual(before);
    // Positive control: the same export imports into a store without the tombstone.
    expect(await importJsonl(createMemoryStore(), scopeOwner, jsonl)).toMatchObject({
      imported: 2,
    });
  });

  test("a redaction in a newer export reaches the copy an earlier import made", async () => {
    const source = open();
    const memory = await source.note("Erased at the source after the first import.");
    const target = open(createMemoryStore(), "t");
    await importJsonl(
      target.store,
      scopeOwner,
      await exportJsonl(source.store, owner, { scope: SCOPE }),
    );
    // Positive control: the earlier import holds the text.
    expect((await target.relembra.recall(owner)).map((m) => m.revision.text)).toEqual([
      "Erased at the source after the first import.",
    ]);

    await source.relembra.redact(owner, { memoryId: memory.id });
    await importJsonl(
      target.store,
      scopeOwner,
      await exportJsonl(source.store, owner, { scope: SCOPE }),
    );
    expect(await target.relembra.zoom(owner, { memoryId: memory.id })).toMatchObject({
      status: "redacted",
    });
    expect(JSON.stringify(await target.store.events({ scopes: [SCOPE] }))).not.toContain(
      "Erased at the source",
    );
  });

  test("a newer format, in the header or in an event, is refused; format 1 imports", async () => {
    const source = open();
    await source.note("A fact in format 1.");
    const jsonl = await exportJsonl(source.store, owner, { scope: SCOPE });
    const [header, event] = jsonl.split("\n");
    // Format 2 adds promote (test/promote-transfer.test.ts); 3 is newer than this relembra.
    const newerHeader = `${JSON.stringify({ ...JSON.parse(header as string), format: 3 })}\n${event}\n`;
    const newerEvent = `${header}\n${JSON.stringify({ ...JSON.parse(event as string), format: 3 })}\n`;
    const target = createMemoryStore();

    await expect(importJsonl(target, scopeOwner, newerHeader)).rejects.toMatchObject({
      name: "ImportError",
      reason: "format-too-new",
      line: 1,
    });
    await expect(importJsonl(target, scopeOwner, newerEvent)).rejects.toMatchObject({
      reason: "format-too-new",
      line: 2,
    });
    expect(await target.events({ scopes: [SCOPE] })).toEqual([]);
    expect(await importJsonl(target, scopeOwner, jsonl)).toMatchObject({ imported: 1 });
  });

  test("an import never grants owner trust or a pin, and keeps lower trust", async () => {
    const source = open();
    await source.note("An owner rule, pinned.", { pinned: true, trust: "owner" });
    await source.note("From a web page.", { trust: "untrusted" });
    const before = await source.relembra.recall(owner);
    // Positive control: the source holds owner trust and a pin.
    expect(before.map((m) => [m.pinned, m.revision.provenance.trust])).toEqual([
      [false, "untrusted"],
      [true, "owner"],
    ]);

    const target = open(createMemoryStore(), "t");
    await importJsonl(
      target.store,
      { ...scopeOwner, trustCeiling: "owner", pinnable: [SCOPE] },
      await exportJsonl(source.store, owner, { scope: SCOPE }),
    );
    const after = await target.relembra.recall(owner);
    expect(after.map((m) => [m.revision.text, m.pinned, m.revision.provenance.trust])).toEqual([
      ["From a web page.", false, "untrusted"],
      ["An owner rule, pinned.", false, "agent"],
    ]);
    const events = await target.store.events({ scopes: [SCOPE] });
    expect(events.map((e) => ("pinned" in e ? e.pinned : null))).toEqual([false, false]);
    // The importing principal wrote them.
    expect(events.map((e) => e.principalId)).toEqual([scopeOwner.id, scopeOwner.id]);
  });

  test("the import needs ownership of every scope in the export, and writes nothing otherwise", async () => {
    const source = open();
    await source.note("In the main scope.");
    await source.note("In the other scope.", { scope: OTHER_SCOPE });
    const jsonl = await exportJsonl(source.store, owner, {});
    const target = createMemoryStore();

    await expect(importJsonl(target, scopeOwner, jsonl)).rejects.toThrow(
      new ScopeDeniedError("own"),
    );
    await expect(importJsonl(target, writer, jsonl)).rejects.toThrow(new ScopeDeniedError("own"));
    expect(await target.events({ scopes: [SCOPE, OTHER_SCOPE] })).toEqual([]);
    expect(await importJsonl(target, owner, jsonl)).toMatchObject({ imported: 2 });
  });

  test("a credential, a bad line or an unknown kind refuses the whole import by line, echoing nothing", async () => {
    const source = open();
    await source.note("An ordinary fact.");
    const jsonl = await exportJsonl(source.store, owner, { scope: SCOPE });
    const [header, event] = jsonl.split("\n") as [string, string];
    const parsed = JSON.parse(event);
    const key = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    const withSecret = {
      ...parsed,
      seq: parsed.seq + 1,
      memoryId: "m-secret",
      revision: { ...parsed.revision, text: `The token is ${key}` },
    };
    const cases: [string, ImportError["reason"], number][] = [
      [`${header}\n${event}\n${JSON.stringify(withSecret)}\n`, "guard", 3],
      [`${header}\n${event}\nnot json\n`, "malformed", 3],
      [`${header}\n${JSON.stringify({ ...parsed, kind: "promote" })}\n`, "malformed", 2],
      [`${event}\n`, "malformed", 1],
      [`${header}\n${event}\n${event}\n`, "malformed", 3],
      ["", "malformed", 1],
    ];
    for (const [file, reason, line] of cases) {
      const target = createMemoryStore();
      const refusal = await importJsonl(target, scopeOwner, file).catch((e: unknown) => e);
      expect({
        reason: (refusal as ImportError).reason,
        line: (refusal as ImportError).line,
      }).toEqual({ reason, line });
      expect((refusal as Error).message).not.toContain(key);
      expect(await target.events({ scopes: [SCOPE] })).toEqual([]);
    }
    expect(await importJsonl(createMemoryStore(), scopeOwner, jsonl)).toMatchObject({
      imported: 1,
    });
  });
});

describe("import time is bounded by the host's clock", () => {
  const DAY = 86_400_000;
  /** The source wrote its memory at 1,001 ms; the target imports 400 days later. */
  const NOW = 400 * DAY;
  const clock = { now: () => NOW };

  async function exportWithAt(at: number) {
    const source = open();
    await source.note("A dated fact.");
    const [header, event] = (await exportJsonl(source.store, owner, { scope: SCOPE })).split(
      "\n",
    ) as [string, string];
    const parsed = JSON.parse(event);
    return `${header}\n${JSON.stringify({ ...parsed, revision: { ...parsed.revision, at } })}\n`;
  }

  test("a revision dated after the host's now (beyond 5 minutes of skew) is refused, writing nothing", async () => {
    const target = createMemoryStore();
    const future = await exportWithAt(NOW + 5 * 60_000 + 1);
    await expect(importJsonl(target, scopeOwner, future, { clock })).rejects.toMatchObject({
      name: "ImportError",
      reason: "future-time",
      line: 2,
    });
    // A far-future date, which would keep a memory from every retention sweep, is refused too.
    await expect(
      importJsonl(target, scopeOwner, await exportWithAt(32_503_680_000_000), { clock }),
    ).rejects.toMatchObject({
      reason: "future-time",
    });
    expect(await target.events({ scopes: [SCOPE] })).toEqual([]);
    // Positive control: within the documented skew, it imports.
    expect(
      await importJsonl(target, scopeOwner, await exportWithAt(NOW + 5 * 60_000), { clock }),
    ).toMatchObject({
      imported: 1,
    });
  });

  test("an honest past date stays as provenance and as the noted time, so retention sweeps it", async () => {
    const target = createMemoryStore();
    await importJsonl(target, scopeOwner, await exportWithAt(1_001), { clock });
    const keepAll = createRelembra<Principal>({
      store: target,
      policy: (p) => p,
      retention: [{ scope: SCOPE, maxAgeDays: 1000 }],
    });
    const [memory] = await keepAll.recall(owner);
    expect(memory).toMatchObject({ notedAt: 1_001, revision: { at: 1_001 } });
    // Positive control: a rule longer than its age keeps it.
    expect(await keepAll.sweep(NOW)).toEqual({ redacted: [], derived: [] });

    const yearly = createRelembra<Principal>({
      store: target,
      policy: (p) => p,
      retention: [{ scope: SCOPE, maxAgeDays: 365 }],
    });
    expect(await yearly.sweep(NOW)).toEqual({ redacted: [memory?.id as string], derived: [] });
  });
});

describe("an imported supersede needs the authority a direct one needs", () => {
  /** Owns and writes SCOPE, with the given ceiling and pin rights. */
  const importer = (trustCeiling: "owner" | "agent", pinnable: string[]): Principal => ({
    id: "importer",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
    pinnable,
    trustCeiling,
  });

  /**
   * The same memory noted in a source and a target; the source supersedes it and exports. The
   * target's copy is pinned and trusted as given.
   */
  async function supersededElsewhere(protectedBy: { pinned: boolean; trust: "owner" | "agent" }) {
    const source = open(createMemoryStore(), "m");
    const target = open(createMemoryStore(), "m");
    const original = await source.note("The release needs two approvals.", protectedBy);
    const copy = await target.note("The release needs two approvals.", protectedBy);
    expect(copy.id).toBe(original.id);
    await source.relembra.supersede(owner, {
      memoryId: original.id,
      text: "The release needs one approval.",
      provenance,
    });
    return { jsonl: await exportJsonl(source.store, owner, { scope: SCOPE }), target, original };
  }

  async function refusal(store: Store, principal: Principal, jsonl: string) {
    const before = await store.events({ scopes: [SCOPE] });
    const error = await importJsonl(store, principal, jsonl).catch((e: unknown) => e);
    expect(await store.events({ scopes: [SCOPE] })).toEqual(before);
    return error;
  }

  test("a fact more trusted than the importer's ceiling is not displaced (above-ceiling)", async () => {
    const { jsonl, target, original } = await supersededElsewhere({ pinned: true, trust: "owner" });
    const agent = importer("agent", []);
    // The direct path refuses it.
    await expect(
      target.relembra.supersede(agent, { memoryId: original.id, text: "Replaced.", provenance }),
    ).rejects.toMatchObject({ name: "ProvenanceError", rule: "above-ceiling" });
    expect(await refusal(target.store, agent, jsonl)).toMatchObject({
      name: "ImportError",
      reason: "denied",
      detail: "above-ceiling",
      line: 4,
    });
    const zoomed = await target.relembra.zoom(owner, { memoryId: original.id });
    expect(zoomed.status).toBe("live");
  });

  test("a pinned fact is not displaced without pin rights, whatever the ceiling (pin)", async () => {
    const { jsonl, target, original } = await supersededElsewhere({ pinned: true, trust: "agent" });
    const unpinning = importer("owner", []);
    await expect(
      target.relembra.supersede(unpinning, {
        memoryId: original.id,
        text: "Replaced.",
        provenance,
      }),
    ).rejects.toMatchObject({ name: "ScopeDeniedError" });
    expect(await refusal(target.store, unpinning, jsonl)).toMatchObject({
      reason: "denied",
      detail: "pin",
      line: 4,
    });
    // Positive control: with pin rights the same import supersedes it.
    expect(await importJsonl(target.store, importer("owner", [SCOPE]), jsonl)).toMatchObject({
      imported: 2,
      skipped: 1,
    });
    const zoomed = await target.relembra.zoom(owner, { memoryId: original.id });
    expect(zoomed.status).toBe("superseded");
  });

  test("positive control: an unpinned fact within the ceiling is superseded by an agent-ceiling importer", async () => {
    const { jsonl, target, original } = await supersededElsewhere({
      pinned: false,
      trust: "agent",
    });
    expect(await importJsonl(target.store, importer("agent", []), jsonl)).toMatchObject({
      imported: 2,
      skipped: 1,
    });
    const zoomed = await target.relembra.zoom(owner, { memoryId: original.id });
    expect(zoomed.status).toBe("superseded");
  });
});

/** An export of `scopes` whose event lines are `events`, numbered from seq 1. */
function crafted(scopes: string[], events: Record<string, unknown>[]): string {
  const header = { export: "relembra", format: 1, relembra: RELEMBRA_VERSION, scopes };
  const numbered = events.map((event, index) => ({ format: 1, seq: index + 1, ...event }));
  return [header, ...numbered].map((line) => `${JSON.stringify(line)}\n`).join("");
}

const revisionLine = (text: string) => ({
  number: 1,
  text,
  at: 1_000,
  provenance: { ...provenance, trust: "agent", opId: `op-${text.length}` },
});

describe("a summary's sources outside the importer's scope", () => {
  const summaryOf = (sourceId: string) =>
    crafted(
      [SCOPE],
      [
        {
          kind: "summarize",
          memoryId: "summary-1",
          scope: SCOPE,
          principalId: "x",
          sources: [{ memoryId: sourceId, revision: 1 }],
          revision: revisionLine("A summary of a fact."),
        },
      ],
    );

  test("a foreign source, live or redacted, answers as an absent one does", async () => {
    const { store, relembra, note } = open();
    const foreign = await note("A fact in the other scope.", { scope: OTHER_SCOPE });
    const reason = (jsonl: string) =>
      importJsonl(store, scopeOwner, jsonl).catch((e: unknown) => (e as ImportError).reason);

    const absent = await reason(summaryOf("no-such-memory"));
    const live = await reason(summaryOf(foreign.id));
    await relembra.redact(owner, { memoryId: foreign.id });
    const redacted = await reason(summaryOf(foreign.id));
    expect({ absent, live, redacted }).toEqual({
      absent: "malformed",
      live: "malformed",
      redacted: "malformed",
    });
  });

  test("positive control: a redacted source in the importer's own scope is redacted-in-target", async () => {
    const { store, relembra, note } = open();
    const own = await note("A fact in the importer's scope.");
    await relembra.redact(owner, { memoryId: own.id });
    await expect(importJsonl(store, scopeOwner, summaryOf(own.id))).rejects.toMatchObject({
      reason: "redacted-in-target",
      line: 2,
    });
  });
});

describe("a memory known only by its tombstone keeps its scope", () => {
  const gone = (scope: string) => ({
    kind: "note",
    memoryId: "gone",
    scope,
    principalId: "x",
    pinned: false,
    redacted: true,
  });
  const redact = (scope: string) => ({
    kind: "redact",
    memoryId: "gone",
    scope,
    cause: "request",
    principalId: "x",
  });
  const both = [SCOPE, OTHER_SCOPE];

  async function refused(jsonl: string) {
    const store = createMemoryStore();
    const error = await importJsonl(store, owner, jsonl).catch((e: unknown) => e);
    expect(await store.events({ scopes: both })).toEqual([]);
    return error;
  }

  test("its redact event in another scope refuses the import", async () => {
    expect(await refused(crafted(both, [gone(SCOPE), redact(OTHER_SCOPE)]))).toMatchObject({
      reason: "conflict",
      line: 3,
    });
  });

  test("a retract of it in another scope refuses the import", async () => {
    const retract = { kind: "retract", memoryId: "gone", scope: OTHER_SCOPE, principalId: "x" };
    expect(await refused(crafted(both, [gone(SCOPE), retract, redact(SCOPE)]))).toMatchObject({
      reason: "conflict",
      line: 3,
    });
  });

  test("it cannot replace a memory of another scope", async () => {
    const kept = {
      kind: "note",
      memoryId: "kept",
      scope: SCOPE,
      principalId: "x",
      pinned: false,
      revision: revisionLine("A kept fact."),
    };
    const supersede = (scope: string) => ({
      kind: "supersede",
      memoryId: "kept",
      scope,
      principalId: "x",
      by: "gone",
    });
    expect(
      await refused(
        crafted(both, [kept, gone(OTHER_SCOPE), supersede(SCOPE), redact(OTHER_SCOPE)]),
      ),
    ).toMatchObject({ reason: "malformed", line: 4 });
    // Positive control: the replacement in the same scope imports.
    expect(
      await importJsonl(
        createMemoryStore(),
        owner,
        crafted(both, [kept, gone(SCOPE), supersede(SCOPE), redact(SCOPE)]),
      ),
    ).toMatchObject({ imported: 4 });
  });

  test("positive control: in its own scope it imports, and the scope's export imports again", async () => {
    const store = createMemoryStore();
    expect(await importJsonl(store, owner, crafted(both, [gone(SCOPE), redact(SCOPE)]))).toEqual({
      imported: 2,
      skipped: 0,
      refused: [],
    });
    const again = await exportJsonl(store, owner, { scope: SCOPE });
    expect(await importJsonl(createMemoryStore(), owner, again)).toMatchObject({ imported: 2 });
  });
});

describe("a supersede names a replacement already noted, never itself", () => {
  const note = (memoryId: string, text = `The fact ${memoryId}.`) => ({
    kind: "note",
    memoryId,
    scope: SCOPE,
    principalId: "x",
    pinned: false,
    revision: revisionLine(text),
  });
  const supersede = (memoryId: string, by: string) => ({
    kind: "supersede",
    memoryId,
    scope: SCOPE,
    principalId: "x",
    by,
  });

  async function refusal(store: Store, jsonl: string) {
    const before = await store.events({ scopes: [SCOPE] });
    const error = await importJsonl(store, scopeOwner, jsonl).catch((e: unknown) => e);
    expect(await store.events({ scopes: [SCOPE] })).toEqual(before);
    return error;
  }

  test("a memory superseded by itself is refused, alone or after its own note", async () => {
    const store = createMemoryStore();
    await importJsonl(store, scopeOwner, crafted([SCOPE], [note("self")]));
    expect(await refusal(store, crafted([SCOPE], [supersede("self", "self")]))).toMatchObject({
      reason: "malformed",
      line: 2,
    });
    expect(
      await refusal(
        createMemoryStore(),
        crafted([SCOPE], [note("self"), supersede("self", "self")]),
      ),
    ).toMatchObject({ reason: "malformed", line: 3 });
  });

  test("a replacement neither in the store nor noted on an earlier line is refused", async () => {
    // Noted after the supersede, and absent from the store.
    expect(
      await refusal(
        createMemoryStore(),
        crafted([SCOPE], [note("old"), supersede("old", "new"), note("new")]),
      ),
    ).toMatchObject({ reason: "malformed", line: 3 });
    expect(
      await refusal(
        createMemoryStore(),
        crafted([SCOPE], [note("old"), supersede("old", "absent")]),
      ),
    ).toMatchObject({ reason: "malformed", line: 3 });
    // The same for a memory the file knows only by its tombstone.
    const gone = { ...note("gone"), redacted: true, revision: undefined };
    const redactGone = {
      kind: "redact",
      memoryId: "gone",
      scope: SCOPE,
      cause: "request",
      principalId: "x",
    };
    expect(
      await refusal(
        createMemoryStore(),
        crafted([SCOPE], [gone, supersede("gone", "absent"), redactGone]),
      ),
    ).toMatchObject({ reason: "malformed", line: 3 });
  });

  for (const kind of ["memory", "sqlite"] as const) {
    test(`${kind} store: an import overlapping one before it leaves an export that re-imports`, async () => {
      const dir = tempDir();
      const opened: SqliteStore[] = [];
      const open = (name: string): Store => {
        if (kind === "memory") return createMemoryStore();
        const store = openSqliteStore({ path: join(dir.path, name, "relembra.db") });
        opened.push(store);
        return store;
      };
      try {
        const target = open("target");
        await importJsonl(target, scopeOwner, crafted([SCOPE], [note("new")]));
        // The replacement is already held, so its note is skipped: the store's log now reads
        // note(new), note(old), supersede(old -> new).
        expect(
          await importJsonl(
            target,
            scopeOwner,
            crafted([SCOPE], [note("old"), note("new"), supersede("old", "new")]),
          ),
        ).toEqual({ imported: 2, skipped: 1, refused: [] });
        const again = await exportJsonl(target, scopeOwner, { scope: SCOPE });
        const copy = open("copy");
        expect(await importJsonl(copy, scopeOwner, again)).toEqual({
          imported: 3,
          skipped: 0,
          refused: [],
        });
        expect(await describeStore(copy, [SCOPE])).toEqual(await describeStore(target, [SCOPE]));
        // A replacement the store already holds, superseded by a file that does not note it.
        const held = open("held");
        await importJsonl(held, scopeOwner, crafted([SCOPE], [note("old"), note("new")]));
        expect(
          await importJsonl(held, scopeOwner, crafted([SCOPE], [supersede("old", "new")])),
        ).toEqual({ imported: 1, skipped: 0, refused: [] });
      } finally {
        for (const store of opened) await store.close();
        dir.remove();
      }
    });
  }

  test("positive control: the replacement's note on the line before, in text or redacted form, imports", async () => {
    expect(
      await importJsonl(
        createMemoryStore(),
        scopeOwner,
        crafted([SCOPE], [note("old"), note("new"), supersede("old", "new")]),
      ),
    ).toEqual({ imported: 3, skipped: 0, refused: [] });
    const redactedNew = { ...note("new"), redacted: true, revision: undefined };
    const redact = {
      kind: "redact",
      memoryId: "new",
      scope: SCOPE,
      cause: "request",
      principalId: "x",
    };
    expect(
      await importJsonl(
        createMemoryStore(),
        scopeOwner,
        crafted([SCOPE], [note("old"), redactedNew, supersede("old", "new"), redact]),
      ),
    ).toEqual({ imported: 4, skipped: 0, refused: [] });
  });
});

describe("a replayed supersede needs a live target and a live replacement, as the direct one does", () => {
  const note = (memoryId: string) => ({
    kind: "note",
    memoryId,
    scope: SCOPE,
    principalId: "x",
    pinned: false,
    revision: revisionLine(`The fact ${memoryId}.`),
  });
  const gone = (memoryId: string) => ({ ...note(memoryId), redacted: true, revision: undefined });
  const supersede = (memoryId: string, by: string) => ({
    kind: "supersede",
    memoryId,
    scope: SCOPE,
    principalId: "x",
    by,
  });
  const retract = (memoryId: string) => ({
    kind: "retract",
    memoryId,
    scope: SCOPE,
    principalId: "x",
  });
  const redact = (memoryId: string) => ({
    kind: "redact",
    memoryId,
    scope: SCOPE,
    cause: "request",
    principalId: "x",
  });

  async function refusal(store: Store, jsonl: string) {
    const before = await store.events({ scopes: [SCOPE] });
    const error = await importJsonl(store, scopeOwner, jsonl).catch((e: unknown) => e);
    expect(await store.events({ scopes: [SCOPE] })).toEqual(before);
    return error;
  }

  test("a cycle in one file is refused", async () => {
    const file = crafted([SCOPE], [note("A"), note("B"), supersede("A", "B"), supersede("B", "A")]);
    expect(await refusal(createMemoryStore(), file)).toMatchObject({ reason: "conflict", line: 5 });
  });

  test("a cycle across two imports is refused", async () => {
    const store = createMemoryStore();
    await importJsonl(
      store,
      scopeOwner,
      crafted([SCOPE], [note("A"), note("B"), supersede("A", "B")]),
    );
    expect(await refusal(store, crafted([SCOPE], [supersede("B", "A")]))).toMatchObject({
      reason: "conflict",
      line: 2,
    });
  });

  test("a cycle among memories known only by their tombstones is refused", async () => {
    const file = crafted(
      [SCOPE],
      [gone("A"), gone("B"), supersede("A", "B"), supersede("B", "A"), redact("A"), redact("B")],
    );
    expect(await refusal(createMemoryStore(), file)).toMatchObject({ reason: "conflict", line: 5 });
  });

  test("a retracted or superseded replacement is refused", async () => {
    expect(
      await refusal(
        createMemoryStore(),
        crafted([SCOPE], [note("A"), note("B"), retract("B"), supersede("A", "B")]),
      ),
    ).toMatchObject({ reason: "conflict", line: 5 });
    expect(
      await refusal(
        createMemoryStore(),
        crafted(
          [SCOPE],
          [note("B"), note("C"), supersede("B", "C"), note("A"), supersede("A", "B")],
        ),
      ),
    ).toMatchObject({ reason: "conflict", line: 6 });
  });

  test("positive control: chains, in one file, across imports and through tombstones, import and re-import", async () => {
    const chain = crafted(
      [SCOPE],
      [note("A"), note("B"), supersede("A", "B"), note("C"), supersede("B", "C")],
    );
    const one = createMemoryStore();
    expect(await importJsonl(one, scopeOwner, chain)).toEqual({
      imported: 5,
      skipped: 0,
      refused: [],
    });
    const two = createMemoryStore();
    await importJsonl(
      two,
      scopeOwner,
      crafted([SCOPE], [note("A"), note("B"), supersede("A", "B")]),
    );
    expect(
      await importJsonl(two, scopeOwner, crafted([SCOPE], [note("C"), supersede("B", "C")])),
    ).toMatchObject({ imported: 2 });
    expect(await describeStore(two, [SCOPE])).toEqual(await describeStore(one, [SCOPE]));
    const tombstones = crafted(
      [SCOPE],
      [
        gone("A"),
        gone("B"),
        supersede("A", "B"),
        gone("C"),
        supersede("B", "C"),
        redact("A"),
        redact("B"),
        redact("C"),
      ],
    );
    expect(await importJsonl(createMemoryStore(), scopeOwner, tombstones)).toMatchObject({
      imported: 8,
    });
    for (const store of [one, two]) {
      const again = await exportJsonl(store, scopeOwner, { scope: SCOPE });
      expect(await importJsonl(createMemoryStore(), scopeOwner, again)).toMatchObject({
        refused: [],
      });
    }
  });
});

describe("an event's principalId is well-formed or, on a redact, null", () => {
  const note = {
    kind: "note",
    memoryId: "m",
    scope: SCOPE,
    principalId: "x",
    pinned: false,
    revision: revisionLine("A fact."),
  };
  const redact = {
    kind: "redact",
    memoryId: "m",
    scope: SCOPE,
    cause: "request",
    principalId: "x",
  };

  test("a lone surrogate in it is malformed, on a note and on a redact", async () => {
    await expect(
      importJsonl(
        createMemoryStore(),
        scopeOwner,
        crafted([SCOPE], [{ ...note, principalId: "p\ud800" }]),
      ),
    ).rejects.toMatchObject({ reason: "malformed", line: 2 });
    await expect(
      importJsonl(
        createMemoryStore(),
        scopeOwner,
        crafted([SCOPE], [note, { ...redact, principalId: "p\ud800" }]),
      ),
    ).rejects.toMatchObject({ reason: "malformed", line: 3 });
  });

  test("positive control: a well-formed id, and null on a redact, import", async () => {
    expect(
      await importJsonl(
        createMemoryStore(),
        scopeOwner,
        crafted(
          [SCOPE],
          [
            { ...note, principalId: "pé" },
            { ...redact, principalId: null },
          ],
        ),
      ),
    ).toEqual({ imported: 2, skipped: 0, refused: [] });
  });
});

describe("a replayed redact's cause", () => {
  /** A store holding a fact and a summary of it, and its export followed by `redact`. */
  async function withRedact(cause: string, principalId: string | null) {
    const { store, relembra, note } = open();
    const fact = await note("A fact the summary quotes.");
    const summary = await relembra.submitSummary(owner, {
      scope: SCOPE,
      sources: [{ memoryId: fact.id, revision: 1 }],
      text: "A summary of the fact.",
      provenance,
    });
    const events = lines(await exportJsonl(store, owner, { scope: SCOPE }));
    const seq = events[events.length - 1].seq + 1;
    const redact = { format: 1, seq, kind: "redact", memoryId: fact.id, scope: SCOPE, cause };
    const jsonl = [...events, { ...redact, principalId }]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join("");
    return { store, fact, summary, jsonl };
  }

  for (const [cause, principalId] of [
    ["retention", null],
    ["source", "someone"],
  ] as const) {
    test(`a file's ${cause} redact of a stored memory is recorded as the importer's request`, async () => {
      const { store, fact, summary, jsonl } = await withRedact(cause, principalId);
      expect(await importJsonl(store, scopeOwner, jsonl)).toMatchObject({ imported: 1 });
      const redacts = (await store.events({ scopes: [SCOPE] })).filter((e) => e.kind === "redact");
      expect(redacts.map((e) => [e.memoryId, "cause" in e && e.cause, e.principalId])).toEqual([
        [fact.id, "request", "scope-owner"],
        // The cascade, as the direct path writes it.
        [summary.id, "source", "scope-owner"],
      ]);
    });
  }

  test("positive control: a tombstone-only retention redact replays as the file says", async () => {
    const store = createMemoryStore();
    const jsonl = crafted(
      [SCOPE],
      [
        {
          kind: "note",
          memoryId: "gone",
          scope: SCOPE,
          principalId: "x",
          pinned: false,
          redacted: true,
        },
        { kind: "redact", memoryId: "gone", scope: SCOPE, cause: "retention", principalId: null },
      ],
    );
    expect(await importJsonl(store, scopeOwner, jsonl)).toMatchObject({ imported: 2 });
    const redacts = (await store.events({ scopes: [SCOPE] })).filter((e) => e.kind === "redact");
    expect(redacts.map((e) => ["cause" in e && e.cause, e.principalId])).toEqual([
      ["retention", null],
    ]);
  });
});

describe("an imported retract, supersede or redact stays within the importer's ceiling", () => {
  const agentImporter: Principal = {
    id: "importer",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
    pinnable: [SCOPE],
    trustCeiling: "agent",
  };
  type Change = "retract" | "supersede" | "redact";

  /**
   * The same fact and summary of it in a source and a target; the source then changes the fact
   * and exports. In the target the fact has `factTrust`, and with `ownerSummary` the summary's
   * trust is raised to owner in the store (the library never writes a summary above its sources;
   * test/ceiling.test.ts does the same).
   */
  async function changedElsewhere(
    change: Change,
    factTrust: "owner" | "agent",
    ownerSummary: boolean,
  ) {
    const both = [open(createMemoryStore(), "m"), open(createMemoryStore(), "m")] as const;
    const made = [];
    for (const side of both) {
      const fact = await side.note("Deploys need two approvals.", { trust: factTrust });
      const summary = await side.relembra.submitSummary(owner, {
        scope: SCOPE,
        sources: [{ memoryId: fact.id, revision: 1 }],
        text: "Approvals, summarized.",
        provenance: { ...provenance, trust: "agent" },
      });
      made.push({ fact, summary });
    }
    const [source, target] = both;
    const { fact, summary } = made[1] as (typeof made)[number];
    if (ownerSummary) {
      const raised = {
        ...summary,
        revision: {
          ...summary.revision,
          provenance: { ...summary.revision.provenance, trust: "owner" as const },
        },
      };
      await target.store.transaction((tx) => tx.putMemory(raised));
    }
    if (change === "supersede") {
      await source.relembra.supersede(owner, {
        memoryId: fact.id,
        text: "Deploys need one approval.",
        provenance,
      });
    } else await source.relembra[change](owner, { memoryId: fact.id });
    const jsonl = await exportJsonl(source.store, owner, { scope: SCOPE });
    return { jsonl, target, fact, summary };
  }

  const status = async (target: ReturnType<typeof open>, memoryId: string) =>
    (await target.relembra.zoom(owner, { memoryId })).status;

  for (const change of ["retract", "supersede", "redact"] as const) {
    for (const [what, factTrust, ownerSummary] of [
      ["an owner fact", "owner", false],
      ["an agent fact with an owner summary", "agent", true],
    ] as const) {
      test(`a replayed ${change} of ${what} is denied (above-ceiling), writing nothing`, async () => {
        const { jsonl, target, fact, summary } = await changedElsewhere(
          change,
          factTrust,
          ownerSummary,
        );
        const before = await target.store.events({ scopes: [SCOPE] });
        const error = await importJsonl(target.store, agentImporter, jsonl).catch((e) => e);
        expect(error).toMatchObject({
          name: "ImportError",
          reason: "denied",
          detail: "above-ceiling",
        });
        expect(await target.store.events({ scopes: [SCOPE] })).toEqual(before);
        expect(await status(target, fact.id)).toBe("live");
        expect(await status(target, summary.id)).toBe("live");
        // The direct operation refuses it too.
        const direct =
          change === "supersede"
            ? target.relembra.supersede(agentImporter, {
                memoryId: fact.id,
                text: "Deploys need one approval.",
                provenance,
              })
            : target.relembra[change](agentImporter, { memoryId: fact.id });
        await expect(direct).rejects.toMatchObject({ name: "ProvenanceError" });
      });
    }

    test(`positive control: a replayed ${change} of agent memories imports`, async () => {
      const { jsonl, target, fact, summary } = await changedElsewhere(change, "agent", false);
      const report = await importJsonl(target.store, agentImporter, jsonl);
      expect(report).toMatchObject({ refused: [] });
      expect(report.imported).toBeGreaterThan(0);
      const expected = {
        retract: "retracted",
        supersede: "superseded",
        redact: "redacted",
      } as const;
      expect(await status(target, fact.id)).toBe(expected[change]);
      expect(await status(target, summary.id)).toBe(change === "redact" ? "redacted" : "retracted");
    });
  }

  test("positive control: tombstone-only history replays at an agent ceiling", async () => {
    const jsonl = crafted(
      [SCOPE],
      [
        {
          kind: "note",
          memoryId: "gone",
          scope: SCOPE,
          principalId: "x",
          pinned: false,
          redacted: true,
        },
        { kind: "retract", memoryId: "gone", scope: SCOPE, principalId: "x" },
        { kind: "redact", memoryId: "gone", scope: SCOPE, cause: "request", principalId: "x" },
      ],
    );
    expect(await importJsonl(createMemoryStore(), agentImporter, jsonl)).toEqual({
      imported: 3,
      skipped: 0,
      refused: [],
    });
  });
});

describe("replayed summaries follow the direct path's summary rules", () => {
  /** A store with plain memories A (pinned when asked) and B and a summary S of B, and its export. */
  async function withSummary(trust: "owner" | "agent" | "untrusted" = "agent", pinnedA = false) {
    const { store, relembra, note } = open();
    const a = await note("Fact A.", { trust, pinned: pinnedA });
    const b = await note("Fact B.", { trust });
    const summary = await relembra.submitSummary(owner, {
      scope: SCOPE,
      sources: [{ memoryId: b.id, revision: 1 }],
      text: "Summary of B.",
      provenance,
    });
    const events = lines(await exportJsonl(store, owner, { scope: SCOPE }));
    /** The export, then `more`, numbered on from its last seq. */
    const extended = (more: Record<string, unknown>[]) => {
      const last = events[events.length - 1].seq;
      const added = more.map((event, i) => ({ format: 1, seq: last + 1 + i, ...event }));
      return [...events, ...added].map((line) => `${JSON.stringify(line)}\n`).join("");
    };
    return { store, relembra, a, b, summary, extended, lineCount: events.length };
  }

  const replacementNote = {
    kind: "note",
    memoryId: "r",
    scope: SCOPE,
    principalId: "x",
    pinned: false,
    revision: revisionLine("A replacement."),
  };
  const supersede = (memoryId: string, by: string) => ({
    kind: "supersede",
    memoryId,
    scope: SCOPE,
    principalId: "x",
    by,
  });

  async function refusedWith(store: Store, jsonl: string, principal: Principal = scopeOwner) {
    const before = await store.events({ scopes: [SCOPE] });
    const error = await importJsonl(store, principal, jsonl).catch((e: unknown) => e);
    expect(await store.events({ scopes: [SCOPE] })).toEqual(before);
    return error;
  }

  test("a supersede of a stored summary is malformed (summary-supersede), as the direct path refuses it", async () => {
    const { store, relembra, summary, extended, lineCount } = await withSummary();
    await expect(
      relembra.supersede(owner, { memoryId: summary.id, text: "Restated.", provenance }),
    ).rejects.toMatchObject({ name: "SummarySupersedeError" });
    const jsonl = extended([replacementNote, supersede(summary.id, "r")]);
    expect(await refusedWith(store, jsonl)).toMatchObject({
      name: "ImportError",
      reason: "malformed",
      detail: "summary-supersede",
      line: lineCount + 2,
    });
  });

  test("a supersede of a summary the file knows only by its tombstone is malformed too", async () => {
    const jsonl = crafted(
      [SCOPE],
      [
        {
          kind: "summarize",
          memoryId: "s",
          scope: SCOPE,
          principalId: "x",
          sources: [{ memoryId: "gone", revision: 1 }],
          redacted: true,
        },
        replacementNote,
        supersede("s", "r"),
        { kind: "redact", memoryId: "s", scope: SCOPE, cause: "request", principalId: "x" },
      ],
    );
    expect(await refusedWith(createMemoryStore(), jsonl)).toMatchObject({
      reason: "malformed",
      detail: "summary-supersede",
      line: 4,
    });
  });

  test("a summary is never a replacement, stored or known only by its tombstone", async () => {
    const { store, a, summary, extended, lineCount } = await withSummary();
    expect(await refusedWith(store, extended([supersede(a.id, summary.id)]))).toMatchObject({
      reason: "malformed",
      detail: "summary-supersede",
      line: lineCount + 1,
    });
    const tombstoneOnly = crafted(
      [SCOPE],
      [
        { ...replacementNote, memoryId: "a" },
        {
          kind: "summarize",
          memoryId: "s",
          scope: SCOPE,
          principalId: "x",
          sources: [{ memoryId: "gone", revision: 1 }],
          redacted: true,
        },
        supersede("a", "s"),
        { kind: "redact", memoryId: "s", scope: SCOPE, cause: "request", principalId: "x" },
      ],
    );
    expect(await refusedWith(createMemoryStore(), tombstoneOnly)).toMatchObject({
      reason: "malformed",
      detail: "summary-supersede",
      line: 4,
    });
  });

  /** Owns and writes SCOPE, with no pin rights. */
  const unpinning = (trustCeiling: "untrusted" | "agent"): Principal => ({
    id: "importer",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
    pinnable: [],
    trustCeiling,
  });

  for (const [authority, trustCeiling, pinnedA, denial] of [
    ["the ceiling", "untrusted", false, "above-ceiling"],
    ["pin rights", "agent", true, "pin"],
  ] as const) {
    test(`a summary as replacement is malformed even where ${authority} would deny the line`, async () => {
      const importer = unpinning(trustCeiling);
      const { store, a, summary, extended } = await withSummary("agent", pinnedA);
      expect(
        await refusedWith(store, extended([supersede(a.id, summary.id)]), importer),
      ).toMatchObject({ reason: "malformed", detail: "summary-supersede" });
      // Positive control: with a plain replacement, that authority check denies the same importer.
      const plain = await withSummary("agent", pinnedA);
      expect(
        await refusedWith(
          plain.store,
          plain.extended([replacementNote, supersede(plain.a.id, "r")]),
          importer,
        ),
      ).toMatchObject({ reason: "denied", detail: denial });
    });
  }

  test("positive control: a plain memory is superseded by a plain one, retracting its summary", async () => {
    const { store, relembra, b, summary, extended } = await withSummary();
    expect(
      await importJsonl(store, scopeOwner, extended([replacementNote, supersede(b.id, "r")])),
    ).toMatchObject({ imported: 2, refused: [] });
    expect((await relembra.zoom(owner, { memoryId: b.id })).status).toBe("superseded");
    expect((await relembra.zoom(owner, { memoryId: summary.id })).status).toBe("retracted");
  });

  test("a nested summary imports, floored at its source summary's trust, as submitSummary floors it", async () => {
    const { store, relembra, summary, extended } = await withSummary("untrusted");
    expect(summary.revision.provenance.trust).toBe("untrusted");
    const nested = {
      kind: "summarize",
      memoryId: "nested",
      scope: SCOPE,
      principalId: "x",
      sources: [{ memoryId: summary.id, revision: 1 }],
      revision: revisionLine("A summary of the summary."),
    };
    expect(await importJsonl(store, scopeOwner, extended([nested]))).toMatchObject({
      imported: 1,
    });
    const imported = await relembra.zoom(owner, { memoryId: "nested" });
    expect(imported.status).toBe("live");
    expect(imported.status !== "redacted" && imported.revision.provenance.trust).toBe("untrusted");
    // The direct path gives the same floor.
    const direct = await relembra.submitSummary(owner, {
      scope: SCOPE,
      sources: [{ memoryId: summary.id, revision: 1 }],
      text: "A direct summary of the summary.",
      provenance,
    });
    expect(direct.revision.provenance.trust).toBe("untrusted");
  });
});
