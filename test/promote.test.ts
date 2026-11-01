import { describe, expect, test } from "bun:test";
import {
  advanceFence,
  createRelembra,
  FencedError,
  IdentifierError,
  type Memory,
  MemoryNotFoundError,
  MemoryRedactedError,
  OpConflictError,
  PlanChangedError,
  type Principal,
  ProvenanceError,
  ScopeDeniedError,
  SourceChangedError,
  type Trust,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { provenance } from "./support.js";

const TEAM = "team/shared";
const DEV = "dev/repo";
const ELSEWHERE = "dev/elsewhere";

const principals = {
  // Reads and owns DEV, may promote into TEAM.
  promoter: {
    id: "promoter",
    readable: [DEV],
    writable: [DEV],
    promotable: [TEAM],
    owned: [DEV],
    trustCeiling: "owner",
  },
  // Reads DEV (not owner) and promotes into TEAM, at the default ceiling.
  agent: { id: "agent", readable: [DEV], writable: [DEV], promotable: [TEAM] },
  // Promotes into TEAM, but cannot read DEV.
  stranger: { id: "stranger", readable: [ELSEWHERE], writable: [], promotable: [TEAM] },
  // Reads DEV, may not promote anywhere.
  reader: { id: "reader", readable: [DEV], writable: [DEV], promotable: [] },
  // Owns TEAM: reads, writes and summarizes the copies there.
  team: {
    id: "team",
    readable: [TEAM],
    writable: [TEAM],
    promotable: [],
    owned: [TEAM],
    trustCeiling: "owner",
  },
  // Owns DEV only: redacts the origin without any right on TEAM.
  devOwner: {
    id: "devOwner",
    readable: [DEV],
    writable: [DEV],
    promotable: [],
    owned: [DEV],
    trustCeiling: "owner",
  },
  // Promotes from DEV and from TEAM back into ELSEWHERE.
  relay: {
    id: "relay",
    readable: [DEV, TEAM],
    writable: [],
    promotable: [TEAM, ELSEWHERE],
    trustCeiling: "owner",
  },
  fenced: {
    id: "fenced",
    readable: [DEV],
    writable: [DEV],
    promotable: [TEAM],
    fence: { key: "lease", epoch: 1 },
  },
} satisfies Record<string, Principal>;

function open(overrides: Record<string, Principal> = {}) {
  const store = createMemoryStore();
  let n = 0;
  const all: Record<string, Principal> = { ...principals, ...overrides };
  const relembra = createRelembra<string>({
    store,
    policy: (name) => all[name] as Principal,
    clock: { now: () => 1_000 + n },
    ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
  });
  const note = (text: string, trust?: Trust, pinned = false) =>
    relembra.note("promoter", {
      scope: DEV,
      text,
      pinned,
      provenance: trust === undefined ? provenance : { ...provenance, trust },
    });
  const promote = (
    context: string,
    origin: Pick<Memory, "id"> & { revision?: { number: number } },
    more: { scope?: string; revision?: number; opId?: string; trust?: Trust } = {},
  ) =>
    relembra.promote(context, {
      memoryId: origin.id,
      revision: more.revision ?? origin.revision?.number ?? 1,
      scope: more.scope ?? TEAM,
      provenance: more.trust === undefined ? provenance : { ...provenance, trust: more.trust },
      ...(more.opId === undefined ? {} : { opId: more.opId }),
    });
  return { store, relembra, note, promote };
}

describe("promote: the copy and its link to the origin", () => {
  test("copies the origin's text into the target scope with a link to its id and revision", async () => {
    const { relembra, note, promote } = open();
    const origin = await note("Deploys go through the release branch.");
    const copy = await promote("promoter", origin);
    expect(copy.id).not.toBe(origin.id);
    expect(copy.scope).toBe(TEAM);
    expect(copy.revision.text).toBe(origin.revision.text);
    expect(copy.revision.number).toBe(1);
    expect(copy.origin).toEqual({ memoryId: origin.id, revision: 1 });
    expect(copy.status).toBe("live");
    expect(copy.sources).toBeUndefined();
    // The stored copy is what promote returned, and the origin is untouched.
    expect(await relembra.zoom("team", { memoryId: copy.id })).toEqual(copy);
    expect(await relembra.zoom("promoter", { memoryId: origin.id })).toEqual(origin);
    // Readers of the target scope find it through the term index.
    const found = await relembra.find("team", { query: "release branch" });
    expect(found.map((r) => r.memory.id)).toEqual([copy.id]);
  });

  test("is refused when the revision changed, and succeeds at the current one", async () => {
    const { note, promote } = open();
    const origin = await note("A fact at revision 1.");
    await expect(promote("promoter", origin, { revision: 2 })).rejects.toThrow(
      new SourceChangedError(origin.id),
    );
    // Positive control: the exact current revision.
    expect((await promote("promoter", origin, { revision: 1 })).origin).toEqual({
      memoryId: origin.id,
      revision: 1,
    });
  });

  test("is refused once the origin is superseded, retracted or redacted", async () => {
    const { relembra, note, promote } = open();
    const superseded = await note("Old fact.");
    await relembra.supersede("promoter", {
      memoryId: superseded.id,
      text: "New fact.",
      provenance,
    });
    const retracted = await note("Retracted fact.");
    await relembra.retract("promoter", { memoryId: retracted.id });
    const redacted = await note("Redacted fact.");
    await relembra.redact("promoter", { memoryId: redacted.id });
    for (const gone of [superseded, retracted, redacted]) {
      // The owner sees it, and is told it changed; a reader is told it does not exist.
      await expect(promote("promoter", gone)).rejects.toThrow(new SourceChangedError(gone.id));
      await expect(promote("agent", gone)).rejects.toThrow(new MemoryNotFoundError());
    }
    // Positive control: a live memory promotes for both.
    const live = await note("Live fact.");
    expect((await promote("agent", live)).scope).toBe(TEAM);
  });

  test("needs promote rights on the target and read access to the origin", async () => {
    const { note, promote } = open();
    const origin = await note("A fact.");
    await expect(promote("reader", origin)).rejects.toThrow(new ScopeDeniedError("promote"));
    await expect(promote("promoter", origin, { scope: ELSEWHERE })).rejects.toThrow(
      new ScopeDeniedError("promote"),
    );
    await expect(promote("stranger", origin)).rejects.toThrow(new MemoryNotFoundError());
    await expect(promote("agent", { id: "memory-404" })).rejects.toThrow(new MemoryNotFoundError());
    // Positive control: promote rights on TEAM and read access to DEV, without write on TEAM.
    expect((await promote("agent", origin)).scope).toBe(TEAM);
  });

  test("refuses the origin's own scope and a summary, and promotes a plain memory", async () => {
    const { relembra, note, promote } = open({
      promoter: { ...principals.promoter, promotable: [TEAM, DEV] },
    });
    const origin = await note("A fact.");
    await expect(promote("promoter", origin, { scope: DEV })).rejects.toBeInstanceOf(RangeError);
    const summary = await relembra.submitSummary("promoter", {
      scope: DEV,
      sources: [{ memoryId: origin.id, revision: 1 }],
      text: "A summary.",
      provenance,
    });
    await expect(promote("promoter", summary)).rejects.toBeInstanceOf(RangeError);
    // Positive control: the plain memory, into another scope.
    expect((await promote("promoter", origin)).scope).toBe(TEAM);
  });

  test("never pins the copy, even of a pinned origin", async () => {
    const { note, promote } = open({
      promoter: { ...principals.promoter, pinnable: [DEV, TEAM] },
    });
    const pinned = await note("A pinned rule.", undefined, true);
    expect(pinned.pinned).toBe(true);
    expect((await promote("promoter", pinned)).pinned).toBe(false);
  });

  test("applies the identifier rule to the memory id and the scope", async () => {
    const { note, promote } = open();
    const origin = await note("A fact.");
    await expect(promote("promoter", { id: "bad\u0007id" })).rejects.toBeInstanceOf(
      IdentifierError,
    );
    await expect(
      promote("promoter", origin, { scope: "team/\u200bshared" }),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
    const bidi = open({
      promoter: { ...principals.promoter, promotable: ["team/\u202eshared"] },
    });
    await expect(bidi.promote("promoter", origin, { scope: "team/\u202eshared" })).rejects.toThrow(
      IdentifierError,
    );
    await expect(promote("promoter", origin, { revision: 0 })).rejects.toBeInstanceOf(RangeError);
    // Positive control.
    expect((await promote("promoter", origin)).scope).toBe(TEAM);
  });

  test("a stale fence commits nothing", async () => {
    const { store, relembra, note, promote } = open();
    const origin = await note("A fact.");
    await advanceFence(store, { key: "lease", epoch: 2 });
    await expect(promote("fenced", origin)).rejects.toBeInstanceOf(FencedError);
    expect(await relembra.recall("team")).toEqual([]);
    // Positive control: the current epoch commits.
    const current = open({
      fenced: { ...principals.fenced, fence: { key: "lease", epoch: 2 } },
    });
    const again = await current.note("A fact.");
    await advanceFence(current.store, { key: "lease", epoch: 2 });
    expect((await current.promote("fenced", again)).scope).toBe(TEAM);
  });
});

describe("promote: trust", () => {
  test("the copy's trust is at most the origin's", async () => {
    const { note, promote } = open();
    const untrusted = await note("From a web page.", "untrusted");
    expect((await promote("promoter", untrusted)).revision.provenance.trust).toBe("untrusted");
    const agent = await note("Model-written.", "agent");
    await expect(promote("promoter", agent, { trust: "owner" })).rejects.toThrow(
      new ProvenanceError("trust", "above-sources"),
    );
    // Positive controls: an owner origin promoted at owner trust by an owner-ceiling principal,
    // and lowered on request.
    const owned = await note("Reviewed by a person.", "owner");
    expect((await promote("promoter", owned, { trust: "owner" })).revision.provenance.trust).toBe(
      "owner",
    );
    expect(
      (await promote("promoter", owned, { trust: "untrusted" })).revision.provenance.trust,
    ).toBe("untrusted");
  });

  test("and at most the promoter's ceiling", async () => {
    const { note, promote } = open();
    const owned = await note("Reviewed by a person.", "owner");
    // The agent's ceiling is the default, agent: the copy of an owner memory is agent.
    expect((await promote("agent", owned)).revision.provenance.trust).toBe("agent");
    await expect(promote("agent", owned, { trust: "owner" })).rejects.toThrow(
      new ProvenanceError("trust", "above-ceiling"),
    );
  });
});

describe("promote: redaction reaches the copy", () => {
  test("redacting the origin redacts the copy, the copy's summaries and copies of the copy", async () => {
    const { store, relembra, note, promote } = open();
    const origin = await note("A secret that leaked into memory.");
    const copy = await promote("promoter", origin);
    const summary = await relembra.submitSummary("team", {
      scope: TEAM,
      sources: [{ memoryId: copy.id, revision: 1 }],
      text: "A summary of the copy.",
      provenance,
    });
    const relayed = await promote("relay", copy, { scope: ELSEWHERE });
    expect(relayed.origin).toEqual({ memoryId: copy.id, revision: 1 });

    const redaction = await relembra.redact("devOwner", { memoryId: origin.id });
    expect(redaction.redacted).toEqual([origin.id]);
    for (const id of [copy.id, summary.id, relayed.id]) {
      expect((await store.transaction((tx) => tx.memory(id)))?.status).toBe("redacted");
    }
    // One outbox row per erased memory, and the text is in no event and no find.
    expect((await store.erasures()).map((w) => w.memoryId).sort()).toEqual(
      [origin.id, copy.id, summary.id, relayed.id].sort(),
    );
    const events = JSON.stringify(await store.events({ scopes: [DEV, TEAM, ELSEWHERE] }));
    expect(events).not.toContain("leaked");
    expect(await relembra.find("team", { query: "secret leaked" })).toEqual([]);
    expect(await relembra.recall("team")).toEqual([]);
  });

  test("the preview lists the copies the principal may see, and the approval covers them", async () => {
    const { relembra, note, promote } = open({
      devOwner: { ...principals.devOwner, readable: [DEV, TEAM] },
    });
    const origin = await note("A fact.");
    const copy = await promote("promoter", origin);
    const preview = await relembra.redactionPreview("devOwner", { memoryId: origin.id });
    expect(preview.map((m) => m.id)).toEqual([origin.id, copy.id]);
    // A promotion after the preview changes the plan: nothing is redacted.
    await promote("promoter", origin);
    await expect(
      relembra.redact("devOwner", { memoryId: origin.id, expect: preview }),
    ).rejects.toBeInstanceOf(PlanChangedError);
    expect((await relembra.zoom("team", { memoryId: copy.id })).status).toBe("live");
    // Positive control: a fresh preview is the plan.
    const fresh = await relembra.redactionPreview("devOwner", { memoryId: origin.id });
    expect(fresh).toHaveLength(3);
    const done = await relembra.redact("devOwner", { memoryId: origin.id, expect: fresh });
    expect(done.derived).toHaveLength(2);
  });

  test("a copy the principal cannot see is erased but not shown to it", async () => {
    const { store, relembra, note, promote } = open();
    const origin = await note("A fact.");
    const copy = await promote("promoter", origin);
    // devOwner cannot read TEAM: neither the preview nor the result names the copy.
    const preview = await relembra.redactionPreview("devOwner", { memoryId: origin.id });
    expect(preview.map((m) => m.id)).toEqual([origin.id]);
    const done = await relembra.redact("devOwner", { memoryId: origin.id, expect: preview });
    expect(done).toEqual({ redacted: [origin.id], derived: [] });
    // The copy is erased all the same.
    expect((await store.transaction((tx) => tx.memory(copy.id)))?.status).toBe("redacted");
    expect((await store.erasures()).map((w) => w.memoryId)).toEqual([origin.id, copy.id]);
  });

  test("retracting or superseding the origin leaves the copy live, where redacting does not", async () => {
    const { relembra, note, promote } = open();
    const retracted = await note("Retracted at the origin.");
    const retractedCopy = await promote("promoter", retracted);
    await relembra.retract("devOwner", { memoryId: retracted.id });
    expect((await relembra.zoom("team", { memoryId: retractedCopy.id })).status).toBe("live");

    const superseded = await note("Superseded at the origin.");
    const supersededCopy = await promote("promoter", superseded);
    await relembra.supersede("promoter", {
      memoryId: superseded.id,
      text: "The replacement.",
      provenance,
    });
    expect((await relembra.zoom("team", { memoryId: supersededCopy.id })).status).toBe("live");

    // Positive control: redacting either origin erases its copy.
    await relembra.redact("devOwner", { memoryId: retracted.id });
    await relembra.redact("devOwner", { memoryId: superseded.id });
    await expect(relembra.zoom("team", { memoryId: retractedCopy.id })).resolves.toMatchObject({
      status: "redacted",
    });
    await expect(relembra.zoom("team", { memoryId: supersededCopy.id })).resolves.toMatchObject({
      status: "redacted",
    });
  });

  test("redacting the copy leaves the origin", async () => {
    const { relembra, note, promote } = open();
    const origin = await note("A fact.");
    const copy = await promote("promoter", origin);
    await relembra.redact("team", { memoryId: copy.id });
    expect((await relembra.zoom("promoter", { memoryId: origin.id })).status).toBe("live");
  });
});

describe("promote: op ids", () => {
  test("a retry returns the first copy, and another payload under the op id conflicts", async () => {
    const { relembra, note, promote } = open();
    const origin = await note("A fact.");
    const first = await promote("promoter", origin, { opId: "promote-1" });
    const retry = await promote("promoter", origin, { opId: "promote-1" });
    expect(retry).toEqual(first);
    expect(await relembra.recall("team")).toHaveLength(1);
    await expect(
      promote("promoter", origin, { opId: "promote-1", trust: "untrusted" }),
    ).rejects.toBeInstanceOf(OpConflictError);
    const other = await note("Another fact.");
    await expect(promote("promoter", other, { opId: "promote-1" })).rejects.toBeInstanceOf(
      OpConflictError,
    );
  });

  test("a retry after the copy was redacted is terminal, and one without promote rights is refused", async () => {
    const { relembra, note, promote } = open();
    const origin = await note("A fact.");
    const copy = await promote("agent", origin, { opId: "promote-r" });
    await relembra.redact("team", { memoryId: copy.id });
    await expect(promote("agent", origin, { opId: "promote-r" })).rejects.toThrow(
      new MemoryRedactedError(copy.id),
    );

    const revoked = open();
    const kept = await revoked.note("A fact.");
    await revoked.promote("agent", kept, { opId: "promote-x" });
    const lost = createRelembra<string>({
      store: revoked.store,
      policy: () => ({ ...principals.agent, promotable: [] }),
    });
    await expect(
      lost.promote("agent", {
        memoryId: kept.id,
        revision: 1,
        scope: TEAM,
        provenance,
        opId: "promote-x",
      }),
    ).rejects.toThrow(new ScopeDeniedError("promote"));
    // Positive control: with the rights, the retry returns the copy.
    expect((await revoked.promote("agent", kept, { opId: "promote-x" })).scope).toBe(TEAM);
  });

  test("a retry by a principal that can no longer read the origin's scope is refused", async () => {
    const { store, note, promote } = open();
    const origin = await note("A fact.");
    const copy = await promote("agent", origin, { opId: "promote-read" });
    const blind = createRelembra<string>({
      store,
      policy: () => ({ ...principals.agent, readable: [] }),
    });
    const retry = () =>
      blind.promote("agent", {
        memoryId: origin.id,
        revision: 1,
        scope: TEAM,
        provenance,
        opId: "promote-read",
      });
    await expect(retry()).rejects.toThrow(new MemoryNotFoundError());
    // Positive control: with read access, the retry returns the copy.
    expect((await promote("agent", origin, { opId: "promote-read" })).id).toBe(copy.id);
  });
});

describe("promote: retention", () => {
  test("a sweep that expires the origin redacts its copy in a scope with no rule", async () => {
    const store = createMemoryStore();
    let n = 0;
    const relembra = createRelembra<string>({
      store,
      policy: (name) => (principals as Record<string, Principal>)[name] as Principal,
      clock: { now: () => 1_000 },
      ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
      retention: [{ scope: DEV, maxAgeDays: 1 }],
    });
    const origin = await relembra.note("promoter", { scope: DEV, text: "Old fact.", provenance });
    const copy = await relembra.promote("promoter", {
      memoryId: origin.id,
      revision: 1,
      scope: TEAM,
      provenance,
    });
    // Positive control: before the cutoff nothing expires.
    expect(await relembra.sweep(1_000)).toEqual({ redacted: [], derived: [] });
    const later = 1_000 + 2 * 86_400_000;
    expect((await relembra.sweepPreview(later)).map((m) => m.id)).toEqual([origin.id, copy.id]);
    expect(await relembra.sweep(later)).toEqual({ redacted: [origin.id], derived: [copy.id] });
    expect((await store.transaction((tx) => tx.memory(copy.id)))?.status).toBe("redacted");
  });
});
