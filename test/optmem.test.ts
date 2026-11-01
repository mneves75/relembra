import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRelembra,
  exportJsonl,
  ImportError,
  importJsonl,
  importOptmem,
  type Memory,
  type Principal,
  ScopeDeniedError,
  type Store,
} from "relembra";
import { openSqliteStore, type SqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { tempDir } from "./sqlite-support.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

/** The memory id of record `n` of OptMem store `name` imported into `scope` (docs/FORMAT.md). */
const idOf = (n: number, name = "fixture", scope = SCOPE) =>
  `om-${createHash("sha256").update(`${scope}\0optmem:${name}\0${n}`).digest("hex").slice(0, 32)}`;

/** The checkpoint key of OptMem store `name` imported into `scope` (docs/FORMAT.md). */
const sourceKey = (scope = SCOPE, name = "fixture") =>
  `optmem:${createHash("sha256").update(scope).digest("hex").slice(0, 16)}:${name}`;

/** The synthetic OptMem store written for this repository: six 100-byte records. */
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "optmem", "memory", "LOG.txt"));
const WIDTH = 100;
const TEXTS = FIXTURE.toString("utf8")
  .split("\n")
  .slice(0, -1)
  .map((record) => record.replace(/ +$/, ""));

const owner: Principal = {
  id: "owner",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  pinnable: [SCOPE],
  owned: [SCOPE],
  trustCeiling: "owner",
};
const reader: Principal = { id: "reader", readable: [SCOPE], writable: [], promotable: [] };

const input = (log: Uint8Array, store = "fixture") => ({
  scope: SCOPE,
  store,
  log,
  clock: { now: () => 1_700_000_000_000 },
  provenance: { agent: "importer", harness: "optmem", model: "none", host: provenance.host },
});

/** A record of the fixture's width holding `text`, padded with spaces. */
function record(text: string): Buffer {
  const bytes = Buffer.from(text);
  return Buffer.concat([bytes, Buffer.alloc(WIDTH - 1 - bytes.length, " "), Buffer.from("\n")]);
}

async function memories(store: Store): Promise<Memory[]> {
  const relembra = createRelembra<Principal>({ store, policy: (p) => p });
  return [...(await relembra.recall(owner, { limit: 1000 }))].reverse();
}

