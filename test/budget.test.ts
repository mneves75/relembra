import { describe, expect, test } from "bun:test";
import { BudgetError } from "relembra";
import { at, openRendering, parseRendering, SCOPE, utf8Bytes } from "./render-support.js";

const line = (id: string, n: number, trust: string, text: string) =>
  `<memory id="${id}" scope="${SCOPE}" rev="1" at="${at(n)}" trust="${trust}">${text}</memory>`;
const indexLine = (id: string) => `<index id="${id}"/>`;
const wakeText = (lines: readonly string[]) => ["<wake>", ...lines, "</wake>"].join("\n");

/** Three agent memories (m-1 oldest) and a pinned owner memory (m-4). */
async function seeded() {
  const opened = openRendering();
  await opened.note("agent", "First fact.");
  await opened.note("agent", "Second fact.");
  await opened.note("agent", "Third fact.");
  await opened.note("owner", "Pinned rule.", { pinned: true, trust: "owner" });
  return opened;
}

describe("wake budget", () => {
  test("memories that do not fit in full are listed, whole, in an index after them", async () => {
    const { relembra } = await seeded();
    const expected = wakeText([
      line("m-4", 4, "owner", "Pinned rule."),
      line("m-3", 3, "agent", "Third fact."),
      indexLine("m-2"),
      indexLine("m-1"),
    ]);

    const wake = await relembra.wake("reader", { budgetBytes: utf8Bytes(expected) });

    expect(wake.text).toBe(expected);
    expect(wake.memoryIds).toEqual(["m-4", "m-3"]);
  });

  test("one byte less omits the last index entry whole", async () => {
    const { relembra } = await seeded();
    const fits = wakeText([
      line("m-4", 4, "owner", "Pinned rule."),
      line("m-3", 3, "agent", "Third fact."),
      indexLine("m-2"),
      indexLine("m-1"),
    ]);

    const wake = await relembra.wake("reader", { budgetBytes: utf8Bytes(fits) - 1 });

    expect(wake.text).toBe(
      wakeText([
        line("m-4", 4, "owner", "Pinned rule."),
        line("m-3", 3, "agent", "Third fact."),
        indexLine("m-2"),
      ]),
    );
  });

  test("the first memory that does not fit ends the full section, and it and the rest go to the index", async () => {
    const opened = openRendering();
    await opened.note("agent", "Short one.");
    await opened.note("agent", `A long one: ${"x".repeat(200)}.`);
    await opened.note("agent", "Short two.");
    const expected = wakeText([
      line("m-3", 3, "agent", "Short two."),
      indexLine("m-2"),
      indexLine("m-1"),
    ]);
    // Room for the short m-1 in full, but it comes after m-2, which does not fit.
    const budgetBytes = utf8Bytes(expected) + 60;

    const wake = await opened.relembra.wake("reader", { budgetBytes });

    expect(wake.text).toBe(expected);
  });

  test("the default budget is 9,500 bytes, filled with whole entries", async () => {
    const opened = openRendering();
    for (let i = 1; i <= 80; i++) {
      await opened.note("agent", `Fact ${String(i).padStart(2, "0")}: ${"detail ".repeat(30)}end.`);
    }

    const wake = await opened.relembra.wake("reader");

    const bytes = utf8Bytes(wake.text);
    expect(bytes).toBeLessThanOrEqual(9_500);
    const { memories, index } = parseRendering(wake.text, "wake");
    expect(memories.length).toBeGreaterThan(0);
    expect(index.length).toBeGreaterThan(0);
    // Newest first in full, then every remaining id in the same order, as many as fit.
    const all = Array.from({ length: 80 }, (_, i) => `m-${80 - i}`);
    expect([...memories.map((m) => m.id), ...index]).toEqual(
      all.slice(0, memories.length + index.length),
    );
    // Nothing more would have fitted: the next index line overflows.
    const next = all[memories.length + index.length];
    if (next !== undefined) expect(bytes + utf8Bytes(indexLine(next)) + 1).toBeGreaterThan(9_500);
  });

  test("a budget that holds only the frame renders the frame; one that cannot hold it is refused", async () => {
    const { relembra } = await seeded();

    expect(await relembra.wake("reader", { budgetBytes: 14 })).toEqual({
      text: "<wake>\n</wake>",
      memoryIds: [],
    });
    const rejection = relembra.wake("reader", { budgetBytes: 13 });
    await expect(rejection).rejects.toBeInstanceOf(BudgetError);
    await expect(rejection).rejects.toMatchObject({ budgetBytes: 13 });
  });

  test("a budget that is not a positive integer is refused", async () => {
    const { relembra } = await seeded();

    for (const budgetBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(relembra.wake("reader", { budgetBytes })).rejects.toThrow(RangeError);
    }
    // Positive control: a positive integer is accepted.
    expect((await relembra.wake("reader", { budgetBytes: 1 << 20 })).memoryIds).toHaveLength(4);
  });

  test("the budget counts UTF-8 bytes, not characters", async () => {
    const opened = openRendering();
    await opened.note("agent", "Migrações são revisadas.");
    const full = wakeText([line("m-1", 1, "agent", "Migrações são revisadas.")]);
    expect(utf8Bytes(full)).toBeGreaterThan(full.length);

    // The character count would fit; the byte count does not, so m-1 goes to the index.
    const wake = await opened.relembra.wake("reader", { budgetBytes: full.length });

    expect(wake.text).toBe(wakeText([indexLine("m-1")]));
    // Positive control: the byte count fits.
    expect((await opened.relembra.wake("reader", { budgetBytes: utf8Bytes(full) })).text).toBe(
      full,
    );
  });
});
