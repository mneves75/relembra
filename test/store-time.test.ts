import { describe, expect, test } from "bun:test";
import {
  createRelembra,
  exportJsonl,
  importJsonl,
  importOptmem,
  MAX_IMPORT_SKEW_MS,
  type Principal,
  type Store,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { timedStore } from "./store-time-support.js";
import { provenance, SCOPE } from "./support.js";

const DAY = 86_400_000;
const owner: Principal = {
  id: "owner",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  owned: [SCOPE],
};

/** A relembra whose caller clock reads `callerNow`, over `store`. */
function open(store: Store, callerNow: number, retention = false) {
  let next = 0;
  return createRelembra<null>({
    store,
    policy: () => owner,
    clock: { now: () => callerNow },
    ids: { memoryId: () => `m-${callerNow}-${++next}`, opId: () => `op-${callerNow}-${++next}` },
    ...(retention ? { retention: [{ scope: SCOPE, maxAgeDays: 30 }] } : {}),
  });
}

describe("a store that keeps its own time (database time, IMPLEMENTATION-PLAN §4.3)", () => {
  test("a note is accepted at the store's time; the caller's time stays as revision.at", async () => {
    let storeNow = 50 * DAY;
    const store = timedStore(createMemoryStore(), () => storeNow);
    const noted = await open(store, 7_000).note(null, {
      scope: SCOPE,
      text: "Accepted by the database clock.",
      provenance,
      opId: "op-1",
    });

    expect(noted.notedAt).toBe(50 * DAY);
    expect(noted.revision.at).toBe(7_000);
    const op = await store.transaction((tx) => tx.op(owner.id, "op-1"));
    expect(op?.at).toBe(50 * DAY);

    // A retry from another process, with another caller clock and a later store time, returns
    // the first outcome: both times as first committed.
    storeNow = 60 * DAY;
    const retried = await open(store, 9_000).note(null, {
      scope: SCOPE,
      text: "Accepted by the database clock.",
      provenance,
      opId: "op-1",
    });
    expect(retried).toEqual(noted);

    // Positive control: a store without its own time accepts at the caller's time.
    const plain = await open(createMemoryStore(), 7_000).note(null, {
      scope: SCOPE,
      text: "Accepted by the caller clock.",
      provenance,
    });
    expect([plain.notedAt, plain.revision.at]).toEqual([7_000, 7_000]);
  });

  test("supersede and summaries are accepted at the store's time too", async () => {
    const store = timedStore(createMemoryStore(), () => 80 * DAY);
    const relembra = open(store, 3_000);
    const first = await relembra.note(null, { scope: SCOPE, text: "Old rule.", provenance });
    const replacement = await relembra.supersede(null, {
      memoryId: first.id,
      text: "New rule.",
      provenance,
      opId: "op-supersede",
    });
    const summary = await relembra.submitSummary(null, {
      scope: SCOPE,
      text: "The rule changed.",
      sources: [{ memoryId: replacement.id, revision: 1 }],
      provenance,
      opId: "op-summary",
    });

    for (const written of [first, replacement, summary]) {
      expect([written.notedAt, written.revision.at]).toEqual([80 * DAY, 3_000]);
    }
    const retried = await open(store, 4_000).supersede(null, {
      memoryId: first.id,
      text: "New rule.",
      provenance,
      opId: "op-supersede",
    });
    expect(retried).toEqual(replacement);
  });

  test("a promoted copy is accepted at the store's time, so a host clock behind it cannot age the copy", async () => {
    const TEAM = "team/shared";
    const promoter: Principal = {
      id: "promoter",
      readable: [SCOPE, TEAM],
      writable: [SCOPE, TEAM],
      promotable: [TEAM],
      owned: [SCOPE, TEAM],
    };
    const store = timedStore(createMemoryStore(), () => 90 * DAY);
    const relembra = createRelembra<null>({
      store,
      policy: () => promoter,
      clock: { now: () => 0 },
      retention: [{ scope: TEAM, maxAgeDays: 1 }],
    });
    const origin = await relembra.note(null, { scope: SCOPE, text: "Shared rule.", provenance });
    const copy = await relembra.promote(null, {
      memoryId: origin.id,
      revision: 1,
      scope: TEAM,
      provenance,
      opId: "op-promote",
    });

    expect([copy.notedAt, copy.revision.at]).toEqual([90 * DAY, 0]);
    const op = await store.transaction((tx) => tx.op(promoter.id, "op-promote"));
    expect(op?.at).toBe(90 * DAY);
    // The host's clock reads the start of time; the copy was accepted a moment ago by the store.
    expect(await relembra.sweep(0)).toEqual({ redacted: [], derived: [] });
  });

  test("retention counts from the store's time, not the time the host passes", async () => {
    let storeNow = 10 * DAY;
    const store = timedStore(createMemoryStore(), () => storeNow);
    const relembra = open(store, 0, true);
    const old = await relembra.note(null, { scope: SCOPE, text: "Noted early.", provenance });

    // The host's clock says a year later; the store says 20 days later: nothing has expired.
    storeNow = 30 * DAY;
    expect(await relembra.sweepPreview(400 * DAY)).toEqual([]);
    expect(await relembra.sweep(400 * DAY)).toEqual({ redacted: [], derived: [] });

    // The host's clock says the start of time; the store says 31 days later: it has expired.
    storeNow = 41 * DAY;
    expect((await relembra.sweepPreview(0)).map((m) => m.id)).toEqual([old.id]);
    expect(await relembra.sweep(0)).toEqual({ redacted: [old.id], derived: [] });
  });

  test("a store time that is not whole non-negative epoch milliseconds is refused", async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const store = timedStore(createMemoryStore(), () => bad);
      await expect(
        open(store, 1_000).note(null, { scope: SCOPE, text: "Bad time.", provenance }),
      ).rejects.toThrow(TypeError);
      expect(await store.recall({ scopes: [SCOPE], limit: 10 })).toEqual([]);
    }
    // Positive control: a whole time is accepted.
    const store = timedStore(createMemoryStore(), () => 1);
    await open(store, 1_000).note(null, { scope: SCOPE, text: "Good time.", provenance });
    expect((await store.recall({ scopes: [SCOPE], limit: 10 })).length).toBe(1);
  });

  test("an OptMem import is accepted at the store's time; the caller's time stays as revision.at", async () => {
    const storeNow = 50 * DAY;
    const store = timedStore(createMemoryStore(), () => storeNow);
    const log = Buffer.from(`${"An imported fact.".padEnd(31, " ")}\n`);
    const input = {
      scope: SCOPE,
      store: "timed",
      log,
      clock: { now: () => 0 },
      provenance: { agent: "importer", harness: "optmem", model: "none", host: "test" },
    };
    expect(await importOptmem(store, owner, input)).toMatchObject({ imported: 1 });
    const [imported] = await store.recall({ scopes: [SCOPE], limit: 10 });
    expect([imported?.notedAt, imported?.revision.at]).toEqual([50 * DAY, 0]);
    // Retention counts from the store's time: a caller clock at 0 does not make it expire.
    expect(await open(store, 0, true).sweep(0)).toEqual({ redacted: [], derived: [] });

    // Positive control: a store without its own time dates it by the caller's clock.
    const plain = createMemoryStore();
    await importOptmem(plain, owner, input);
    const [dated] = await plain.recall({ scopes: [SCOPE], limit: 10 });
    expect([dated?.notedAt, dated?.revision.at]).toEqual([0, 0]);
  });

  test("a JSONL import bounds revision times by the store's time, and keeps each revision's age", async () => {
    /** An export of one memory whose revision is dated `at`. */
    const exportAt = async (at: number) => {
      const source = createMemoryStore();
      await open(source, 1).note(null, { scope: SCOPE, text: "A dated fact.", provenance });
      const [header, event] = (await exportJsonl(source, owner, { scope: SCOPE })).split("\n") as [
        string,
        string,
      ];
      const parsed = JSON.parse(event);
      return `${header}\n${JSON.stringify({ ...parsed, revision: { ...parsed.revision, at } })}\n`;
    };
    const storeNow = 400 * DAY;

    // The host's clock is far behind the store's: a revision dated by the store's time imports,
    // and keeps that time as its age.
    const behind = timedStore(createMemoryStore(), () => storeNow);
    const report = await importJsonl(behind, owner, await exportAt(storeNow - DAY), {
      clock: { now: () => 0 },
    });
    expect(report).toMatchObject({ imported: 1 });
    const [kept] = await behind.recall({ scopes: [SCOPE], limit: 10 });
    expect([kept?.notedAt, kept?.revision.at]).toEqual([storeNow - DAY, storeNow - DAY]);

    // The host's clock is far ahead (2100): a revision past the store's time and skew is refused.
    const ahead = timedStore(createMemoryStore(), () => storeNow);
    const year2100 = { now: () => 4_102_444_800_000 };
    await expect(
      importJsonl(ahead, owner, await exportAt(storeNow + MAX_IMPORT_SKEW_MS + 1), {
        clock: year2100,
      }),
    ).rejects.toMatchObject({ name: "ImportError", reason: "future-time", line: 2 });
    expect(await ahead.events({ scopes: [SCOPE] })).toEqual([]);
    // Positive control: within the skew of the store's time, it imports.
    expect(
      await importJsonl(ahead, owner, await exportAt(storeNow + MAX_IMPORT_SKEW_MS), {
        clock: year2100,
      }),
    ).toMatchObject({ imported: 1 });
  });
});
