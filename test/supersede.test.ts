import { describe, expect, test } from "bun:test";
import {
  advanceFence,
  createRelembra,
  FencedError,
  GuardError,
  MemoryRedactedError,
  OpConflictError,
  type Principal,
  ScopeDeniedError,
  SummarySupersedeError,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { provenance, SCOPE } from "./support.js";

const principals: Record<string, Principal> = {
  owner: {
    id: "owner",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
    pinnable: [SCOPE],
    trustCeiling: "owner",
  },
  // Owns the scope, but may not pin, and writes at most agent trust (the default ceiling).
  reviser: { id: "reviser", readable: [SCOPE], writable: [SCOPE], promotable: [], owned: [SCOPE] },
  external: {
    id: "external",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
    trustCeiling: "untrusted",
  },
  writer: { id: "writer", readable: [SCOPE], writable: [SCOPE], promotable: [] },
  reader: { id: "reader", readable: [SCOPE], writable: [], promotable: [] },
  stale: {
    id: "stale",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    fence: { key: "lease", epoch: 1 },
  },
};

function open() {
  const store = createMemoryStore();
  let n = 0;
  const relembra = createRelembra<string>({
    store,
    policy: (name) => principals[name] as Principal,
    ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
  });
  const note = (text: string) => relembra.note("writer", { scope: SCOPE, text, provenance });
  const replace = (context: string, memoryId: string, text: string, more = {}) =>
    relembra.supersede(context, { memoryId, text, provenance, ...more });
  return { store, relembra, note, replace };
}

describe("supersede", () => {
  test("a reader that may not write the scope is refused, and the memory stays served", async () => {
    const { relembra, note, replace } = open();
    const old = await note("The old fact.");

    await expect(replace("reader", old.id, "A new fact.")).rejects.toThrow(
      new ScopeDeniedError("write"),
    );
    expect((await relembra.recall("reader")).map((m) => m.id)).toEqual([old.id]);
    // Positive control: the owner supersedes it.
    const replacement = await replace("owner", old.id, "A new fact.");
    expect((await relembra.recall("reader")).map((m) => m.id)).toEqual([replacement.id]);
  });

  test("a writer that does not own the scope is refused, as for retract, even for its own memory", async () => {
    const { relembra, note, replace } = open();
    const old = await note("The writer's own fact.");

    await expect(replace("writer", old.id, "Rewritten by the writer.")).rejects.toThrow(
      new ScopeDeniedError("own"),
    );
    expect((await relembra.recall("reader")).map((m) => m.id)).toEqual([old.id]);
    // Positive control: a principal that owns the scope supersedes it.
    const replacement = await replace("reviser", old.id, "Rewritten by the owner.");
    expect((await relembra.recall("reader")).map((m) => m.id)).toEqual([replacement.id]);
  });

  test("superseding a pinned memory needs pin rights, even when the replacement is not pinned", async () => {
    const { relembra, replace } = open();
    // At agent trust, so only the pin is above what the reviser may displace.
    const rule = await relembra.note("owner", {
      scope: SCOPE,
      text: "Never deploy on Fridays.",
      provenance,
      pinned: true,
    });

    await expect(replace("reviser", rule.id, "Deploy whenever.")).rejects.toThrow(
      new ScopeDeniedError("pin"),
    );
    expect((await relembra.recall("reader")).map((m) => m.id)).toEqual([rule.id]);
    // Positive control: the owner supersedes its own pinned rule.
    const replacement = await replace("owner", rule.id, "Never deploy on Fridays or holidays.", {
      pinned: true,
    });
    expect((await relembra.recall("reader")).map((m) => [m.id, m.pinned])).toEqual([
      [replacement.id, true],
    ]);
  });

  test("a memory whose trust is above the principal's ceiling cannot be superseded", async () => {
    const { relembra, note, replace } = open();
    const owned = await relembra.note("owner", {
      scope: SCOPE,
      text: "Owner-reviewed fact.",
      provenance: { ...provenance, trust: "owner" },
    });
    const agent = await note("Agent fact.");

    await expect(replace("reviser", owned.id, "An agent's rewrite.")).rejects.toMatchObject({
      name: "ProvenanceError",
      field: "trust",
      rule: "above-ceiling",
    });
    await expect(replace("external", agent.id, "External rewrite.")).rejects.toMatchObject({
      name: "ProvenanceError",
      rule: "above-ceiling",
    });
    expect((await relembra.recall("reader")).map((m) => m.id).sort()).toEqual(
      [owned.id, agent.id].sort(),
    );
    // Positive controls: within the ceiling, superseding works.
    await replace("owner", owned.id, "Owner-reviewed fact, revised.", {
      provenance: { ...provenance, trust: "owner" },
    });
    await replace("reviser", agent.id, "Agent fact, revised.");
  });

  test("the replacement passes the guard, and pinning needs pin rights", async () => {
    const { note, replace } = open();
    const old = await note("The old fact.");

    await expect(replace("reviser", old.id, "two\nlines")).rejects.toBeInstanceOf(GuardError);
    await expect(replace("reviser", old.id, "Pinned.", { pinned: true })).rejects.toThrow(
      new ScopeDeniedError("pin"),
    );
    // Positive control: the owner may pin it.
    const pinned = await replace("owner", old.id, "Pinned.", { pinned: true });
    expect(pinned.pinned).toBe(true);
  });

  test("the same op id superseding another memory, or with another text, is a conflict", async () => {
    const { note, replace } = open();
    const a = await note("Fact A.");
    const b = await note("Fact B.");
    const first = await replace("owner", a.id, "Replacement.", { opId: "op-x" });

    await expect(replace("owner", b.id, "Replacement.", { opId: "op-x" })).rejects.toBeInstanceOf(
      OpConflictError,
    );
    await expect(replace("owner", a.id, "Other text.", { opId: "op-x" })).rejects.toBeInstanceOf(
      OpConflictError,
    );
    // Positive control: the same request is a replay.
    expect(await replace("owner", a.id, "Replacement.", { opId: "op-x" })).toEqual(first);
  });

  test("a retried supersede whose replacement was redacted is terminal", async () => {
    const { relembra, note, replace } = open();
    const old = await note("Old.");
    const replacement = await replace("owner", old.id, "Replacement.", { opId: "op-r" });
    await relembra.redact("owner", { memoryId: replacement.id });

    await expect(replace("owner", old.id, "Replacement.", { opId: "op-r" })).rejects.toThrow(
      new MemoryRedactedError(replacement.id),
    );
  });

  test("a writer whose fence epoch was advanced supersedes nothing", async () => {
    const { store, relembra, note, replace } = open();
    const old = await note("Fenced.");
    await advanceFence(store, { key: "lease", epoch: 2 });

    await expect(replace("stale", old.id, "Too late.")).rejects.toBeInstanceOf(FencedError);
    expect((await relembra.recall("writer")).map((m) => m.id)).toEqual([old.id]);
  });

  test("a summary is not superseded: its replacement would carry its sources' facts with no lineage", async () => {
    const { relembra, note, replace } = open();
    const secret = await note("Secret fact X.");
    const summary = await relembra.submitSummary("owner", {
      scope: SCOPE,
      sources: [{ memoryId: secret.id, revision: 1 }],
      text: "Summary of X.",
      provenance,
    });

    await expect(replace("owner", summary.id, "Secret fact X, restated.")).rejects.toBeInstanceOf(
      SummarySupersedeError,
    );
    expect((await relembra.recall("reader")).map((m) => m.id)).toEqual([summary.id, secret.id]);
    // Redacting the source still reaches the summary, and nothing else holds its fact.
    await relembra.redact("owner", { memoryId: secret.id });
    expect(await relembra.recall("owner", { includeRetracted: true })).toEqual([]);
    // Positive control: a plain memory is superseded.
    const plain = await note("Plain fact.");
    const replacement = await replace("owner", plain.id, "Plain fact, corrected.");
    expect((await relembra.recall("reader")).map((m) => m.id)).toEqual([replacement.id]);
  });
});
