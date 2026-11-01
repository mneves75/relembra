/**
 * The MCP server in process, over the memory store, for what the binary cannot show: every
 * rendering tool (find, brief, wake) goes through the host's egress filter and is measured after
 * it, and a denying filter is a tool refusal.
 */
import { describe, expect, test } from "bun:test";
import { MAX_PENDING_REQUESTS, type McpHost, OVERLOADED, serveMcp } from "../src/cli/mcp.js";
import type { Principal } from "../src/model.js";
import type { Carrier, EgressFilter, Exposure, Store } from "../src/ports.js";
import { createRelembra, type Relembra } from "../src/relembra.js";
import { createMemoryStore } from "../src/testing/index.js";
import { call, parseResponses, type Response, request, toolText } from "./cli/mcp-support.js";

const SCOPE = "test/mcp";
const principal: Principal = {
  id: "uid-1",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  pinnable: [SCOPE],
  owned: [SCOPE],
  trustCeiling: "agent",
};

const CARRIER: Carrier = { id: "mcp:test-process", kind: "mcp" };

function host(egress: EgressFilter, store: Store = createMemoryStore()): McpHost {
  return {
    relembra: createRelembra<null>({ store, policy: () => principal, egress }),
    scope: SCOPE,
    provenance: { agent: "a", harness: "mcp", model: "m", host: "h" },
    carrier: CARRIER,
  };
}

async function session(target: McpHost, ...messages: string[]): Promise<Response[]> {
  const encoder = new TextEncoder();
  async function* input() {
    for (const message of messages) yield encoder.encode(`${message}\n`);
  }
  let stdout = "";
  const logs: string[] = [];
  await serveMcp(
    input(),
    {
      write: async (line) => {
        stdout += line;
      },
      log: (message) => logs.push(message),
    },
    target,
  );
  return parseResponses(stdout);
}

const byId = (responses: readonly Response[], id: string | number) =>
  responses.find((response) => response.id === id) as Response;

const masking: EgressFilter = (text) => ({
  allow: true,
  text: text.replaceAll("hunter", "[masked]"),
});

describe("find, brief and wake leave through the host's egress filter", () => {
  test("a masking filter applies to every rendering tool; the identity filter is the control", async () => {
    for (const [filter, expected] of [
      [masking, "[masked]"],
      [((text) => ({ allow: true, text })) as EgressFilter, "hunter"],
    ] as const) {
      const responses = await session(
        host(filter),
        call(1, "note", { text: "the guard dog is named hunter" }),
        call(2, "find", { query: "guard dog" }),
        call(3, "brief", { topic: "guard dog" }),
        call(4, "wake"),
      );
      for (const id of [2, 3, 4]) {
        const text = toolText(byId(responses, id));
        expect(text).toContain(expected);
        if (expected !== "hunter") expect(text).not.toContain("hunter");
      }
    }
  });

  test("an expanding filter is measured after filtering: whole entries go, the budget holds", async () => {
    const expanding: EgressFilter = (text) => ({ allow: true, text: text.replaceAll("x", "xxxx") });
    const notes = Array.from({ length: 6 }, (_, i) =>
      call(`n${i}`, "note", { text: `lantern ${i} ${"x".repeat(60)}` }),
    );
    const budget = 600;
    const responses = await session(
      host(expanding),
      ...notes,
      call("f", "find", { query: "lantern", budget }),
      call("b", "brief", { topic: "lantern", budget }),
      call("w", "wake", { budget }),
    );
    for (const id of ["f", "b", "w"]) {
      const text = toolText(byId(responses, id));
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(budget);
      expect(text.split("\n").length).toBeGreaterThan(2);
      expect(text.split("\n").length).toBeLessThan(8);
    }
  });

  test("a denying filter is a tool refusal that names no text", async () => {
    const deny: EgressFilter = () => ({ allow: false, reason: "policy says hunter" });
    const responses = await session(
      host(deny),
      call(1, "note", { text: "hunter" }),
      call(2, "find", { query: "hunter" }),
      call(3, "wake"),
    );
    for (const id of [2, 3]) {
      const response = byId(responses, id);
      expect(response.result.isError).toBe(true);
      expect(toolText(response)).toBe("refused: egress-denied");
    }
    expect(byId(responses, 1).result.isError).toBe(false);
  });
});

