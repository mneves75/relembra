import { describe, expect, test } from "bun:test";
import {
  createRelembra,
  exportJsonl,
  IdentifierError,
  type ImportError,
  importJsonl,
  importOptmem,
  type Principal,
  RELEMBRA_VERSION,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { provenance, SCOPE } from "./support.js";

/**
 * docs/FORMAT.md, "Import of an export": every identifier a file carries (memory ids, `by`,
 * sources, scopes, principal ids, the header's version) goes through the guard's rules within its
 * byte cap, as memory text does, and a refusal is `malformed` with detail `<field>:<rule>`.
 */

const ESC = "\u001b[31m";
const BIDI = "\u202e";
const ZERO_WIDTH = "\u200b";
/** Synthetic: the shape of a GitHub token, never a real one. */
const CREDENTIAL = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;

const HOSTILE: readonly [string, string, string][] = [
  ["ESC", `m-${ESC}x`, "control-character"],
  ["bidi", `m-${BIDI}x`, "bidi-character"],
  ["zero-width", `m-${ZERO_WIDTH}x`, "zero-width-character"],
  ["credential", CREDENTIAL, "credential"],
];

function owning(...scopes: string[]): Principal {
  return {
    id: "importer",
    readable: scopes,
    writable: scopes,
    promotable: [],
    owned: scopes,
  };
}

function crafted(
  scopes: string[],
  events: Record<string, unknown>[],
  header: Record<string, unknown> = {},
): string {
  const head = { export: "relembra", format: 1, relembra: RELEMBRA_VERSION, scopes, ...header };
  const numbered = events.map((event, index) => ({ format: 1, seq: index + 1, ...event }));
  return [head, ...numbered].map((line) => `${JSON.stringify(line)}\n`).join("");
}

const revision = (text: string) => ({
  number: 1,
  text,
  at: 1_000,
  provenance: { ...provenance, trust: "agent", opId: `op-${text.length}` },
});

const note = (memoryId: string, scope = SCOPE, text = "A clean fact.") => ({
  kind: "note",
  memoryId,
  scope,
  principalId: "p",
  pinned: false,
  revision: revision(text),
});

/** Imports `jsonl` into an empty store; the refusal, and proof that nothing was written. */
async function refusal(jsonl: string, principal: Principal = owning(SCOPE)) {
  const store = createMemoryStore();
  const error = (await importJsonl(store, principal, jsonl).catch(
    (e: unknown) => e,
  )) as ImportError;
  expect(await store.events({ scopes: [...principal.writable] })).toEqual([]);
  return { reason: error.reason, line: error.line, detail: error.detail };
}

describe("an imported identifier goes through the guard's rules", () => {
  for (const [name, id, rule] of HOSTILE) {
    test(`a note's memoryId with ${name} is malformed (memoryId:${rule}), writing nothing`, async () => {
      expect(await refusal(crafted([SCOPE], [note(id)]))).toEqual({
        reason: "malformed",
        line: 2,
        detail: `memoryId:${rule}`,
      });
    });

    test(`a supersede's by with ${name} is malformed (by:${rule})`, async () => {
      const supersede = {
        kind: "supersede",
        memoryId: "a",
        scope: SCOPE,
        principalId: "p",
        by: id,
      };
      expect(await refusal(crafted([SCOPE], [note("a"), supersede]))).toEqual({
        reason: "malformed",
        line: 3,
        detail: `by:${rule}`,
      });
    });

    test(`a summary source with ${name} is malformed (sources:${rule})`, async () => {
      const summary = {
        kind: "summarize",
        memoryId: "s",
        scope: SCOPE,
        principalId: "p",
        sources: [{ memoryId: id, revision: 1 }],
        revision: revision("A summary."),
      };
      expect(await refusal(crafted([SCOPE], [note("a"), summary]))).toEqual({
        reason: "malformed",
        line: 3,
        detail: `sources:${rule}`,
      });
    });

    test(`a principalId with ${name} is malformed (principalId:${rule}), on a note and a redact`, async () => {
      expect(await refusal(crafted([SCOPE], [{ ...note("a"), principalId: id }]))).toEqual({
        reason: "malformed",
        line: 2,
        detail: `principalId:${rule}`,
      });
      const redact = { kind: "redact", memoryId: "a", scope: SCOPE, cause: "request" };
      expect(await refusal(crafted([SCOPE], [note("a"), { ...redact, principalId: id }]))).toEqual({
        reason: "malformed",
        line: 3,
        detail: `principalId:${rule}`,
      });
    });

    test(`a header scope with ${name} is malformed (scope:${rule}), before ownership is checked`, async () => {
      const scope = `dev/${id}`;
      expect(await refusal(crafted([SCOPE, scope], [note("a", scope)]))).toEqual({
        reason: "malformed",
        line: 1,
        detail: `scope:${rule}`,
      });
    });

    test(`a principal owning a scope with ${name} is refused by the core rule (IdentifierError)`, async () => {
      const scope = `dev/${id}`;
      const store = createMemoryStore();
      const error = await importJsonl(
        store,
        owning(scope),
        crafted([scope], [note("a", scope)]),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdentifierError);
      expect({
        field: (error as IdentifierError).field,
        rule: (error as IdentifierError).rule as string,
      }).toEqual({
        field: "scope",
        rule,
      });
      expect(await store.events({ scopes: [scope] })).toEqual([]);
    });

    test(`the header's relembra version with ${name} is malformed (relembra:${rule})`, async () => {
      expect(await refusal(crafted([SCOPE], [note("a")], { relembra: id }))).toEqual({
        reason: "malformed",
        line: 1,
        detail: `relembra:${rule}`,
      });
    });
  }

  test("a blank identifier is malformed (memoryId:blank)", async () => {
    expect(await refusal(crafted([SCOPE], [note("   ")]))).toEqual({
      reason: "malformed",
      line: 2,
      detail: "memoryId:blank",
    });
  });

  test("a principalId over 256 UTF-8 bytes is malformed (principalId:too-long); 256 imports", async () => {
    expect(
      await refusal(crafted([SCOPE], [{ ...note("a"), principalId: "p".repeat(257) }])),
    ).toEqual({ reason: "malformed", line: 2, detail: "principalId:too-long" });
    const store = createMemoryStore();
    expect(
      await importJsonl(
        store,
        owning(SCOPE),
        crafted([SCOPE], [{ ...note("a"), principalId: "p".repeat(256) }]),
      ),
    ).toMatchObject({ imported: 1 });
  });

  test("a provenance field with ESC is refused as provenance (agent:control-character)", async () => {
    const bad = note("a");
    const event = {
      ...bad,
      revision: { ...bad.revision, provenance: { ...bad.revision.provenance, agent: `a${ESC}` } },
    };
    expect(await refusal(crafted([SCOPE], [event]))).toEqual({
      reason: "provenance",
      line: 2,
      detail: "agent:control-character",
    });
  });

  test("positive control: safe ids import, and the wake renders them exactly as the source's", async () => {
    const source = createMemoryStore();
    let n = 0;
    const ids = ["m-1", "550e8400-e29b-41d4-a716-446655440000", "nota-é", "id with spaces"];
    const relembra = (store: typeof source) =>
      createRelembra<undefined>({
        store,
        policy: () => ({ ...owning(SCOPE), id: "owner" }),
        ids: { memoryId: () => ids[n++] ?? `m-${n}`, opId: () => `op-${n}` },
        clock: { now: () => 1_000 + n },
      });
    for (const text of ["First fact.", "Second fact.", "Third 👨‍👩‍👧 fact.", "Fourth 1️⃣ fact."]) {
      await relembra(source).note(undefined, { scope: SCOPE, text, provenance });
    }
    const jsonl = await exportJsonl(source, owning(SCOPE), { scope: SCOPE });
    const target = createMemoryStore();
    expect(await importJsonl(target, owning(SCOPE), jsonl)).toEqual({
      imported: 4,
      skipped: 0,
      refused: [],
    });
    const before = await relembra(source).wake(undefined);
    const after = await relembra(target).wake(undefined);
    expect(after).toEqual(before);
    for (const id of ids) expect(after.text).toContain(`id="${id}"`);
  });
});

describe("an OptMem import's scope goes through the same rule", () => {
  const log = new TextEncoder().encode("A clean record.\n");
  const input = (scope: string) => ({
    scope,
    store: "fixture",
    log,
    clock: { now: () => 1_700_000_000_000 },
    provenance: { agent: "importer", harness: "optmem", model: "none", host: "test-host" },
  });

  for (const [name, id, rule] of HOSTILE) {
    // The scope is the host's argument, not the file's: the core rule refuses it (IdentifierError).
    test(`a scope with ${name} is refused (${rule}), writing nothing`, async () => {
      const scope = `dev/${id}`;
      const store = createMemoryStore();
      const error = await importOptmem(store, owning(scope), input(scope)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdentifierError);
      expect((error as IdentifierError).rule as string).toBe(rule);
      expect((error as Error).message).not.toContain(id);
      expect(await store.events({ scopes: [scope] })).toEqual([]);
    });
  }

  test("positive control: a clean scope imports", async () => {
    expect(await importOptmem(createMemoryStore(), owning(SCOPE), input(SCOPE))).toEqual({
      imported: 1,
      skipped: 0,
      refused: [],
    });
  });
});