describe("OptMem import", () => {
  test("imports every record of the fixture as one memory, its text byte for byte", async () => {
    const store = createMemoryStore();
    const report = await importOptmem(store, owner, input(FIXTURE));
    expect(report).toEqual({ imported: 6, skipped: 0, refused: [] });

    const imported = await memories(store);
    expect(imported.map((m) => m.id)).toEqual(TEXTS.map((_, i) => idOf(i + 1)));
    expect(imported.map((m) => m.revision.text)).toEqual(TEXTS);
    for (const [i, memory] of imported.entries()) {
      const recordBytes = FIXTURE.subarray(i * WIDTH, (i + 1) * WIDTH - 1);
      expect(
        Buffer.compare(
          Buffer.from(memory.revision.text),
          Buffer.from(recordBytes.toString().trimEnd()),
        ),
      ).toBe(0);
      expect(memory).toMatchObject({
        scope: SCOPE,
        pinned: false,
        status: "live",
        notedAt: 1_700_000_000_000,
      });
      // The owner principal could pin and write owner trust; an import grants neither.
      expect(memory.revision.provenance).toMatchObject({
        trust: "agent",
        source: `optmem:fixture:${i + 1}`,
        opId: memory.id,
      });
    }
    expect(TEXTS[5]).toBe("2026-01-12 Café, naïve and 日本語 must round-trip byte for byte.");
  });

  test("importing the same log again adds nothing", async () => {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(FIXTURE));
    const events = (await store.events({ scopes: [SCOPE] })).length;

    expect(await importOptmem(store, owner, input(FIXTURE))).toEqual({
      imported: 0,
      skipped: 6,
      refused: [],
    });
    expect((await store.events({ scopes: [SCOPE] })).length).toBe(events);
  });

  test("idempotent by source id even without a checkpoint, and a redacted record stays redacted", async () => {
    const first = createMemoryStore();
    await importOptmem(first, owner, input(FIXTURE));
    const relembra = createRelembra<Principal>({ store: first, policy: (p) => p });
    await relembra.redact(owner, { memoryId: idOf(2) });
    // A second store with the same memories and the tombstone, but no checkpoint (exports carry none).
    const second = createMemoryStore();
    await importJsonl(second, owner, await exportJsonl(first, owner, { scope: SCOPE }));

    expect(await importOptmem(second, owner, input(FIXTURE))).toEqual({
      imported: 0,
      skipped: 6,
      refused: [],
    });
    const zoomed = await createRelembra<Principal>({ store: second, policy: (p) => p }).zoom(
      owner,
      {
        memoryId: idOf(2),
      },
    );
    expect(zoomed.status).toBe("redacted");
    // Positive control: a store without those memories imports the record.
    expect(await importOptmem(createMemoryStore(), owner, input(FIXTURE))).toMatchObject({
      imported: 6,
    });
  });

  test("a log that grew since imports only its new records", async () => {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(FIXTURE));
    const grown = Buffer.concat([FIXTURE, record("2026-02-01 A seventh fact, appended later.")]);

    expect(await importOptmem(store, owner, input(grown))).toEqual({
      imported: 1,
      skipped: 6,
      refused: [],
    });
    expect((await memories(store)).at(-1)).toMatchObject({
      id: idOf(7),
      revision: { text: "2026-02-01 A seventh fact, appended later." },
    });
  });

  test("a truncated or modified prefix is refused, writing nothing", async () => {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(FIXTURE));
    const before = await store.events({ scopes: [SCOPE] });
    // Cut to four records, then grown past the old length: as long, but not the same prefix.
    const cutAndRegrown = Buffer.concat([
      FIXTURE.subarray(0, 4 * WIDTH),
      record("2026-03-01 New, after a cut."),
      record("2026-03-02 Another."),
      record("2026-03-03 And a third."),
    ]);
    const modified = Buffer.from(FIXTURE);
    modified.write("X", WIDTH + 11);
    const grownAndModified = Buffer.concat([modified, record("2026-02-01 Looks like growth.")]);

    for (const [log, reason] of [
      [FIXTURE.subarray(0, 4 * WIDTH), "truncated"],
      [cutAndRegrown, "modified"],
      [modified, "modified"],
      [grownAndModified, "modified"],
    ] as const) {
      const refusal = await importOptmem(store, owner, input(log)).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ImportError);
      expect((refusal as ImportError).reason).toBe(reason);
      expect(await store.events({ scopes: [SCOPE] })).toEqual(before);
    }
    // Positive control: the unchanged log is accepted (and adds nothing).
    expect(await importOptmem(store, owner, input(FIXTURE))).toMatchObject({ imported: 0 });
  });

  test("a credential is refused and reported by line, never imported or echoed; the rest imports", async () => {
    const key = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    const log = Buffer.concat([
      FIXTURE.subarray(0, 2 * WIDTH),
      record(`2026-01-06 The token is ${key}`),
      record("2026-01-06 A line with a\ttab."),
      FIXTURE.subarray(2 * WIDTH),
    ]);
    const store = createMemoryStore();
    const report = await importOptmem(store, owner, input(log));

    expect(report).toEqual({
      imported: 6,
      skipped: 0,
      refused: [
        { line: 3, rule: "credential" },
        { line: 4, rule: "control-character" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(key);
    expect(JSON.stringify(await store.events({ scopes: [SCOPE] }))).not.toContain(key);
    expect((await memories(store)).map((m) => m.id)).not.toContain(idOf(3));
    // Positive control: the guard does see the key in the same text.
    expect(JSON.stringify(log.toString())).toContain(key);
    // A second import reports them again (no fingerprint of them is kept) and imports neither.
    expect(await importOptmem(store, owner, input(log))).toEqual({
      imported: 0,
      skipped: 6,
      refused: [
        { line: 3, rule: "credential" },
        { line: 4, rule: "control-character" },
      ],
    });
  });

  test("records a crash left at the end are never written; a damaged record before them is refused", async () => {
    const zeros = Buffer.alloc(WIDTH);
    const cut = Buffer.concat([
      record("2026-01-13 Cut short by a crash.").subarray(0, 40),
      Buffer.alloc(60),
    ]);
    const short = record("2026-01-13 Shorter than a record.").subarray(0, 30);
    for (const tail of [zeros, cut, short]) {
      expect(
        await importOptmem(createMemoryStore(), owner, input(Buffer.concat([FIXTURE, tail]))),
      ).toEqual({
        imported: 6,
        skipped: 0,
        refused: [],
      });
    }
    const damaged = Buffer.concat([FIXTURE.subarray(0, WIDTH), zeros, FIXTURE.subarray(WIDTH)]);
    await expect(importOptmem(createMemoryStore(), owner, input(damaged))).rejects.toMatchObject({
      reason: "not-optmem",
      line: 2,
    });
    const misaligned = Buffer.concat([FIXTURE, Buffer.from("short line\n")]);
    await expect(importOptmem(createMemoryStore(), owner, input(misaligned))).rejects.toMatchObject(
      {
        reason: "not-optmem",
      },
    );
    await expect(
      importOptmem(createMemoryStore(), owner, input(Buffer.from("no newline at all"))),
    ).rejects.toMatchObject({
      reason: "not-optmem",
    });
    expect(await importOptmem(createMemoryStore(), owner, input(new Uint8Array()))).toEqual({
      imported: 0,
      skipped: 0,
      refused: [],
    });
  });

  test("a record that is not UTF-8 is refused by line", async () => {
    const bad = record("2026-01-14 Bytes: XX.");
    bad[18] = 0xff;
    const store = createMemoryStore();
    expect(await importOptmem(store, owner, input(Buffer.concat([FIXTURE, bad])))).toMatchObject({
      imported: 6,
      refused: [{ line: 7, rule: "ill-formed" }],
    });
  });

  test("trust follows a lower ceiling, and a principal that cannot write the scope is refused", async () => {
    const store = createMemoryStore();
    await expect(importOptmem(store, reader, input(FIXTURE))).rejects.toThrow(
      new ScopeDeniedError("own"),
    );
    expect(await store.events({ scopes: [SCOPE] })).toEqual([]);

    await importOptmem(store, { ...owner, trustCeiling: "untrusted" }, input(FIXTURE));
    expect(new Set((await memories(store)).map((m) => m.revision.provenance.trust))).toEqual(
      new Set(["untrusted"]),
    );
  });

  test("two OptMem stores import side by side under their own names", async () => {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(FIXTURE, "one"));
    expect(await importOptmem(store, owner, input(FIXTURE, "two"))).toMatchObject({ imported: 6 });
    await expect(importOptmem(store, owner, input(FIXTURE, "bad name!"))).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("OptMem import time", () => {
  test("a date inside a record never sets the noted time: retention counts from the import", async () => {
    const DAY = 86_400_000;
    const log = Buffer.concat([record("2999-12-31 Dated far in the future by its text.")]);
    const store = createMemoryStore();
    await importOptmem(store, owner, { ...input(log), clock: { now: () => 10 * DAY } });
    const [memory] = await memories(store);
    expect(memory).toMatchObject({ notedAt: 10 * DAY, revision: { at: 10 * DAY } });
    const relembra = createRelembra<Principal>({
      store,
      policy: (p) => p,
      retention: [{ scope: SCOPE, maxAgeDays: 30 }],
    });
    // Positive control: younger than the rule, it stays.
    expect(await relembra.sweep(20 * DAY)).toEqual({ redacted: [], derived: [] });
    expect(await relembra.sweep(41 * DAY)).toEqual({
      redacted: [memory?.id as string],
      derived: [],
    });
  });
});

describe("OptMem imports are kept apart by scope", () => {
  /** Owns and writes OTHER_SCOPE only: it cannot read SCOPE. */
  const outsider: Principal = {
    id: "outsider",
    readable: [OTHER_SCOPE],
    writable: [OTHER_SCOPE],
    promotable: [],
    owned: [OTHER_SCOPE],
  };
  const into = (log: Uint8Array) => ({ ...input(log), scope: OTHER_SCOPE });
  const changedFixture = () => {
    const changed = Buffer.from(FIXTURE);
    changed.write("X", WIDTH + 11);
    return changed;
  };

  test("the same store name in another scope is a fresh import, never compared with the first scope's", async () => {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(FIXTURE));
    // Neither "truncated" nor "modified": the first scope's checkpoint and texts are not consulted.
    expect(await importOptmem(store, outsider, into(FIXTURE.subarray(0, 4 * WIDTH)))).toEqual({
      imported: 4,
      skipped: 0,
      refused: [],
    });
  });

  test("a changed log in the other scope is checked against that scope's own checkpoint only", async () => {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(FIXTURE));
    // Positive control: in its own scope the change is caught.
    await expect(importOptmem(store, owner, input(changedFixture()))).rejects.toMatchObject({
      reason: "modified",
    });
    expect(await importOptmem(store, outsider, into(changedFixture()))).toEqual({
      imported: 6,
      skipped: 0,
      refused: [],
    });
    const relembra = createRelembra<Principal>({ store, policy: (p) => p });
    expect((await relembra.recall(outsider)).map((m) => m.id).sort()).toEqual(
      TEXTS.map((_, i) => idOf(i + 1, "fixture", OTHER_SCOPE)).sort(),
    );
  });

  test("an import needs ownership of its scope, refused before any content is read", async () => {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(FIXTURE));
    const writerOnly: Principal = { id: "w", readable: [], writable: [SCOPE], promotable: [] };
    await expect(
      importOptmem(store, writerOnly, input(FIXTURE.subarray(0, WIDTH))),
    ).rejects.toThrow(new ScopeDeniedError("own"));
  });

  test("a memory planted under the import's id in another scope is a conflict, its content never compared", async () => {
    const store = createMemoryStore();
    // A crafted export plants, in SCOPE, the id the outsider's import would use.
    const planted = idOf(1, "fixture", OTHER_SCOPE);
    await store.transaction(async (tx) => {
      const revision = {
        number: 1,
        text: "2026-01-05 The build runs with make, never with the IDE's button.",
        at: 1,
        provenance: {
          agent: "a",
          harness: "h",
          model: "m",
          host: "h",
          trust: "agent" as const,
          opId: planted,
        },
      };
      const { seq } = await tx.append({
        format: 1,
        kind: "note",
        memoryId: planted,
        scope: SCOPE,
        principalId: "x",
        pinned: false,
        revision,
      });
      await tx.putMemory({
        id: planted,
        scope: SCOPE,
        seq,
        pinned: false,
        notedAt: 1,
        revision,
        status: "live",
      });
    });
    // Same text as record 1, yet refused: the scope differs, so nothing is compared.
    await expect(importOptmem(store, outsider, into(FIXTURE))).rejects.toMatchObject({
      reason: "conflict",
      line: 1,
    });
  });
});

describe("OptMem import time comes from the host's clock", () => {
  test("every memory is dated by the injected clock, and no input field can set its time", async () => {
    const store = createMemoryStore();
    const given = { ...input(FIXTURE), at: 99_999_999_999_999 } as Parameters<
      typeof importOptmem
    >[2];
    await importOptmem(store, owner, given);
    expect(new Set((await memories(store)).map((m) => m.notedAt))).toEqual(
      new Set([1_700_000_000_000]),
    );
  });
});

describe("a redacted record leaves no fingerprint of its text", () => {
  const sourceOf = (scope = SCOPE) =>
    `optmem:${createHash("sha256").update(scope).digest("hex").slice(0, 16)}:fixture`;
  const ERASED = "2026-01-20 Erased sentinel apricot.";
  const CANDIDATE = "2026-01-20 A different candidate sentence.";
  const logWith = (first: string) => Buffer.concat([record(first), FIXTURE.subarray(0, WIDTH)]);
  const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const redactFirst = (store: Store) =>
    createRelembra<Principal>({ store, policy: (p) => p }).redact(owner, { memoryId: idOf(1) });
  const checkpointOf = (store: Store) => store.transaction((tx) => tx.checkpoint(sourceOf()));

  for (const kind of ["memory", "sqlite"] as const) {
    test(`${kind} store: once a record is redacted, the checkpoint no longer depends on it, even after a reimport`, async () => {
      const dir = tempDir();
      const sqlite: SqliteStore[] = [];
      const open = (name: string): Store => {
        if (kind === "memory") return createMemoryStore();
        const store = openSqliteStore({ path: join(dir.path, name, "relembra.db") });
        sqlite.push(store);
        return store;
      };
      try {
        const erased = open("erased");
        const candidate = open("candidate");
        for (const [store, text] of [
          [erased, ERASED],
          [candidate, CANDIDATE],
        ] as const) {
          await importOptmem(store, owner, input(logWith(text)));
          await redactFirst(store);
        }
        expect(await checkpointOf(erased)).toBeDefined();
        expect(await checkpointOf(erased)).toEqual(await checkpointOf(candidate));
        // A reimport of each log must not write the erased record's fingerprint back.
        for (const [store, text] of [
          [erased, ERASED],
          [candidate, CANDIDATE],
        ] as const) {
          expect(await importOptmem(store, owner, input(logWith(text)))).toEqual({
            imported: 0,
            skipped: 2,
            refused: [],
          });
        }
        expect(await checkpointOf(erased)).toEqual(await checkpointOf(candidate));
        // Positive control: the comparison sees a checkpoint that differs (a longer log).
        const longer = open("longer");
        await importOptmem(longer, owner, input(Buffer.concat([logWith(ERASED), record("x")])));
        expect(await checkpointOf(longer)).not.toEqual(await checkpointOf(erased));
      } finally {
        for (const store of sqlite) await store.close();
        dir.remove();
      }
    });
  }

  test("sqlite store: the erased record's hash is nowhere in the database's files", async () => {
    const dir = tempDir();
    const path = join(dir.path, "store", "relembra.db");
    const log = record(ERASED);
    const digests = [hex(log), hex(log.subarray(0, WIDTH - 1)), hex(Buffer.from(ERASED))];
    const files = () =>
      [path, `${path}-wal`]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file).toString("latin1"))
        .join("");
    try {
      const first = openSqliteStore({ path });
      await importOptmem(first, owner, input(log));
      await first.close();
      // Positive control: reading the files this way finds what the store holds.
      expect(files().includes(ERASED)).toBe(true);

      const second = openSqliteStore({ path });
      await redactFirst(second);
      await importOptmem(second, owner, input(log));
      await second.close();
      const after = files();
      expect(after.includes(ERASED)).toBe(false);
      expect(digests.filter((digest) => after.includes(digest))).toEqual([]);
    } finally {
      dir.remove();
    }
  });

  test("a changed record at a redacted position cannot be told apart, while a live one still is", async () => {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(logWith(ERASED)));
    await redactFirst(store);
    // Telling it apart would need a fingerprint of the erased text: it is accepted and skipped.
    expect(await importOptmem(store, owner, input(logWith(CANDIDATE)))).toEqual({
      imported: 0,
      skipped: 2,
      refused: [],
    });
    // Positive control: a changed live record is still refused.
    const changed = logWith(ERASED);
    changed.write("X", WIDTH + 11);
    await expect(importOptmem(store, owner, input(changed))).rejects.toMatchObject({
      reason: "modified",
      line: 2,
    });
  });
});