describe("find, brief and wake record what the client received under the server's carrier", () => {
  const allow: EgressFilter = (text) => ({ allow: true, text });

  test("each rendering tool records exactly the memories in its text", async () => {
    const base = createMemoryStore();
    const calls: Exposure[] = [];
    const store: Store = {
      ...base,
      recordExposure(exposure) {
        calls.push(exposure);
        return base.recordExposure(exposure);
      },
    };
    const responses = await session(
      host(allow, store),
      call(1, "note", { text: "the lantern is in the shed" }),
      call(2, "note", { text: "the ladder is in the barn" }),
      call(3, "find", { query: "lantern" }),
      call(4, "brief", { topic: "ladder" }),
      call(5, "wake"),
      call(6, "find", { query: "nothing matches this" }),
    );
    const lantern = byId(responses, 1).result.structuredContent.memoryId as string;
    const ladder = byId(responses, 2).result.structuredContent.memoryId as string;
    expect(toolText(byId(responses, 3))).toContain("lantern");

    expect(calls.map(({ carrier, memoryIds }) => ({ carrier, memoryIds }))).toEqual([
      { carrier: CARRIER, memoryIds: [lantern] },
      { carrier: CARRIER, memoryIds: [ladder] },
      { carrier: CARRIER, memoryIds: [lantern, ladder].sort() },
    ]);
  });

  test("a denied rendering records nothing; a rendering that cannot be recorded is an internal error", async () => {
    const base = createMemoryStore();
    let recorded = 0;
    const failing: Store = {
      ...base,
      recordExposure: async () => {
        recorded++;
        throw new Error("exposures unavailable");
      },
    };
    const denied = await session(
      host(() => ({ allow: false, reason: "no" }), failing),
      call(1, "note", { text: "the lantern is in the shed" }),
      call(2, "wake"),
    );
    expect(toolText(byId(denied, 2))).toBe("refused: egress-denied");
    expect(recorded).toBe(0);

    const responses = await session(
      host(allow, failing),
      call(3, "wake"),
      call(4, "find", { query: "lantern" }),
    );
    for (const id of [3, 4]) {
      expect(byId(responses, id).error?.code).toBe(-32603);
      expect(JSON.stringify(byId(responses, id))).not.toContain("lantern");
    }
    expect(recorded).toBe(2);
  });

  test("a memory redacted on every try is refused as redacted, naming no text", async () => {
    const base = createMemoryStore();
    const racing: Store = { ...base, recordExposure: async (exposure) => exposure.memoryIds };
    const responses = await session(
      host(allow, racing),
      call(1, "note", { text: "the lantern is in the shed" }),
      call(2, "wake"),
    );
    expect(toolText(byId(responses, 2))).toBe("refused: redacted");
  });
});

/**
 * A host whose first wake waits until `release()`, so every later request stays queued behind it:
 * what is queued and what is refused is then decided by the count alone, not by timing.
 */
function heldHost(): { target: McpHost; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const relembra = {
    async wake() {
      if (first) {
        first = false;
        await gate;
      }
      return { text: "<wake>\n</wake>", memoryIds: [] };
    },
  } as unknown as Relembra<null>;
  return { target: { ...host((text) => ({ allow: true, text })), relembra }, release };
}

