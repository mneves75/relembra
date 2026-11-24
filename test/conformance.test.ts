import { describe, expect, test } from "bun:test";
import { createRelembra, type Principal } from "relembra";
import { createMemoryStore, storeConformanceCases } from "relembra/testing";
import { timedStore } from "./store-time-support.js";
import { provenance, SCOPE } from "./support.js";

describe("store conformance: memory store", () => {
  const cases = storeConformanceCases({ open: () => ({ store: createMemoryStore(), close() {} }) });
  for (const conformance of cases) test(conformance.name, () => conformance.run());
});

describe("store conformance: memory store keeping its own time", () => {
  // A clock far from the suite's caller clocks, that moves on every read, as a database's does.
  let now = 1_900_000_000_000;
  const cases = storeConformanceCases({
    open: () => ({ store: timedStore(createMemoryStore(), () => (now += 7)), close() {} }),
  });
  for (const conformance of cases) test(conformance.name, () => conformance.run());
});

describe("core defensive invariants: generated ids, clocks, sparse sources and memory-store parity", () => {
  const owner: Principal = {
    id: "owner",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
  };

  test("a colliding Ids.memoryId is refused instead of overwriting an existing memory or tombstone", async () => {
    const store = createMemoryStore();
    let seq = 0;
    const relembra = createRelembra<null>({
      store,
      policy: () => owner,
      ids: { memoryId: () => "dup-id", opId: () => `op-${++seq}` },
    });
    const first = await relembra.note(null, { scope: SCOPE, text: "Original.", provenance });
    await expect(
      relembra.note(null, { scope: SCOPE, text: "Overwrite attempt.", provenance }),
    ).rejects.toBeInstanceOf(RangeError);
    expect((await relembra.recall(null)).map((m) => m.revision.text)).toEqual(["Original."]);

    await relembra.redact(null, { memoryId: first.id });
    await expect(
      relembra.note(null, { scope: SCOPE, text: "Resurrect attempt.", provenance }),
    ).rejects.toBeInstanceOf(RangeError);
    expect((await relembra.zoom(null, { memoryId: first.id })).status).toBe("redacted");
  });

  test("an invalid host Clock reading and sparse summary sources are refused", async () => {
    const store = createMemoryStore();
    const badClock = createRelembra<null>({
      store,
      policy: () => owner,
      clock: { now: () => Number.NaN },
    });
    await expect(
      badClock.note(null, { scope: SCOPE, text: "Bad clock.", provenance }),
    ).rejects.toBeInstanceOf(RangeError);

    const ok = createRelembra<null>({ store, policy: () => owner });
    const sparse = new Array(1) as { memoryId: string; revision: number }[];
    await expect(
      ok.submitSummary(null, { scope: SCOPE, sources: sparse, text: "Sparse.", provenance }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test("MemoryStore pendingErasures sorts carriers by id and rejects duplicate seq/tombstone overwrites", async () => {
    const store = createMemoryStore();
    await store.transaction(async (tx) => {
      await tx.putErasure({
        seq: 1,
        memoryId: "m1",
        carriers: [
          { id: "c-z", kind: "mcp" },
          { id: "c-a", kind: "mcp" },
        ],
      });
    });
    const pending = await store.pendingErasures({ after: 0, limit: 10 });
    expect(pending[0]?.carriers.map((c) => c.id)).toEqual(["c-a", "c-z"]);

    await expect(
      store.transaction(async (tx) => {
        await tx.putErasure({ seq: 1, memoryId: "m2", carriers: [] });
      }),
    ).rejects.toThrow();
    await expect(
      store.transaction(async (tx) => {
        await tx.redact({ id: "m1", scope: SCOPE, seq: 1, status: "redacted" });
        await tx.redact({ id: "m1", scope: SCOPE, seq: 2, status: "redacted" });
      }),
    ).rejects.toThrow();
  });
});
