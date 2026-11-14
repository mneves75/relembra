import { describe, expect, test } from "bun:test";
import { createRelembra, type Memory, PlanChangedError, type Principal } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

const DAY = 86_400_000;
const owner: Principal = {
  id: "owner",
  readable: [SCOPE, OTHER_SCOPE],
  writable: [SCOPE, OTHER_SCOPE],
  promotable: [],
  owned: [SCOPE, OTHER_SCOPE],
  trustCeiling: "owner",
};

/** A store with an owner memory noted at 0 and a clock at 400 days, retention 30 days. */
async function open() {
  const store = createMemoryStore();
  let now = 0;
  let n = 0;
  const relembra = createRelembra<null>({
    store,
    policy: () => owner,
    clock: { now: () => now },
    ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
    retention: [{ scope: SCOPE, maxAgeDays: 30 }],
  });
  const ownerTrust = { ...provenance, trust: "owner" as const };
  const source = await relembra.note(null, {
    scope: SCOPE,
    text: "Two approvals.",
    provenance: ownerTrust,
  });
  now = 400 * DAY;
  /** What a second connection does while a person reads the confirmation prompt. */
  const concurrentSummary = () =>
    relembra.submitSummary(null, {
      scope: SCOPE,
      sources: [{ memoryId: source.id, revision: 1 }],
      text: "Approvals, summarized.",
      provenance: ownerTrust,
    });
  return { store, relembra, source, concurrentSummary, now: () => now };
}

const status = async (relembra: Awaited<ReturnType<typeof open>>["relembra"], id: string) =>
  (await relembra.zoom(null, { memoryId: id })).status;

describe("a mutation bound to the plan a person approved aborts when the plan changed", () => {
  test("redact", async () => {
    const { relembra, source, concurrentSummary } = await open();
    const approved = await relembra.redactionPreview(null, { memoryId: source.id });
    const summary: Memory = await concurrentSummary();
    // The summary, never shown, is redacted with the source.
    await expect(
      relembra.redact(null, { memoryId: source.id, expect: approved }),
    ).rejects.toBeInstanceOf(PlanChangedError);
    expect(await status(relembra, source.id)).toBe("live");
    expect(await status(relembra, summary.id)).toBe("live");
    // Positive control: the fresh plan is accepted, and erases exactly what it lists.
    const fresh = await relembra.redactionPreview(null, { memoryId: source.id });
    const report = await relembra.redact(null, { memoryId: source.id, expect: fresh });
    expect([...report.redacted, ...report.derived].sort()).toEqual(fresh.map((m) => m.id).sort());
  });

  test("sweep", async () => {
    const { relembra, source, concurrentSummary, now } = await open();
    const approved = await relembra.sweepPreview(now());
    const summary = await concurrentSummary();
    await expect(relembra.sweep(now(), { expect: approved })).rejects.toBeInstanceOf(
      PlanChangedError,
    );
    expect(await status(relembra, source.id)).toBe("live");
    expect(await status(relembra, summary.id)).toBe("live");
    const fresh = await relembra.sweepPreview(now());
    const report = await relembra.sweep(now(), { expect: fresh });
    expect([...report.redacted, ...report.derived].sort()).toEqual(fresh.map((m) => m.id).sort());
  });

  test("retract", async () => {
    const { relembra, source, concurrentSummary } = await open();
    const approved = await relembra.redactionPreview(null, { memoryId: source.id });
    const summary = await concurrentSummary();
    await expect(
      relembra.retract(null, { memoryId: source.id, expect: approved }),
    ).rejects.toBeInstanceOf(PlanChangedError);
    expect(await status(relembra, source.id)).toBe("live");
    expect(await status(relembra, summary.id)).toBe("live");
    const fresh = await relembra.redactionPreview(null, { memoryId: source.id });
    await relembra.retract(null, { memoryId: source.id, expect: fresh });
    expect(await status(relembra, summary.id)).toBe("retracted");
  });

  test("supersede", async () => {
    const { relembra, source, concurrentSummary } = await open();
    const approved = await relembra.redactionPreview(null, { memoryId: source.id });
    const summary = await concurrentSummary();
    const input = { memoryId: source.id, text: "One approval.", provenance };
    await expect(relembra.supersede(null, { ...input, expect: approved })).rejects.toBeInstanceOf(
      PlanChangedError,
    );
    expect(await status(relembra, source.id)).toBe("live");
    expect(await status(relembra, summary.id)).toBe("live");
    const fresh = await relembra.redactionPreview(null, { memoryId: source.id });
    await relembra.supersede(null, { ...input, expect: fresh });
    expect(await status(relembra, source.id)).toBe("superseded");
    expect(await status(relembra, summary.id)).toBe("retracted");
  });

  test("a change of status or revision counts, and with no plan given nothing changes", async () => {
    const { relembra, source, concurrentSummary } = await open();
    const summary = await concurrentSummary();
    const approved = await relembra.redactionPreview(null, { memoryId: source.id });
    // Same ids, but the summary is retracted since: a different plan.
    await relembra.retract(null, { memoryId: summary.id });
    await expect(
      relembra.redact(null, { memoryId: source.id, expect: approved }),
    ).rejects.toBeInstanceOf(PlanChangedError);
    // Without `expect`, redact compares no plan.
    expect((await relembra.redact(null, { memoryId: source.id })).redacted).toEqual([source.id]);
  });
});

