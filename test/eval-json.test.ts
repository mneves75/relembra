import { describe, expect, test } from "bun:test";
import { scanJson } from "../eval/json.js";

describe("scanJson", () => {
  test("a response without repeated keys passes, and every key and string value is kept", () => {
    const text = JSON.stringify({
      id: "r1",
      ok: true,
      result: { results: [{ id: "a", text: 'say "hi"\n\\', trust: "agent" }], n: 3, x: null },
    });
    expect(scanJson(text)).toEqual({
      duplicate: false,
      strings: [
        "id",
        "r1",
        "ok",
        "result",
        "results",
        "id",
        "a",
        "text",
        'say "hi"\n\\',
        "trust",
        "agent",
        "n",
        "x",
      ],
    });
  });

  test("the same key in sibling objects or at another depth is no duplicate", () => {
    expect(scanJson('[{"text":"a"},{"text":"b"}]').duplicate).toBe(false);
    expect(scanJson('{"text":{"text":"a"},"t":[{"text":1}]}').duplicate).toBe(false);
    expect(scanJson('{"a":"text","text":"a"}').duplicate).toBe(false);
  });

  test("a key repeated in one object is a duplicate at any depth, and both values are kept", () => {
    const top = scanJson('{"ok":"hidden","ok":true}');
    expect(top.duplicate).toBe(true);
    expect(top.strings).toContain("hidden");
    expect(scanJson('{"r":[{"text":"hidden","id":"a","text":"shown"}]}')).toEqual({
      duplicate: true,
      strings: ["r", "text", "hidden", "id", "a", "text", "shown"],
    });
    // After a nested object closes, the outer object's keys are still compared.
    expect(scanJson('{"a":{"b":1},"a":2}').duplicate).toBe(true);
  });

  test("keys are compared decoded: an escaped spelling of a key repeats it", () => {
    expect(scanJson('{"text":"a","te\\u0078t":"b"}').duplicate).toBe(true);
    expect(scanJson('{"text":"a","te\\"xt":"b"}').duplicate).toBe(false);
  });
});
