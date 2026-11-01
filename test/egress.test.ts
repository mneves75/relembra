import { describe, expect, test } from "bun:test";
import { BudgetError, EgressDeniedError, type EgressFilter, type Principal } from "relembra";
import { openRendering, parseRendering, utf8Bytes } from "./render-support.js";

const identity: EgressFilter = (rendering) => ({ allow: true, text: rendering });

async function seed(egress?: EgressFilter) {
  const opened = openRendering(egress === undefined ? {} : { egress });
  await opened.note("agent", "The codename is bluebird.");
  await opened.note("agent", "Deploys run on Fridays.");
  return opened;
}

describe("egress filter", () => {
  test("the filter receives the final rendering and the principal, and its text is what leaves", async () => {
    const seen: { rendering: string; principal: Principal }[] = [];
    const { relembra } = await seed((rendering, principal) => {
      seen.push({ rendering, principal });
      return { allow: true, text: rendering.replaceAll("bluebird", "[masked]") };
    });
    const unfiltered = await (await seed(identity)).relembra.wake("reader");

    const wake = await relembra.wake("reader");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rendering).toBe(unfiltered.text);
    expect(seen[0]?.principal.id).toBe("reader");
    expect(wake.text).toBe(unfiltered.text.replace("bluebird", "[masked]"));
    expect(wake.text).not.toContain("bluebird");
  });

  test("the filter runs per principal: it can mask for one and not for another", async () => {
    const { relembra } = await seed((rendering, principal) => ({
      allow: true,
      text: principal.id === "reader" ? rendering.replaceAll("bluebird", "[masked]") : rendering,
    }));

    expect((await relembra.wake("reader")).text).not.toContain("bluebird");
    // Positive control: the same filter passes the text for another principal.
    expect((await relembra.wake("both")).text).toContain("bluebird");
  });

  test("a deny refuses the whole rendering with the host's reason; the identity filter is the control", async () => {
    const { relembra } = await seed(() => ({ allow: false, reason: "quiet hours" }));

    const rejection = relembra.wake("reader");

    await expect(rejection).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(rejection).rejects.toMatchObject({ reason: "quiet hours" });
    const allowed = await (await seed(identity)).relembra.wake("reader");
    expect(allowed.memoryIds).toEqual(["m-2", "m-1"]);
  });

  test("a deny is never dodged by omitting the entry that caused it", async () => {
    const { relembra } = await seed((rendering) =>
      rendering.includes("bluebird")
        ? { allow: false, reason: "codename" }
        : { allow: true, text: rendering },
    );

    await expect(relembra.wake("reader")).rejects.toBeInstanceOf(EgressDeniedError);
    // Even with a budget so small the codename would be indexed, not shown, the filter decides
    // on what is rendered: here it holds no codename, so it passes.
    const small = await relembra.wake("reader", { budgetBytes: 40 });
    expect(small.text).not.toContain("bluebird");
  });

  test("the default filter is the identity", async () => {
    const withDefault = await (await seed()).relembra.wake("reader");
    const withIdentity = await (await seed(identity)).relembra.wake("reader");

    expect(withDefault).toEqual(withIdentity);
  });

  test("an async filter is awaited", async () => {
    const { relembra } = await seed(async (rendering) => {
      await new Promise((done) => setTimeout(done, 1));
      return { allow: true, text: rendering.replaceAll("Fridays", "[day]") };
    });

    expect((await relembra.wake("reader")).text).toContain("[day]");
  });

  test("a decision that is not exactly allow: true is a deny, and allowed text must be a string", async () => {
    const loose = (await seed((() => ({ allow: 1, text: "x" })) as unknown as EgressFilter))
      .relembra;
    await expect(loose.wake("reader")).rejects.toBeInstanceOf(EgressDeniedError);

    const textless = (await seed((() => ({ allow: true, text: 7 })) as unknown as EgressFilter))
      .relembra;
    await expect(textless.wake("reader")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the budget is measured after the egress filter", () => {
  /** Memories whose text expands under the filter below: every "x" becomes four. */
  async function expandable(egress: EgressFilter) {
    const opened = openRendering({ egress });
    for (let i = 1; i <= 12; i++) {
      await opened.note("agent", `Fact ${String(i).padStart(2, "0")} ${"x".repeat(40)}.`);
    }
    return opened;
  }
  const expanding: EgressFilter = (rendering) => ({
    allow: true,
    text: rendering.replaceAll("x", "xxxx"),
  });

  test("an expanding filter still yields whole entries within the budget, by omitting entries", async () => {
    const budgetBytes = 1_200;
    const control = await (await expandable(identity)).relembra.wake("reader", { budgetBytes });
    const expanded = await (await expandable(expanding)).relembra.wake("reader", { budgetBytes });

    expect(utf8Bytes(control.text)).toBeLessThanOrEqual(budgetBytes);
    expect(utf8Bytes(expanded.text)).toBeLessThanOrEqual(budgetBytes);
    const shown = parseRendering(expanded.text, "wake");
    const shownControl = parseRendering(control.text, "wake");
    expect(shown.memories.length).toBeGreaterThan(0);
    expect(shown.memories.length).toBeLessThan(shownControl.memories.length);
    // What remains is a prefix of the same composition order, each entry expanded whole.
    const order = [...shownControl.memories.map((m) => m.id), ...shownControl.index];
    expect([...shown.memories.map((m) => m.id), ...shown.index]).toEqual(
      order.slice(0, shown.memories.length + shown.index.length),
    );
    for (const memory of shown.memories) expect(memory.text).toContain("x".repeat(160));
    expect(expanded.memoryIds).toEqual(shown.memories.map((m) => m.id));
  });

  test("a filter that pushes even the empty frame over budget is refused", async () => {
    const { relembra } = await expandable((rendering) => ({
      allow: true,
      text: `${rendering}${"!".repeat(100)}`,
    }));

    await expect(relembra.wake("reader", { budgetBytes: 100 })).rejects.toBeInstanceOf(BudgetError);
    // Positive control: with room for the padding, the same filter renders within the budget.
    const wake = await relembra.wake("reader", { budgetBytes: 400 });
    expect(utf8Bytes(wake.text)).toBeLessThanOrEqual(400);
  });

  test("a shrinking filter's output is within the budget too", async () => {
    const { relembra } = await expandable((rendering) => ({
      allow: true,
      text: rendering.replaceAll("x", ""),
    }));

    const wake = await relembra.wake("reader", { budgetBytes: 1_200 });

    expect(utf8Bytes(wake.text)).toBeLessThanOrEqual(1_200);
    expect(wake.text).not.toContain("x");
  });
});
