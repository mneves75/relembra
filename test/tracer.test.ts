import { describe, expect, test } from "bun:test";
import { ScopeDeniedError } from "relembra";
import { OTHER_SCOPE, openTestRelembra, provenance, SCOPE } from "./support.js";

describe("note then recall", () => {
  test("a memory noted in a scope is recalled by a principal that can read the scope", async () => {
    const relembra = openTestRelembra();

    const noted = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "The build uses Bun 1.4.", provenance },
    );
    const recalled = await relembra.recall({ user: "reader" }, { scope: SCOPE });

    expect(recalled.map((memory) => memory.id)).toEqual([noted.id]);
    expect(recalled[0]?.scope).toBe(SCOPE);
    expect(recalled[0]?.revision.number).toBe(1);
    expect(recalled[0]?.revision.text).toBe("The build uses Bun 1.4.");
  });
});

describe("scope isolation", () => {
  test("a principal without read access to the scope never sees its memories", async () => {
    const relembra = openTestRelembra();
    const noted = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "Deploys run from the release branch.", provenance },
    );

    // Positive control: a principal that can read the scope sees the memory.
    const allowed = await relembra.recall({ user: "reader" });
    expect(allowed.map((memory) => memory.id)).toEqual([noted.id]);

    expect(await relembra.recall({ user: "outsider" })).toEqual([]);
    await expect(relembra.recall({ user: "outsider" }, { scope: SCOPE })).rejects.toThrow(
      ScopeDeniedError,
    );
  });

  test("a principal without write access to the scope cannot note into it", async () => {
    const relembra = openTestRelembra();
    const input = { scope: SCOPE, text: "Tests run with bun test.", provenance };

    await expect(relembra.note({ user: "reader" }, input)).rejects.toThrow(ScopeDeniedError);
    expect(await relembra.recall({ user: "reader" })).toEqual([]);

    // Positive control: the same input from a writer is stored.
    const noted = await relembra.note({ user: "writer" }, input);
    expect((await relembra.recall({ user: "reader" })).map((memory) => memory.id)).toEqual([
      noted.id,
    ]);
  });
});

describe("recall bounds", () => {
  async function noteMany(count: number) {
    const relembra = openTestRelembra();
    for (let i = 1; i <= count; i++) {
      await relembra.note(
        { user: "writer" },
        { scope: SCOPE, text: `Fact number ${i}.`, provenance },
      );
    }
    return relembra;
  }

  test("recall returns the newest memories first, at most 50 by default", async () => {
    const relembra = await noteMany(51);

    const recalled = await relembra.recall({ user: "reader" });

    expect(recalled).toHaveLength(50);
    expect(recalled[0]?.revision.text).toBe("Fact number 51.");
    expect(recalled[49]?.revision.text).toBe("Fact number 2.");
  });

  test("recall honours an explicit limit", async () => {
    const relembra = await noteMany(3);

    const recalled = await relembra.recall({ user: "reader" }, { limit: 2 });

    expect(recalled.map((memory) => memory.revision.text)).toEqual([
      "Fact number 3.",
      "Fact number 2.",
    ]);
  });

  test("a limit that is not a positive integer is refused", async () => {
    const relembra = await noteMany(1);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(relembra.recall({ user: "reader" }, { limit })).rejects.toThrow(RangeError);
    }
  });

  test("a memory is pinned only when noted as pinned", async () => {
    const relembra = openTestRelembra();
    const pinned = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "Always run the linter.", provenance, pinned: true },
    );
    const plain = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "The linter is Biome.", provenance },
    );

    const recalled = await relembra.recall({ user: "reader" });

    expect(recalled.map((memory) => [memory.id, memory.pinned])).toEqual([
      [plain.id, false],
      [pinned.id, true],
    ]);
  });
});

describe("note input is read once", () => {
  test("a scope accessor that changes between reads cannot move the memory out of the authorized scope", async () => {
    const relembra = openTestRelembra();
    let reads = 0;
    const input = {
      get scope() {
        reads += 1;
        return reads === 1 ? SCOPE : OTHER_SCOPE;
      },
      text: "Scope accessors are read once.",
      provenance,
    };

    const noted = await relembra.note({ user: "writer" }, input);

    expect(noted.scope).toBe(SCOPE);
    expect(await relembra.recall({ user: "outsider" })).toEqual([]);
    expect((await relembra.recall({ user: "reader" })).map((memory) => memory.id)).toEqual([
      noted.id,
    ]);
  });

  test("a text accessor that changes between reads cannot store unguarded text", async () => {
    const relembra = openTestRelembra();
    const credential = ["pass", "word=", "hunter2-example"].join("");
    let reads = 0;
    const input = {
      scope: SCOPE,
      get text() {
        reads += 1;
        return reads === 1 ? "Guarded text is stored." : credential;
      },
      provenance,
    };

    await relembra.note({ user: "writer" }, input);

    const stored = await relembra.recall({ user: "reader" });
    expect(stored.map((memory) => memory.revision.text)).toEqual(["Guarded text is stored."]);
  });

  test("a plain object input is stored as given", async () => {
    const relembra = openTestRelembra();
    const noted = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "Plain input works.", provenance, pinned: true, opId: "op-plain" },
    );

    expect(noted).toMatchObject({ scope: SCOPE, pinned: true });
    expect(noted.revision.text).toBe("Plain input works.");
    expect(noted.revision.provenance.opId).toBe("op-plain");
  });
});
