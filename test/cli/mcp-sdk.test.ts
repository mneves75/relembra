/**
 * The stdio round trip through an independent conforming client: the official MCP TypeScript SDK
 * client, @modelcontextprotocol/client 2.4.0 (a devDependency, pinned exactly), pinned to protocol
 * revision 2026-07-28 so it neither falls back to the legacy initialize handshake nor accepts a
 * result without `resultType`. The README names this as the qualified client version.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BINARY, cliTest, ok, sandbox, sandboxEnv } from "./support.js";

const { PATH } = process.env;
const PINNED = { versionNegotiation: { mode: { pin: "2026-07-28" } } } as const;
const box = sandbox();
afterAll(() => box.remove());

function client(): Client {
  return new Client({ name: "relembra-round-trip", version: "1" }, PINNED);
}

function fakeServer(env: Record<string, string>): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "mcp-fake-server.ts")],
    env: { PATH: PATH ?? "/usr/bin:/bin", ...env },
    stderr: "pipe",
  });
}

describe("a stdio round trip through the official MCP client, pinned to 2026-07-28", () => {
  cliTest(
    "discover, list, note, find, brief, wake and retract over the real binary",
    async () => {
      ok(box, ["init"]);
      const transport = new StdioClientTransport({
        command: BINARY,
        args: ["mcp"],
        cwd: box.repo,
        env: sandboxEnv(box),
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      // Diagnostic: on the Windows runners this test timed out with no failing step, so each step
      // is logged there until the stalled one is known.
      const step = (name: string) => {
        if (process.platform === "win32") console.warn(`mcp-sdk step: ${name}`);
      };
      const mcp = client();
      const callTool = mcp.callTool.bind(mcp);
      mcp.callTool = ((params, ...rest) => {
        step(`callTool ${params.name}`);
        return callTool(params, ...rest);
      }) as typeof mcp.callTool;
      step("connect");
      await mcp.connect(transport);
      try {
        step("listTools");
        const { tools } = await mcp.listTools();
        expect(tools.map((tool) => tool.name)).toEqual([
          "note",
          "find",
          "brief",
          "wake",
          "retract",
        ]);

        const noted = await mcp.callTool({
          name: "note",
          arguments: { text: "the round trip reached the store", idempotencyKey: "rt-1" },
        });
        expect(noted.isError).toBe(false);
        const memoryId = (noted.structuredContent as { memoryId: string }).memoryId;
        expect(typeof memoryId).toBe("string");

        const again = await mcp.callTool({
          name: "note",
          arguments: { text: "the round trip reached the store", idempotencyKey: "rt-1" },
        });
        expect((again.structuredContent as { memoryId: string }).memoryId).toBe(memoryId);

        const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
          (result.content as { type: string; text: string }[])[0]?.text ?? "";
        const found = await mcp.callTool({ name: "find", arguments: { query: "round trip" } });
        expect(text(found)).toContain(`id="${memoryId}"`);
        const brief = await mcp.callTool({ name: "brief", arguments: { topic: "store" } });
        expect(text(brief)).toStartWith("<brief>");
        const wake = await mcp.callTool({ name: "wake", arguments: { budget: 2000 } });
        expect(text(wake)).toContain(memoryId);

        const refused = await mcp.callTool({ name: "note", arguments: { text: "a\nb" } });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toBe("refused: guard (multi-line)");

        const retracted = await mcp.callTool({ name: "retract", arguments: { memoryId } });
        expect(retracted.isError).toBe(false);
        const after = await mcp.callTool({ name: "find", arguments: { query: "round trip" } });
        expect(text(after)).toBe("<find>\n</find>");

        await expect(
          mcp.callTool({ name: "note", arguments: { text: "x", scope: "y" } }),
        ).rejects.toThrow();
      } finally {
        step("close");
        await mcp.close();
        step("closed");
      }
      expect(ok(box, ["recall", "--retracted"]).memories).toHaveLength(1);
      expect(stderr).not.toContain("{");
    },
    60_000,
  );

  test("negative control: the client rejects a server that leaves resultType out", async () => {
    const mcp = client();
    await mcp.connect(fakeServer({ DROP_RESULT_TYPE: "1" }));
    try {
      await expect(mcp.listTools()).rejects.toThrow(/resultType/);
    } finally {
      await mcp.close();
    }
  }, 30_000);

  test("positive control: the same fake server with resultType passes", async () => {
    const mcp = client();
    await mcp.connect(fakeServer({}));
    try {
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    } finally {
      await mcp.close();
    }
  }, 30_000);
});
