import { describe, expect, test } from "bun:test";
import { type AuthorityFence, advanceFence, createRelembra, type Principal } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { provenance, SCOPE } from "./support.js";

const writer = (fence?: AuthorityFence): Principal => ({
  id: "writer",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  ...(fence === undefined ? {} : { fence }),
});

function open() {
  const store = createMemoryStore();
  const relembra = createRelembra<AuthorityFence | undefined>({ store, policy: writer });
  return { store, relembra };
}

const note = { scope: SCOPE, text: "Fenced writes.", provenance };

const malformed: Record<string, readonly [AuthorityFence, ErrorConstructor]> = {
  "an empty key": [{ key: "", epoch: 1 }, TypeError],
  "a key that is not a string": [{ key: 7 as unknown as string, epoch: 1 }, TypeError],
  "a negative epoch": [{ key: "lease", epoch: -1 }, RangeError],
  "a fractional epoch": [{ key: "lease", epoch: 1.5 }, RangeError],
  "a NaN epoch": [{ key: "lease", epoch: Number.NaN }, RangeError],
  "an unsafe epoch": [{ key: "lease", epoch: 2 ** 53 }, RangeError],
};

describe("authority fence", () => {
  for (const [label, [fence, error]] of Object.entries(malformed)) {
    test(`a fence with ${label} is refused on write and on advance, storing nothing`, async () => {
      const { store, relembra } = open();

      await expect(relembra.note(fence, note)).rejects.toThrow(error);
      await expect(advanceFence(store, fence)).rejects.toThrow(error);

      expect(await relembra.recall(undefined)).toEqual([]);
      // Positive control: a well-formed fence at the lowest epoch writes and advances.
      await relembra.note({ key: "lease", epoch: 0 }, note);
      await advanceFence(store, { key: "lease", epoch: 0 });
      expect(await relembra.recall(undefined)).toHaveLength(1);
    });
  }

  test("an unfenced principal writes whatever epochs the store holds", async () => {
    const { store, relembra } = open();
    await advanceFence(store, { key: "lease", epoch: 9 });

    await relembra.note(undefined, note);

    expect(await relembra.recall(undefined)).toHaveLength(1);
    // Positive control: a fenced writer below the held epoch is refused.
    await expect(relembra.note({ key: "lease", epoch: 8 }, note)).rejects.toMatchObject({
      name: "FencedError",
    });
  });

  test("the refusal names neither the key nor the epochs", async () => {
    const { store, relembra } = open();
    await advanceFence(store, { key: "conversation lease 42", epoch: 31 });

    const error = (await relembra
      .note({ key: "conversation lease 42", epoch: 17 }, note)
      .catch((caught: unknown) => caught)) as Error;

    expect(error.name).toBe("FencedError");
    for (const fragment of ["lease 42", "31", "17"]) {
      expect(error.message).not.toContain(fragment);
    }
  });
});
