import { describe, expect, test } from "bun:test";
import { type Frame, LineSplitter, MAX_MESSAGE_BYTES } from "../src/cli/mcp-lines.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const lines = (frames: readonly Frame[]) =>
  frames.map((frame) => (frame.kind === "line" ? frame.text : `<${frame.kind}>`));

describe("the stdio framer splits newline-delimited messages by bytes", () => {
  test("one message per line, the newline excluded", () => {
    const splitter = new LineSplitter(64);
    expect(lines(splitter.push(bytes('{"a":1}\n{"b":2}\n')))).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.end()).toEqual({ partialBytes: 0 });
  });

  test("a message split across chunks, inside a multi-byte character, is joined", () => {
    const splitter = new LineSplitter(64);
    const all = bytes('{"t":"é"}\n');
    const cut = all.indexOf(0xc3) + 1; // between the two bytes of é
    expect(splitter.push(all.subarray(0, cut))).toEqual([]);
    expect(lines(splitter.push(all.subarray(cut)))).toEqual(['{"t":"é"}']);
  });

  test("a trailing carriage return is dropped; nothing else is changed", () => {
    const splitter = new LineSplitter(64);
    expect(lines(splitter.push(bytes(' {"a":1}\r\n\n')))).toEqual([' {"a":1}', ""]);
  });

  test("ill-formed UTF-8 is reported, never decoded with replacement characters", () => {
    const splitter = new LineSplitter(64);
    const bad = new Uint8Array([0x7b, 0xff, 0x7d, 0x0a, ...bytes('{"ok":1}\n')]);
    expect(lines(splitter.push(bad))).toEqual(["<ill-formed>", '{"ok":1}']);
  });

  test("a line of exactly the cap is kept; one byte more is oversized, and the next line is read", () => {
    const splitter = new LineSplitter(8);
    expect(lines(splitter.push(bytes("12345678\n")))).toEqual(["12345678"]);
    expect(lines(splitter.push(bytes("123456789\nok\n")))).toEqual(["<oversized>", "ok"]);
  });

  test("an oversized line is discarded as it streams, across chunks, and reported once", () => {
    const splitter = new LineSplitter(8);
    const frames = [
      ...splitter.push(bytes("1234")),
      ...splitter.push(bytes("56789")),
      ...splitter.push(bytes("x".repeat(1000))),
      ...splitter.push(bytes("x\nnext\n")),
    ];
    expect(lines(frames)).toEqual(["<oversized>", "next"]);
    // Nothing of the discarded line is held: the splitter reports no partial at the end.
    expect(splitter.end()).toEqual({ partialBytes: 0 });
  });

  test("an unterminated final line is not a message: end() reports its bytes and drops them", () => {
    const splitter = new LineSplitter(64);
    expect(lines(splitter.push(bytes('{"a":1}\n{"b":')))).toEqual(['{"a":1}']);
    expect(splitter.end()).toEqual({ partialBytes: 5 });
    // Positive control: the same bytes with a newline are a message.
    const control = new LineSplitter(64);
    expect(lines(control.push(bytes('{"a":1}\n{"b":\n')))).toEqual(['{"a":1}', '{"b":']);
  });

  test("the cap is 1 MiB", () => {
    expect(MAX_MESSAGE_BYTES).toBe(1_048_576);
  });
});