describe("an imported record cannot be replaced unseen", () => {
  const LIVE = "2026-01-21 Original live fact.";
  const NEXT = record("2026-01-22 A fact appended later.");

  async function refusedAfter(changed: Uint8Array) {
    const store = createMemoryStore();
    await importOptmem(store, owner, input(record(LIVE)));
    const before = await store.events({ scopes: [SCOPE] });
    const checkpoint = await store.transaction((tx) => tx.checkpoint(sourceKey()));
    const error = await importOptmem(store, owner, input(changed)).catch((e: unknown) => e);
    expect(await store.events({ scopes: [SCOPE] })).toEqual(before);
    expect(await store.transaction((tx) => tx.checkpoint(sourceKey()))).toEqual(checkpoint);
    return error;
  }

  test("a live record replaced by one the guard refuses is modified, not a refused line", async () => {
    const blank = record("");
    expect(await refusedAfter(Buffer.concat([blank, NEXT]))).toMatchObject({
      reason: "modified",
      line: 1,
    });
    const undecodable = record("2026-01-21 Bytes: XX.");
    undecodable[18] = 0xff;
    expect(await refusedAfter(Buffer.concat([undecodable, NEXT]))).toMatchObject({
      reason: "modified",
      line: 1,
    });
    // Positive control: the same blank record at a new position is a refused line.
    const store = createMemoryStore();
    await importOptmem(store, owner, input(record(LIVE)));
    expect(await importOptmem(store, owner, input(Buffer.concat([record(LIVE), blank])))).toEqual({
      imported: 0,
      skipped: 1,
      refused: [{ line: 2, rule: "blank" }],
    });
  });

  test("a log whose record width changed is modified, even when the old text still leads it", async () => {
    const narrow = (text: string) => {
      const bytes = Buffer.from(text);
      return Buffer.concat([bytes, Buffer.alloc(49 - bytes.length, " "), Buffer.from("\n")]);
    };
    // One 100-byte record rewritten as two 50-byte records: the old text, then an insertion.
    const split = Buffer.concat([narrow(LIVE), narrow("2026-01-21 Inserted inside.")]);
    expect(split.length).toBe(WIDTH);
    expect(await refusedAfter(split)).toMatchObject({ reason: "modified", line: 0 });
    expect(await refusedAfter(Buffer.concat([split, narrow("2026-01-22 More.")]))).toMatchObject({
      reason: "modified",
      line: 0,
    });
    // Positive control: the same width, grown, imports its new record.
    const store = createMemoryStore();
    await importOptmem(store, owner, input(record(LIVE)));
    expect(await importOptmem(store, owner, input(Buffer.concat([record(LIVE), NEXT])))).toEqual({
      imported: 1,
      skipped: 1,
      refused: [],
    });
  });
});