type Opened = Awaited<ReturnType<typeof open>>;

/** Each mutation with its preview, as a host gates it. */
const MUTATIONS = {
  redact: {
    preview: ({ relembra, source }: Opened) =>
      relembra.redactionPreview(null, { memoryId: source.id }),
    run: ({ relembra, source }: Opened, expect: readonly Memory[]) =>
      relembra.redact(null, { memoryId: source.id, expect }),
  },
  sweep: {
    preview: ({ relembra, now }: Opened) => relembra.sweepPreview(now()),
    run: ({ relembra, now }: Opened, expect: readonly Memory[]) =>
      relembra.sweep(now(), { expect }),
  },
  retract: {
    preview: ({ relembra, source }: Opened) =>
      relembra.redactionPreview(null, { memoryId: source.id }),
    run: ({ relembra, source }: Opened, expect: readonly Memory[]) =>
      relembra.retract(null, { memoryId: source.id, expect }),
  },
  supersede: {
    preview: ({ relembra, source }: Opened) =>
      relembra.redactionPreview(null, { memoryId: source.id }),
    run: ({ relembra, source }: Opened, expect: readonly Memory[]) =>
      relembra.supersede(null, { memoryId: source.id, text: "One approval.", provenance, expect }),
  },
} as const;

/** In-place rewrites a second store connection could make, keeping id, seq, revision and status. */
const EDITS: Record<string, (m: Memory) => Memory> = {
  text: (m) => ({ ...m, revision: { ...m.revision, text: "Keep this fact; never erase it." } }),
  scope: (m) => ({ ...m, scope: OTHER_SCOPE }),
  provenance: (m) => ({
    ...m,
    revision: { ...m.revision, provenance: { ...m.revision.provenance, source: "elsewhere" } },
  }),
};

describe("the approval covers every field of every memory, not only its id, revision and status", () => {
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    for (const [field, edit] of Object.entries(EDITS)) {
      test(`${name}: an in-place change of ${field} after the preview needs a new approval`, async () => {
        const opened = await open();
        const { store, relembra, source } = opened;
        const approved = await mutation.preview(opened);
        // A direct store write: same id, seq, revision number and status.
        await store.transaction(async (tx) => tx.putMemory(edit(source)));
        await expect(mutation.run(opened, approved)).rejects.toBeInstanceOf(PlanChangedError);
        expect((await relembra.zoom(null, { memoryId: source.id })).status).toBe("live");
        // Positive control: the plan as it now stands is accepted.
        await mutation.run(opened, await mutation.preview(opened));
      });
    }
  }
});

