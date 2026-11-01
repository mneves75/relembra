import { describe, expect, test } from "bun:test";
import {
  advanceFence,
  createRelembra,
  FencedError,
  MemoryNotFoundError,
  type Principal,
  ScopeDeniedError,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

const principals: Record<string, Principal> = {
  owner: { id: "owner", readable: [SCOPE], writable: [SCOPE], promotable: [], owned: [SCOPE] },
  writer: { id: "writer", readable: [SCOPE], writable: [SCOPE, OTHER_SCOPE], promotable: [] },
  stale: {
    id: "stale",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
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
  const note = (text: string, scope = SCOPE) =>
    relembra.note("writer", { scope, text, provenance });
  return { store, relembra, note };
}

describe("redact authorization", () => {
  test("a reader who does not own the scope is refused, and the text stays", async () => {
    const { relembra, note } = open();
    const memory = await note("Kept despite a writer's redact.");

    await expect(relembra.redact("writer", { memoryId: memory.id })).rejects.toThrow(
      new ScopeDeniedError("own"),
    );
    expect((await relembra.recall("writer")).map((m) => m.revision.text)).toEqual([
      "Kept despite a writer's redact.",
    ]);
    // Positive control: the owner's redaction of the same memory succeeds.
    expect(await relembra.redact("owner", { memoryId: memory.id })).toEqual({
      redacted: [memory.id],
      derived: [],
    });
  });

  test("an unknown id, or one in a scope the principal cannot see, is not found, naming no id", async () => {
    const { relembra, note } = open();
    const outside = await note("In the other scope.", OTHER_SCOPE);

    for (const memoryId of ["no-such-memory", outside.id]) {
      const refusal = relembra.redact("owner", { memoryId });
      await expect(refusal).rejects.toBeInstanceOf(MemoryNotFoundError);
      await expect(refusal).rejects.not.toThrow(memoryId);
    }
  });

  test("an owner redacts a retracted memory", async () => {
    const { relembra, note } = open();
    const memory = await note("Retracted, then redacted.");
    await relembra.retract("owner", { memoryId: memory.id });

    expect(await relembra.redact("owner", { memoryId: memory.id })).toEqual({
      redacted: [memory.id],
      derived: [],
    });
    expect(await relembra.recall("owner", { includeRetracted: true })).toEqual([]);
  });

  test("a writer whose fence epoch was advanced redacts nothing", async () => {
    const { store, relembra, note } = open();
    const memory = await note("Fenced.");
    await advanceFence(store, { key: "lease", epoch: 2 });

    await expect(relembra.redact("stale", { memoryId: memory.id })).rejects.toBeInstanceOf(
      FencedError,
    );
    expect((await relembra.recall("writer")).map((m) => m.id)).toEqual([memory.id]);
    expect(await store.erasures()).toEqual([]);
  });
});