describe("OptMem memory ids are minted per destination scope", () => {
  test("the same log imported into two scopes yields distinct ids, and both import fully", async () => {
    const store = createMemoryStore();
    const both: Principal = {
      ...owner,
      readable: [SCOPE, OTHER_SCOPE],
      writable: [SCOPE, OTHER_SCOPE],
      owned: [SCOPE, OTHER_SCOPE],
    };
    expect(await importOptmem(store, both, input(FIXTURE))).toMatchObject({ imported: 6 });
    expect(await importOptmem(store, both, { ...input(FIXTURE), scope: OTHER_SCOPE })).toEqual({
      imported: 6,
      skipped: 0,
      refused: [],
    });
    const events = await store.events({ scopes: [SCOPE, OTHER_SCOPE] });
    const ids = (scope: string) =>
      events.filter((event) => event.scope === scope).map((event) => event.memoryId);
    expect(new Set([...ids(SCOPE), ...ids(OTHER_SCOPE)]).size).toBe(12);
    // Neither the store name nor the record number shows in an id: it is a hash of both and the scope.
    for (const id of [...ids(SCOPE), ...ids(OTHER_SCOPE)]) expect(id).toMatch(/^om-[0-9a-f]{32}$/);
    const expected = (scope: string, n: number) =>
      `om-${createHash("sha256").update(`${scope}\0optmem:fixture\0${n}`).digest("hex").slice(0, 32)}`;
    expect(ids(OTHER_SCOPE)).toEqual(TEXTS.map((_, i) => expected(OTHER_SCOPE, i + 1)));
    // The record's origin stays readable in its provenance, for those who can read the memory.
    const [first] = await memories(store);
    expect(first?.revision.provenance).toMatchObject({
      source: "optmem:fixture:1",
      opId: first?.id,
    });
  });
});

