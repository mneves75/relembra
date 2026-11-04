import { expect } from "bun:test";
import { type RunOptions, run, type Sandbox } from "./support.js";

/** Modern first, followed by the initialize-based revisions, newest first. */
export const SUPPORTED_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** The `_meta` every 2026-07-28 request must carry (basic/index, "Per-request protocol fields"). */
export const META = {
  "io.modelcontextprotocol/protocolVersion": SUPPORTED_VERSIONS[0],
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

export type Id = string | number;

/** A handshake-era request: deliberately carries no modern `_meta`. */
export function legacyRequest(id: Id, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

export const initialize = (id: Id, protocolVersion: unknown) =>
  legacyRequest(id, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });

export interface ResponseExpectations {
  /** Only these request ids may return legacy results, without resultType or modern metadata. */
  readonly legacyIds?: readonly Id[];
  /** Only these zero-based stdout lines must be nonempty JSON-RPC response arrays. */
  readonly batchLines?: readonly number[];
}

/** One request line: params get META unless they bring their own `_meta`. */
export function request(id: Id, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: META, ...params } });
}

export const call = (id: Id, name: string, args: Record<string, unknown> = {}) =>
  request(id, "tools/call", { name, arguments: args });

export const notification = (method: string, params?: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });

export interface Response {
  readonly jsonrpc: "2.0";
  readonly id?: Id;
  // biome-ignore lint/suspicious/noExplicitAny: the server's JSON; the assertions check its shape.
  readonly result?: any;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface McpRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Checked JSON-RPC responses, with explicitly expected batch lines flattened in order. */
  readonly responses: readonly Response[];
  /** The response with this id; a test failure when there is none or more than one. */
  byId(id: Id): Response;
}

/**
 * Runs `relembra mcp` in the sandbox with `input` on stdin, which then ends (EOF), and checks
 * the stdio rule on every run: each stdout line is a JSON-RPC response (or an explicitly
 * expected 2025-03-26 batch of responses) and nothing else
 * (basic/transports/stdio: "The server MUST NOT write anything to its stdout that is not a valid
 * MCP message").
 */
export function mcp(
  box: Sandbox,
  input: string | Uint8Array,
  options: RunOptions & ResponseExpectations & { readonly args?: readonly string[] } = {},
): McpRun {
  const result = run(box, ["mcp", ...(options.args ?? [])], { ...options, input });
  const responses = parseResponses(result.stdout, options);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    responses,
    byId(id) {
      const found = responses.filter((r) => "id" in r && r.id === id);
      if (found.length !== 1) {
        throw new Error(`expected one response with id ${JSON.stringify(id)}:\n${result.stdout}`);
      }
      return found[0] as Response;
    },
  };
}

/** Lines of `input`, each ended by a newline. */
export const lines = (...messages: string[]) => messages.map((m) => `${m}\n`).join("");

export function parseResponses(stdout: string, expected: ResponseExpectations = {}): Response[] {
  if (stdout === "") return [];
  expect(stdout.endsWith("\n")).toBe(true);
  const check = (value: unknown): Response => {
    expect(typeof value).toBe("object");
    expect(value).not.toBeNull();
    expect(Array.isArray(value)).toBe(false);
    const message = value as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: { resultType?: unknown };
      error?: { code?: unknown; message?: unknown };
    };
    expect(message.jsonrpc).toBe("2.0");
    expect("method" in message).toBe(false);
    expect("result" in message !== "error" in message).toBe(true);
    if ("id" in message) expect(["string", "number"]).toContain(typeof message.id);
    if (message.error !== undefined) {
      expect(Number.isInteger(message.error.code)).toBe(true);
      expect(typeof message.error.message).toBe("string");
    } else {
      expect(typeof message.result).toBe("object");
      expect(message.result).not.toBeNull();
      if (message.id !== undefined && expected.legacyIds?.includes(message.id as Id)) {
        for (const field of ["resultType", "_meta", "ttlMs", "cacheScope"]) {
          expect(Object.hasOwn(message.result ?? {}, field)).toBe(false);
        }
      } else {
        expect(message.result?.resultType).toBe("complete");
      }
    }
    return message as unknown as Response;
  };
  return stdout
    .slice(0, -1)
    .split("\n")
    .flatMap((line, index) => {
      const message: unknown = JSON.parse(line);
      if (expected.batchLines?.includes(index)) {
        expect(Array.isArray(message)).toBe(true);
        expect((message as unknown[]).length).toBeGreaterThan(0);
        return (message as unknown[]).map(check);
      }
      return [check(message)];
    });
}

/** The text of a tool result's single text block. */
export function toolText(response: Response): string {
  const content = response.result?.content;
  expect(Array.isArray(content)).toBe(true);
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe("text");
  return content[0].text as string;
}