const wakes = (ids: readonly number[]) => ids.map((id) => `${call(id, "wake")}\n`).join("");
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the request queue is bounded", () => {
  test("the cap is 64 requests queued or running", () => {
    expect(MAX_PENDING_REQUESTS).toBe(64);
  });

  test("cap + N requests at once while the first is held: N overload errors at once, the rest answered", async () => {
    const { target, release } = heldHost();
    const extra = 5;
    const ids = range(1, MAX_PENDING_REQUESTS + extra + 1);
    let stdout = "";
    let before: Response[] = [];
    async function* input() {
      yield new TextEncoder().encode(wakes(ids));
      // The chunk has been read; the first request is still held, so nothing was answered yet
      // except what was refused without being queued.
      before = parseResponses(stdout);
      release();
    }
    await serveMcp(
      input(),
      {
        write: async (line) => {
          stdout += line;
        },
        log: () => {},
      },
      target,
    );
    expect(before).toHaveLength(extra);
    for (const response of before) {
      expect(response.error?.code).toBe(OVERLOADED);
      expect(response.error?.data).toEqual({ maxPending: MAX_PENDING_REQUESTS });
    }
    expect(before.map((r) => r.id)).toEqual(ids.slice(MAX_PENDING_REQUESTS));
    const after = parseResponses(stdout).slice(extra);
    expect(after.map((r) => r.id)).toEqual(ids.slice(0, MAX_PENDING_REQUESTS));
    for (const response of after) expect(response.result.isError).toBe(false);
  });

  test("control: exactly the cap at once while the first is held is all queued and answered", async () => {
    const { target, release } = heldHost();
    const ids = range(1, MAX_PENDING_REQUESTS + 1);
    let stdout = "";
    let before: Response[] = [];
    async function* input() {
      yield new TextEncoder().encode(wakes(ids));
      before = parseResponses(stdout);
      release();
    }
    await serveMcp(
      input(),
      {
        write: async (line) => {
          stdout += line;
        },
        log: () => {},
      },
      target,
    );
    expect(before).toHaveLength(0);
    expect(parseResponses(stdout).map((r) => r.id)).toEqual(ids);
  });

  test("the cap counts what is pending, not a lifetime: once the queue drains, requests are taken again", async () => {
    const { target, release } = heldHost();
    const ids = range(1, MAX_PENDING_REQUESTS + 2);
    let stdout = "";
    async function* input() {
      yield new TextEncoder().encode(wakes(ids));
      release();
      while (parseResponses(stdout).length < ids.length) await turn();
      yield new TextEncoder().encode(`${request("later", "tools/list")}\n`);
    }
    await serveMcp(
      input(),
      {
        write: async (line) => {
          stdout += line;
        },
        log: () => {},
      },
      target,
    );
    const later = parseResponses(stdout).find((r) => r.id === "later");
    expect(later?.result.tools).toHaveLength(5);
  });

  test("a client that stops reading its responses stops being read: unflushed responses stay at the cap", async () => {
    const { target, release } = heldHost();
    const total = MAX_PENDING_REQUESTS * 2 + 10;
    let pulled = 0;
    let unflushed = 0;
    const flushers: (() => void)[] = [];
    async function* input() {
      for (const id of range(1, total + 1)) {
        pulled++;
        yield new TextEncoder().encode(`${call(id, "wake")}\n`);
      }
    }
    const served = serveMcp(
      input(),
      {
        write: () =>
          new Promise<void>((resolve) => {
            unflushed++;
            flushers.push(() => {
              unflushed--;
              resolve();
            });
          }),
        log: () => {},
      },
      target,
    );
    while (unflushed < MAX_PENDING_REQUESTS) await turn();
    for (let i = 0; i < 20; i++) await turn();
    // 64 requests queued behind the held one, 64 overload errors written and not read: reading
    // waits there, so nothing past them was taken from the input.
    expect(unflushed).toBe(MAX_PENDING_REQUESTS);
    expect(pulled).toBe(MAX_PENDING_REQUESTS * 2);
    release();
    let done = false;
    served.then(() => {
      done = true;
    });
    while (!done) {
      for (const flush of flushers.splice(0)) flush();
      await turn();
    }
    expect(pulled).toBe(total);
    expect(unflushed).toBe(0);
  });

  test("one chunk of many malformed lines leaves no more than the cap unread", async () => {
    const { target } = heldHost();
    const lines = MAX_PENDING_REQUESTS * 3;
    let unflushed = 0;
    const flushers: (() => void)[] = [];
    async function* input() {
      yield new TextEncoder().encode("x\n".repeat(lines));
    }
    const served = serveMcp(
      input(),
      {
        write: () =>
          new Promise<void>((resolve) => {
            unflushed++;
            flushers.push(() => {
              unflushed--;
              resolve();
            });
          }),
        log: () => {},
      },
      target,
    );
    for (let i = 0; i < 20; i++) await turn();
    expect(unflushed).toBe(MAX_PENDING_REQUESTS);
    let done = false;
    let written = 0;
    served.then(() => {
      done = true;
    });
    while (!done) {
      const batch = flushers.splice(0);
      written += batch.length;
      for (const flush of batch) flush();
      await turn();
    }
    expect(written).toBe(lines);
  });
});