describe("an approval that cannot be compared, or differs only where JSON is blind, is a changed plan", () => {
  /** The approval as given, against the source as stored: redact must refuse and erase nothing. */
  async function refused(opened: Opened, approval: readonly unknown[]) {
    const { relembra, source } = opened;
    await expect(
      relembra.redact(null, { memoryId: source.id, expect: approval as Memory[] }),
    ).rejects.toBeInstanceOf(PlanChangedError);
    expect((await relembra.zoom(null, { memoryId: source.id })).status).toBe("live");
  }

  test("a cyclic record in the approval", async () => {
    const opened = await open();
    const cyclic: Memory & { self?: unknown } = { ...opened.source };
    cyclic.self = cyclic;
    await refused(opened, [cyclic]);
  });

  test("a BigInt field in the approval", async () => {
    const opened = await open();
    await refused(opened, [{ ...opened.source, extra: 1n }]);
  });

  // A custom store may hold values JSON cannot tell apart; each pair is approved as the first
  // value and stored as the second before the redact runs.
  const BLIND: Record<string, [(m: Memory) => unknown, (m: Memory) => unknown]> = {
    "[undefined] then [null]": [
      (m) => ({ ...m, extra: [undefined] }),
      (m) => ({ ...m, extra: [null] }),
    ],
    "NaN then Infinity": [
      (m) => ({ ...m, revision: { ...m.revision, at: Number.NaN } }),
      (m) => ({ ...m, revision: { ...m.revision, at: Number.POSITIVE_INFINITY } }),
    ],
    "a missing field then an undefined one": [(m) => m, (m) => ({ ...m, supersededBy: undefined })],
  };
  for (const [name, [approvedAs, storedAs]] of Object.entries(BLIND)) {
    test(name, async () => {
      const opened = await open();
      const { store, relembra, source } = opened;
      const put = (memory: unknown) => store.transaction((tx) => tx.putMemory(memory as Memory));
      await put(approvedAs(source));
      const approved = await relembra.redactionPreview(null, { memoryId: source.id });
      await put(storedAs(source));
      await refused(opened, approved);
      // Positive control: an approval of the record as it now stands goes through.
      const fresh = await relembra.redactionPreview(null, { memoryId: source.id });
      expect(
        (await relembra.redact(null, { memoryId: source.id, expect: fresh })).redacted,
      ).toEqual([source.id]);
    });
  }
});

describe("a sparse approval is a changed plan: every slot must hold an approved record", () => {
  /** `length` slots, the first `filled` holding the approved records, the rest holes. */
  const sparse = (approved: readonly Memory[], length: number, filled: number): Memory[] => {
    const slots = new Array<Memory>(length);
    for (let i = 0; i < filled; i++) slots[i] = approved[i] as Memory;
    return slots;
  };

  for (const name of ["redact", "sweep"] as const) {
    const mutation = MUTATIONS[name];

    test(`${name}: new Array(1) does not approve a one-memory plan`, async () => {
      const opened = await open();
      expect(await mutation.preview(opened)).toHaveLength(1);
      // A sparse approval's holes are not skipped: an empty one is a changed plan.
      await expect(mutation.run(opened, new Array(1))).rejects.toBeInstanceOf(PlanChangedError);
      expect((await opened.relembra.zoom(null, { memoryId: opened.source.id })).status).toBe(
        "live",
      );
      // Positive control: the real approval of the same plan goes through.
      await mutation.run(opened, await mutation.preview(opened));
    });

    test(`${name}: [approved source, <hole>] does not approve its derived summary`, async () => {
      const opened = await open();
      const summary = await opened.concurrentSummary();
      const approved = await mutation.preview(opened);
      expect(approved).toHaveLength(2);
      const holed = sparse(
        approved.filter((m) => m.id === opened.source.id),
        2,
        1,
      );
      await expect(mutation.run(opened, holed)).rejects.toBeInstanceOf(PlanChangedError);
      for (const id of [opened.source.id, summary.id]) {
        expect((await opened.relembra.zoom(null, { memoryId: id })).status).toBe("live");
      }
      // Positive control: the whole approval goes through.
      await mutation.run(opened, approved);
    });
  }
});

describe("the approval is read once: what changes between reads cannot skip the check", () => {
  test("redact: a Proxy whose length is 1, then 0, does not approve a one-memory plan", async () => {
    const opened = await open();
    const { relembra, source } = opened;
    expect(await MUTATIONS.redact.preview(opened)).toHaveLength(1);
    // The approval's length is read once: one that shrinks between reads must not pass.
    let reads = 0;
    const shifting = new Proxy([] as Memory[], {
      get: (target, key, receiver) =>
        key === "length" ? (++reads === 1 ? 1 : 0) : Reflect.get(target, key, receiver),
    });
    await expect(
      relembra.redact(null, { memoryId: source.id, expect: shifting }),
    ).rejects.toBeInstanceOf(PlanChangedError);
    expect((await relembra.zoom(null, { memoryId: source.id })).status).toBe("live");
    // Positive control: a real approval of the same plan goes through.
    const fresh = await MUTATIONS.redact.preview(opened);
    expect((await relembra.redact(null, { memoryId: source.id, expect: fresh })).redacted).toEqual([
      source.id,
    ]);
  });
});
