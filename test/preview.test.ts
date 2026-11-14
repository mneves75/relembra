import { describe, expect, test } from "bun:test";
import { createRelembra, type Memory, type Principal, ScopeDeniedError } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { provenance, SCOPE } from "./support.js";

const DAY = 86_400_000;
const principals: Record<string, Principal> = {
  owner: {
    id: "owner",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
    trustCeiling: "owner",
  },
  writer: { id: "writer", readable: [SCOPE], writable: [SCOPE], promotable: [] },
};

function open(maxAgeDays = 30) {
  const store = createMemoryStore();
  let now = 0;
  let n = 0;
  const relembra = createRelembra<string>({
    store,
    policy: (name) => principals[name] as Principal,
    clock: { now: () => now },
    ids: { memoryId: () => `memory-${++n}`, opId: () => `op-${++n}` },
    retention: [{ scope: SCOPE, maxAgeDays }],
  });
  const note = (text: string, trust: "owner" | "agent" = "agent") =>
    relembra.note("owner", { scope: SCOPE, text, provenance: { ...provenance, trust } });
  const summarize = (sources: readonly Memory[], text: string, trust: "owner" | "agent") =>
    relembra.submitSummary("owner", {
      scope: SCOPE,
      sources: sources.map((m) => ({ memoryId: m.id, revision: 1 })),
      text,
      provenance: { ...provenance, trust },
    });
  return { relembra, note, summarize, at: (ms: number) => (now = ms) };
}

const ids = (memories: readonly Memory[]) => memories.map((m) => m.id).sort();

describe("sweepPreview: exactly what sweep(now) would redact, changing nothing", () => {
  test("superseded memories and derived summaries included, the same boundary as sweep", async () => {
    const { relembra, note, summarize, at } = open(30);
    const rule = await note("Keep the audit log on.", "owner");
    const fact = await note("Builds run nightly.");
    const summary = await summarize([fact], "Nightly builds.", "agent");
    at(10 * DAY);
    // The owner rule is superseded, so recall no longer lists it; sweep still expires it.
    await relembra.supersede("owner", {
      memoryId: rule.id,
      text: "Keep it on for 90 days.",
      provenance,
    });
    expect((await relembra.recall("owner")).map((m) => m.id)).not.toContain(rule.id);
    // Exactly 30 days after the first notes: sweep's boundary is exclusive, so nothing expires yet.
    expect(await relembra.sweepPreview(30 * DAY)).toEqual([]);
    const preview = await relembra.sweepPreview(30 * DAY + 1);
    expect(ids(preview)).toEqual([fact.id, rule.id, summary.id].sort());
    expect(preview.find((m) => m.id === rule.id)?.status).toBe("superseded");
    // Nothing changed: a second preview is the same, and the rule is still there.
    expect(ids(await relembra.sweepPreview(30 * DAY + 1))).toEqual(ids(preview));
    expect((await relembra.zoom("owner", { memoryId: rule.id })).status).toBe("superseded");
    // Positive control: sweep then redacts exactly the previewed set.
    const report = await relembra.sweep(30 * DAY + 1);
    expect([...report.redacted, ...report.derived].sort()).toEqual(ids(preview));
    expect(await relembra.sweepPreview(30 * DAY + 1)).toEqual([]);
  });

  test("with no retention rule, or a bad time, it previews like sweep", async () => {
    const store = createMemoryStore();
    const relembra = createRelembra<string>({
      store,
      policy: () => ({
        id: "owner",
        readable: [SCOPE],
        writable: [SCOPE],
        promotable: [],
        owned: [SCOPE],
      }),
    });
    expect(await relembra.sweepPreview(1000 * DAY)).toEqual([]);
    await expect(relembra.sweepPreview(Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("redactionPreview: exactly what redact would erase, changing nothing", () => {
  test("the memory and its derived closure, through summaries of summaries", async () => {
    const { relembra, note, summarize } = open();
    const a = await note("Alpha.", "owner");
    const b = await note("Beta.", "owner");
    const s1 = await summarize([a, b], "Alpha and beta.", "owner");
    const s2 = await summarize([s1], "All of it.", "agent");
    const unrelated = await note("Gamma.");
    const preview = await relembra.redactionPreview("owner", { memoryId: a.id });
    expect(preview.map((m) => m.id)).toEqual([a.id, s1.id, s2.id]);
    expect(preview.map((m) => m.revision.provenance.trust)).toEqual(["owner", "owner", "agent"]);
    expect((await relembra.zoom("owner", { memoryId: a.id })).status).toBe("live");
    // Positive control: redact erases exactly that set, and the unrelated memory stays.
    const report = await relembra.redact("owner", { memoryId: a.id });
    expect([...report.redacted, ...report.derived]).toEqual(preview.map((m) => m.id));
    expect((await relembra.zoom("owner", { memoryId: unrelated.id })).status).toBe("live");
    // A tombstone previews nothing, as redacting it again erases nothing.
    expect(await relembra.redactionPreview("owner", { memoryId: a.id })).toEqual([]);
  });

  test("the same authority as redact: a writer who does not own the scope is refused", async () => {
    const { relembra, note } = open();
    const a = await note("Alpha.");
    await expect(relembra.redactionPreview("writer", { memoryId: a.id })).rejects.toBeInstanceOf(
      ScopeDeniedError,
    );
  });
});
