/**
 * Values a refactor must keep: those persisted or compared across versions (op fingerprints,
 * OptMem ids) and the PowerShell request's encoding.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promoteFingerprint, sha256 } from "../src/ops.js";
import { requestJson } from "../src/sqlite/windows-security.js";

const provenance = { agent: "a", harness: "h", model: "mo", host: "ho", source: "s" } as never;

describe("a promote op's fingerprint is the one 1.0.0-beta.7 stored", () => {
  // Computed by the beta.7 sources (d0b6529) with fields origin/scope for the same values.
  test("for a requested trust and for the default", () => {
    const payload = {
      originId: "m-origin-é",
      revision: 3,
      targetScope: "team:ü",
      principalId: "p-1",
      requestedTrust: "agent",
      provenance,
    } as const;
    expect(promoteFingerprint(payload)).toBe(
      "a2a69b7137b37d1d076d1f5bea548df0cf8ea5dd6fd29c36f52cf10d38d83816",
    );
    expect(promoteFingerprint({ ...payload, requestedTrust: undefined })).toBe(
      "8d292adccca630a73922c02d1a287089613f991ff22ed4448e1fa73d2dd0958f",
    );
    // Negative control: swapping origin and target changes it, so the golden values discriminate.
    expect(
      promoteFingerprint({
        ...payload,
        originId: payload.targetScope,
        targetScope: payload.originId,
      }),
    ).not.toBe("a2a69b7137b37d1d076d1f5bea548df0cf8ea5dd6fd29c36f52cf10d38d83816");
  });
});

describe("ops.sha256 hashes what optmem's own TextEncoder hash did", () => {
  const beta7 = (text: string) =>
    createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");

  test("for ASCII, multi-byte, NUL, astral and lone-surrogate input", () => {
    for (const text of [
      "",
      "scope",
      "team:João",
      "a\0optmem:name\0" + "7",
      "👨‍👩‍👧",
      "lone \ud800 high",
      "lone \udc00 low",
      "pair \ud83d\ude00",
    ]) {
      expect(sha256(text)).toBe(beta7(text));
    }
    // Positive control: a hash of the UTF-16 code units differs, so the comparison can fail.
    expect(createHash("sha256").update("team:João", "utf16le").digest("hex")).not.toBe(
      beta7("team:João"),
    );
  });
});

describe("requestJson", () => {
  // 7-bit only (DEL is ASCII and survives any console code page).
  const ASCII = /^[\x20-\x7f]*$/;

  test("is ASCII and parses back for every code-unit class", () => {
    const values = [
      "\u0080",
      "\u00ff",
      "\u0100",
      "\u2028\u2029",
      "\ufeff",
      "\uffff",
      "😀",
      "\ud83d\ude00x",
      "lone \ud800",
      "lone \udfff",
      "ctl \u0001\u001f\u007f",
      'quote " backslash \\',
      "C:\\Users\\João\\memória",
    ];
    for (const value of values) {
      const text = requestJson({ paths: [value] });
      expect(text).toMatch(ASCII);
      expect(JSON.parse(text)).toEqual({ paths: [value] });
    }
    // A surrogate pair travels as two escapes, which is what JSON (and JavaScriptSerializer) reads.
    expect(requestJson("😀")).toBe('"\\ud83d\\ude00"');
    // Negative control: escaping by code point would emit a 5-digit escape that parses wrongly.
    const byCodePoint = JSON.stringify("😀").replace(
      /[\u{80}-\u{10ffff}]/gu,
      (char) => `\\u${(char.codePointAt(0) as number).toString(16).padStart(4, "0")}`,
    );
    expect(JSON.parse(byCodePoint)).not.toBe("😀");
  });
});
