import { describe, expect, test } from "bun:test";
import { createRelembra, MemoryNotFoundError, type Principal } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

const principals: Record<string, Principal> = {
  owner: { id: "owner", readable: [SCOPE], writable: [SCOPE], promotable: [], owned: [SCOPE] },
  reader: { id: "reader", readable: [SCOPE], writable: [], promotable: [] },
  outsider: { id: "outsider", readable: [OTHER_SCOPE], writable: [OTHER_SCOPE], promotable: [] },
};

function open() {
  let n = 0;
  return createRelembra<string>({
    store: createMemoryStore(),
    policy: (name) => principals[name] as Principal,
    ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
  });
}

describe("zoom: one memory by id, as the principal may see it", () => {
  test("a reader of the scope sees a live memory with its provenance; an outsider does not", async () => {
    const relembra = open();
    const memory = await relembra.note("owner", { scope: SCOPE, text: "a fact", provenance });
    const seen = await relembra.zoom("reader", { memoryId: memory.id });
    expect(seen).toEqual(memory);
    await expect(relembra.zoom("outsider", { memoryId: memory.id })).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  test("an unknown id is not found, the same refusal as an unreadable one", async () => {
    const relembra = open();
    await expect(relembra.zoom("owner", { memoryId: "nope" })).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  test("the owner sees retracted, superseded and redacted memories; a reader sees none of them", async () => {
    const relembra = open();
    const write = (text: string) => relembra.note("owner", { scope: SCOPE, text, provenance });
    const retracted = await write("retracted fact");
    const superseded = await write("old fact");
    const redacted = await write("secret-ish fact");
    await relembra.retract("owner", { memoryId: retracted.id });
    const replacement = await relembra.supersede("owner", {
      memoryId: superseded.id,
      text: "new fact",
      provenance,
    });
    await relembra.redact("owner", { memoryId: redacted.id });

    expect(await relembra.zoom("owner", { memoryId: retracted.id })).toMatchObject({
      status: "retracted",
    });
    expect(await relembra.zoom("owner", { memoryId: superseded.id })).toMatchObject({
      status: "superseded",
      supersededBy: replacement.id,
    });
    const tombstone = await relembra.zoom("owner", { memoryId: redacted.id });
    expect(tombstone).toEqual({
      id: redacted.id,
      scope: SCOPE,
      seq: tombstone.seq,
      status: "redacted",
    });
    expect(JSON.stringify(tombstone)).not.toContain("secret-ish");

    for (const id of [retracted.id, superseded.id, redacted.id]) {
      await expect(relembra.zoom("reader", { memoryId: id })).rejects.toBeInstanceOf(
        MemoryNotFoundError,
      );
    }
    // Positive control: the reader does see the live replacement.
    expect(await relembra.zoom("reader", { memoryId: replacement.id })).toMatchObject({
      status: "live",
    });
  });

  test("a summary carries its sources", async () => {
    const relembra = open();
    const source = await relembra.note("owner", { scope: SCOPE, text: "source fact", provenance });
    const summary = await relembra.submitSummary("owner", {
      scope: SCOPE,
      sources: [{ memoryId: source.id, revision: 1 }],
      text: "the summary",
      provenance,
    });
    expect(await relembra.zoom("reader", { memoryId: summary.id })).toMatchObject({
      sources: [{ memoryId: source.id, revision: 1 }],
    });
  });
});
