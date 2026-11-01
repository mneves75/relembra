import { describe, expect, test } from "bun:test";
import { createRelembra, type Ids, ProvenanceError } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { hostPolicy, openTestRelembra, provenance, SCOPE } from "./support.js";

describe("provenance", () => {
  test("every recalled memory carries agent, harness, model, host and the writer's op id", async () => {
    const relembra = openTestRelembra();
    await relembra.note(
      { user: "writer" },
      {
        scope: SCOPE,
        text: "Migrations are forward-only.",
        provenance: { ...provenance, source: "session-start" },
        opId: "op-0001",
      },
    );

    const [memory] = await relembra.recall({ user: "reader" });

    expect(memory?.revision.provenance).toEqual({
      agent: "test-agent",
      harness: "test-harness",
      model: "test-model",
      host: "test-host",
      source: "session-start",
      trust: "agent",
      opId: "op-0001",
    });
  });

  test("a note without an op id gets one from the Ids port", async () => {
    const ids: Ids = { memoryId: () => "memory-1", opId: () => "generated-op-1" };
    const relembra = createRelembra({ store: createMemoryStore(), policy: hostPolicy, ids });

    const memory = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "Lint with Biome.", provenance },
    );

    expect(memory.id).toBe("memory-1");
    expect(memory.revision.provenance.opId).toBe("generated-op-1");
  });

  for (const field of ["agent", "harness", "model", "host"] as const) {
    test(`a note whose provenance ${field} is blank or missing is refused and stores nothing`, async () => {
      const relembra = openTestRelembra();
      const blank = { ...provenance, [field]: "  " };
      const { [field]: _omitted, ...missing } = provenance;

      const refused = { name: "ProvenanceError", field };

      await expect(
        relembra.note(
          { user: "writer" },
          { scope: SCOPE, text: "Ship on Fridays.", provenance: blank },
        ),
      ).rejects.toMatchObject(refused);
      await expect(
        relembra.note(
          { user: "writer" },
          // @ts-expect-error: an untyped caller can omit a field.
          { scope: SCOPE, text: "Ship on Fridays.", provenance: missing },
        ),
      ).rejects.toMatchObject(refused);
      expect(await relembra.recall({ user: "reader" })).toEqual([]);
    });
  }

  test("an unknown provenance field is dropped, not stored", async () => {
    const relembra = openTestRelembra();
    const withExtra = { ...provenance, source: "cli", extra: "unknown field" };

    const noted = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "Unknown fields are dropped.", provenance: withExtra, opId: "op-x" },
    );
    const [recalled] = await relembra.recall({ user: "reader" });

    for (const memory of [noted, recalled]) {
      expect(Object.keys(memory?.revision.provenance ?? {}).sort()).toEqual([
        "agent",
        "harness",
        "host",
        "model",
        "opId",
        "source",
        "trust",
      ]);
    }
  });

  const bidi = String.fromCodePoint(0x202e);
  const unsafe: Record<string, readonly [field: "agent" | "source" | "opId", value: string]> = {
    "a newline in source": ["source", "session\nstart"],
    "a bidi character in source": ["source", `session${bidi}start`],
    "a credential in source": ["source", ["pass", "word=", "hunter2-example"].join("")],
    "a credential in agent": [
      "agent",
      ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join(""),
    ],
    "a control character in opId": ["opId", "op\u0000id"],
    "a 129-byte agent": ["agent", "a".repeat(129)],
    "a 257-byte op id": ["opId", "o".repeat(257)],
  };

  for (const [label, [field, value]] of Object.entries(unsafe)) {
    test(`provenance with ${label} is refused, naming the field and not the value`, async () => {
      const relembra = openTestRelembra();
      const input =
        field === "opId"
          ? { scope: SCOPE, text: "Screened provenance.", provenance, opId: value }
          : {
              scope: SCOPE,
              text: "Screened provenance.",
              provenance: { ...provenance, [field]: value },
            };

      const rejection = relembra.note({ user: "writer" }, input);

      await expect(rejection).rejects.toBeInstanceOf(ProvenanceError);
      await expect(rejection).rejects.toMatchObject({ field });
      const error = (await rejection.catch((caught: unknown) => caught)) as Error;
      expect(error.message).not.toContain(value.slice(0, 12));
      expect(await relembra.recall({ user: "reader" })).toEqual([]);
    });
  }

  test("provenance at the byte caps is accepted", async () => {
    const relembra = openTestRelembra();
    const noted = await relembra.note(
      { user: "writer" },
      {
        scope: SCOPE,
        text: "Caps are inclusive.",
        provenance: { ...provenance, agent: "a".repeat(128), source: "s".repeat(128) },
        opId: "o".repeat(256),
      },
    );
    expect(noted.revision.provenance.agent).toHaveLength(128);
    expect(noted.revision.provenance.opId).toHaveLength(256);
  });

  test("a blank op id is refused", async () => {
    const relembra = openTestRelembra();
    const input = { scope: SCOPE, text: "Ship on Fridays.", provenance, opId: "" };
    const rejection = relembra.note({ user: "writer" }, input);
    await expect(rejection).rejects.toBeInstanceOf(ProvenanceError);
    await expect(rejection).rejects.toMatchObject({ field: "opId" });
  });
});
