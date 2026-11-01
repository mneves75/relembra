import { describe, expect, test } from "bun:test";
import { createRelembra, type Principal, ProvenanceError, type Trust } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { provenance, SCOPE } from "./support.js";

/** A host whose context names the trust ceiling its policy grants. */
function openWithCeiling() {
  const policy = (ceiling: Trust | undefined): Principal => ({
    id: "writer",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    ...(ceiling === undefined ? {} : { trustCeiling: ceiling }),
  });
  return createRelembra<Trust | undefined>({ store: createMemoryStore(), policy });
}

const note = (trust?: Trust) => ({
  scope: SCOPE,
  text: "Trust is part of provenance.",
  provenance: trust === undefined ? provenance : { ...provenance, trust },
});

describe("provenance trust", () => {
  test("a note without trust is stored as agent", async () => {
    const relembra = openWithCeiling();

    const noted = await relembra.note(undefined, note());
    const [recalled] = await relembra.recall(undefined);

    expect(noted.revision.provenance.trust).toBe("agent");
    expect(recalled?.revision.provenance.trust).toBe("agent");
  });

  test("a writer may lower its trust below its ceiling", async () => {
    const relembra = openWithCeiling();

    await relembra.note("owner", note("untrusted"));
    await relembra.note("owner", note("agent"));
    await relembra.note("owner", note("owner"));

    const recalled = await relembra.recall(undefined);
    expect(recalled.map((memory) => memory.revision.provenance.trust)).toEqual([
      "owner",
      "agent",
      "untrusted",
    ]);
  });

  test("trust above the principal's ceiling is refused with a named rule and stores nothing", async () => {
    const relembra = openWithCeiling();

    for (const [ceiling, trust] of [
      [undefined, "owner"],
      ["agent", "owner"],
      ["untrusted", "agent"],
      ["untrusted", "owner"],
    ] as const) {
      const rejection = relembra.note(ceiling, note(trust));
      await expect(rejection).rejects.toBeInstanceOf(ProvenanceError);
      await expect(rejection).rejects.toMatchObject({ field: "trust", rule: "above-ceiling" });
    }
    expect(await relembra.recall(undefined)).toEqual([]);

    // Positive control: the same trust at a ceiling that allows it is stored.
    const noted = await relembra.note("owner", note("owner"));
    expect(noted.revision.provenance.trust).toBe("owner");
  });

  test("the default trust never exceeds an untrusted ceiling", async () => {
    const relembra = openWithCeiling();

    const noted = await relembra.note("untrusted", note());

    expect(noted.revision.provenance.trust).toBe("untrusted");
  });

  test("a trust value that is not a tier is refused, naming the field and not the value", async () => {
    const relembra = openWithCeiling();
    const input = { ...note(), provenance: { ...provenance, trust: "administrator" as Trust } };

    const rejection = relembra.note("owner", input);

    await expect(rejection).rejects.toMatchObject({ field: "trust", rule: "unknown-tier" });
    const error = (await rejection.catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain("administrator");
    expect(await relembra.recall(undefined)).toEqual([]);
  });

  test("a policy that returns a ceiling outside the tiers fails closed", async () => {
    const relembra = openWithCeiling();

    await expect(relembra.note("root" as Trust, note())).rejects.toThrow(TypeError);
    expect(await relembra.recall(undefined)).toEqual([]);
  });
});
