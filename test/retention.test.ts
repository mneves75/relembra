import { describe, expect, test } from "bun:test";
import { createRelembra, type Principal, type RetentionRule } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

const DAY = 86_400_000;
const owner: Principal = {
  id: "owner",
  readable: [SCOPE, OTHER_SCOPE],
  writable: [SCOPE, OTHER_SCOPE],
  promotable: [],
  owned: [SCOPE, OTHER_SCOPE],
};

function open(retention?: readonly RetentionRule[], now = 0) {
  const store = createMemoryStore();
  const clock = { now: () => now };
  const relembra = createRelembra<null>({
    store,
    policy: () => owner,
    clock,
    ...(retention === undefined ? {} : { retention }),
  });
  return { store, relembra };
}

describe("retention rules", () => {
  test("a rule needs a scope and a positive whole number of days, once per scope", () => {
    const bad: unknown[] = [
      [{ scope: "", maxAgeDays: 30 }],
      [{ scope: "x".repeat(300), maxAgeDays: 30 }],
      [{ scope: SCOPE, maxAgeDays: 0 }],
      [{ scope: SCOPE, maxAgeDays: -1 }],
      [{ scope: SCOPE, maxAgeDays: 1.5 }],
      [{ scope: SCOPE, maxAgeDays: Number.POSITIVE_INFINITY }],
      [
        { scope: SCOPE, maxAgeDays: 30 },
        { scope: SCOPE, maxAgeDays: 60 },
      ],
      "not a list",
    ];
    for (const retention of bad) {
      expect(() => open(retention as readonly RetentionRule[])).toThrow(RangeError);
    }
    // Positive control: one rule per scope.
    open([
      { scope: SCOPE, maxAgeDays: 30 },
      { scope: OTHER_SCOPE, maxAgeDays: 1 },
    ]);
  });

  test("sweep needs a whole number of epoch milliseconds", async () => {
    const { relembra } = open([{ scope: SCOPE, maxAgeDays: 30 }]);
    for (const now of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, -1]) {
      await expect(relembra.sweep(now)).rejects.toBeInstanceOf(RangeError);
    }
    expect(await relembra.sweep(0)).toEqual({ redacted: [], derived: [] });
  });
});

describe("sweep", () => {
  test("redacts only when the host calls it: reads and writes never expire a memory", async () => {
    const { relembra } = open([{ scope: SCOPE, maxAgeDays: 1 }], 0);
    const old = await relembra.note(null, { scope: SCOPE, text: "Old fact.", provenance });
    // The clock reads 0, but nothing here asks for a sweep, so nothing is redacted.
    await relembra.wake(null);
    await relembra.find(null, { query: "fact" });
    const later = await relembra.note(null, { scope: SCOPE, text: "A later fact.", provenance });
    expect((await relembra.recall(null)).map((m) => m.id)).toEqual([later.id, old.id]);

    // Positive control: the host's sweep, ten days on, redacts both.
    const report = await relembra.sweep(10 * DAY);
    expect([...report.redacted].sort()).toEqual([later.id, old.id].sort());
    expect(await relembra.recall(null)).toEqual([]);
  });

  test("with no rules, sweep redacts nothing", async () => {
    const { relembra } = open(undefined, 0);
    await relembra.note(null, { scope: SCOPE, text: "Kept forever.", provenance });
    expect(await relembra.sweep(1000 * DAY)).toEqual({ redacted: [], derived: [] });
    expect(await relembra.recall(null)).toHaveLength(1);
  });

  test("each scope expires by its own rule", async () => {
    const { relembra } = open(
      [
        { scope: SCOPE, maxAgeDays: 1 },
        { scope: OTHER_SCOPE, maxAgeDays: 10 },
      ],
      0,
    );
    const short = await relembra.note(null, { scope: SCOPE, text: "Short-lived.", provenance });
    await relembra.note(null, { scope: OTHER_SCOPE, text: "Long-lived.", provenance });

    expect(await relembra.sweep(5 * DAY)).toEqual({ redacted: [short.id], derived: [] });
    expect((await relembra.recall(null)).map((m) => m.revision.text)).toEqual(["Long-lived."]);
  });
});
