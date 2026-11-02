import { afterAll, beforeAll, describe, expect } from "bun:test";
import { BINARY, cliTest, ok, refused, run, runStdinOpen, sandbox } from "./support.js";

const box = sandbox();
beforeAll(() => {
  if (BINARY !== "") run(box, ["init"]);
});
afterAll(() => box.remove());

const count = () => ok(box, ["recall", "--limit", "1000"]).memories.length as number;

/** A refused write: the exit code and rule, nothing stored, and the input never echoed. */
function refusedWrite(args: string[], rule: string, input?: string) {
  const before = count();
  const result = refused(box, args, 1, "guard", input === undefined ? {} : { input });
  expect(result.json?.ok === false && result.json.error.rule).toBe(rule);
  expect(count()).toBe(before);
  return result;
}

/**
 * A line break inside an argument. On Windows the command line splits the argument there before
 * relembra reads it, so the write is refused as a usage error (an extra argument), nothing stored
 * (docs/CLI.md#windows); elsewhere the guard refuses it by `rule`.
 */
function refusedLineBreak(args: string[], code: "guard" | "provenance", rule: string) {
  const windows = process.platform === "win32";
  const before = count();
  const result = windows ? refused(box, args, 2, "usage") : refused(box, args, 1, code);
  expect(result.json?.ok === false && result.json.error.rule).toBe(
    windows ? "extra-argument" : rule,
  );
  expect(count()).toBe(before);
}

// Built at run time, so no credential-shaped literal sits in the repository.
const shaped = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

