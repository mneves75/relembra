import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { createRelembra, type Memory, type Principal, type Store } from "relembra";
import {
  openSqliteStore,
  SchemaTooNewError,
  StoreBusyError,
  StoreFileModeError,
  StoreFileTypeError,
  WalScrubError,
} from "relembra/sqlite";
import { storeConformanceCases } from "relembra/testing";
import { rank } from "../src/ranking.js";
import { createOwnerOnly, OWNER_MODES, openDatabase } from "../src/sqlite/database.js";
import { MIGRATIONS, migrate, schemaVersion } from "../src/sqlite/migrations.js";

/** A schema version newer than this relembra supports. */
const FUTURE = MIGRATIONS.length + 1;

import { sqliteTarget, tempDir } from "./sqlite-support.js";
import { type HostContext, hostPolicy, OTHER_SCOPE, provenance, SCOPE } from "./support.js";

// Mode tests run where the store checks POSIX modes; on Windows, sqlite-windows-acl.test.ts covers
// the owner-only ACL in their place.
const modeTest = test.skipIf(!OWNER_MODES);

describe("store conformance: sqlite store", () => {
  for (const conformance of storeConformanceCases(sqliteTarget)) {
    test(conformance.name, () => conformance.run());
  }
});

describe("sqlite store files", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.remove());

  const modeOf = (path: string) => statSync(path).mode & 0o777;

  modeTest(
    "creates missing directories as 0700 and the database, WAL and SHM files as 0600",
    async () => {
      const path = join(dir.path, "home", "nested", "relembra.db");
      const store = openSqliteStore({ path });
      await store.transaction(async (tx) => tx.putMemory(sampleMemory("m-1")));

      expect(modeOf(join(dir.path, "home"))).toBe(0o700);
      expect(modeOf(join(dir.path, "home", "nested"))).toBe(0o700);
      for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(modeOf(file)).toBe(0o600);
      await store.close();
    },
  );

  modeTest("leaves an existing directory's mode alone", async () => {
    // The temp dir itself already exists; relembra must not chmod a directory it did not create.
    chmodSync(dir.path, 0o755);
    const store = openSqliteStore({ path: join(dir.path, "relembra.db") });

    expect(modeOf(dir.path)).toBe(0o755);
    expect(modeOf(join(dir.path, "relembra.db"))).toBe(0o600);
    await store.close();
  });

  modeTest("an existing store file that others can read or write is refused", async () => {
    const path = join(dir.path, "relembra.db");
    await openSqliteStore({ path }).close();

    // Positive control: the file as relembra created it (0600) opens.
    await openSqliteStore({ path }).close();

    for (const loose of [0o644, 0o640, 0o620, 0o604, 0o660]) {
      chmodSync(path, loose);
      expect(() => openSqliteStore({ path })).toThrow(StoreFileModeError);
    }
    chmodSync(path, 0o600);
    await openSqliteStore({ path }).close();
  });

  test("the file is in WAL mode and records schema versions 1 to 6 once", async () => {
    const path = join(dir.path, "store", "relembra.db");
    await openSqliteStore({ path }).close();
    await openSqliteStore({ path }).close();

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("SELECT version FROM schema_version").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
      ]);
    } finally {
      db.close();
    }
  });

  test("a schema 2 file migrates to the latest schema keeping its memories, tombstones and op records", async () => {
    const path = join(dir.path, "relembra.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    migrate(old, MIGRATIONS.slice(0, 2));
    expect(schemaVersion(old)).toBe(2);
    const memory = sampleMemory("m-kept");
    old
      .prepare(
        `INSERT INTO memories (id, scope, seq, pinned, noted_at, revision_number, text, revised_at, provenance)
         VALUES (?, ?, 1, 0, 1, 1, ?, 1, ?)`,
      )
      .run(
        memory.id,
        memory.scope,
        memory.revision.text,
        JSON.stringify(memory.revision.provenance),
      );
    old.exec("INSERT INTO tombstones (id, scope, seq) VALUES ('m-gone', 'files/a', 2)");
    old.exec(
      "INSERT INTO ops (principal_id, op_id, fingerprint, memory_id, at, seq) VALUES ('p', 'op-gone', NULL, 'm-gone', 1, 2)",
    );
    old.close();
    chmodSync(path, 0o600);

    const store = openSqliteStore({ path });
    try {
      const read = await store.transaction(async (tx) => ({
        kept: await tx.memory("m-kept"),
        gone: await tx.memory("m-gone"),
        op: await tx.op("p", "op-gone"),
        checkpoint: await tx.checkpoint("optmem:none"),
      }));
      expect(read.kept).toEqual(memory);
      expect(read.gone).toEqual({ id: "m-gone", scope: "files/a", seq: 2, status: "redacted" });
      expect(read.op).toEqual({
        principalId: "p",
        opId: "op-gone",
        memoryId: "m-gone",
        at: 1,
        seq: 2,
      });
      // The new table is there and empty.
      expect(read.checkpoint).toBeUndefined();
    } finally {
      await store.close();
    }
    const after = new DatabaseSync(path);
    expect(schemaVersion(after)).toBe(MIGRATIONS.length);
    after.close();
  });

  test("a schema 3 file with data migrates to 4, and its term index equals the one writes build", async () => {
    const path = join(dir.path, "store", "relembra.db");
    // A store built through the library, so its index was kept write by write.
    const store = openSqliteStore({ path });
    const writer = await populate(store);
    await store.close();
    const incremental = termIndexRows(path);
    expect(incremental.docs.length).toBe(writer.live);
    expect(incremental.postings.length).toBeGreaterThan(writer.live);

    // Back to schema 3: the exposure tables (6), the origin column (5) and the index tables (4)
    // dropped, and versions 4 to 6 forgotten, nothing else changed.
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE exposures; DROP TABLE erasure_deliveries; DROP TABLE erasure_pending");
    raw.exec("DROP INDEX memories_by_origin; ALTER TABLE memories DROP COLUMN origin");
    raw.exec("DROP TABLE term_postings; DROP TABLE term_docs; DROP TABLE term_scopes");
    raw.exec("DELETE FROM schema_version WHERE version >= 4");
    raw.close();
    const reference = new DatabaseSync(":memory:");
    migrate(reference, MIGRATIONS.slice(0, 3));
    expect(schemaOf(path)).toEqual(schemaOf(reference));
    reference.close();
    expect(schemaOf(path).some((entry) => entry.includes("term_"))).toBe(false);

    // Opening migrates and backfills, in one transaction.
    const reopened = openSqliteStore({ path });
    try {
      const relembra = createRelembra<HostContext>({ store: reopened, policy: populatePolicy });
      for (const query of POPULATE_QUERIES) {
        const live = await reopened.liveMemories({ scopes: [SCOPE, OTHER_SCOPE] });
        const found = await relembra.find({ user: "writer" }, { query, limit: 100 });
        expect(found).toEqual(rank(query, live));
        expect(found.length).toBeGreaterThan(0);
      }
    } finally {
      await reopened.close();
    }
    const migrated = new DatabaseSync(path);
    expect(schemaVersion(migrated)).toBe(MIGRATIONS.length);
    migrated.close();
    expect(termIndexRows(path)).toEqual(incremental);
  });

  test("a term index backfill that fails leaves the schema 3 file as it was", () => {
    const path = join(dir.path, "relembra.db");
    const db = new DatabaseSync(path);
    try {
      migrate(db, MIGRATIONS.slice(0, 3));
      db.exec(
        `INSERT INTO memories (id, scope, seq, pinned, noted_at, revision_number, text, revised_at, provenance)
         VALUES ('m-1', 's', 1, 0, 1, 1, 'Agents deploy.', 1, '{}')`,
      );
      const failing = {
        ...MIGRATIONS[3],
        backfill: () => {
          throw new Error("interrupted");
        },
      };
      expect(() =>
        migrate(db, [...MIGRATIONS.slice(0, 3), failing as (typeof MIGRATIONS)[3]]),
      ).toThrow("interrupted");
      expect(schemaVersion(db)).toBe(3);
      expect(schemaOf(db).some((entry) => entry.includes("term_"))).toBe(false);

      // Positive control: the real migration applies and indexes the memory.
      migrate(db);
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare("SELECT memory_id, length_kept FROM term_docs").all()).toEqual([
        { memory_id: "m-1", length_kept: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  test("a schema 4 file migrates to the latest schema: its memories have no origin, and a copy written after is derived", async () => {
    const path = join(dir.path, "relembra.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    migrate(old, MIGRATIONS.slice(0, 4));
    const kept = sampleMemory("m-kept");
    old
      .prepare(
        `INSERT INTO memories (id, scope, seq, pinned, noted_at, revision_number, text, revised_at, provenance)
         VALUES (?, ?, 1, 0, 1, 1, ?, 1, ?)`,
      )
      .run(kept.id, kept.scope, kept.revision.text, JSON.stringify(kept.revision.provenance));
    old.close();
    chmodSync(path, 0o600);

    const store = openSqliteStore({ path });
    try {
      expect(await store.transaction((tx) => tx.memory(kept.id))).toEqual(kept);
      const copy = {
        ...sampleMemory("m-copy"),
        scope: "files/b",
        origin: { memoryId: kept.id, revision: 1 },
      };
      await store.transaction((tx) => tx.putMemory(copy));
      const read = await store.transaction(async (tx) => ({
        copy: await tx.memory(copy.id),
        derived: await tx.derived(kept.id),
      }));
      expect(read).toEqual({ copy, derived: [copy.id] });
    } finally {
      await store.close();
    }
    const after = new DatabaseSync(path);
    expect(schemaVersion(after)).toBe(MIGRATIONS.length);
    after.close();
  });

  test("a schema 5 file migrates to 6: its outbox rows keep their carriers, and exposures start empty", async () => {
    const path = join(dir.path, "relembra.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    migrate(old, MIGRATIONS.slice(0, 5));
    old
      .prepare("INSERT INTO erasure_outbox (seq, memory_id, carriers) VALUES (3, 'm-old', '[]')")
      .run();
    // A row written with a carrier by a library host before 6 (the column took any JSON).
    old
      .prepare(
        `INSERT INTO erasure_outbox (seq, memory_id, carriers)
         VALUES (4, 'm-held', '[{"id":"c-old","kind":"k"}]')`,
      )
      .run();
    old.close();
    chmodSync(path, 0o600);

    const store = openSqliteStore({ path });
    try {
      expect(await store.erasures()).toEqual([
        { seq: 3, memoryId: "m-old", carriers: [] },
        { seq: 4, memoryId: "m-held", carriers: [{ id: "c-old", kind: "k" }] },
      ]);
      // The migration fills the pending table from the outbox: the carrier is pending.
      expect(await store.pendingErasures({ limit: 10 })).toEqual([
        { seq: 4, memoryId: "m-held", carriers: [{ id: "c-old", kind: "k" }] },
      ]);
      expect(await store.pendingErasureCount()).toEqual({ work: 1, carriers: 1 });
      expect(await store.settlements()).toEqual([]);
      expect(await store.transaction((tx) => tx.exposures("m-old"))).toEqual([]);
      const carrier = { id: "carrier-1", kind: "kind-a" };
      expect(await store.recordExposure({ carrier, memoryIds: ["m-new"], at: 1 })).toEqual([]);
      expect(await store.transaction((tx) => tx.exposures("m-new"))).toEqual([carrier]);
    } finally {
      await store.close();
    }
    const after = new DatabaseSync(path);
    expect(schemaVersion(after)).toBe(6);
    after.close();
  });

  test("a file written by a newer relembra is refused, not downgraded", async () => {
    const path = join(dir.path, "store", "relembra.db");
    await openSqliteStore({ path }).close();

    // Positive control: the current version opens.
    await openSqliteStore({ path }).close();

    const db = new DatabaseSync(path);
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${FUTURE}, 0)`);
    db.close();

    expect(() => openSqliteStore({ path })).toThrow(SchemaTooNewError);
  });
});

describe("sqlite store opening", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.remove());

  test("the connection is defensive, WAL and synchronous=FULL", () => {
    const path = join(dir.path, "store", "relembra.db");
    createOwnerOnly(path);
    const db = openDatabase(path, 100);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
      db.exec("PRAGMA schema_version = 42");
      expect(db.prepare("PRAGMA schema_version").get()).not.toEqual({ schema_version: 42 });
    } finally {
      db.close();
    }
    // Control: a connection opened with defensive:false may write the schema version.
    const loose = new DatabaseSync(path, { defensive: false });
    try {
      loose.exec("PRAGMA schema_version = 42");
      expect(loose.prepare("PRAGMA schema_version").get()).toEqual({ schema_version: 42 });
    } finally {
      loose.close();
    }
  });

  modeTest("an existing -wal or -shm file that others can read or write is refused", async () => {
    const path = join(dir.path, "relembra.db");
    const holder = openSqliteStore({ path });
    await holder.transaction((tx) => tx.putMemory(sampleMemory("m-1")));
    try {
      // Positive control: sidecars at 0600, as SQLite creates them for a 0600 file, open.
      await openSqliteStore({ path }).close();

      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        expect(existsSync(sidecar)).toBe(true);
        chmodSync(sidecar, 0o644);
        expect(() => openSqliteStore({ path })).toThrow(StoreFileModeError);
        expect(statSync(sidecar).mode & 0o777).toBe(0o644);
        chmodSync(sidecar, 0o600);
      }
      await openSqliteStore({ path }).close();
    } finally {
      await holder.close();
    }
  });

  test("a newer store in WAL mode, closed cleanly, is refused without creating or changing a file", async () => {
    const path = join(dir.path, "store", "relembra.db");
    await openSqliteStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${FUTURE}, 0)`);
    raw.close();
    expect([existsSync(`${path}-wal`), existsSync(`${path}-shm`)]).toEqual([false, false]);
    const before = readFileSync(path);

    expect(() => openSqliteStore({ path })).toThrow(SchemaTooNewError);

    expect(readFileSync(path).equals(before)).toBe(true);
    expect([existsSync(`${path}-wal`), existsSync(`${path}-shm`)]).toEqual([false, false]);
  });

  test("a store newer than this relembra is refused without changing a byte", async () => {
    const path = join(dir.path, "store", "relembra.db");
    await openSqliteStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${FUTURE}, 0)`);
    raw.exec("PRAGMA journal_mode = DELETE");
    raw.close();
    const before = readFileSync(path);

    expect(() => openSqliteStore({ path })).toThrow(SchemaTooNewError);

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);
    // Positive control: opening a current store does switch it to WAL, which changes the file.
    const current = join(dir.path, "current", "relembra.db");
    await openSqliteStore({ path: current }).close();
    const check = new DatabaseSync(current);
    check.exec("PRAGMA journal_mode = DELETE");
    check.close();
    const rollback = readFileSync(current);
    await openSqliteStore({ path: current }).close();
    expect(readFileSync(current).equals(rollback)).toBe(false);
  });

  test("a writer holding the lock during open and migration raises StoreBusyError", async () => {
    const path = join(dir.path, "relembra.db");
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA journal_mode = WAL");
    holder.exec("CREATE TABLE unrelated (x INTEGER)");
    for (const file of [path, `${path}-wal`, `${path}-shm`]) chmodSync(file, 0o600);
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect(() => openSqliteStore({ path, busyTimeoutMs: 10 })).toThrow(StoreBusyError);
    } finally {
      holder.exec("ROLLBACK");
    }
    // Positive control: once the lock is released, the same open migrates the file.
    await openSqliteStore({ path, busyTimeoutMs: 10 }).close();
    holder.close();
  });

  test("a reader holding a rollback-journal store while it is switched to WAL raises StoreBusyError", async () => {
    const path = join(dir.path, "store", "relembra.db");
    await openSqliteStore({ path }).close();
    const reader = new DatabaseSync(path);
    reader.exec("PRAGMA journal_mode = DELETE");
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM schema_version").all();
    try {
      expect(() => openSqliteStore({ path, busyTimeoutMs: 40 })).toThrow(StoreBusyError);
    } finally {
      reader.exec("COMMIT");
    }
    // Positive control: once the reader lets go, the same open switches the file to WAL.
    await openSqliteStore({ path, busyTimeoutMs: 40 }).close();
    reader.close();
    expect(readFileSync(path).subarray(18, 20)).toEqual(Buffer.from([2, 2]));
  });

  test("a busy timeout above SQLite's 32-bit maximum is refused, and the maximum is accepted", async () => {
    const path = join(dir.path, "store", "relembra.db");
    // PRAGMA busy_timeout takes a 32-bit int: 2147483648 would silently become 0 (no waiting).
    expect(() => openSqliteStore({ path, busyTimeoutMs: 2_147_483_648 })).toThrow(RangeError);
    expect(existsSync(path)).toBe(false);
    // Positive control: the largest value SQLite keeps is accepted.
    await openSqliteStore({ path, busyTimeoutMs: 2_147_483_647 }).close();
  });

  test("a busy timeout that is not a finite non-negative integer is refused before the file is touched", () => {
    const path = join(dir.path, "store", "relembra.db");
    for (const busyTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => openSqliteStore({ path, busyTimeoutMs })).toThrow(RangeError);
    }
    expect(existsSync(path)).toBe(false);
    // Positive control: zero is a valid timeout.
    expect(() => openSqliteStore({ path, busyTimeoutMs: 0 }).close()).not.toThrow();
  });
});

describe("sqlite redaction on disk", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.remove());

  const SECRET = "Erase me: the archive key sits under the blue lamp.";
  const owner = {
    id: "owner",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    owned: [SCOPE],
  };
  const bytesOf = (path: string) =>
    Buffer.concat(
      [path, `${path}-wal`].filter((file) => existsSync(file)).map((f) => readFileSync(f)),
    );
  /** Whether any 16-byte piece of SECRET (at 8-byte steps) is in the file: a partial residue too. */
  const holdsAny = (path: string) => {
    const bytes = bytesOf(path);
    for (let at = 0; at + 16 <= SECRET.length; at += 8) {
      if (bytes.includes(SECRET.slice(at, at + 16))) return true;
    }
    return false;
  };

  test("the store's connection has secure_delete on", () => {
    const path = join(dir.path, "store", "relembra.db");
    createOwnerOnly(path);
    const db = openDatabase(path, 100);
    try {
      expect(db.prepare("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
    } finally {
      db.close();
    }
  });

  // Why secure_delete: the same rewrite and checkpoint leave the old text in the file without it.
  for (const [mode, kept] of [
    ["OFF", true],
    ["ON", false],
  ] as const) {
    test(`with secure_delete ${mode}, rewritten text ${kept ? "stays" : "is gone"} after a checkpoint`, () => {
      const path = join(dir.path, `plain-${mode}.db`);
      const db = new DatabaseSync(path);
      try {
        db.exec(`PRAGMA journal_mode = WAL; PRAGMA secure_delete = ${mode};`);
        db.exec("CREATE TABLE t (body TEXT) STRICT");
        const insert = db.prepare("INSERT INTO t (body) VALUES (?)");
        for (let i = 0; i < 20; i++) insert.run(`filler ${i} ${"x".repeat(100)}`);
        insert.run(SECRET);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.prepare("UPDATE t SET body = ? WHERE body = ?").run("{}", SECRET);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        expect(holdsAny(path)).toBe(kept);
      } finally {
        db.close();
      }
    });
  }

  test("a reader holding an old snapshot defers the WAL truncation, and a later commit completes it", async () => {
    const path = join(dir.path, "store", "relembra.db");
    const store = openSqliteStore({ path, busyTimeoutMs: 50 });
    const relembra = createRelembra({ store, policy: () => owner });
    const secret = await relembra.note(null, { scope: SCOPE, text: SECRET, provenance });
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM memories").get();

    await relembra.redact(null, { memoryId: secret.id });

    // The redaction committed, but the old page images stay while the reader holds them.
    expect(await relembra.recall(null)).toEqual([]);
    expect(holdsAny(path)).toBe(true);
    reader.exec("COMMIT");
    reader.close();

    await relembra.note(null, { scope: SCOPE, text: "A later commit.", provenance });

    expect(holdsAny(path)).toBe(false);
    expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
    await store.close();
  });

  test("a scrub that failed survives a restart: the reopened store truncates the WAL before any read", async () => {
    const path = join(dir.path, "store", "relembra.db");
    const store = openSqliteStore({ path, busyTimeoutMs: 50 });
    const relembra = createRelembra({ store, policy: () => owner });
    const secret = await relembra.note(null, { scope: SCOPE, text: SECRET, provenance });
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM memories").get();

    await relembra.redact(null, { memoryId: secret.id });

    // The scrub cannot finish while the reader holds its snapshot: the host can read that, and
    // closing says so instead of resolving as if the text were gone.
    expect(await store.walScrubPending()).toBe(true);
    await expect(store.close()).rejects.toBeInstanceOf(WalScrubError);
    reader.exec("COMMIT");
    reader.close();
    // Positive control: the old page images are still on disk across the restart.
    expect(holdsAny(path)).toBe(true);

    const reopened = openSqliteStore({ path, busyTimeoutMs: 50 });
    try {
      expect(await reopened.walScrubPending()).toBe(false);
      expect(holdsAny(path)).toBe(false);
      expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
    } finally {
      await reopened.close();
    }
  });

  test("handles opened before another handle's redaction see its pending scrub, and finish it", async () => {
    const path = join(dir.path, "store", "relembra.db");
    const a = openSqliteStore({ path, busyTimeoutMs: 50 });
    const b = openSqliteStore({ path, busyTimeoutMs: 50 });
    const c = openSqliteStore({ path, busyTimeoutMs: 50 });
    const relembraA = createRelembra({ store: a, policy: () => owner });
    const relembraB = createRelembra({ store: b, policy: () => owner });
    const secret = await relembraA.note(null, { scope: SCOPE, text: SECRET, provenance });
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM memories").get();

    await relembraA.redact(null, { memoryId: secret.id });

    expect(await a.walScrubPending()).toBe(true);
    expect(await b.walScrubPending()).toBe(true);
    // c never wrote anything, but closing it while the scrub cannot finish says so.
    await expect(c.close()).rejects.toBeInstanceOf(WalScrubError);
    expect(holdsAny(path)).toBe(true);
    reader.exec("COMMIT");
    reader.close();

    // b's next commit finishes the scrub a started.
    await relembraB.note(null, { scope: SCOPE, text: "A later commit.", provenance });

    expect(holdsAny(path)).toBe(false);
    expect(await a.walScrubPending()).toBe(false);
    expect(await b.walScrubPending()).toBe(false);
    await a.close();
    await b.close();
  });

  test("a scrub clears only the redactions it truncated: one committed after its truncation stays pending", async () => {
    const path = join(dir.path, "store", "relembra.db");
    // a waits long enough to outlast the hold below; b gives up on its truncation quickly.
    const a = openSqliteStore({ path, busyTimeoutMs: 1_000 });
    const b = openSqliteStore({ path, busyTimeoutMs: 50 });
    const relembraA = createRelembra({ store: a, policy: () => owner });
    const relembraB = createRelembra({ store: b, policy: () => owner });
    const later = await relembraB.note(null, { scope: SCOPE, text: SECRET, provenance });
    const first = await relembraA.note(null, {
      scope: SCOPE,
      text: "Another secret, redacted first.",
      provenance,
    });
    // Holds a scrub between its truncation and clearing the marker, by answering SQLITE_BUSY to
    // the clearing statement until released: the window in which another handle can redact.
    const run = StatementSync.prototype.run;
    let held = 0;
    let released = false;
    StatementSync.prototype.run = function (this: StatementSync, ...args) {
      if (
        !released &&
        /^\s*(DELETE FROM wal_scrub|UPDATE wal_scrub SET scrubbed)/.test(this.sourceSQL)
      ) {
        held++;
        throw Object.assign(new Error("database is locked"), { errcode: 5 });
      }
      return run.apply(this, args as Parameters<typeof run>);
    } as typeof run;
    try {
      const redactingA = relembraA.redact(null, { memoryId: first.id });
      while (held === 0) await new Promise((done) => setTimeout(done, 1));
      // A has truncated the WAL. Now b redacts, and a reader stops b's own truncation.
      const reader = new DatabaseSync(path, { readOnly: true });
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM memories").get();
      await relembraB.redact(null, { memoryId: later.id });
      released = true;
      await redactingA;

      // a's clearing must leave b's redaction pending: its text is still on disk.
      expect(held).toBeGreaterThan(0);
      expect(holdsAny(path)).toBe(true);
      expect(await b.walScrubPending()).toBe(true);
      reader.exec("COMMIT");
      reader.close();
    } finally {
      StatementSync.prototype.run = run;
    }

    await relembraA.note(null, { scope: SCOPE, text: "A later commit.", provenance });

    expect(holdsAny(path)).toBe(false);
    expect(await a.walScrubPending()).toBe(false);
    await a.close();
    await b.close();
  });

  test("a scrub that still cannot finish at reopen stays pending, and the next commit retries it", async () => {
    const path = join(dir.path, "store", "relembra.db");
    const store = openSqliteStore({ path, busyTimeoutMs: 50 });
    const relembra = createRelembra({ store, policy: () => owner });
    const secret = await relembra.note(null, { scope: SCOPE, text: SECRET, provenance });
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM memories").get();
    await relembra.redact(null, { memoryId: secret.id });
    await expect(store.close()).rejects.toBeInstanceOf(WalScrubError);

    const reopened = openSqliteStore({ path, busyTimeoutMs: 50 });
    const again = createRelembra({ store: reopened, policy: () => owner });
    expect(await again.recall(null)).toEqual([]);
    expect(await reopened.walScrubPending()).toBe(true);
    expect(holdsAny(path)).toBe(true);
    reader.exec("COMMIT");
    reader.close();

    await again.note(null, { scope: SCOPE, text: "A later commit.", provenance });

    expect(await reopened.walScrubPending()).toBe(false);
    expect(holdsAny(path)).toBe(false);
    await reopened.close();
  });
});

describe("sqlite store paths are regular files, never symbolic links", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.remove());

  test("a dangling symbolic link is refused and nothing is created behind it", () => {
    const real = join(dir.path, "real.db");
    const alias = join(dir.path, "alias.db");
    symlinkSync(real, alias);

    expect(() => openSqliteStore({ path: alias })).toThrow(StoreFileTypeError);

    expect(existsSync(real)).toBe(false);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  test("a symbolic link to an existing store is refused without touching the store", async () => {
    const real = join(dir.path, "store", "real.db");
    await openSqliteStore({ path: real }).close();
    const before = readFileSync(real);
    const alias = join(dir.path, "alias.db");
    symlinkSync(real, alias);

    expect(() => openSqliteStore({ path: alias })).toThrow(StoreFileTypeError);

    expect(readFileSync(real).equals(before)).toBe(true);
    // Positive control: the regular 0600 file the link points to opens.
    await openSqliteStore({ path: real }).close();
  });

  modeTest("a loose sidecar behind a symbolic link is refused", async () => {
    const real = join(dir.path, "real.db");
    const holder = openSqliteStore({ path: real });
    await holder.transaction((tx) => tx.putMemory(sampleMemory("m-1")));
    try {
      chmodSync(`${real}-wal`, 0o644);
      const alias = join(dir.path, "alias.db");
      symlinkSync(real, alias);

      expect(() => openSqliteStore({ path: alias })).toThrow(StoreFileTypeError);
      expect(() => openSqliteStore({ path: real })).toThrow(StoreFileModeError);
      chmodSync(`${real}-wal`, 0o600);
    } finally {
      await holder.close();
    }
  });

  modeTest("the files are checked again once SQLite has opened them", () => {
    // openDatabase alone, without createOwnerOnly first: only the check after opening runs.
    const path = join(dir.path, "relembra.db");
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(() => openDatabase(path, 100)).toThrow(StoreFileModeError);

    // Positive control: the same file at 0600 opens, and so do the sidecars SQLite creates.
    chmodSync(path, 0o600);
    openDatabase(path, 100).close();
  });

  test("a sidecar that is a symbolic link is refused", async () => {
    const path = join(dir.path, "store", "relembra.db");
    await openSqliteStore({ path }).close();
    const elsewhere = join(dir.path, "elsewhere");
    mkdirSync(elsewhere);
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      const target = join(elsewhere, "target");
      writeFileSync(target, "", { mode: 0o600 });
      symlinkSync(target, sidecar);

      expect(() => openSqliteStore({ path })).toThrow(StoreFileTypeError);

      // Remove only the link this test made, never its target.
      unlinkSync(sidecar);
      expect(existsSync(target)).toBe(true);
    }
    // Positive control: with regular sidecars (or none), the store opens.
    await openSqliteStore({ path }).close();
  });
});

describe("sqlite migrations", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });
  afterEach(() => db.close());

  const tables = () =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => name);

  test("a failing migration leaves the store at the version it had", () => {
    const first = { version: 1, sql: "CREATE TABLE first (x INTEGER)" };

    expect(() => migrate(db, [first, { version: 2, sql: "CREATE TABLE broken (" }])).toThrow();
    expect(schemaVersion(db)).toBe(0);
    expect(tables()).toEqual([]);

    // Positive control: the same steps with a valid second migration both apply.
    migrate(db, [first, { version: 2, sql: "CREATE TABLE second (x INTEGER)" }]);
    expect(schemaVersion(db)).toBe(2);
    expect(tables()).toEqual(["first", "schema_version", "second"]);
  });

  test("only migrations newer than the recorded version run", () => {
    migrate(db, [{ version: 1, sql: "CREATE TABLE first (x INTEGER)" }]);

    // Re-running version 1 would fail, because its table already exists.
    migrate(db, [
      { version: 1, sql: "CREATE TABLE first (x INTEGER)" },
      { version: 2, sql: "CREATE TABLE second (x INTEGER)" },
    ]);

    expect(schemaVersion(db)).toBe(2);
    expect(tables()).toEqual(["first", "schema_version", "second"]);
  });
});

/** One principal that reads, writes and owns both test scopes. */
const populatePolicy = (): Principal => ({
  id: "populator",
  readable: [SCOPE, OTHER_SCOPE],
  writable: [SCOPE, OTHER_SCOPE],
  promotable: [],
  owned: [SCOPE, OTHER_SCOPE],
});

const POPULATE_QUERIES = [
  "agents release",
  "migracao agente",
  "the",
  "branch deploys",
  "night dao",
];

/**
 * Notes, retracts, supersedes, summarizes and redacts in two scopes, and returns how many
 * memories are left live.
 */
async function populate(store: Store): Promise<{ live: number }> {
  let now = 0;
  let next = 0;
  const relembra = createRelembra<HostContext>({
    store,
    policy: populatePolicy,
    clock: { now: () => ++now },
    ids: { memoryId: () => `pop-${++next}`, opId: () => `pop-op-${++next}` },
  });
  const writer: HostContext = { user: "writer" };
  const texts = [
    "Agents deploy the release branch.",
    "The agent reviews each release.",
    "Migrações do banco rodam à noite.",
    "A migração do agente falhou.",
    "Does the dao run? The does.",
    "!!",
  ];
  const noted: Memory[] = [];
  for (const [i, text] of texts.entries()) {
    const scope = i % 2 === 0 ? SCOPE : OTHER_SCOPE;
    noted.push(await relembra.note(writer, { scope, text, provenance }));
  }
  const at = (i: number) => noted[i] as Memory;
  await relembra.retract(writer, { memoryId: at(1).id });
  await relembra.supersede(writer, {
    memoryId: at(0).id,
    text: "Agents deploy from the main branch.",
    provenance,
  });
  await relembra.submitSummary(writer, {
    scope: OTHER_SCOPE,
    sources: [{ memoryId: at(3).id, revision: 1 }],
    text: "Summary: the agent migration failed at night.",
    provenance,
  });
  await relembra.redact(writer, { memoryId: at(2).id });
  // Left live: 3, 4, 5, the replacement of 0, and the summary.
  return { live: 5 };
}

/** The term index tables of the file at `path`, every row, in key order. */
function termIndexRows(path: string) {
  const db = new DatabaseSync(path);
  try {
    return {
      scopes: db.prepare("SELECT * FROM term_scopes ORDER BY scope").all(),
      docs: db.prepare("SELECT * FROM term_docs ORDER BY position").all(),
      postings: db
        .prepare("SELECT * FROM term_postings ORDER BY scope, form, term, position")
        .all(),
    };
  } finally {
    db.close();
  }
}

/** The schema of a database (a path or an open handle): every table's and index's SQL. */
function schemaOf(source: string | DatabaseSync): string[] {
  const db = typeof source === "string" ? new DatabaseSync(source) : source;
  try {
    const rows = db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
      .all() as { type: string; name: string; sql: string }[];
    return rows.map((row) => `${row.type} ${row.name}: ${row.sql.replace(/\s+/g, " ")}`);
  } finally {
    if (typeof source === "string") db.close();
  }
}

function sampleMemory(id: string): Memory {
  return {
    id,
    scope: "files/a",
    seq: 1,
    pinned: false,
    notedAt: 1,
    status: "live",
    revision: {
      number: 1,
      text: "A fact.",
      at: 1,
      provenance: {
        agent: "a",
        harness: "h",
        model: "m",
        host: "h",
        trust: "agent",
        opId: `op-${id}`,
      },
    },
  };
}

describe("relembra on the sqlite store", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.remove());

  test("note, find and recall work end to end, and survive reopening the file", async () => {
    const path = join(dir.path, "store", "relembra.db");
    const store = openSqliteStore({ path });
    const relembra = createRelembra({ store, policy: hostPolicy });
    const build = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "The build uses Bun 1.4.", provenance },
    );
    const deploy = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "Deploys run from the release branch.", provenance },
    );
    const elsewhere = await relembra.note(
      { user: "outsider" },
      { scope: OTHER_SCOPE, text: "The build in the other repo uses Deno.", provenance },
    );

    const found = await relembra.find({ user: "reader" }, { query: "build" });
    expect(found.map((result) => result.memory)).toEqual([build]);
    // Positive control: the outsider finds the build memory of its own scope, and only that.
    const foreign = await relembra.find({ user: "outsider" }, { query: "build" });
    expect(foreign.map((result) => result.memory)).toEqual([elsewhere]);
    expect(await relembra.recall({ user: "reader" })).toEqual([deploy, build]);
    expect(deploy.seq).toBeGreaterThan(build.seq);
    await store.close();

    const reopened = openSqliteStore({ path });
    const again = createRelembra({ store: reopened, policy: hostPolicy });
    const refound = await again.find({ user: "reader" }, { query: "release branch" });
    expect(refound.map((result) => result.memory)).toEqual([deploy]);
    await reopened.close();
  });
});

describe("sqlite event format", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.remove());

  test("every persisted event body carries format 1", async () => {
    const path = join(dir.path, "store", "relembra.db");
    const store = openSqliteStore({ path });
    const relembra = createRelembra({ store, policy: hostPolicy });
    const noted = await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "Events carry a format version.", provenance },
    );
    await store.close();

    const raw = new DatabaseSync(path);
    try {
      const rows = raw.prepare("SELECT body FROM events").all() as { body: string }[];
      // Positive control: the event really is there, for the memory just noted.
      expect(rows).toHaveLength(1);
      const body = JSON.parse(rows[0]?.body ?? "{}");
      expect(body).toMatchObject({ kind: "note", memoryId: noted.id });
      expect(body.format).toBe(1);
    } finally {
      raw.close();
    }
  });
});

describe("host callbacks and sqlite transactions", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.remove());

  test("the policy, clock and ids never run while the store holds its write lock", async () => {
    const path = join(dir.path, "store", "relembra.db");
    const store = openSqliteStore({ path });
    const probe = new DatabaseSync(path);
    probe.exec("PRAGMA busy_timeout = 0");
    /** True when another connection holds the write lock, as an open store transaction does. */
    const locked = () => {
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
        return false;
      } catch {
        return true;
      }
    };
    const seen: string[] = [];
    const watch = <T>(name: string, value: T): T => {
      if (locked()) seen.push(name);
      return value;
    };
    try {
      // Positive control: the probe sees a transaction the store holds open.
      expect(await store.transaction(async () => locked())).toBe(true);
      expect(locked()).toBe(false);

      const relembra = createRelembra({
        store,
        policy: (context: HostContext) => watch("policy", hostPolicy(context)),
        clock: { now: () => watch("clock", 1_000) },
        ids: {
          memoryId: () => watch("memoryId", crypto.randomUUID()),
          opId: () => watch("opId", crypto.randomUUID()),
        },
      });
      await relembra.note(
        { user: "writer" },
        { scope: SCOPE, text: "Callbacks run first.", provenance },
      );
      await relembra.note(
        { user: "writer" },
        { scope: SCOPE, text: "Callbacks run first.", provenance, opId: "op-replayed" },
      );
      await relembra.note(
        { user: "writer" },
        { scope: SCOPE, text: "Callbacks run first.", provenance, opId: "op-replayed" },
      );

      expect(seen).toEqual([]);
      expect(await relembra.recall({ user: "reader" })).toHaveLength(2);
    } finally {
      probe.close();
      await store.close();
    }
  });
});
