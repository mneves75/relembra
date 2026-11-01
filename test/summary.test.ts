import { describe, expect, test } from "bun:test";
import {
  advanceFence,
  createRelembra,
  FencedError,
  GuardError,
  MemoryNotFoundError,
  MemoryRedactedError,
  OpConflictError,
  type Principal,
  ScopeDeniedError,
  SourceChangedError,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { openRendering, parseRendering, utf8Bytes } from "./render-support.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

const principals: Record<string, Principal> = {
  owner: {
    id: "owner",
    readable: [SCOPE, OTHER_SCOPE],
    writable: [SCOPE, OTHER_SCOPE],
    promotable: [],
    owned: [SCOPE],
  },
  writer: {
    id: "writer",
    readable: [SCOPE, OTHER_SCOPE],
    writable: [SCOPE, OTHER_SCOPE],
    promotable: [],
  },
  reader: { id: "reader", readable: [SCOPE], writable: [], promotable: [] },
  stale: {
    id: "stale",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
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
  const summarize = (
    context: string,
    sources: readonly { readonly id: string }[],
    more: { scope?: string; text?: string; opId?: string } = {},
  ) =>
    relembra.submitSummary(context, {
      scope: more.scope ?? SCOPE,
      sources: sources.map((m) => ({ memoryId: m.id, revision: 1 })),
      text: more.text ?? "A summary.",
      provenance,
      ...(more.opId === undefined ? {} : { opId: more.opId }),
    });
  return { store, relembra, note, summarize };
}

describe("submitSummary", () => {
  test("needs write access to the scope", async () => {
    const { note, summarize } = open();
    const a = await note("Fact.");
    await expect(summarize("reader", [a])).rejects.toThrow(new ScopeDeniedError("write"));
    // Positive control.
    expect((await summarize("writer", [a])).sources).toEqual([{ memoryId: a.id, revision: 1 }]);
  });

  test("refuses no sources, a repeated source, a bad revision, and text the guard refuses", async () => {
    const { relembra, note, summarize } = open();
    const a = await note("Fact.");
    await expect(summarize("writer", [])).rejects.toBeInstanceOf(RangeError);
    await expect(summarize("writer", [a, a])).rejects.toBeInstanceOf(RangeError);
    await expect(
      relembra.submitSummary("writer", {
        scope: SCOPE,
        sources: [{ memoryId: a.id, revision: 0 }],
        text: "A summary.",
        provenance,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(summarize("writer", [a], { text: "two\nlines" })).rejects.toBeInstanceOf(
      GuardError,
    );
  });

  test("a source in another scope is refused, so a summary never carries text across scopes", async () => {
    const { note, summarize } = open();
    const here = await note("Here.");
    const there = await note("There.", OTHER_SCOPE);
    await expect(summarize("writer", [here, there])).rejects.toBeInstanceOf(RangeError);
    // Positive control: each scope's sources summarize within it.
    await summarize("writer", [there], { scope: OTHER_SCOPE });
  });

  test("an unknown or unreadable source is not found", async () => {
    const { note, summarize } = open();
    const there = await note("There.", OTHER_SCOPE);
    await expect(summarize("writer", [{ id: "no-such-memory" }])).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    // stale reads only SCOPE and writes it; the other scope's memory does not exist for it.
    await expect(summarize("stale", [there])).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  test("a retracted, superseded or redacted source is not found for a principal that does not own its scope", async () => {
    const { relembra, note, summarize } = open();
    const retracted = await note("Retracted.");
    const superseded = await note("Superseded.");
    const redacted = await note("Redacted.");
    await relembra.retract("owner", { memoryId: retracted.id });
    await relembra.supersede("owner", {
      memoryId: superseded.id,
      text: "Replacement.",
      provenance,
    });
    await relembra.redact("owner", { memoryId: redacted.id });

    for (const source of [retracted, superseded, redacted]) {
      const refusal = summarize("writer", [source]);
      await expect(refusal).rejects.toBeInstanceOf(MemoryNotFoundError);
      await expect(refusal).rejects.not.toThrow(source.id);
      // Positive control: the owner, who can see it, learns that it changed.
      await expect(summarize("owner", [source])).rejects.toThrow(new SourceChangedError(source.id));
    }
  });

  test("a stale revision of a live source is a changed source, for a reader and for the owner", async () => {
    const { relembra, note } = open();
    const live = await note("Live fact.");
    for (const context of ["writer", "owner"]) {
      await expect(
        relembra.submitSummary(context, {
          scope: SCOPE,
          sources: [{ memoryId: live.id, revision: 2 }],
          text: "A summary.",
          provenance,
        }),
      ).rejects.toThrow(new SourceChangedError(live.id));
    }
  });

  test("the same op id with other sources is a conflict, and a redacted summary's retry is terminal", async () => {
    const { relembra, note, summarize } = open();
    const a = await note("Fact A.");
    const b = await note("Fact B.");
    const first = await summarize("writer", [a], { opId: "op-s" });
    await expect(summarize("writer", [b], { opId: "op-s" })).rejects.toBeInstanceOf(
      OpConflictError,
    );
    expect(await summarize("writer", [a], { opId: "op-s" })).toEqual(first);

    await relembra.redact("owner", { memoryId: a.id });
    await expect(summarize("writer", [a], { opId: "op-s" })).rejects.toThrow(
      new MemoryRedactedError(first.id),
    );
  });

  test("a writer whose fence epoch was advanced writes no summary", async () => {
    const { store, relembra, note, summarize } = open();
    const a = await note("Fenced.");
    await advanceFence(store, { key: "lease", epoch: 2 });
    await expect(summarize("stale", [a])).rejects.toBeInstanceOf(FencedError);
    expect((await relembra.recall("writer")).map((m) => m.id)).toEqual([a.id]);
  });
});

describe("pending", () => {
  test("reads only readable scopes and honours its limit", async () => {
    const { relembra, note } = open();
    const a = await note("First.");
    await note("Second.");
    await note("Elsewhere.", OTHER_SCOPE);
    await expect(relembra.pending("reader", { scope: OTHER_SCOPE })).rejects.toThrow(
      new ScopeDeniedError("read"),
    );
    expect((await relembra.pending("reader", { limit: 1 })).map((m) => m.id)).toEqual([a.id]);
    await expect(relembra.pending("reader", { limit: 0 })).rejects.toBeInstanceOf(RangeError);
  });

  test("a source stays due unless a live summary of at least its trust covers it", async () => {
    const opened = openRendering();
    const rule = await opened.note("owner", "Owner rule.", { trust: "owner" });
    const fact = await opened.note("agent", "Agent fact.");
    const other = await opened.note("agent", "Other agent fact.");
    const summarize = (sources: readonly { id: string }[], trust?: "untrusted") =>
      opened.relembra.submitSummary("owner", {
        scope: SCOPE,
        sources: sources.map((m) => ({ memoryId: m.id, revision: 1 })),
        text: "A summary.",
        provenance: trust === undefined ? provenance : { ...provenance, trust },
      });
    // An agent summary of the owner rule and the agent fact; an untrusted one of the other fact.
    expect((await summarize([rule, fact])).revision.provenance.trust).toBe("agent");
    expect((await summarize([other], "untrusted")).revision.provenance.trust).toBe("untrusted");

    // Positive control: the agent fact, covered at its own trust, is no longer due.
    expect((await opened.relembra.pending("reader")).map((m) => m.id)).toEqual([rule.id, other.id]);
  });
});

describe("summaries in wake and brief", () => {
  async function seeded() {
    const opened = openRendering();
    const a = await opened.note("agent", "Deploys use tags.");
    const b = await opened.note("agent", "Deploys pause on Fridays.");
    const c = await opened.note("agent", "Lint with Biome.");
    const summarize = (sources: readonly { id: string }[], text: string, trust?: "untrusted") =>
      opened.relembra.submitSummary("owner", {
        scope: SCOPE,
        sources: sources.map((m) => ({ memoryId: m.id, revision: 1 })),
        text,
        provenance: trust === undefined ? provenance : { ...provenance, trust },
      });
    return { ...opened, a, b, c, summarize };
  }

  test("an untrusted summary comes after every trusted memory, and covers no trusted source", async () => {
    const { relembra, a, b, c, summarize } = await seeded();
    const external = await summarize([c], "External summary.", "untrusted");
    const trusted = await summarize([a, b], "Release rules.");

    const wake = parseRendering((await relembra.wake("reader")).text, "wake");

    // c keeps its place among recent memories: a less trusted summary does not displace it.
    expect(wake.memories.map((m) => [m.id, m.trust])).toEqual([
      [c.id, "agent"],
      [trusted.id, "agent"],
      [b.id, "agent"],
      [a.id, "agent"],
      [external.id, "untrusted"],
    ]);
  });

  test("an owner memory covered by an agent summary renders before that summary", async () => {
    const opened = openRendering();
    const rule = await opened.note("owner", "Owner rule: deploys need a tag.", { trust: "owner" });
    const fact = await opened.note("agent", "Agent fact: deploys run at noon.");
    const summary = await opened.relembra.submitSummary("owner", {
      scope: SCOPE,
      sources: [
        { memoryId: rule.id, revision: 1 },
        { memoryId: fact.id, revision: 1 },
      ],
      text: "Deploys: tagged, at noon.",
      provenance,
    });
    expect(summary.revision.provenance.trust).toBe("agent");

    const wake = parseRendering((await opened.relembra.wake("reader")).text, "wake");

    // The agent summary covers the agent fact, an equal trust, but not the owner rule.
    expect(wake.memories.map((m) => [m.id, m.trust])).toEqual([
      [rule.id, "owner"],
      [summary.id, "agent"],
      [fact.id, "agent"],
    ]);
  });

  test("a less trusted summary of a summary never renders ahead of it", async () => {
    const opened = openRendering();
    const first = await opened.note("owner", "Owner rule one.", { trust: "owner" });
    const second = await opened.note("owner", "Owner rule two.", { trust: "owner" });
    const ownerSummary = await opened.relembra.submitSummary("owner", {
      scope: SCOPE,
      sources: [
        { memoryId: first.id, revision: 1 },
        { memoryId: second.id, revision: 1 },
      ],
      text: "Owner rules one and two.",
      provenance: { ...provenance, trust: "owner" },
    });
    const agentSummary = await opened.relembra.submitSummary("agent", {
      scope: SCOPE,
      sources: [{ memoryId: ownerSummary.id, revision: 1 }],
      text: "Agent restatement of the owner rules.",
      provenance,
    });
    expect(agentSummary.revision.provenance.trust).toBe("agent");

    const full = await opened.relembra.wake("reader");
    expect(parseRendering(full.text, "wake").memories.map((m) => [m.id, m.trust])).toEqual([
      [ownerSummary.id, "owner"],
      [agentSummary.id, "agent"],
      [second.id, "owner"],
      [first.id, "owner"],
    ]);
    // Under a budget for one memory, the owner summary is the one that renders.
    const lines = full.text.split("\n");
    const tight = await opened.relembra.wake("reader", {
      budgetBytes: utf8Bytes(["<wake>", lines[1], "</wake>"].join("\n")),
    });
    expect(tight.memoryIds).toEqual([ownerSummary.id]);
  });

  test("an untrusted summary never renders ahead of trusted memories another summary covers", async () => {
    const opened = openRendering();
    const fact = await opened.note("agent", "Agent fact.");
    const external = await opened.note("agent", "External fact.", { trust: "untrusted" });
    const summarize = (source: { id: string }, text: string) =>
      opened.relembra.submitSummary("owner", {
        scope: SCOPE,
        sources: [{ memoryId: source.id, revision: 1 }],
        text,
        provenance,
      });
    const trustedSummary = await summarize(fact, "Summary of the agent fact.");
    const untrustedSummary = await summarize(external, "Summary of the external fact.");
    expect(untrustedSummary.revision.provenance.trust).toBe("untrusted");

    const wake = parseRendering((await opened.relembra.wake("reader")).text, "wake");

    expect(wake.memories.map((m) => [m.id, m.trust])).toEqual([
      [trustedSummary.id, "agent"],
      [fact.id, "agent"],
      [untrustedSummary.id, "untrusted"],
      [external.id, "untrusted"],
    ]);
  });

  test("a tight budget keeps whole summaries and sends covered sources to the index", async () => {
    const { relembra, a, b, c, summarize } = await seeded();
    const summary = await summarize([a, b], "Release rules.");
    const full = await relembra.wake("reader");
    const lines = full.text.split("\n");
    // Room for the frame, c, the summary and two index lines, not for a covered source in full.
    const budget =
      utf8Bytes(["<wake>", lines[1], lines[2], "</wake>"].join("\n")) +
      utf8Bytes(`\n<index id="${b.id}"/>\n<index id="${a.id}"/>`);

    const tight = await relembra.wake("reader", { budgetBytes: budget });

    expect(tight.memoryIds).toEqual([c.id, summary.id]);
    expect(parseRendering(tight.text, "wake").index).toEqual([b.id, a.id]);
    expect(utf8Bytes(tight.text)).toBeLessThanOrEqual(budget);
  });

  test("a brief shows a summary once, after its results, and omits it whole when it does not fit", async () => {
    const { relembra, a, b, summarize } = await seeded();
    const summary = await summarize([a, b], "Deploy rules: tags, never on Fridays.");

    const brief = await relembra.brief("reader", { topic: "deploys" });
    // The summary matches the topic too: it is ranked, and not repeated in the summary slot.
    expect(brief.memoryIds).toEqual([...new Set(brief.memoryIds)]);
    expect([...brief.memoryIds].sort()).toEqual([a.id, b.id, summary.id].sort());

    const onlyFriday = await relembra.brief("reader", { topic: "fridays" });
    expect(onlyFriday.memoryIds).toEqual([b.id, summary.id]);
    const firstLine = onlyFriday.text.split("\n")[1] ?? "";
    const tight = await relembra.brief("reader", {
      topic: "fridays",
      budgetBytes: utf8Bytes(["<brief>", firstLine, "</brief>"].join("\n")),
    });
    expect(tight.memoryIds).toEqual([b.id]);
  });
});
