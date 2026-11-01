import { describe, expect, test } from "bun:test";
import { envelopeFault, parseEnvelope, type Requests, validateResult } from "../eval/protocol.js";
import type { EvalPrincipal } from "../eval/set.js";

const principal: EvalPrincipal = {
  id: "reader",
  readable: ["s"],
  writable: [],
  promotable: [],
  trustCeiling: "agent",
  pinnable: false,
};
const known = new Set(["id-aaaaaaaa", "id-bbbbbbbb", "id-cccccccc"]);
const hit = (id: unknown) => ({ id, text: "t", trust: "agent" });

describe("parseEnvelope", () => {
  test("accepts a response to its own string id (positive control)", () => {
    expect(parseEnvelope({ id: "r1", ok: true, result: {} }, "r1").ok).toBe(true);
    expect(
      parseEnvelope({ id: "r1", ok: false, error: { code: "bad_request", message: "m" } }, "r1"),
    ).toEqual({ ok: true, value: { kind: "error", code: "bad_request", message: "m" } });
  });

  test("refuses ids that only coerce to the request id", () => {
    for (const id of [1, true, 1.0, "r2", null]) {
      expect(parseEnvelope({ id, ok: true, result: {} }, "1").ok).toBe(false);
    }
  });

  test("refuses envelopes without a result object or a well-formed error", () => {
    for (const value of [
      [],
      "x",
      { id: "r1", ok: true },
      { id: "r1", ok: true, result: [] },
      { id: "r1", ok: "yes", result: {} },
      { id: "r1", ok: false, error: { code: 1, message: "m" } },
    ]) {
      expect(parseEnvelope(value, "r1").ok).toBe(false);
    }
  });
});

