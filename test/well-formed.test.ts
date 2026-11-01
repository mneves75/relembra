/**
 * Strings that name things (scopes, principal ids, memory ids, fence keys) must be well-formed
 * UTF-16. A lone surrogate becomes U+FFFD once encoded as UTF-8, so two different strings would
 * name the same scope, id or key in a store, a hash or a file.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  advanceFence,
  createRelembra,
  exportJsonl,
  GuardError,
  IllFormedStringError,
  ImportError,
  importJsonl,
  importOptmem,
  type Principal,
  ProvenanceError,
  RELEMBRA_VERSION,
  type Store,
} from "relembra";
import { openSqliteStore, type SqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { tempDir } from "./sqlite-support.js";
import { provenance, SCOPE } from "./support.js";

const LONE_A = "probe/\ud800";
const LONE_B = "probe/\ud801";
const record = (text: string) => Buffer.from(`${text.padEnd(99, " ")}\n`);
const optmemInput = (scope: string) => ({
  scope,
  store: "fixture",
  log: record("2026-01-23 One fact."),
  clock: { now: () => 1_700_000_000_000 },
  provenance: { agent: "a", harness: "h", model: "m", host: "h" },
});
const owning = (scopes: string[], id = "owner"): Principal => ({
  id,
  readable: scopes,
  writable: scopes,
  promotable: [],
  pinnable: scopes,
  owned: scopes,
  trustCeiling: "owner",
});

function illFormed(error: unknown, field: string) {
  expect(error).toBeInstanceOf(IllFormedStringError);
  expect(error).toMatchObject({ name: "IllFormedStringError", field });
  // The message never echoes the value.
  expect((error as Error).message.isWellFormed()).toBe(true);
}

const caught = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

describe("OptMem imports into scopes that differ only by a lone surrogate", () => {
  for (const kind of ["memory", "sqlite"] as const) {
    test(`${kind} store: refused before anything is read or written`, async () => {
      const dir = tempDir();
      const store: Store =
        kind === "memory"
          ? createMemoryStore()
          : openSqliteStore({ path: join(dir.path, "s", "relembra.db") });
      try {
        const principal = owning([LONE_A, LONE_B]);
        illFormed(await caught(() => importOptmem(store, principal, optmemInput(LONE_A))), "scope");
        illFormed(await caught(() => importOptmem(store, principal, optmemInput(LONE_B))), "scope");
        expect(await store.events({ scopes: [SCOPE] })).toEqual([]);
        // Positive control: two well-formed scopes that differ by one character import apart.
        const a = "probe/\u{1F600}";
        const b = "probe/\u{1F601}";
        const both = owning([a, b]);
        expect(await importOptmem(store, both, optmemInput(a))).toMatchObject({ imported: 1 });
        expect(await importOptmem(store, both, optmemInput(b))).toMatchObject({ imported: 1 });
        expect(await importOptmem(store, both, optmemInput(a))).toMatchObject({ imported: 0 });
      } finally {
        if (kind === "sqlite") await (store as SqliteStore).close();
        dir.remove();
      }
    });
  }
});

describe("the library refuses ill-formed names where they enter", () => {
  const open = (principal: Principal, ids?: { memoryId: () => string; opId: () => string }) =>
    createRelembra<null>({
      store: createMemoryStore(),
      policy: () => principal,
      ...(ids === undefined ? {} : { ids }),
    });

  test("a principal id or a principal's scope from the policy", async () => {
    illFormed(
      await caught(() =>
        open(owning([SCOPE], "p\udc00")).note(null, { scope: SCOPE, text: "A fact.", provenance }),
      ),
      "principal id",
    );
    illFormed(
      await caught(() =>
        open(owning([LONE_A])).note(null, { scope: LONE_A, text: "A fact.", provenance }),
      ),
      "scope",
    );
    illFormed(await caught(() => open(owning([LONE_A])).recall(null)), "scope");
    // Positive control: non-ASCII, well-formed names work.
    const memory = await open(owning(["probe/é😀"], "pé")).note(null, {
      scope: "probe/é😀",
      text: "A fact.",
      provenance,
    });
    expect(memory.scope).toBe("probe/é😀");
  });

  test("a memory id given by the caller or by the Ids port", async () => {
    const relembra = open(owning([SCOPE]));
    for (const call of [
      () => relembra.zoom(null, { memoryId: "m\ud800" }),
      () => relembra.retract(null, { memoryId: "m\ud800" }),
      () => relembra.redact(null, { memoryId: "m\ud800" }),
      () => relembra.supersede(null, { memoryId: "m\ud800", text: "New.", provenance }),
      () =>
        relembra.submitSummary(null, {
          scope: SCOPE,
          sources: [{ memoryId: "m\ud800", revision: 1 }],
          text: "A summary.",
          provenance,
        }),
    ]) {
      illFormed(await caught(call), "memory id");
    }
    const minting = open(owning([SCOPE]), { memoryId: () => "id\ud800", opId: () => "op" });
    illFormed(
      await caught(() => minting.note(null, { scope: SCOPE, text: "A fact.", provenance })),
      "memory id",
    );
    // Positive control: a well-formed id that does not exist is simply not found.
    await expect(relembra.zoom(null, { memoryId: "mé" })).rejects.toMatchObject({
      name: "MemoryNotFoundError",
    });
  });

  test("a retention scope and a fence key", async () => {
    illFormed(
      await caught(async () =>
        createRelembra({
          store: createMemoryStore(),
          policy: () => owning([SCOPE]),
          retention: [{ scope: LONE_A, maxAgeDays: 1 }],
        }),
      ),
      "scope",
    );
    illFormed(
      await caught(() => advanceFence(createMemoryStore(), { key: "k\ud800", epoch: 1 })),
      "fence key",
    );
    await advanceFence(createMemoryStore(), { key: "ké", epoch: 1 });
  });

  test("text and provenance go through the guard, which refuses a lone surrogate", async () => {
    const relembra = open(owning([SCOPE]));
    await expect(
      relembra.note(null, { scope: SCOPE, text: "A fact \ud800.", provenance }),
    ).rejects.toMatchObject({ name: "GuardError", rule: "ill-formed" });
    const error = await caught(() =>
      relembra.note(null, {
        scope: SCOPE,
        text: "A fact.",
        provenance: { ...provenance, source: "s\ud800" },
      }),
    );
    expect(error).toBeInstanceOf(ProvenanceError);
    expect(error).toMatchObject({ field: "source", rule: "ill-formed" });
    expect(GuardError).toBeDefined();
  });
});

describe("transfers refuse ill-formed names", () => {
  const header = (scopes: string[]) =>
    `${JSON.stringify({ export: "relembra", format: 1, relembra: RELEMBRA_VERSION, scopes })}\n`;

  test("in the file: a header scope or an event's memory id, written as JSON escapes", async () => {
    const store = createMemoryStore();
    const badScope = header([LONE_A]);
    expect(badScope).toContain("\\ud800");
    await expect(importJsonl(store, owning([SCOPE]), badScope)).rejects.toMatchObject({
      reason: "malformed",
      line: 1,
    });
    const event = {
      format: 1,
      kind: "note",
      seq: 1,
      memoryId: "m\ud800",
      scope: SCOPE,
      principalId: "x",
      pinned: false,
      revision: {
        number: 1,
        text: "A fact.",
        at: 1,
        provenance: { ...provenance, trust: "agent", opId: "op" },
      },
    };
    const badId = `${header([SCOPE])}${JSON.stringify(event)}\n`;
    const error = await importJsonl(store, owning([SCOPE]), badId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ reason: "malformed", line: 2 });
    // Positive control: the same line with a well-formed id imports.
    const good = `${header([SCOPE])}${JSON.stringify({ ...event, memoryId: "mé" })}\n`;
    expect(await importJsonl(store, owning([SCOPE]), good)).toMatchObject({ imported: 1 });
  });

  test("in the principal given to an export or an import", async () => {
    const store = createMemoryStore();
    illFormed(await caught(() => exportJsonl(store, owning([LONE_A]))), "scope");
    illFormed(
      await caught(() => importJsonl(store, owning([SCOPE], "p\ud800"), header([SCOPE]))),
      "principal id",
    );
  });
});
