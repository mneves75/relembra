import { describe, expect, test } from "bun:test";
import {
  createRelembra,
  EgressDeniedError,
  type EgressFilter,
  type Policy,
  type Principal,
  ScopeDeniedError,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

const writer: Principal = {
  id: "writer",
  readable: [SCOPE],
  writable: [SCOPE, OTHER_SCOPE],
  promotable: [],
};
const policy: Policy<null> = () => writer;

async function seed(texts: readonly string[], egress?: EgressFilter) {
  const relembra = createRelembra({
    store: createMemoryStore(),
    policy,
    ...(egress === undefined ? {} : { egress }),
  });
  for (const text of texts) await relembra.note(null, { scope: SCOPE, text, provenance });
  return relembra;
}

const encoder = new TextEncoder();

describe("find rendering", () => {
  test("renders find's results, best first, as escaped evidence in a <find> frame", async () => {
    const relembra = await seed(["Use <pnpm> for installs.", "Lunch is at noon.", "pnpm pnpm"]);

    const rendering = await relembra.findRendering(null, { query: "pnpm" });
    const found = await relembra.find(null, { query: "pnpm" });

    expect(rendering.memoryIds).toEqual(found.map((result) => result.memory.id));
    const lines = rendering.text.split("\n");
    expect(lines[0]).toBe("<find>");
    expect(lines.at(-1)).toBe("</find>");
    expect(rendering.text).toContain("Use &lt;pnpm&gt; for installs.</memory>");
    expect(rendering.text).not.toContain("Lunch");
  });

  test("a query that matches nothing renders an empty frame", async () => {
    const relembra = await seed(["Lunch is at noon."]);

    expect(await relembra.findRendering(null, { query: "zebra" })).toEqual({
      text: "<find>\n</find>",
      memoryIds: [],
    });
  });

  test("the host's egress filter sees the rendering, and its deny refuses it", async () => {
    const seen: string[] = [];
    const egress: EgressFilter = (rendering) => {
      seen.push(rendering);
      return rendering.includes("restricted")
        ? { allow: false, reason: "restricted text" }
        : { allow: true, text: rendering.replaceAll("noon", "[time]") };
    };
    const relembra = await seed(["A restricted plan.", "Lunch is at noon."], egress);

    await expect(relembra.findRendering(null, { query: "restricted plan" })).rejects.toThrow(
      EgressDeniedError,
    );
    // Positive control: a rendering the filter allows leaves as the filter rewrote it.
    const allowed = await relembra.findRendering(null, { query: "lunch" });
    expect(allowed.text).toContain("Lunch is at [time].");
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  test("the rendering stays within the byte budget by omitting whole entries", async () => {
    const texts = Array.from({ length: 40 }, (_, i) => `Deploy note ${i} ${"x".repeat(200)}.`);
    const relembra = await seed(texts);

    const rendering = await relembra.findRendering(null, {
      query: "deploy note",
      limit: 40,
      budgetBytes: 1_000,
    });

    expect(encoder.encode(rendering.text).length).toBeLessThanOrEqual(1_000);
    expect(rendering.memoryIds.length).toBeGreaterThan(0);
    expect(rendering.memoryIds.length).toBeLessThan(40);
    // Positive control: with the default budget more of the same results fit.
    const wide = await relembra.findRendering(null, { query: "deploy note", limit: 40 });
    expect(wide.memoryIds.length).toBeGreaterThan(rendering.memoryIds.length);
    expect(encoder.encode(wide.text).length).toBeLessThanOrEqual(9_500);
  });

  test("the same read checks as find: an unreadable scope is refused", async () => {
    const relembra = await seed(["Use pnpm."]);

    await expect(
      relembra.findRendering(null, { query: "pnpm", scope: OTHER_SCOPE }),
    ).rejects.toThrow(ScopeDeniedError);
    await expect(relembra.findRendering(null, { query: "pnpm", limit: 0 })).rejects.toThrow(
      RangeError,
    );
    // Positive control: a readable scope works.
    const ok = await relembra.findRendering(null, { query: "pnpm", scope: SCOPE });
    expect(ok.memoryIds).toHaveLength(1);
  });
});