describe("an OptMem store name is screened like any provenance source", () => {
  // Built by concatenation so no literal token sits in the source. It fits the store-name shape.
  const CREDENTIAL_NAME = `gh${"p"}_${"a".repeat(36)}`;
  const checkpointOf = (store: Store, name: string) =>
    store.transaction((tx) => tx.checkpoint(sourceKey(SCOPE, name)));

  test("a credential-shaped name is refused like a direct note's source, writing nothing", async () => {
    // Positive control: the guard refuses the same source on the direct note path.
    const direct = createRelembra<Principal>({ store: createMemoryStore(), policy: (p) => p });
    await expect(
      direct.note(owner, {
        scope: SCOPE,
        text: "A clean fact.",
        provenance: { ...provenance, source: `optmem:${CREDENTIAL_NAME}:1` },
      }),
    ).rejects.toMatchObject({ name: "ProvenanceError", field: "source", rule: "credential" });

    // An empty log writes no memory but would still write the checkpoint, which holds the name.
    for (const log of [FIXTURE, Buffer.alloc(0)]) {
      const store = createMemoryStore();
      await expect(importOptmem(store, owner, input(log, CREDENTIAL_NAME))).rejects.toMatchObject({
        name: "ProvenanceError",
        field: "source",
        rule: "credential",
      });
      expect(await store.events({ scopes: [SCOPE] })).toEqual([]);
      expect(await checkpointOf(store, CREDENTIAL_NAME)).toBeUndefined();
    }
  });

  test("sqlite store: a refused name is nowhere in the database's files", async () => {
    const dir = tempDir();
    const path = join(dir.path, "store", "relembra.db");
    const files = () =>
      [path, `${path}-wal`]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file).toString("latin1"))
        .join("");
    try {
      const store = openSqliteStore({ path });
      for (const log of [FIXTURE, Buffer.alloc(0)]) {
        await expect(importOptmem(store, owner, input(log, CREDENTIAL_NAME))).rejects.toMatchObject(
          { name: "ProvenanceError", field: "source" },
        );
      }
      // Positive control: a safe name imports, and reading the files this way finds it.
      await importOptmem(store, owner, input(FIXTURE, "safe-store.1"));
      await store.close();
      expect(files().includes("safe-store.1")).toBe(true);
      expect(files().includes(CREDENTIAL_NAME)).toBe(false);
    } finally {
      dir.remove();
    }
  });

  test("control characters never pass the store-name shape; a safe name imports and round-trips", async () => {
    const store = createMemoryStore();
    for (const name of ["bad\u001bname", "bad\nname", "bad\u0000name", "tab\tname"]) {
      await expect(importOptmem(store, owner, input(FIXTURE, name))).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(importOptmem(store, owner, input(Buffer.alloc(0), name))).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(await checkpointOf(store, name)).toBeUndefined();
    }
    expect(await store.events({ scopes: [SCOPE] })).toEqual([]);

    // Positive control: a safe name imports, exports and imports again with the same sources.
    expect(await importOptmem(store, owner, input(FIXTURE, "safe-store.1"))).toMatchObject({
      imported: 6,
    });
    expect(await checkpointOf(store, "safe-store.1")).toEqual({
      source: sourceKey(SCOPE, "safe-store.1"),
      bytes: 6 * WIDTH,
      width: WIDTH,
    });
    const copy = createMemoryStore();
    await importJsonl(copy, owner, await exportJsonl(store, owner, { scope: SCOPE }));
    expect((await memories(copy)).map((m) => m.revision.provenance.source)).toEqual(
      TEXTS.map((_, i) => `optmem:safe-store.1:${i + 1}`),
    );
  });
});

