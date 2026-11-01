import { describe, expect, test } from "bun:test";
import {
  type Carrier,
  createRelembra,
  EgressDeniedError,
  type EgressFilter,
  type ErasureHook,
  type ErasureWork,
  type Exposure,
  ExposureRedactedError,
  IdentifierError,
  type Principal,
  type Store,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

const principals: Record<string, Principal> = {
  owner: {
    id: "owner",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [OTHER_SCOPE],
    owned: [SCOPE],
  },
  other: { id: "other", readable: [OTHER_SCOPE], writable: [OTHER_SCOPE], promotable: [] },
};

const CHAT: Carrier = { id: "host/7", kind: "pi-durable" };
const SESSION: Carrier = { id: "mcp:session-1", kind: "mcp" };

/** `store` with every recordExposure call kept, and an optional replacement for it. */
function spied(store: Store, replace?: (exposure: Exposure) => Promise<readonly string[]>) {
  const calls: Exposure[] = [];
  const wrapped: Store = {
    ...store,
    recordExposure(exposure) {
      calls.push(exposure);
      return replace === undefined ? store.recordExposure(exposure) : replace(exposure);
    },
  };
  return { store: wrapped, calls };
}

function open(options: { store?: Store; egress?: EgressFilter } = {}) {
  const store = options.store ?? createMemoryStore();
  let n = 0;
  const relembra = createRelembra<string>({
    store,
    policy: (name) => principals[name] as Principal,
    ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
    clock: { now: () => 1_000 + n },
    ...(options.egress === undefined ? {} : { egress: options.egress }),
  });
  const note = (text: string, scope = SCOPE) => relembra.note("owner", { scope, text, provenance });
  return { store, relembra, note };
}

const sorted = (ids: readonly string[]) => [...ids].sort();

describe("a rendering records the memory ids it carried", () => {
  test("wake, brief and findRendering record exactly their memoryIds for the carrier", async () => {
    const base = createMemoryStore();
    const { store, calls } = spied(base);
    const { relembra, note } = open({ store });
    await note("Deploys run on Fridays.");
    await note("Rollbacks use the previous tag.");
    await note("Lunch is at noon.");

    const wake = await relembra.wake("owner", { carrier: CHAT });
    const brief = await relembra.brief("owner", { topic: "deploys", carrier: CHAT });
    const found = await relembra.findRendering("owner", { query: "rollbacks", carrier: SESSION });

    expect(wake.memoryIds.length).toBe(3);
    expect(brief.memoryIds.length).toBe(1);
    expect(found.memoryIds.length).toBe(1);
    expect(calls).toEqual([
      { carrier: CHAT, memoryIds: sorted(wake.memoryIds), at: expect.any(Number) },
      { carrier: CHAT, memoryIds: sorted(brief.memoryIds), at: expect.any(Number) },
      { carrier: SESSION, memoryIds: sorted(found.memoryIds), at: expect.any(Number) },
    ]);
    // The store holds them: a redaction reads them back.
    const carriers = await base.transaction((tx) => tx.exposures(found.memoryIds[0] as string));
    expect(carriers).toContainEqual(SESSION);
  });

  test("index lines carry no text, so a wake records only the memories it shows in full", async () => {
    const { store, calls } = spied(createMemoryStore());
    const { relembra, note } = open({ store });
    for (let i = 0; i < 40; i++) await note(`Release step ${i}: ${"check ".repeat(30)}done.`);

    const wake = await relembra.wake("owner", { carrier: CHAT, budgetBytes: 2_000 });

    expect(wake.text).toContain("<index");
    expect(wake.memoryIds.length).toBeGreaterThan(0);
    expect(wake.memoryIds.length).toBeLessThan(40);
    expect(calls.map((call) => call.memoryIds)).toEqual([sorted(wake.memoryIds)]);
  });

  test("without a carrier, a rendering records nothing", async () => {
    const { store, calls } = spied(createMemoryStore());
    const { relembra, note } = open({ store });
    await note("Deploys run on Fridays.");

    const wake = await relembra.wake("owner");
    await relembra.brief("owner", { topic: "deploys" });
    await relembra.findRendering("owner", { query: "deploys" });

    expect(wake.memoryIds.length).toBe(1);
    expect(calls).toEqual([]);
  });

  test("an egress deny records nothing, and an allowed rendering does (positive control)", async () => {
    let deny = true;
    const egress: EgressFilter = (rendering) =>
      deny ? { allow: false, reason: "revoked" } : { allow: true, text: rendering };
    const { store, calls } = spied(createMemoryStore());
    const { relembra, note } = open({ store, egress });
    await note("Deploys run on Fridays.");

    await expect(relembra.wake("owner", { carrier: CHAT })).rejects.toBeInstanceOf(
      EgressDeniedError,
    );
    await expect(
      relembra.findRendering("owner", { query: "deploys", carrier: CHAT }),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(calls).toEqual([]);

    deny = false;
    await relembra.wake("owner", { carrier: CHAT });
    expect(calls.length).toBe(1);
  });

  test("an empty rendering records nothing", async () => {
    const { store, calls } = spied(createMemoryStore());
    const { relembra } = open({ store });

    const wake = await relembra.wake("owner", { carrier: CHAT });
    const found = await relembra.findRendering("owner", { query: "nothing", carrier: CHAT });

    expect(wake.memoryIds).toEqual([]);
    expect(found.memoryIds).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a rendering the egress filter empties carries no memory and records nothing, even when recording would fail", async () => {
    const emptying: EgressFilter = () => ({ allow: true, text: "" });
    for (const replace of [undefined, () => Promise.reject(new Error("recorder down"))]) {
      const { store, calls } = spied(createMemoryStore(), replace);
      const { relembra, note } = open({ store, egress: emptying });
      await note("Deploys run on Fridays.");

      const renderings = [
        await relembra.wake("owner", { carrier: CHAT }),
        await relembra.brief("owner", { topic: "deploys", carrier: CHAT }),
        await relembra.findRendering("owner", { query: "deploys", carrier: CHAT }),
      ];

      expect(renderings).toEqual([
        { text: "", memoryIds: [] },
        { text: "", memoryIds: [] },
        { text: "", memoryIds: [] },
      ]);
      expect(calls).toEqual([]);
    }
    // Positive control: the same memory under the identity filter is carried and recorded.
    const { store, calls } = spied(createMemoryStore());
    const { relembra, note } = open({ store });
    await note("Deploys run on Fridays.");
    expect((await relembra.wake("owner", { carrier: CHAT })).memoryIds.length).toBe(1);
    expect(calls.length).toBe(1);
  });

  test("a recording that fails refuses the rendering", async () => {
    const failure = new Error("exposures unavailable");
    const { store, calls } = spied(createMemoryStore(), async () => {
      throw failure;
    });
    const { relembra, note } = open({ store });
    await note("Deploys run on Fridays.");

    await expect(relembra.wake("owner", { carrier: CHAT })).rejects.toBe(failure);
    await expect(relembra.brief("owner", { topic: "deploys", carrier: CHAT })).rejects.toBe(
      failure,
    );
    await expect(relembra.findRendering("owner", { query: "deploys", carrier: CHAT })).rejects.toBe(
      failure,
    );
    expect(calls.length).toBe(3);
    // Positive control: without a carrier the same rendering is returned.
    expect((await relembra.wake("owner")).memoryIds.length).toBe(1);
  });

  test("a memory redacted between the read and the recording is rendered again without it", async () => {
    const base = createMemoryStore();
    let raced = false;
    let relembraRef: ReturnType<typeof open>["relembra"] | undefined;
    let victim = "";
    const { store, calls } = spied(base, async (exposure) => {
      if (!raced) {
        raced = true;
        // A redaction commits after the wake read its memories and before it recorded them.
        await relembraRef?.redact("owner", { memoryId: victim });
      }
      return base.recordExposure(exposure);
    });
    const { relembra, note } = open({ store });
    relembraRef = relembra;
    victim = (await note("Redacted while rendered.")).id;
    const kept = await note("Kept all along.");

    const wake = await relembra.wake("owner", { carrier: CHAT });

    expect(wake.memoryIds).toEqual([kept.id]);
    expect(wake.text).not.toContain("Redacted while rendered.");
    expect(calls.map((call) => call.memoryIds)).toEqual([sorted([victim, kept.id]), [kept.id]]);
  });

  test("a store that keeps reporting a redaction refuses the rendering", async () => {
    const { store, calls } = spied(createMemoryStore(), async (exposure) => exposure.memoryIds);
    const { relembra, note } = open({ store });
    await note("Deploys run on Fridays.");

    await expect(relembra.wake("owner", { carrier: CHAT })).rejects.toBeInstanceOf(
      ExposureRedactedError,
    );
    expect(calls.length).toBe(3);
  });

  test("a carrier that breaks the identifier rule is refused before anything is read", async () => {
    const { store, calls } = spied(createMemoryStore());
    const { relembra, note } = open({ store });
    await note("Deploys run on Fridays.");

    await expect(
      relembra.wake("owner", { carrier: { id: "line\nbreak", kind: "mcp" } }),
    ).rejects.toMatchObject({ name: "IdentifierError", field: "carrier id" });
    await expect(
      relembra.brief("owner", { topic: "deploys", carrier: { id: "ok", kind: "" } }),
    ).rejects.toMatchObject({ name: "IdentifierError", field: "carrier kind" });
    await expect(
      relembra.findRendering("owner", {
        query: "deploys",
        carrier: { id: "x".repeat(513), kind: "mcp" },
      }),
    ).rejects.toBeInstanceOf(IdentifierError);
    await expect(
      relembra.wake("owner", { carrier: { id: 7, kind: "mcp" } as unknown as Carrier }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
    // Positive control: a 512-byte id and a 64-byte kind pass.
    await relembra.wake("owner", { carrier: { id: "x".repeat(512), kind: "k".repeat(64) } });
    expect(calls.length).toBe(1);
  });
});

describe("a redaction lists the carriers of every memory it erases", () => {
  test("the origin, its summary and its promoted copy each get the carriers that received them", async () => {
    const { store, relembra, note } = open();
    const origin = await note("Releases ship from the release branch.");
    const summary = await relembra.submitSummary("owner", {
      scope: SCOPE,
      text: "Summary: releases ship from a branch.",
      sources: [{ memoryId: origin.id, revision: 1 }],
      provenance,
    });
    const copy = await relembra.promote("owner", {
      memoryId: origin.id,
      revision: 1,
      scope: OTHER_SCOPE,
      provenance,
    });
    const unseen = await note("Never rendered to anyone.");

    await relembra.brief("owner", { topic: "releases", carrier: CHAT });
    await relembra.wake("other", { carrier: SESSION });
    await relembra.redact("owner", { memoryId: origin.id });
    await relembra.redact("owner", { memoryId: unseen.id });

    const work = await store.erasures();
    expect(work.map((w) => [w.memoryId, w.carriers])).toEqual([
      [origin.id, [CHAT]],
      [summary.id, [CHAT]],
      [copy.id, [SESSION]],
      [unseen.id, []],
    ]);
  });
});

describe("erasure delivery", () => {
  /** A store with two redacted memories: one seen by two carriers, one by none. */
  async function redacted() {
    const opened = open();
    const { relembra, note } = opened;
    const seen = await note("Seen by two carriers.");
    const unseen = await note("Seen by nobody.");
    await relembra.findRendering("owner", { query: "carriers", carrier: CHAT });
    await relembra.findRendering("owner", { query: "carriers", carrier: SESSION });
    await relembra.redact("owner", { memoryId: seen.id });
    await relembra.redact("owner", { memoryId: unseen.id });
    return { ...opened, seen, unseen };
  }

  test("the hook gets each row's pending carriers, and its answers are kept per carrier", async () => {
    const { relembra, seen, unseen } = await redacted();
    const sent: ErasureWork[] = [];
    const hook: ErasureHook = (work) => {
      sent.push(work);
      return { [CHAT.id]: "acknowledged", [SESSION.id]: "unsupported" };
    };

    const delivery = await relembra.deliverErasures(hook);

    // The row with no carriers is not sent: there is nobody to tell.
    expect(sent).toEqual([
      { seq: expect.any(Number), memoryId: seen.id, carriers: [CHAT, SESSION] },
    ]);
    expect(delivery).toEqual({ acknowledged: 1, unsupported: 1, pending: 0, errors: [] });
    expect(await relembra.erasureStatus()).toEqual([
      {
        seq: expect.any(Number),
        memoryId: seen.id,
        carriers: [
          { ...CHAT, status: "acknowledged" },
          { ...SESSION, status: "unsupported" },
        ],
      },
      { seq: expect.any(Number), memoryId: unseen.id, carriers: [] },
    ]);
    // Settled carriers are never sent again.
    const again = await relembra.deliverErasures(hook);
    expect(sent.length).toBe(1);
    expect(again).toEqual({ acknowledged: 0, unsupported: 0, pending: 0, errors: [] });
  });

  test("a hook that returns nothing leaves every carrier pending, and they are sent again", async () => {
    const { relembra } = await redacted();
    let calls = 0;
    const silent = (() => {
      calls++;
    }) as unknown as ErasureHook;

    expect(await relembra.deliverErasures(silent)).toEqual({
      acknowledged: 0,
      unsupported: 0,
      pending: 2,
      errors: [],
    });
    expect((await relembra.erasureStatus())[0]?.carriers.map((c) => c.status)).toEqual([
      "pending",
      "pending",
    ]);
    await relembra.deliverErasures(silent);
    expect(calls).toBe(2);
  });

  test("a carrier the hook leaves out, or answers with anything else, stays pending and is the only one sent again", async () => {
    const { relembra } = await redacted();
    const sent: ErasureWork[] = [];
    const answers = [
      { [CHAT.id]: "acknowledged", [SESSION.id]: "erased" },
      { [SESSION.id]: "ACKNOWLEDGED" },
      Object.create({ [SESSION.id]: "acknowledged" }),
      { [SESSION.id]: "acknowledged" },
    ];
    const hook = ((work: ErasureWork) => {
      sent.push(work);
      return answers[sent.length - 1];
    }) as ErasureHook;

    for (let round = 0; round < 3; round++) await relembra.deliverErasures(hook);
    expect(sent.map((work) => work.carriers)).toEqual([[CHAT, SESSION], [SESSION], [SESSION]]);
    expect((await relembra.erasureStatus())[0]?.carriers.map((c) => c.status)).toEqual([
      "acknowledged",
      "pending",
    ]);
    // Positive control: an exact answer settles it.
    expect(await relembra.deliverErasures(hook)).toMatchObject({ acknowledged: 1, pending: 0 });
  });

  test("a hook that throws leaves that row pending, reports the error, and the other rows are delivered", async () => {
    const { relembra, note } = await redacted();
    const other = await note("Seen by the chat only.");
    await relembra.findRendering("owner", { query: "chat only", carrier: CHAT });
    await relembra.redact("owner", { memoryId: other.id });
    const failure = new Error("host offline");
    const hook: ErasureHook = (work) => {
      if (work.carriers.length === 2) throw failure;
      return { [CHAT.id]: "acknowledged" };
    };

    const delivery = await relembra.deliverErasures(hook);

    expect(delivery).toEqual({ acknowledged: 1, unsupported: 0, pending: 2, errors: [failure] });
    const status = await relembra.erasureStatus();
    expect(status.map((row) => row.carriers.map((c) => c.status))).toEqual([
      ["pending", "pending"],
      [],
      ["acknowledged"],
    ]);
  });

  test("delivery reads only pending work, a bounded page at a time, never the full outbox", async () => {
    const base = createMemoryStore();
    const pages: { after?: number; limit: number }[] = [];
    const store: Store = {
      ...base,
      erasures: () => Promise.reject(new Error("delivery read the full outbox")),
      settlements: () => Promise.reject(new Error("delivery read every outcome")),
      pendingErasures(query) {
        pages.push(query);
        return base.pendingErasures(query);
      },
    };
    // 250 redacted memories, each seen by the chat, and one settled already.
    await base.transaction(async (tx) => {
      for (let seq = 1; seq <= 250; seq++) {
        await tx.putErasure({ seq, memoryId: `m-${seq}`, carriers: [CHAT] });
      }
      await tx.settle({ seq: 1, carrierId: CHAT.id, status: "acknowledged", at: 1 });
    });
    const { relembra } = open({ store });
    const sent: number[] = [];

    const delivery = await relembra.deliverErasures((work) => {
      sent.push(work.seq);
      return work.seq % 2 === 0 ? { [CHAT.id]: "acknowledged" } : undefined;
    });

    expect(sent).toEqual(Array.from({ length: 249 }, (_, n) => n + 2));
    expect(delivery).toEqual({ acknowledged: 125, unsupported: 0, pending: 124, errors: [] });
    expect(pages.length).toBeGreaterThan(1);
    for (const query of pages) expect(query.limit).toBeLessThanOrEqual(100);
    // Nothing pending is one empty page and no hook call.
    const quiet = await relembra.deliverErasures(() => ({ [CHAT.id]: "acknowledged" }));
    expect(quiet).toEqual({ acknowledged: 124, unsupported: 0, pending: 0, errors: [] });
    pages.length = 0;
    expect(await relembra.deliverErasures(() => undefined)).toMatchObject({ pending: 0 });
    expect(pages.length).toBe(1);
  });

  test("no status ever says a copy was erased", async () => {
    const { relembra } = await redacted();
    await relembra.deliverErasures(() => ({ [CHAT.id]: "acknowledged" }));
    const text = JSON.stringify(await relembra.erasureStatus());
    expect(text).toContain("acknowledged");
    expect(text).toContain("pending");
    expect(text).not.toMatch(/erased|deleted/);
  });
});
