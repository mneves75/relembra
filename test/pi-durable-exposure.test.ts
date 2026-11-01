import { describe, expect, test } from "bun:test";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createRelembra, type Exposure, type Store } from "relembra";
import { createMemoryExtension, MEMORY_SECTION_KEY, WAKE_UNAVAILABLE } from "relembra/pi-durable";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { context, MEMORY_SCOPE, piPolicy, piProvenance } from "./pi-durable-support.js";

const NAMESPACE = "host-a/journal-1";

/** A memory store whose exposure recordings are kept, or fail when `fail` is set. */
function spiedStore() {
  const base = createMemoryStore();
  const calls: Exposure[] = [];
  let fail = false;
  const store: Store = {
    ...base,
    recordExposure(exposure) {
      calls.push(exposure);
      return fail
        ? Promise.reject(new Error("exposures unavailable"))
        : base.recordExposure(exposure);
    },
  };
  return { base, store, calls, failNext: () => (fail = true) };
}

async function open(hostNamespace = NAMESPACE) {
  const spied = spiedStore();
  const relembra = createRelembra({ store: spied.store, policy: piPolicy });
  for (const text of ["Use pnpm for installs.", "Deploys run on Fridays."]) {
    await relembra.note({ user: "agent" }, { scope: MEMORY_SCOPE, text, provenance: piProvenance });
  }
  const extension = createMemoryExtension({
    relembra,
    hostNamespace,
    resolve: () => ({ context: { user: "agent" }, scope: MEMORY_SCOPE, provenance: piProvenance }),
  });
  const tool = (name: string) => {
    const found = extension.tools?.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  const section = extension.sections?.[0];
  const hook = extension.hooks?.[0]?.handlers as {
    beforeRequest(request: unknown, api: unknown): Promise<unknown>;
  };
  if (section === undefined || hook === undefined) throw new Error("no section or hook");
  return { ...spied, relembra, tool, section, hook };
}

function callApi(conversationId: number, taskId: number, callId: string) {
  return { conversationId, taskId, callId } as unknown as ToolExecutionApi;
}

const carrierOf = (conversationId: number) => ({
  id: `${NAMESPACE}/${conversationId}`,
  kind: "pi-durable",
});

describe("pi-durable records what each conversation received", () => {
  test("memory_find and memory_brief record their memory ids under the conversation's carrier", async () => {
    const { tool, calls } = await open();

    const found = await tool("memory_find").execute(
      { query: "pnpm installs" },
      callApi(4, 2, "find-1"),
      context,
    );
    const brief = await tool("memory_brief").execute(
      { topic: "deploys" },
      callApi(5, 3, "brief-1"),
      context,
    );

    const ids = (result: typeof found) => (result.details as { memoryIds: string[] }).memoryIds;
    expect(ids(found).length).toBe(1);
    expect(ids(brief).length).toBe(1);
    expect(calls.map(({ carrier, memoryIds }) => ({ carrier, memoryIds }))).toEqual([
      { carrier: carrierOf(4), memoryIds: ids(found) },
      { carrier: carrierOf(5), memoryIds: ids(brief) },
    ]);
  });

  test("the memory section and the request hook record the wake under the conversation's carrier", async () => {
    const { section, hook, calls } = await open();

    const rendered = await section.render({ conversationId: 9 } as never, context);
    await hook.beforeRequest(
      { messages: [{ role: "system", sections: { [MEMORY_SECTION_KEY]: "<wake>\n</wake>" } }] },
      { conversationId: 9 },
    );

    expect(rendered).toContain("Use pnpm for installs.");
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.carrier).toEqual(carrierOf(9));
      expect(call.memoryIds.length).toBe(2);
    }
  });

  test("a recording that fails never sends the text: the wake becomes the notice and find an error", async () => {
    const { section, tool, failNext } = await open();
    // Positive control: before the failure the wake carries memory text.
    expect(await section.render({ conversationId: 9 } as never, context)).toContain("Use pnpm");

    failNext();

    expect(await section.render({ conversationId: 9 } as never, context)).toBe(WAKE_UNAVAILABLE);
    await expect(
      tool("memory_find").execute({ query: "pnpm" }, callApi(4, 2, "find-2"), context),
    ).rejects.toThrow("exposures unavailable");
  });

  test("a host namespace that cannot name a carrier is refused when the extension is made", async () => {
    await expect(open("line\nbreak")).rejects.toMatchObject({
      name: "IdentifierError",
      field: "carrier id",
    });
    await expect(open("n".repeat(600))).rejects.toMatchObject({ name: "IdentifierError" });
    // Positive control: a namespace with a slash, as the other tests use, is accepted.
    await open("tenant/7/journal");
  });
});