describe("OptMem records that begin with #<n> <YYYY-MM-DD>", () => {
  /** The record width of the OptMem 1.3.5 store the prefix was observed in. */
  const PREFIXED_WIDTH = 320;
  const DATE = "2026-07-27";
  const checkpointOf = (store: Store) => store.transaction((tx) => tx.checkpoint(sourceKey()));

  /** A 320-byte record holding `body`, padded with spaces. */
  function wide(body: string | Uint8Array): Buffer {
    const bytes = Buffer.from(body);
    return Buffer.concat([
      bytes,
      Buffer.alloc(PREFIXED_WIDTH - 1 - bytes.length, " "),
      Buffer.from("\n"),
    ]);
  }
  /** A record as OptMem 1.3.5 writes it: `#<n> <date> <text>`, then padding. */
  const prefixed = (n: number | string, text: string, date = DATE) => wide(`#${n} ${date} ${text}`);
  /** Synthetic prose of exactly `bytes` UTF-8 bytes (ASCII), never ending in a space. */
  function prose(bytes: number, lead = "A"): string {
    const base = `${lead} synthetic fact about the build, written for this test only. `;
    return `${base.repeat(Math.ceil(bytes / base.length)).slice(0, bytes - 1)}.`;
  }

  async function refusedWithNothingWritten(log: Uint8Array) {
    const store = createMemoryStore();
    const error = await importOptmem(store, owner, input(log)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect(await store.events({ scopes: [SCOPE] })).toEqual([]);
    expect(await checkpointOf(store)).toBeUndefined();
    return error as ImportError;
  }

  test("the prefix is removed from the text and its date goes to the source", async () => {
    const first = prose(270);
    const second = prose(270, "Another");
    const log = Buffer.concat([prefixed(0, first), prefixed(1, second, "2026-07-28")]);
    expect(log.length).toBe(2 * PREFIXED_WIDTH);
    // With the prefix kept, each record would be 284 bytes of text: over the 280-byte rule.
    expect(`#0 ${DATE} ${first}`.length).toBeGreaterThan(280);

    const store = createMemoryStore();
    expect(await importOptmem(store, owner, input(log))).toEqual({
      imported: 2,
      skipped: 0,
      refused: [],
    });
    const imported = await memories(store);
    expect(imported.map((m) => m.id)).toEqual([idOf(1), idOf(2)]);
    expect(imported.map((m) => m.revision.text)).toEqual([first, second]);
    // The number in the source is the record's position, as for a plain record and the id.
    expect(imported.map((m) => m.revision.provenance.source)).toEqual([
      "optmem:fixture:1:2026-07-27",
      "optmem:fixture:2:2026-07-28",
    ]);
    // The date never sets a memory's time: retention still counts from the import.
    for (const memory of imported) {
      expect(memory).toMatchObject({
        notedAt: 1_700_000_000_000,
        revision: { at: 1_700_000_000_000 },
      });
    }
  });

  test("the text after the prefix is held to 280 bytes: 281 is too-long, 280 imports", async () => {
    const fits = prose(280);
    const over = prose(281, "Over");
    expect(Buffer.byteLength(fits)).toBe(280);
    expect(Buffer.byteLength(over)).toBe(281);
    const store = createMemoryStore();
    expect(
      await importOptmem(
        store,
        owner,
        input(Buffer.concat([prefixed(0, fits), prefixed(1, over)])),
      ),
    ).toEqual({ imported: 1, skipped: 0, refused: [{ line: 2, rule: "too-long" }] });
    expect((await memories(store)).map((m) => m.revision.text)).toEqual([fits]);
  });

  test("a counter that is not the position minus one is not-optmem, writing nothing", async () => {
    const text = "The deploy runs from the release branch.";
    for (const [log, line] of [
      [Buffer.concat([prefixed(0, text), prefixed(5, text)]), 2],
      [Buffer.concat([prefixed(1, text), prefixed(2, text)]), 1],
      [Buffer.concat([prefixed(0, text), prefixed("01", text)]), 2],
    ] as const) {
      const error = await refusedWithNothingWritten(log);
      expect(error).toMatchObject({ reason: "not-optmem", line });
      // An error names the line, never the record's text.
      expect(error.message).not.toContain(text);
    }
    // Positive control: counted from 0 at every position, the same records import.
    expect(
      await importOptmem(
        createMemoryStore(),
        owner,
        input(Buffer.concat([prefixed(0, text), prefixed(1, text)])),
      ),
    ).toEqual({ imported: 2, skipped: 0, refused: [] });
  });

  test("a log that mixes prefixed and plain records is not-optmem, writing nothing", async () => {
    const plain = wide("2026-07-27 A plain record that has a date but no counter.");
    for (const log of [
      Buffer.concat([prefixed(0, "A prefixed fact."), plain]),
      Buffer.concat([plain, prefixed(1, "A prefixed fact.")]),
    ]) {
      expect(await refusedWithNothingWritten(log)).toMatchObject({
        reason: "not-optmem",
        line: 2,
      });
    }
    // Positive control: the plain records alone import as before, their text whole.
    const store = createMemoryStore();
    expect(await importOptmem(store, owner, input(Buffer.concat([plain, plain])))).toEqual({
      imported: 2,
      skipped: 0,
      refused: [],
    });
    expect((await memories(store)).map((m) => m.revision.provenance.source)).toEqual([
      "optmem:fixture:1",
      "optmem:fixture:2",
    ]);
  });

  test("a plain record that begins with # but no date keeps its text whole", async () => {
    const store = createMemoryStore();
    const texts = ["#3274 was the flaky test, fixed by a retry.", "#1 priority: the deploy."];
    expect(await importOptmem(store, owner, input(Buffer.concat(texts.map(wide))))).toEqual({
      imported: 2,
      skipped: 0,
      refused: [],
    });
    expect((await memories(store)).map((m) => m.revision.text)).toEqual(texts);
  });

  test("a counter of any length is read as the prefix: an oversized one is not-optmem", async () => {
    // A 33-byte prefix: longer than any window short of the whole record.
    const oversized = "#10000000000000000000 2026-07-27 ";
    expect(oversized.length).toBe(33);
    for (const [log, line] of [
      [wide(`${oversized}A fact.`), 1],
      [Buffer.concat([prefixed(0, "A fact."), wide(`${oversized}A fact.`)]), 2],
      // A leading zero is still a counter, and not the position minus one.
      [prefixed("00", "A fact."), 1],
    ] as const) {
      expect(await refusedWithNothingWritten(log)).toMatchObject({ reason: "not-optmem", line });
    }
    // Positive control: a valid 4-digit counter, at record 1001, imports with its prefix removed.
    const records = Array.from({ length: 1001 }, (_, i) => prefixed(i, `Fact number ${i}.`));
    const store = createMemoryStore();
    expect(await importOptmem(store, owner, input(Buffer.concat(records)))).toMatchObject({
      imported: 1001,
      refused: [],
    });
    const last = await createRelembra<Principal>({ store, policy: (p) => p }).zoom(owner, {
      memoryId: idOf(1001),
    });
    expect(last).toMatchObject({
      status: "live",
      revision: {
        text: "Fact number 1000.",
        provenance: { source: "optmem:fixture:1001:2026-07-27" },
      },
    });
  });

  test("a log whose every record begins #<position − 1> <real date> is the OptMem format, by definition", async () => {
    // OptMem always writes the prefix, so a log shaped this way is read as prefixed: there is no
    // plain reading of it. Its text is what follows the prefix; the date goes to the source.
    const store = createMemoryStore();
    expect(
      await importOptmem(store, owner, input(wide("#0 2026-07-27 Deploy on Friday."))),
    ).toEqual({ imported: 1, skipped: 0, refused: [] });
    const [memory] = await memories(store);
    expect(memory?.revision).toMatchObject({
      text: "Deploy on Friday.",
      provenance: { source: "optmem:fixture:1:2026-07-27" },
    });
  });

  test("an invalid date in the prefix is not-optmem, writing nothing", async () => {
    for (const [log, line] of [
      [prefixed(0, "A fact.", "2026-13-40"), 1],
      [Buffer.concat([prefixed(0, "A fact."), prefixed(1, "A fact.", "2026-02-29")]), 2],
      [prefixed(0, "A fact.", "2026-00-10"), 1],
    ] as const) {
      expect(await refusedWithNothingWritten(log)).toMatchObject({ reason: "not-optmem", line });
    }
    // Positive control: a real leap day and the year's last day import.
    const store = createMemoryStore();
    const log = Buffer.concat([
      prefixed(0, "A fact.", "2028-02-29"),
      prefixed(1, "A fact.", "2026-12-31"),
    ]);
    expect(await importOptmem(store, owner, input(log))).toMatchObject({ imported: 2 });
    expect((await memories(store)).map((m) => m.revision.provenance.source)).toEqual([
      "optmem:fixture:1:2028-02-29",
      "optmem:fixture:2:2026-12-31",
    ]);
  });

  test("the text after the prefix is decoded alone: a bad byte there is ill-formed by line", async () => {
    const bad = Buffer.from(prefixed(1, "Bytes: XX."));
    bad[22] = 0xff;
    const store = createMemoryStore();
    expect(
      await importOptmem(store, owner, input(Buffer.concat([prefixed(0, "A fact."), bad]))),
    ).toEqual({ imported: 1, skipped: 0, refused: [{ line: 2, rule: "ill-formed" }] });
  });

  test("importing the same prefixed log twice adds nothing", async () => {
    const log = Buffer.concat([prefixed(0, prose(270)), prefixed(1, prose(200, "Second"))]);
    const store = createMemoryStore();
    await importOptmem(store, owner, input(log));
    const events = await store.events({ scopes: [SCOPE] });
    expect(events.length).toBe(2);
    expect(await importOptmem(store, owner, input(log))).toEqual({
      imported: 0,
      skipped: 2,
      refused: [],
    });
    expect(await store.events({ scopes: [SCOPE] })).toEqual(events);
    // Positive control: a record appended later imports, its counter continuing the log's.
    const grown = Buffer.concat([log, prefixed(2, "A third fact, appended later.")]);
    expect(await importOptmem(store, owner, input(grown))).toEqual({
      imported: 1,
      skipped: 2,
      refused: [],
    });
  });

  test("memory ids depend on scope, store and position only, prefix or not", async () => {
    const plain = createMemoryStore();
    await importOptmem(plain, owner, input(Buffer.concat([wide("A fact."), wide("B fact.")])));
    const withPrefix = createMemoryStore();
    await importOptmem(
      withPrefix,
      owner,
      input(Buffer.concat([prefixed(0, "A fact."), prefixed(1, "B fact.")])),
    );
    const idsOf = async (store: Store) => (await memories(store)).map((m) => m.id);
    expect(await idsOf(withPrefix)).toEqual(await idsOf(plain));
    expect(await idsOf(withPrefix)).toEqual([idOf(1), idOf(2)]);
  });

  test("upgrade from 0.3.x: a store holding prefixed texts is modified, and a redacted record stays a tombstone", async () => {
    const texts = ["The deploy runs from the release branch.", "A second fact."];
    const log = Buffer.concat(texts.map((text, i) => prefixed(i, text)));
    // What a 0.3.x import stored: each record whole as its text, the prefix included.
    const store = createMemoryStore();
    await store.transaction(async (tx) => {
      for (const [i, text] of texts.entries()) {
        const memoryId = idOf(i + 1);
        const revision = {
          number: 1,
          text: `#${i} ${DATE} ${text}`,
          at: 1,
          provenance: {
            agent: "importer",
            harness: "optmem",
            model: "none",
            host: provenance.host,
            source: `optmem:fixture:${i + 1}`,
            trust: "agent" as const,
            opId: memoryId,
          },
        };
        const { seq } = await tx.append({
          format: 1,
          kind: "note",
          memoryId,
          scope: SCOPE,
          principalId: "owner",
          pinned: false,
          revision,
        });
        await tx.putMemory({
          id: memoryId,
          scope: SCOPE,
          seq,
          pinned: false,
          notedAt: 1,
          revision,
          status: "live",
        });
      }
      // And the checkpoint that import recorded: the whole log, at its record width.
      await tx.putCheckpoint({
        source: sourceKey(),
        bytes: texts.length * PREFIXED_WIDTH,
        width: PREFIXED_WIDTH,
      });
    });
    const legacy = await checkpointOf(store);
    expect(legacy).toEqual({
      source: sourceKey(),
      bytes: log.length,
      width: PREFIXED_WIDTH,
    });
    const before = await store.events({ scopes: [SCOPE] });
    // The checkpoint passes (same length, same width): the refusal is the record's text.
    await expect(importOptmem(store, owner, input(log))).rejects.toMatchObject({
      reason: "modified",
      line: 1,
    });
    expect(await store.events({ scopes: [SCOPE] })).toEqual(before);
    expect(await checkpointOf(store)).toEqual(legacy);

    // Redaction is no repair: the tombstone is skipped, never written over with the new text.
    const relembra = createRelembra<Principal>({ store, policy: (p) => p });
    await relembra.redact(owner, { memoryId: idOf(1) });
    await expect(importOptmem(store, owner, input(log))).rejects.toMatchObject({
      reason: "modified",
      line: 2,
    });
    await relembra.redact(owner, { memoryId: idOf(2) });
    expect(await importOptmem(store, owner, input(log))).toEqual({
      imported: 0,
      skipped: 2,
      refused: [],
    });
    for (const memoryId of [idOf(1), idOf(2)]) {
      expect((await relembra.zoom(owner, { memoryId })).status).toBe("redacted");
    }
    expect(JSON.stringify(await store.events({ scopes: [SCOPE] }))).not.toContain(texts[0]);

    // Positive control, the repair: a fresh destination scope imports the corrected texts.
    const both: Principal = {
      ...owner,
      readable: [SCOPE, OTHER_SCOPE],
      writable: [SCOPE, OTHER_SCOPE],
      owned: [SCOPE, OTHER_SCOPE],
    };
    expect(await importOptmem(store, both, { ...input(log), scope: OTHER_SCOPE })).toEqual({
      imported: 2,
      skipped: 0,
      refused: [],
    });
    const fresh = await createRelembra<Principal>({ store, policy: (p) => p }).recall(
      { ...both, readable: [OTHER_SCOPE] },
      { limit: 10 },
    );
    expect(fresh.map((m) => m.revision.text).sort()).toEqual([...texts].sort());
  });
});
