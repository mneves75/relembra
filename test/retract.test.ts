import { describe, expect, test } from "bun:test";
import {
  advanceFence,
  createRelembra,
  FencedError,
  MemoryNotFoundError,
  type Principal,
  ScopeDeniedError,
  type Store,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

const principals: Record<string, Principal> = {
  owner: { id: "owner", readable: [SCOPE], writable: [SCOPE], promotable: [], owned: [SCOPE] },
  writer: { id: "writer", readable: [SCOPE], writable: [SCOPE], promotable: [] },
  // Owns another scope only.
  elsewhere: {
    id: "elsewhere",
    readable: [OTHER_SCOPE],
    writable: [OTHER_SCOPE],
    promotable: [],
    owned: [OTHER_SCOPE],
  },
  // Owns both scopes but reads only SCOPE.
  both: {
    id: "both",
    readable: [SCOPE, OTHER_SCOPE],
    writable: [SCOPE, OTHER_SCOPE],
    promotable: [],
    owned: [SCOPE],
  },
  stale: {
    id: "stale",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
    fence: { key: "lease", epoch: 1 },
  },
};

function open(store: Store = createMemoryStore()) {
  let n = 0;
  const relembra = createRelembra<string>({
    store,
    policy: (name) => principals[name] as Principal,
    ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
  });
  const note = (text: string, scope = SCOPE) =>
    relembra.note(scope === SCOPE ? "writer" : "elsewhere", { scope, text, provenance });
  return { store, relembra, note };
}

describe("retract authorization", () => {
  test("a reader who does not own the scope is refused, and the memory stays served", async () => {
    const { relembra, note } = open();
    const memory = await note("Kept despite a writer's retract.");

    await expect(relembra.retract("writer", { memoryId: memory.id })).rejects.toThrow(
      new ScopeDeniedError("own"),
    );

    expect((await relembra.recall("writer")).map((m) => m.id)).toEqual([memory.id]);
    // Positive control: the owner's retract of the same memory succeeds.
    await relembra.retract("owner", { memoryId: memory.id });
    expect(await relembra.recall("writer")).toEqual([]);
  });

  test("an unknown id, or one in a scope the principal cannot see, is not found, naming no id", async () => {
    const { relembra, note } = open();
    const outside = await note("In the other scope.", OTHER_SCOPE);

    for (const memoryId of ["no-such-memory", outside.id]) {
      const refusal = relembra.retract("owner", { memoryId });
      await expect(refusal).rejects.toBeInstanceOf(MemoryNotFoundError);
      await expect(refusal).rejects.not.toThrow(memoryId);
    }
    // Positive control: the other scope's owner retracts it.
    await relembra.retract("elsewhere", { memoryId: outside.id });
    expect(await relembra.recall("elsewhere")).toEqual([]);
  });

  test("a retracted memory is not found by a principal who does not own its scope", async () => {
    const { relembra, note } = open();
    const memory = await note("Retracted, then probed.");
    await relembra.retract("owner", { memoryId: memory.id });

    // The writer could see it while it was live; now it does not exist for the writer.
    await expect(relembra.retract("writer", { memoryId: memory.id })).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  test("a writer whose fence epoch was advanced retracts nothing", async () => {
    const { store, relembra, note } = open();
    const memory = await note("Fenced.");
    await advanceFence(store, { key: "lease", epoch: 2 });

    await expect(relembra.retract("stale", { memoryId: memory.id })).rejects.toBeInstanceOf(
      FencedError,
    );
    expect((await relembra.recall("writer")).map((m) => m.id)).toEqual([memory.id]);
  });
});

describe("the owner view", () => {
  test("includeRetracted needs a scope the principal owns among those it reads", async () => {
    const { relembra, note } = open();
    const memory = await note("Hidden from agents.");
    await relembra.retract("owner", { memoryId: memory.id });

    await expect(relembra.recall("writer", { includeRetracted: true })).rejects.toThrow(
      new ScopeDeniedError("own"),
    );
    await expect(
      relembra.recall("both", { scope: OTHER_SCOPE, includeRetracted: true }),
    ).rejects.toThrow(new ScopeDeniedError("own"));
    // Positive control: owning SCOPE, `both` sees the retracted memory, marked.
    const shown = await relembra.recall("both", { includeRetracted: true });
    expect(shown.map((m) => [m.id, m.status])).toEqual([[memory.id, "retracted"]]);
  });
});