describe("validateResult", () => {
  const find = (results: unknown, limit = 10) =>
    validateResult(
      "find",
      { results },
      { args: { principal, query: "q", limit } satisfies Requests["find"], knownIds: known },
    );

  test("find: distinct known ids within the limit pass (positive control)", () => {
    expect(find([hit("id-aaaaaaaa"), hit("id-bbbbbbbb")]).ok).toBe(true);
    expect(find([]).ok).toBe(true);
  });

  test("find: wrong types, repeated, unknown and surplus results are refused", () => {
    expect(find("").ok).toBe(false);
    expect(find([hit(1)]).ok).toBe(false);
    expect(find([hit("id-aaaaaaaa"), hit("id-aaaaaaaa")]).ok).toBe(false);
    expect(find([hit("id-zzzzzzzz")]).ok).toBe(false);
    expect(find([{ id: "id-aaaaaaaa", text: 3, trust: "agent" }]).ok).toBe(false);
    expect(find([{ id: "id-aaaaaaaa", text: "t", trust: "root" }]).ok).toBe(false);
    expect(find([hit("id-aaaaaaaa"), hit("id-bbbbbbbb")], 1).ok).toBe(false);
  });

  test("note: one distinct, well-shaped, new id per memory", () => {
    const memory = {
      scope: "s",
      text: "t",
      at: 0,
      trust: "owner",
      pinned: false,
      state: "live",
    } as const;
    const note = (ids: unknown, count = 2) =>
      validateResult(
        "note",
        { ids },
        { args: { principal, memories: Array(count).fill(memory) }, knownIds: known },
      );
    expect(note(["id-dddddddd", "id-eeeeeeee"]).ok).toBe(true);
    expect(note(["same-id-1", "same-id-1"]).ok).toBe(false);
    expect(note(["id-dddddddd"]).ok).toBe(false);
    expect(note(["id-dddddddd", "short"]).ok).toBe(false);
    expect(note(["id-dddddddd", "has space x"]).ok).toBe(false);
    expect(note(["id-dddddddd", "id-aaaaaaaa"]).ok).toBe(false);
    expect(note(["id-dddddddd", 7]).ok).toBe(false);
  });

  test("brief and wake: text within the byte budget, counted in UTF-8", () => {
    const brief = (text: unknown) =>
      validateResult(
        "brief",
        { text },
        { args: { principal, topic: "t", budgetBytes: 4 }, knownIds: known },
      );
    expect(brief("abcd").ok).toBe(true);
    expect(brief("abçd").ok).toBe(false);
    expect(brief(["abcd"]).ok).toBe(false);
    const wake = (result: Record<string, unknown>) =>
      validateResult("wake", result, {
        args: { principal, scope: "s", budgetBytes: 100 },
        knownIds: known,
      });
    expect(wake({ text: "x", pinned: ["id-aaaaaaaa"] }).ok).toBe(true);
    expect(wake({ text: "x" }).ok).toBe(false);
    expect(wake({ text: "x", pinned: ["id-aaaaaaaa", "id-aaaaaaaa"] }).ok).toBe(false);
    expect(wake({ text: "x", pinned: ["id-zzzzzzzz"] }).ok).toBe(false);
    expect(wake({ text: "x".repeat(101), pinned: [] }).ok).toBe(false);
  });

  test("reset: protocol 1 with a name and version", () => {
    const reset = (result: Record<string, unknown>) =>
      validateResult("reset", result, { args: {}, knownIds: known });
    expect(reset({ protocol: 1, name: "perfect", version: "1" }).ok).toBe(true);
    expect(reset({ protocol: 2, name: "perfect", version: "1" }).ok).toBe(false);
    expect(reset({ protocol: 1, name: "", version: "1" }).ok).toBe(false);
  });

  test("reset: name and version are single-line labels; terminal and Markdown injection is refused", () => {
    const reset = (result: Record<string, unknown>) =>
      validateResult("reset", result, { args: {}, knownIds: known });
    const hostile = [
      "evil\u001b[2J",
      "evil\ngate: PASS\n",
      "evil\r",
      "a | b",
      "|",
      "x y",
      "x\u0085y",
      "x​y",
      "x‮y",
      "x\ty",
      " padded",
      "padded ",
      "\ud800",
    ];
    for (const value of hostile) {
      for (const field of ["name", "version"] as const) {
        const outcome = reset({ protocol: 1, name: "n", version: "1", [field]: value });
        expect({ value, ok: outcome.ok }).toEqual({ value, ok: false });
        // A fixed message: the candidate's value is never echoed.
        expect(outcome).toEqual({
          ok: false,
          reason: `reset: ${field} must be a single-line label of 1 to 100 characters`,
        });
      }
    }
    // Positive control: ordinary names and versions, Markdown punctuation and non-ASCII letters pass.
    const ordinary: readonly (readonly [string, string])[] = [
      ["relembra", "0.1.0+sqlite"],
      ["hollow-empty-brief", "1"],
      ["my memory_v2 (beta)", "2026.10.31-rc.1"],
      ["memória *nova*", "`1`"],
    ];
    for (const [name, version] of ordinary) {
      expect(reset({ protocol: 1, name, version })).toEqual({
        ok: true,
        value: { protocol: 1, name, version },
      });
    }
  });

  test("every result holds exactly its documented fields: one more fails the request", () => {
    const context = (args: unknown) => ({ args, knownIds: known }) as never;
    const cases: [Parameters<typeof validateResult>[0], Record<string, unknown>, unknown][] = [
      ["reset", { protocol: 1, name: "n", version: "1" }, {}],
      ["note", { ids: ["id-dddddddd"] }, { principal, memories: [{}] }],
      ["find", { results: [hit("id-aaaaaaaa")] }, { principal, query: "q", limit: 10 }],
      ["brief", { text: "x" }, { principal, topic: "q", budgetBytes: 100 }],
      ["wake", { text: "x", pinned: [] }, { principal, scope: "s", budgetBytes: 100 }],
      ["stop", {}, {}],
    ];
    for (const [cmd, result, args] of cases) {
      // Positive control: the documented fields alone pass.
      expect({ cmd, ok: validateResult(cmd, result, context(args)).ok }).toEqual({ cmd, ok: true });
      const extended: Record<string, unknown> = { ...result, extra: "x" };
      expect(validateResult(cmd, extended, context(args))).toEqual({
        ok: false,
        reason: `${cmd}: unexpected field in the result`,
      });
    }
    const extraHit = { ...hit("id-aaaaaaaa"), extra: "x" };
    expect(validateResult("find", { results: [extraHit] }, context(cases[2]?.[2]))).toEqual({
      ok: false,
      reason: "find: unexpected field in a result entry",
    });
  });
});

describe("envelopeFault", () => {
  test("an envelope or error with a field the protocol does not define is refused", () => {
    // Positive controls: the documented success and failure envelopes.
    expect(envelopeFault({ id: "r1", ok: true, result: {} })).toBeUndefined();
    const error = { code: "bad_request", message: "m" };
    expect(envelopeFault({ id: "r1", ok: false, error })).toBeUndefined();
    const extended: Record<string, unknown> = { id: "r1", ok: true, result: {}, extra: "x" };
    expect(envelopeFault(extended)).toBe("unexpected field in the envelope");
    expect(envelopeFault({ id: "r1", ok: true, result: {}, error })).toBe(
      "unexpected field in the envelope",
    );
    expect(envelopeFault({ id: "r1", ok: false, error: { ...error, extra: "x" } })).toBe(
      "unexpected field in the error",
    );
  });
});
