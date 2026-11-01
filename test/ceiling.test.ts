import { describe, expect, test } from "bun:test";
import { createRelembra, type Memory, type Principal, ProvenanceError, type Trust } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { provenance, SCOPE } from "./support.js";

/** Both own the scope; only the trust ceiling differs. */
const principal = (trustCeiling: Trust): Principal => ({
  id: trustCeiling,
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  owned: [SCOPE],
  trustCeiling,
});

function open() {
  const store = createMemoryStore();
  const relembra = createRelembra<Trust>({ store, policy: principal });
  const note = (text: string, trust: Trust) =>
    relembra.note("owner", { scope: SCOPE, text, provenance: { ...provenance, trust } });
  /**
   * An agent-trust memory with an owner-trust summary of it. The library never writes a summary
   * above its sources, so the summary's trust is raised in the store, as data from an import or
   * a foreign writer could arrive. With `raise` false the summary keeps agent trust.
   */
  const withOwnerSummary = async (raise = true) => {
    const source = await note("Deploys need two approvals.", "agent");
    const summary = await relembra.submitSummary("owner", {
      scope: SCOPE,
      sources: [{ memoryId: source.id, revision: 1 }],
      text: "Approvals, summarized.",
      provenance: { ...provenance, trust: "agent" },
    });
    const raised: Memory = {
      ...summary,
      revision: {
        ...summary.revision,
        provenance: { ...summary.revision.provenance, trust: "owner" },
      },
    };
    if (raise) await store.transaction((tx) => tx.putMemory(raised));
    return { source, summary };
  };
  const status = async (id: string) => (await relembra.zoom("owner", { memoryId: id })).status;
  return { relembra, note, withOwnerSummary, status };
}

const aboveCeiling = (error: unknown) =>
  error instanceof ProvenanceError && error.field === "trust" && error.rule === "above-ceiling";

describe("retract and redact never change a memory more trusted than the principal's ceiling", () => {
  for (const op of ["retract", "redact"] as const) {
    test(`${op}: an agent-ceiling principal cannot ${op} an owner memory; an owner can`, async () => {
      const { relembra, note, status } = open();
      const rule = await note("Never publish secrets.", "owner");
      const refusal = await relembra[op]("agent", { memoryId: rule.id }).catch((e: unknown) => e);
      expect(aboveCeiling(refusal)).toBe(true);
      expect(await status(rule.id)).toBe("live");
      // Positive control: an owner-ceiling principal may.
      await relembra[op]("owner", { memoryId: rule.id });
      expect(await status(rule.id)).toBe(op === "retract" ? "retracted" : "redacted");
    });

    test(`${op}: an agent memory whose cascade reaches an owner summary is refused too`, async () => {
      const { relembra, withOwnerSummary, status } = open();
      const { source, summary } = await withOwnerSummary();
      const refusal = await relembra[op]("agent", { memoryId: source.id }).catch((e: unknown) => e);
      expect(aboveCeiling(refusal)).toBe(true);
      expect(await status(source.id)).toBe("live");
      expect(await status(summary.id)).toBe("live");
      // Positive control: the owner cascades it.
      await relembra[op]("owner", { memoryId: source.id });
      expect(await status(summary.id)).toBe(op === "retract" ? "retracted" : "redacted");
    });

    test(`${op}: an agent-ceiling principal still changes agent memories`, async () => {
      const { relembra, note, status } = open();
      const fact = await note("The build takes four minutes.", "agent");
      await relembra[op]("agent", { memoryId: fact.id });
      expect(await status(fact.id)).toBe(op === "retract" ? "retracted" : "redacted");
    });
  }

  test("previews list owner memories at agent ceiling, so a host can ask before it raises", async () => {
    const { relembra, withOwnerSummary } = open();
    const { source, summary } = await withOwnerSummary();
    const preview = await relembra.redactionPreview("agent", { memoryId: source.id });
    expect(preview.map((m) => m.id)).toEqual([source.id, summary.id]);
  });

  test("retracting an already retracted owner memory changes nothing and is not refused", async () => {
    const { relembra, note, status } = open();
    const rule = await note("Never publish secrets.", "owner");
    await relembra.retract("owner", { memoryId: rule.id });
    await relembra.retract("agent", { memoryId: rule.id });
    expect(await status(rule.id)).toBe("retracted");
  });

  test("supersede: an agent memory whose live summary has owner trust is refused, nothing written", async () => {
    const { relembra, withOwnerSummary, status } = open();
    const { source, summary } = await withOwnerSummary();
    const before = (await relembra.recall("owner", { includeRetracted: true })).length;
    const input = { memoryId: source.id, text: "Deploys need one approval.", provenance };
    const refusal = await relembra.supersede("agent", input).catch((e: unknown) => e);
    expect(aboveCeiling(refusal)).toBe(true);
    expect(await status(source.id)).toBe("live");
    expect(await status(summary.id)).toBe("live");
    expect((await relembra.recall("owner", { includeRetracted: true })).length).toBe(before);
  });

  test("supersede: positive control, the same with an agent summary goes through", async () => {
    const { relembra, withOwnerSummary, status } = open();
    const { source, summary } = await withOwnerSummary(false);
    const input = { memoryId: source.id, text: "Deploys need one approval.", provenance };
    await relembra.supersede("agent", input);
    expect(await status(source.id)).toBe("superseded");
    expect(await status(summary.id)).toBe("retracted");
  });
});
