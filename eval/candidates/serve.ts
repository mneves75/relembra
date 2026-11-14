/**
 * The candidate side of eval/PROTOCOL.md. A candidate implements `CandidateHandler` and calls
 * `serve`, which reads requests from stdin, dispatches them and writes one response line each.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Command, Requests, Results } from "../protocol.js";

type Awaitable<T> = T | Promise<T>;

export interface CandidateHandler {
  reset(args: Requests["reset"]): Awaitable<Results["reset"]>;
  note(args: Requests["note"]): Awaitable<Results["note"]>;
  find(args: Requests["find"]): Awaitable<Results["find"]>;
  brief(args: Requests["brief"]): Awaitable<Results["brief"]>;
  wake(args: Requests["wake"]): Awaitable<Results["wake"]>;
}

const COMMANDS: ReadonlySet<string> = new Set<Command>([
  "reset",
  "note",
  "find",
  "brief",
  "wake",
  "stop",
]);

function errorResponse(id: unknown, code: string, message: string): string {
  return JSON.stringify({
    id: typeof id === "string" ? id : null,
    ok: false,
    error: { code, message },
  });
}

/** Serves requests until `stop` or end of input. */
export async function serve(
  handler: CandidateHandler,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    let request: { id?: unknown; cmd?: unknown; args?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      output.write(`${errorResponse(null, "bad_request", "request is not JSON")}\n`);
      continue;
    }
    const { id, cmd, args } = request;
    if (typeof id !== "string" || typeof cmd !== "string" || !COMMANDS.has(cmd)) {
      output.write(`${errorResponse(id, "bad_request", "unknown command or missing id")}\n`);
      continue;
    }
    if (cmd === "stop") {
      output.write(`${JSON.stringify({ id, ok: true, result: {} })}\n`);
      break;
    }
    try {
      const method = handler[cmd as Exclude<Command, "stop">] as (a: unknown) => Awaitable<unknown>;
      const result = await method.call(handler, args ?? {});
      output.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch (error) {
      output.write(`${errorResponse(id, "internal", String(error))}\n`);
    }
  }
  lines.close();
}
