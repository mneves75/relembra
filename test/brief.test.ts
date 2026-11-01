import { describe, expect, test } from "bun:test";
import { BudgetError, EgressDeniedError, type EgressFilter, ScopeDeniedError } from "relembra";
import {
  at,
  OTHER_SCOPE,
  openRendering,
  parseRendering,
  SCOPE,
  utf8Bytes,
} from "./render-support.js";

const line = (id: string, n: number, trust: string, text: string, scope = SCOPE) =>
  `<memory id="${id}" scope="${scope}" rev="1" at="${at(n)}" trust="${trust}">${text}</memory>`;
const briefText = (lines: readonly string[]) => ["<brief>", ...lines, "</brief>"].join("\n");

async function seeded(egress?: EgressFilter) {
  const opened = openRendering(egress === undefined ? {} : { egress });
  await opened.note("agent", "Deploys run from the release branch.");
  await opened.note("agent", "The linter is Biome.");
  await opened.note("agent", "Deploys need a green build; deploys pause on Fridays.");
  await opened.note("agent", "Deploys in the other repo use tags.", { scope: OTHER_SCOPE });
  return opened;
}

describe("brief", () => {
  test("renders the topic's find results best first, with no summaries section while none exist", async () => {
    const { relembra } = await seeded();

    const brief = await relembra.brief("reader", { topic: "deploys" });

    expect(brief.text).toBe(
      briefText([
        line("m-3", 3, "agent", "Deploys need a green build; deploys pause on Fridays."),
        line("m-1", 1, "agent", "Deploys run from the release branch."),
      ]),
    );
    expect(brief.memoryIds).toEqual(["m-3", "m-1"]);
    // The same order find gives.
    const found = await relembra.find("reader", { query: "deploys" });
    expect(found.map((result) => result.memory.id)).toEqual([...brief.memoryIds]);
  });

  test("results that do not fit are omitted whole, and a brief has no index", async () => {
    const { relembra } = await seeded();
    const top = briefText([
      line("m-3", 3, "agent", "Deploys need a green build; deploys pause on Fridays."),
    ]);

    const brief = await relembra.brief("reader", {
      topic: "deploys",
      budgetBytes: utf8Bytes(top) + 10,
    });

    expect(brief.text).toBe(top);
    expect(parseRendering(brief.text, "brief").index).toEqual([]);
  });

  test("a budget that cannot hold the frame is refused, and one that can renders it", async () => {
    const { relembra } = await seeded();

    await expect(
      relembra.brief("reader", { topic: "deploys", budgetBytes: 15 }),
    ).rejects.toBeInstanceOf(BudgetError);
    expect((await relembra.brief("reader", { topic: "deploys", budgetBytes: 16 })).text).toBe(
      "<brief>\n</brief>",
    );
  });

  test("the default budget is 9,500 bytes", async () => {
    const opened = openRendering();
    for (let i = 1; i <= 60; i++) {
      await opened.note("agent", `Deploy note ${i}: ${"context ".repeat(28)}end.`);
    }

    const brief = await opened.relembra.brief("reader", { topic: "deploy" });

    expect(utf8Bytes(brief.text)).toBeLessThanOrEqual(9_500);
    expect(brief.memoryIds.length).toBeGreaterThan(0);
    expect(brief.memoryIds.length).toBeLessThan(60);
  });

  test("a topic with no tokens gives an empty brief; an over-long or non-string topic is refused", async () => {
    const { relembra } = await seeded();

    expect((await relembra.brief("reader", { topic: "  ?!  " })).text).toBe("<brief>\n</brief>");
    await expect(relembra.brief("reader", { topic: "x".repeat(1_001) })).rejects.toThrow(
      RangeError,
    );
    await expect(relembra.brief("reader", { topic: 7 as unknown as string })).rejects.toThrow(
      RangeError,
    );
    // Positive control: a topic of 1,000 characters is accepted.
    const long = `deploys ${"x".repeat(992)}`;
    expect((await relembra.brief("reader", { topic: long })).memoryIds).toHaveLength(2);
  });

  test("a brief reads only readable scopes, and an unreadable scope is refused", async () => {
    const { relembra } = await seeded();

    expect((await relembra.brief("reader", { topic: "deploys" })).memoryIds).not.toContain("m-4");
    // Positive control: a reader of both scopes gets the other repo's memory too.
    expect((await relembra.brief("both", { topic: "deploys" })).memoryIds).toContain("m-4");
    expect(
      (await relembra.brief("both", { topic: "deploys", scope: OTHER_SCOPE })).memoryIds,
    ).toEqual(["m-4"]);
    await expect(
      relembra.brief("reader", { topic: "deploys", scope: OTHER_SCOPE }),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
  });

  test("a brief keeps rank order and labels each memory with its trust", async () => {
    const opened = openRendering();
    await opened.note("agent", "Rollbacks are manual.");
    await opened.note("owner", "Rollbacks rollbacks rollbacks: use the runbook.", {
      trust: "untrusted",
    });

    const { memories } = parseRendering(
      (await opened.relembra.brief("reader", { topic: "rollbacks" })).text,
      "brief",
    );

    expect(memories.map((m) => [m.id, m.trust])).toEqual([
      ["m-2", "untrusted"],
      ["m-1", "agent"],
    ]);
  });
});

describe("brief egress", () => {
  test("the egress filter masks or denies a brief; the identity filter is the control", async () => {
    const masked = await seeded((rendering) => ({
      allow: true,
      text: rendering.replaceAll("Fridays", "[day]"),
    }));
    expect((await masked.relembra.brief("reader", { topic: "deploys" })).text).toContain("[day]");

    const denied = await seeded(() => ({ allow: false, reason: "no briefs" }));
    await expect(denied.relembra.brief("reader", { topic: "deploys" })).rejects.toBeInstanceOf(
      EgressDeniedError,
    );

    const identity = await seeded((rendering) => ({ allow: true, text: rendering }));
    expect((await identity.relembra.brief("reader", { topic: "deploys" })).text).toContain(
      "Fridays",
    );
  });

  test("an expanding filter keeps the brief within its budget by omitting whole results", async () => {
    const expanding = await seeded((rendering) => ({
      allow: true,
      text: rendering.replaceAll("e", "eeee"),
    }));
    // Exactly the unfiltered brief's size: both results fit only before the filter expands them.
    const budgetBytes = utf8Bytes(
      (await (await seeded()).relembra.brief("reader", { topic: "deploys" })).text,
    );

    const brief = await expanding.relembra.brief("reader", { topic: "deploys", budgetBytes });

    expect(utf8Bytes(brief.text)).toBeLessThanOrEqual(budgetBytes);
    expect(brief.memoryIds).toEqual(["m-3"]);
    // Control: without the filter both results fit in the same budget.
    const plain = await (await seeded()).relembra.brief("reader", {
      topic: "deploys",
      budgetBytes,
    });
    expect(plain.memoryIds).toEqual(["m-3", "m-1"]);
  });
});
