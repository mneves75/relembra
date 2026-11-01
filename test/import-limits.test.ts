import { describe, expect, test } from "bun:test";
import {
  type ImportError,
  importJsonl,
  importOptmem,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_EVENTS,
  MAX_IMPORT_LINE_BYTES,
  type Principal,
  RELEMBRA_VERSION,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { provenance, SCOPE } from "./support.js";

/**
 * docs/FORMAT.md, "Import limits": a file, a line and an event count are bounded, and each bound
 * is checked before any line is parsed or anything is written.
 */

const importer: Principal = {
  id: "importer",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  owned: [SCOPE],
};

const headerLine = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    export: "relembra",
    format: 1,
    relembra: RELEMBRA_VERSION,
    scopes: [SCOPE],
    ...extra,
  });

const noteLine = (seq: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 1,
    kind: "note",
    seq,
    memoryId: `m-${seq}`,
    scope: SCOPE,
    principalId: "p",
    pinned: false,
    revision: {
      number: 1,
      text: `Fact number ${seq}.`,
      at: 1_000,
      provenance: { ...provenance, trust: "agent", opId: `op-${seq}` },
    },
    ...extra,
  });

/** A header padded with an ignored field to exactly `bytes` UTF-8 bytes, with `pad` as filler. */
function paddedHeader(bytes: number, pad = "x"): string {
  const bare = headerLine({ ignored: "" });
  const room = bytes - Buffer.byteLength(bare);
  const filler = pad.repeat(Math.floor(room / Buffer.byteLength(pad)));
  const line = headerLine({ ignored: filler + "x".repeat(room - Buffer.byteLength(filler)) });
  expect(Buffer.byteLength(line)).toBe(bytes);
  return line;
}

async function refusal(jsonl: string) {
  const store = createMemoryStore();
  const error = (await importJsonl(store, importer, jsonl).catch((e: unknown) => e)) as ImportError;
  expect(await store.events({ scopes: [SCOPE] })).toEqual([]);
  return { reason: error.reason, line: error.line, detail: error.detail };
}

describe("the limits are the documented numbers", () => {
  test("64 MiB a file, 256 KiB a line, 100,000 events", () => {
    expect(MAX_IMPORT_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_IMPORT_LINE_BYTES).toBe(256 * 1024);
    expect(MAX_IMPORT_EVENTS).toBe(100_000);
  });
});

describe("a JSONL import is bounded before any line is parsed", () => {
  test("the reviewer's 4,194,388-byte header with an ignored field is too-large (line 1)", async () => {
    expect(await refusal(`${paddedHeader(4_194_388)}\n${noteLine(1)}\n`)).toEqual({
      reason: "too-large",
      line: 1,
      detail: "line",
    });
  });

  test("an event line one byte over the cap is too-large at its line", async () => {
    const big = noteLine(2, { ignored: "y".repeat(MAX_IMPORT_LINE_BYTES) });
    expect(await refusal(`${headerLine()}\n${noteLine(1)}\n${big}\n`)).toEqual({
      reason: "too-large",
      line: 3,
      detail: "line",
    });
  });

  test("the cap counts UTF-8 bytes, not UTF-16 code units", async () => {
    // Two bytes per "é": under the cap in code units, over it in bytes.
    const line = paddedHeader(MAX_IMPORT_LINE_BYTES + 2, "é");
    expect(line.length).toBeLessThanOrEqual(MAX_IMPORT_LINE_BYTES);
    expect(await refusal(`${line}\n`)).toEqual({ reason: "too-large", line: 1, detail: "line" });
  });

  test("more than 100,000 events is too-large at the first line past the cap, unparsed", async () => {
    // "{}" is no event: a parse would refuse it as malformed, so too-large proves no line was read.
    const lines = [headerLine(), ...Array.from({ length: MAX_IMPORT_EVENTS + 1 }, () => "{}")];
    expect(await refusal(`${lines.join("\n")}\n`)).toEqual({
      reason: "too-large",
      line: MAX_IMPORT_EVENTS + 2,
      detail: "events",
    });
  });

  test("positive control: exactly 100,000 event lines pass the count, and the parse goes on", async () => {
    const lines = [headerLine(), ...Array.from({ length: MAX_IMPORT_EVENTS }, () => "{}")];
    expect(await refusal(`${lines.join("\n")}\n`)).toEqual({
      reason: "malformed",
      line: 2,
      detail: undefined,
    });
  });

  test("a file over 64 MiB is too-large (line 0), though every line is under its cap", async () => {
    const line = noteLine(1, { ignored: "z".repeat(MAX_IMPORT_LINE_BYTES - 1024) });
    const count = Math.ceil(MAX_IMPORT_BYTES / (line.length + 1)) + 1;
    const jsonl = `${headerLine()}\n${`${line}\n`.repeat(count)}`;
    expect(jsonl.length).toBeGreaterThan(MAX_IMPORT_BYTES);
    expect(await refusal(jsonl)).toEqual({ reason: "too-large", line: 0, detail: "file" });
  });

  test("positive control: a header of exactly 256 KiB with an unknown field imports", async () => {
    const jsonl = `${paddedHeader(MAX_IMPORT_LINE_BYTES)}\n${noteLine(1)}\n${noteLine(2)}\n`;
    expect(await importJsonl(createMemoryStore(), importer, jsonl)).toEqual({
      imported: 2,
      skipped: 0,
      refused: [],
    });
  });
});

describe("an OptMem import is bounded too", () => {
  const input = (log: Uint8Array) => ({
    scope: SCOPE,
    store: "fixture",
    log,
    clock: { now: () => 1_700_000_000_000 },
    provenance: { agent: "importer", harness: "optmem", model: "none", host: "test-host" },
  });
  const records = (count: number) => new TextEncoder().encode("a\n".repeat(count));

  async function optmemRefusal(log: Uint8Array) {
    const store = createMemoryStore();
    const error = (await importOptmem(store, importer, input(log)).catch(
      (e: unknown) => e,
    )) as ImportError;
    expect(await store.events({ scopes: [SCOPE] })).toEqual([]);
    return { reason: error.reason, line: error.line, detail: error.detail };
  }

  test("a log over 64 MiB is too-large (line 0)", async () => {
    expect(await optmemRefusal(new Uint8Array(MAX_IMPORT_BYTES + 1))).toEqual({
      reason: "too-large",
      line: 0,
      detail: "file",
    });
  });

  test("more than 100,000 records is too-large at the first record past the cap", async () => {
    expect(await optmemRefusal(records(MAX_IMPORT_EVENTS + 1))).toEqual({
      reason: "too-large",
      line: MAX_IMPORT_EVENTS + 1,
      detail: "records",
    });
  });

  test("positive control: 1,000 records import", async () => {
    expect(await importOptmem(createMemoryStore(), importer, input(records(1_000)))).toMatchObject({
      imported: 1_000,
    });
  });
});
