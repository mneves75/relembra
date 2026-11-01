import { describe, expect, test } from "bun:test";
import { ScopeDeniedError, type Store } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { at, OTHER_SCOPE, openRendering, parseRendering, SCOPE } from "./render-support.js";

const line = (id: string, n: number, trust: string, text: string, scope = SCOPE) =>
  `<memory id="${id}" scope="${scope}" rev="1" at="${at(n)}" trust="${trust}">${text}</memory>`;

describe("wake composition", () => {
  test("pinned memories come first, then recent ones newest first, one memory per line, with no summaries section while none exist", async () => {
    const { relembra, note } = openRendering();
    await note("owner", "Always run the linter.", { pinned: true, trust: "owner" });
    await note("agent", "The build uses Bun.");
    await note("agent", "Tests run with bun test.");

    const wake = await relembra.wake("reader");

    expect(wake.text).toBe(
      [
        "<wake>",
        line("m-1", 1, "owner", "Always run the linter."),
        line("m-3", 3, "agent", "Tests run with bun test."),
        line("m-2", 2, "agent", "The build uses Bun."),
        "</wake>",
      ].join("\n"),
    );
    expect(wake.memoryIds).toEqual(["m-1", "m-3", "m-2"]);
  });

  test("untrusted memories never enter the pinned section and come after trusted ones in the recent section", async () => {
    const { relembra, note } = openRendering();
    await note("owner", "Pinned but untrusted.", { pinned: true, trust: "untrusted" });
    await note("agent", "First trusted.");
    await note("owner", "Plain untrusted.", { trust: "untrusted" });
    await note("agent", "Second trusted.");
    await note("owner", "Pinned and owned.", { pinned: true, trust: "owner" });

    const { memories } = parseRendering((await relembra.wake("reader")).text, "wake");

    expect(memories.map((m) => [m.id, m.trust])).toEqual([
      ["m-5", "owner"],
      ["m-4", "agent"],
      ["m-2", "agent"],
      ["m-3", "untrusted"],
      ["m-1", "untrusted"],
    ]);
  });

  test("a pinned agent memory is pinned: trusted means owner or agent", async () => {
    const { relembra, note } = openRendering();
    await note("owner", "Pinned by the owner at agent trust.", { pinned: true, trust: "agent" });
    await note("agent", "Newer and unpinned.");

    const { memories } = parseRendering((await relembra.wake("reader")).text, "wake");

    expect(memories.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  test("wake reads every readable scope, an explicit scope narrows it, and an unreadable one is refused", async () => {
    const { relembra, note } = openRendering();
    await note("agent", "In the example repo.");
    await note("agent", "In the other repo.", { scope: OTHER_SCOPE });

    const ids = async (user: "both" | "reader" | "outsider", scope?: string) =>
      parseRendering(
        (await relembra.wake(user, scope === undefined ? {} : { scope })).text,
        "wake",
      ).memories.map((m) => m.id);

    expect(await ids("both")).toEqual(["m-2", "m-1"]);
    expect(await ids("both", SCOPE)).toEqual(["m-1"]);
    expect(await ids("reader")).toEqual(["m-1"]);
    expect(await ids("outsider")).toEqual(["m-2"]);
    await expect(relembra.wake("reader", { scope: OTHER_SCOPE })).rejects.toBeInstanceOf(
      ScopeDeniedError,
    );
    await expect(relembra.wake("reader", { scope: OTHER_SCOPE })).rejects.toMatchObject({
      access: "read",
    });
  });

  test("a principal with nothing to read gets an empty frame", async () => {
    const { relembra, note } = openRendering();
    await note("agent", "Only in the example repo.");

    const wake = await relembra.wake("outsider");

    expect(wake).toEqual({ text: "<wake>\n</wake>", memoryIds: [] });
  });

  test("the same store gives the same bytes, whatever order the store returns memories in", async () => {
    const { store, relembra, note } = openRendering();
    await note("owner", "Pinned rule.", { pinned: true, trust: "owner" });
    for (let i = 1; i <= 5; i++) await note("agent", `Fact ${i}.`);
    const first = await relembra.wake("reader");

    const reversing: Store = {
      transaction: (work) => store.transaction(work),
      recall: (query) => store.recall(query),
      liveMemories: async (query) => [...(await store.liveMemories(query))].reverse(),
      erasures: () => store.erasures(),
      settlements: () => store.settlements(),
      pendingErasures: (query) => store.pendingErasures(query),
      pendingErasureCount: () => store.pendingErasureCount(),
      recordExposure: (exposure) => store.recordExposure(exposure),
      events: (query) => store.events(query),
      findByTerms: (query) => store.findByTerms(query),
    };
    const again = await openRendering({ store: reversing }).relembra.wake("reader");

    expect(again.text).toBe(first.text);
    expect(await relembra.wake("reader")).toEqual(first);
  });

  test("a store with no memories still renders the frame", async () => {
    const { relembra } = openRendering({ store: createMemoryStore() });

    expect((await relembra.wake("reader")).text).toBe("<wake>\n</wake>");
  });
});
