import { describe, expect, test } from "bun:test";
import { createRelembra, type Principal, ScopeDeniedError } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

/** Principals by context name. Only `owner` may pin, and only in SCOPE. */
const principals: Record<string, Principal> = {
  owner: {
    id: "owner",
    readable: [SCOPE, OTHER_SCOPE],
    writable: [SCOPE, OTHER_SCOPE],
    promotable: [],
    pinnable: [SCOPE],
    trustCeiling: "owner",
  },
  agent: { id: "agent", readable: [SCOPE], writable: [SCOPE], promotable: [] },
};

function open() {
  const store = createMemoryStore();
  let pinRight = true;
  const relembra = createRelembra<string>({
    store,
    policy: (name) => {
      const principal = principals[name] as Principal;
      return name === "owner" && !pinRight ? { ...principal, pinnable: [] } : principal;
    },
  });
  return {
    relembra,
    revokePin: () => {
      pinRight = false;
    },
    count: async () => (await store.liveMemories({ scopes: [SCOPE, OTHER_SCOPE] })).length,
  };
}

const pinnedNote = { scope: SCOPE, text: "Always run the linter.", provenance, pinned: true };

describe("pin rights", () => {
  test("a principal without the pin right is refused a pinned note and stores nothing", async () => {
    const { relembra, count } = open();

    const rejection = relembra.note("agent", pinnedNote);

    await expect(rejection).rejects.toBeInstanceOf(ScopeDeniedError);
    await expect(rejection).rejects.toMatchObject({ access: "pin" });
    expect(await count()).toBe(0);
    // Positive control: the same principal's unpinned note is stored.
    const plain = await relembra.note("agent", { ...pinnedNote, pinned: false });
    expect(plain.pinned).toBe(false);
    expect(await count()).toBe(1);
  });

  test("a principal with the pin right for the scope can pin", async () => {
    const { relembra } = open();

    const noted = await relembra.note("owner", {
      ...pinnedNote,
      provenance: { ...provenance, trust: "owner" },
    });

    expect(noted.pinned).toBe(true);
    expect(noted.revision.provenance.trust).toBe("owner");
  });

  test("the pin right is per scope", async () => {
    const { relembra, count } = open();

    await expect(
      relembra.note("owner", { ...pinnedNote, scope: OTHER_SCOPE }),
    ).rejects.toMatchObject({ name: "ScopeDeniedError", access: "pin" });
    expect(await count()).toBe(0);
    // Positive control: the same principal pins in the scope it may pin.
    expect((await relembra.note("owner", pinnedNote)).pinned).toBe(true);
  });

  test("a retried pinned note is refused once the principal has lost the pin right", async () => {
    const { relembra, revokePin, count } = open();
    const input = { ...pinnedNote, opId: "op-pin" };
    const first = await relembra.note("owner", input);
    // Positive control: while the right holds, the retry replays the first outcome.
    expect(await relembra.note("owner", input)).toEqual(first);

    revokePin();

    await expect(relembra.note("owner", input)).rejects.toMatchObject({ access: "pin" });
    expect(await count()).toBe(1);
  });

  test("the refusal names the access, never the scope", async () => {
    const { relembra } = open();

    const error = (await relembra.note("agent", pinnedNote).catch((e: unknown) => e)) as Error;

    expect(error.message).toContain("pin");
    expect(error.message).not.toContain(SCOPE);
  });
});