describe("bad input, refused cleanly by the compiled binary", () => {
  cliTest("blank: an empty or whitespace argument, and empty stdin", () => {
    refusedWrite(["note", ""], "blank");
    refusedWrite(["note", "   "], "blank");
    refusedWrite(["note"], "blank", "");
    refusedWrite(["note"], "blank", "\n");
    // Positive control.
    expect(ok(box, ["note", "x"]).memory.revision.text).toBe("x");
  });

  cliTest("exactly 280 bytes is accepted and 281 refused, accented letters costing 2 bytes", () => {
    const accented = "é".repeat(140);
    expect(Buffer.byteLength(accented)).toBe(280);
    expect(ok(box, ["note", accented]).memory.revision.text).toBe(accented);
    refusedWrite(["note", `${accented}a`], "too-long");
    expect(ok(box, ["note", "b".repeat(280)]).memory.id).toBeString();
    refusedWrite(["note", "b".repeat(281)], "too-long");
    // On stdin, one trailing newline is not part of the memory.
    expect(ok(box, ["note"], { input: `${"c".repeat(280)}\n` }).memory.id).toBeString();
    refusedWrite(["note"], "too-long", `${"c".repeat(281)}\n`);
  });

  cliTest("multi-line, from an argument or stdin", () => {
    refusedLineBreak(["note", "first\nsecond"], "guard", "multi-line");
    refusedWrite(["note"], "multi-line", "first\nsecond\n");
    refusedLineBreak(["note", "first\r\nsecond"], "guard", "multi-line");
  });

  cliTest("bidi and zero-width characters", () => {
    refusedWrite(["note", "abc‮def"], "bidi-character");
    refusedWrite(["note", "abc⁦def"], "bidi-character");
    refusedWrite(["note", "ab​cd"], "zero-width-character");
    refusedWrite(["note"], "zero-width-character", "ab﻿cd");
  });

  cliTest("a credential shape is refused and never echoed; a benign mention is accepted", () => {
    const result = refusedWrite(["note", `the token is ${shaped}`], "credential");
    expect(result.stdout).not.toContain(shaped);
    expect(result.stderr).not.toContain(shaped);
    const text = run(box, ["note", `the token is ${shaped}`]);
    expect(text.status).toBe(1);
    expect(text.stderr).toContain("credential");
    expect(text.stderr).not.toContain(shaped);
    expect(ok(box, ["note", "Tokens are read from the keychain."]).memory.id).toBeString();
  });

  cliTest("10 MB on stdin is refused without a crash or a hang", () => {
    const started = Date.now();
    const result = refusedWrite(["note"], "too-long", "a".repeat(10 * 1024 * 1024));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.stderr).toBe("");
    // Positive control: the store still takes a normal write.
    expect(ok(box, ["note"], { input: "after the flood\n" }).memory.id).toBeString();
  });

  cliTest("invalid UTF-8 on stdin is refused as ill-formed", () => {
    const before = count();
    const result = run(box, ["note", "--json"], { input: new Uint8Array([0x61, 0xff, 0x62]) });
    expect(result.status).toBe(1);
    expect(result.json).toEqual({ ok: false, error: { code: "guard", rule: "ill-formed" } });
    expect(count()).toBe(before);
  });

  cliTest("provenance that breaks a guard rule is refused, naming the field", () => {
    refusedLineBreak(
      ["note", "fine text", "--agent", "bad\nagent"],
      "provenance",
      "agent:multi-line",
    );
  });

  cliTest("usage errors exit 2 with the JSON error document", () => {
    for (const args of [
      [],
      ["bogus"],
      ["note", "a", "b"],
      ["note", "text", "--bogus"],
      ["note", "text", "--trust", "root"],
      ["note", "text", "--agent"],
      ["find", "x", "--limit", "0"],
      ["find", "x", "--limit", "1.5"],
      ["find", "x", "--limit", "101"],
      ["recall", "--limit", "abc"],
      ["wake", "--budget", "-1"],
      ["zoom"],
      ["retract"],
      ["retract", "a", "b"],
      ["summarize", "text"],
      ["summarize", "text", "--of", "no-revision"],
      ["summarize", "text", "--of", "id@0"],
      ["check", "extra"],
    ]) {
      const result = run(box, [...args, "--json"]);
      expect({ args, status: result.status }).toEqual({ args, status: 2 });
      expect(result.json?.ok).toBe(false);
    }
    // Text mode: the message goes to stderr, nothing to stdout.
    const text = run(box, ["note", "text", "--bogus"]);
    expect(text.status).toBe(2);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("--bogus");
  });

  cliTest("--help prints the usage and exits 0", () => {
    const result = run(box, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("relembra note");
  });

  cliTest("--help with --json is one JSON document, in either order and after a command", () => {
    for (const args of [
      ["--help", "--json"],
      ["--json", "--help"],
      ["note", "--help", "--json"],
    ]) {
      const result = run(box, args);
      expect({ args, status: result.status }).toEqual({ args, status: 0 });
      expect(result.json?.ok).toBe(true);
      expect(result.json?.ok === true && result.json.data.usage).toContain("relembra note");
    }
  });

  cliTest("a leading byte-order mark on stdin is refused, as it is in an argument", () => {
    refusedWrite(["note", "﻿fine"], "zero-width-character");
    const before = count();
    const result = run(box, ["note", "--json"], {
      input: new Uint8Array([0xef, 0xbb, 0xbf, 0x66, 0x69, 0x6e, 0x65]),
    });
    expect(result.json).toEqual({
      ok: false,
      error: { code: "guard", rule: "zero-width-character" },
    });
    expect(count()).toBe(before);
  });

  cliTest(
    "stdin left open: too much input is refused at once, a stall at the deadline",
    async () => {
      // Sol's repro: 1,000 bytes with stdin never closed blocked until killed.
      const long = await runStdinOpen(box, ["note", "--json"], "a".repeat(1000));
      expect(long.killed).toBe(false);
      expect(long.elapsedMs).toBeLessThan(3_000);
      expect(JSON.parse(long.stdout)).toEqual({
        ok: false,
        error: { code: "guard", rule: "too-long" },
      });
      // A short write that never ends is refused at the input deadline (5 s), not held forever.
      const stalled = await runStdinOpen(box, ["note", "--json"], "short");
      expect(stalled.killed).toBe(false);
      expect(stalled.elapsedMs).toBeLessThan(10_000);
      expect(JSON.parse(stalled.stdout)).toEqual({ ok: false, error: { code: "input-timeout" } });
      // Positive control: 280 bytes and a newline, closed, is a memory.
      expect(ok(box, ["note"], { input: `${"d".repeat(280)}\n` }).memory.id).toBeString();
    },
    30_000,
  );

  cliTest("an id is never confirmed across scopes: another scope's memory is not found", () => {
    const id = ok(box, ["note", "mine"]).memory.id;
    refused(box, ["zoom", id], 1, "not-found", { env: { RELEMBRA_SCOPE: "elsewhere" } });
    refused(box, ["retract", id], 1, "not-found", { env: { RELEMBRA_SCOPE: "elsewhere" } });
    // Positive control: in its own scope it is found.
    expect(ok(box, ["zoom", id]).memory.id).toBe(id);
  });
});
