import { describe, expect, test } from "bun:test";
import {
  createRelembra,
  type NoteInput,
  OpConflictError,
  type Principal,
  ScopeDeniedError,
  type Store,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

/** Principals by context name; `writer` and `twin` write the same scopes under different ids. */
const principals: Record<string, Principal> = {
  writer: {
    id: "writer",
    readable: [SCOPE, OTHER_SCOPE],
    writable: [SCOPE, OTHER_SCOPE],
    promotable: [],
    pinnable: [SCOPE, OTHER_SCOPE],
    trustCeiling: "owner",
  },
  twin: {
    id: "twin",
    readable: [SCOPE, OTHER_SCOPE],
    writable: [SCOPE, OTHER_SCOPE],
    promotable: [],
    trustCeiling: "owner",
  },
};

function open(store: Store = createMemoryStore()) {
  let n = 0;
  const relembra = createRelembra<string>({
    store,
    policy: (name) => principals[name] as Principal,
    ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
  });
  return { store, relembra };
}

const base: NoteInput = {
  scope: SCOPE,
  text: "Retries replay the first outcome.",
  provenance: { ...provenance, source: "session-start" },
  opId: "op-fixed",
};

async function count(relembra: ReturnType<typeof open>["relembra"]) {
  return (await relembra.recall("writer", { limit: 100 })).length;
}

describe("op fingerprint", () => {
  const changes: Record<string, readonly [context: string, input: NoteInput]> = {
    text: ["writer", { ...base, text: "Another fact." }],
    "text whitespace": ["writer", { ...base, text: "Retries  replay the first outcome." }],
    pinned: ["writer", { ...base, pinned: true }],
    scope: ["writer", { ...base, scope: OTHER_SCOPE }],
    agent: ["writer", { ...base, provenance: { ...base.provenance, agent: "other-agent" } }],
    harness: ["writer", { ...base, provenance: { ...base.provenance, harness: "other" } }],
    model: ["writer", { ...base, provenance: { ...base.provenance, model: "other-model" } }],
    host: ["writer", { ...base, provenance: { ...base.provenance, host: "other-host" } }],
    source: ["writer", { ...base, provenance: { ...base.provenance, source: "other" } }],
    "source removed": ["writer", { ...base, provenance }],
    trust: ["writer", { ...base, provenance: { ...base.provenance, trust: "owner" } }],
  };

  for (const [field, [context, changed]] of Object.entries(changes)) {
    test(`a changed ${field} under the same op id is refused and stores nothing`, async () => {
      const { relembra } = open();
      const first = await relembra.note("writer", base);

      const rejection = relembra.note(context, changed);

      await expect(rejection).rejects.toBeInstanceOf(OpConflictError);
      expect(await count(relembra)).toBe(1);
      // Positive control: the changed payload under its own op id is stored.
      await relembra.note(context, { ...changed, opId: "op-fresh" });
      expect(await count(relembra)).toBe(2);
      expect(await relembra.note("writer", base)).toEqual(first);
    });
  }

  test("another principal under the same op id is a new operation, not a conflict or a replay", async () => {
    const { relembra } = open();
    const first = await relembra.note("writer", base);

    const twins = await relembra.note("twin", base);

    expect(twins.id).not.toBe(first.id);
    expect(await count(relembra)).toBe(2);
    // Positive control: each principal's retry replays its own outcome.
    expect(await relembra.note("writer", base)).toEqual(first);
    expect(await relembra.note("twin", base)).toEqual(twins);
  });

  test("the conflict never echoes the payload or the op id", async () => {
    const { relembra } = open();
    await relembra.note("writer", base);

    const error = (await relembra
      .note("writer", { ...base, text: "Secretive replacement text." })
      .catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(OpConflictError);
    for (const fragment of ["Secretive", "Retries replay", "op-fixed", "session-start"]) {
      expect(error.message).not.toContain(fragment);
    }
  });

  test("provenance key order and defaults left out do not change the fingerprint", async () => {
    const { relembra } = open();
    const first = await relembra.note("writer", base);
    const reordered = {
      source: "session-start",
      host: provenance.host,
      model: provenance.model,
      harness: provenance.harness,
      agent: provenance.agent,
    };

    expect(await relembra.note("writer", { ...base, provenance: reordered })).toEqual(first);
    expect(
      await relembra.note("writer", {
        ...base,
        pinned: false,
        provenance: { ...base.provenance, trust: "agent" },
      }),
    ).toEqual(first);
    expect(await count(relembra)).toBe(1);
  });

  test("the op id is not part of the fingerprint: the same payload under two op ids is two memories", async () => {
    const { relembra } = open();

    const a = await relembra.note("writer", { ...base, opId: "op-a" });
    const b = await relembra.note("writer", { ...base, opId: "op-b" });

    expect(a.id).not.toBe(b.id);
    expect(await count(relembra)).toBe(2);
  });

  test("the stored fingerprint is the SHA-256 of the documented canonical encoding", async () => {
    const { store, relembra } = open();
    await relembra.note("writer", {
      scope: SCOPE,
      text: "Golden fingerprint.",
      provenance,
      opId: "op-golden",
    });

    const record = await store.transaction((tx) => tx.op("writer", "op-golden"));

    // printf '%s' '[1,"note","dev/example-repo","writer","Golden fingerprint.",false,"agent",
    //   "test-agent","test-harness","test-model","test-host",null]' | shasum -a 256
    expect(record?.fingerprint).toBe(
      "3611609980fb50f52cd0fbaf0d4d3777a496db8b617b2b80db91bea5be41c4a8",
    );
    expect(record).toMatchObject({ opId: "op-golden", memoryId: "memory-1" });
  });
});

describe("op replay and authorization", () => {
  test("a retry by a principal that lost write access is refused although the op record exists", async () => {
    const store = createMemoryStore();
    let writable = [SCOPE];
    const relembra = createRelembra<undefined>({
      store,
      policy: () => ({ id: "writer", readable: [SCOPE], writable, promotable: [] }),
    });
    const first = await relembra.note(undefined, base);

    writable = [];
    await expect(relembra.note(undefined, base)).rejects.toBeInstanceOf(ScopeDeniedError);

    // Positive control: with access restored, the same principal's retry replays the outcome.
    writable = [SCOPE];
    expect(await relembra.note(undefined, base)).toEqual(first);
    expect(await relembra.recall(undefined)).toHaveLength(1);
  });

  test("a note without an op id gets a fresh one each time, so it is never a replay", async () => {
    const { relembra } = open();
    const { opId: _omitted, ...withoutOpId } = base;

    await relembra.note("writer", withoutOpId);
    await relembra.note("writer", withoutOpId);

    expect(await count(relembra)).toBe(2);
  });
});
