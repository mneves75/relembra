import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createEmpty } from "../eval/candidates/empty.js";
import { createPerfect } from "../eval/candidates/perfect.js";
import { type CandidateHandler, serve } from "../eval/candidates/serve.js";
import { DEFAULT_SEED, generate } from "../eval/generate.js";

/** Runs `serve` in-process over the given request lines and returns the response lines. */
async function exchange(handler: CandidateHandler, lines: readonly string[]): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  const served = serve(handler, input, output);
  input.end(lines.map((line) => `${line}\n`).join(""));
  await served;
  return written
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

const request = (id: string, cmd: string, args: unknown = {}) =>
  JSON.stringify({ v: 1, id, cmd, args });

describe("serve", () => {
  test("answers each request in order and stops at stop", async () => {
    const responses = await exchange(createEmpty(), [
      request("r1", "reset"),
      request("r2", "find", { query: "x", limit: 10 }),
      request("r3", "stop"),
      request("r4", "reset"),
    ]);
    expect(responses).toEqual([
      { id: "r1", ok: true, result: { protocol: 1, name: "empty", version: "1" } },
      { id: "r2", ok: true, result: { results: [] } },
      { id: "r3", ok: true, result: {} },
    ]);
  });

  test("refuses bad lines and reports a throwing handler, without stopping", async () => {
    const throwing: CandidateHandler = {
      ...createEmpty(),
      find: () => {
        throw new Error("boom");
      },
    };
    const responses = (await exchange(throwing, [
      "not json",
      request("r1", "bogus"),
      JSON.stringify({ cmd: "reset" }),
      request("r2", "find"),
      request("r3", "reset"),
    ])) as { id: unknown; ok: boolean; error?: { code: string } }[];
    expect(responses.map((r) => [r.id, r.ok, r.error?.code])).toEqual([
      [null, false, "bad_request"],
      ["r1", false, "bad_request"],
      [null, false, "bad_request"],
      ["r2", false, "internal"],
      ["r3", true, undefined],
    ]);
  });

  test("the perfect candidate serves a set it was given", async () => {
    const set = generate({ seed: DEFAULT_SEED });
    const responses = (await exchange(createPerfect(set), [request("r1", "reset")])) as {
      result: { name: string };
    }[];
    expect(responses[0]?.result.name).toBe("perfect");
  });
});
