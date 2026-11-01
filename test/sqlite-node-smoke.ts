/**
 * Runs the stores under Node with node:test (not bun test): the conformance suite on both, then a
 * write and read back through a fresh file. Run with `bun run test:node`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { openSqliteStore, SchemaTooNewError } from "relembra/sqlite";
import { createMemoryStore, storeConformanceCases } from "relembra/testing";
import { createOwnerOnly, openDatabase } from "../src/sqlite/database.js";
import { MIGRATIONS } from "../src/sqlite/migrations.js";
import { INTERLEAVINGS, openDuringUpgrade } from "./sqlite-race-support.js";
import { sqliteTarget, tempDir } from "./sqlite-support.js";

/** A schema version newer than this relembra supports. */
const FUTURE = MIGRATIONS.length + 1;

describe("a store converted to WAL and upgraded concurrently is refused under node", () => {
  for (const interleaving of INTERLEAVINGS) {
    test(interleaving, async () => {
      const dir = tempDir();
      try {
        const { before, after, refusal } = await openDuringUpgrade(
          join(dir.path, "relembra.db"),
          interleaving,
        );
        assert.ok(refusal instanceof SchemaTooNewError, String(refusal));
        assert.notEqual(before?.[1], null);
        assert.deepEqual(after.slice(0, 2), (before ?? []).slice(0, 2));
        assert.notEqual(after[2], null);
      } finally {
        dir.remove();
      }
    });
  }
});

describe("store conformance: memory store under node", () => {
  const cases = storeConformanceCases({ open: () => ({ store: createMemoryStore(), close() {} }) });
  for (const conformance of cases) test(conformance.name, () => conformance.run());
});

describe("store conformance: sqlite store under node", () => {
  for (const conformance of storeConformanceCases(sqliteTarget)) {
    test(conformance.name, () => conformance.run());
  }
});

test("a store created under node is owner-only and keeps what it wrote", async () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "home", "relembra.db");
    const store = openSqliteStore({ path });
    const noted = {
      id: "m-node",
      scope: "node/smoke",
      seq: 7,
      pinned: false,
      notedAt: 1,
      status: "live" as const,
      revision: {
        number: 1,
        text: "Written under Node.",
        at: 1,
        provenance: {
          agent: "a",
          harness: "h",
          model: "m",
          host: "h",
          trust: "agent" as const,
          opId: "op-node",
        },
      },
    };
    await store.transaction((tx) => tx.putMemory(noted));
    await store.close();

    assert.equal(statSync(join(dir.path, "home")).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const reopened = openSqliteStore({ path });
    assert.deepEqual(await reopened.recall({ scopes: ["node/smoke"], limit: 5 }), [noted]);
    await reopened.close();
  } finally {
    dir.remove();
  }
});

test("under node a newer store in WAL mode is refused without creating or changing a file", async () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "relembra.db");
    await openSqliteStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${FUTURE}, 0)`);
    raw.close();
    const before = readFileSync(path);

    assert.throws(() => openSqliteStore({ path }), { name: "SchemaTooNewError" });

    assert.ok(readFileSync(path).equals(before));
    assert.deepEqual([existsSync(`${path}-wal`), existsSync(`${path}-shm`)], [false, false]);
    // Positive control: the same file at the current version opens.
    const fix = new DatabaseSync(path);
    fix.exec(`DELETE FROM schema_version WHERE version = ${FUTURE}`);
    fix.close();
    await openSqliteStore({ path }).close();
  } finally {
    dir.remove();
  }
});

test("under node a store that stays torn is retried for the busy timeout, then refused, changing no file", async () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "relembra.db");
    await openSqliteStore({ path }).close();
    const full = readFileSync(path);
    writeFileSync(path, full.subarray(0, 4096));
    const torn = readFileSync(path);

    const started = Date.now();
    assert.throws(
      () => openSqliteStore({ path, busyTimeoutMs: 300 }),
      (error: { errcode?: number; message?: string }) =>
        ((error.errcode ?? 0) & 0xff) === 11 && /malformed/.test(error.message ?? ""),
    );
    assert.ok(Date.now() - started >= 300);

    assert.ok(readFileSync(path).equals(torn));
    assert.deepEqual([existsSync(`${path}-wal`), existsSync(`${path}-shm`)], [false, false]);
    // Positive control: the whole file opens.
    writeFileSync(path, full);
    await openSqliteStore({ path, busyTimeoutMs: 300 }).close();
  } finally {
    dir.remove();
  }
});

test("under node the store's connection is defensive, WAL and synchronous=FULL", () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "relembra.db");
    createOwnerOnly(path);
    const db = openDatabase(path, 100);
    try {
      assert.deepEqual({ ...db.prepare("PRAGMA journal_mode").get() }, { journal_mode: "wal" });
      assert.deepEqual({ ...db.prepare("PRAGMA synchronous").get() }, { synchronous: 2 });
      db.exec("PRAGMA schema_version = 42");
      assert.notDeepEqual({ ...db.prepare("PRAGMA schema_version").get() }, { schema_version: 42 });
    } finally {
      db.close();
    }
    // Control: defensive:false allows the same write.
    const loose = new DatabaseSync(path, { defensive: false });
    loose.exec("PRAGMA schema_version = 42");
    assert.deepEqual({ ...loose.prepare("PRAGMA schema_version").get() }, { schema_version: 42 });
    loose.close();
  } finally {
    dir.remove();
  }
});

test("under node an export imports into an empty store, and an OptMem log imports once", async () => {
  const { createRelembra, exportJsonl, importJsonl, importOptmem } = await import("relembra");
  const scope = "node/transfer";
  const principal = {
    id: "p",
    readable: [scope],
    writable: [scope],
    promotable: [],
    owned: [scope],
  };
  const source = createMemoryStore();
  const relembra = createRelembra({ store: source, policy: () => principal });
  const provenance = { agent: "a", harness: "h", model: "m", host: "h" };
  const kept = await relembra.note(null, {
    scope,
    text: "Configuração em config.toml 😀.",
    provenance,
  });
  const gone = await relembra.note(null, { scope, text: "Redacted under Node.", provenance });
  await relembra.redact(null, { memoryId: gone.id });

  const jsonl = await exportJsonl(source, principal, { scope });
  assert.ok(!jsonl.includes("Redacted under Node."));
  const target = createMemoryStore();
  assert.deepEqual(await importJsonl(target, principal, jsonl), {
    imported: 3,
    skipped: 0,
    refused: [],
  });
  const copy = await createRelembra({ store: target, policy: () => principal }).zoom(null, {
    memoryId: kept.id,
  });
  assert.equal(
    copy.status === "redacted" ? "" : copy.revision.text,
    "Configuração em config.toml 😀.",
  );
  assert.equal((await importJsonl(target, principal, jsonl)).imported, 0);

  const log = readFileSync(join(import.meta.dirname, "fixtures", "optmem", "memory", "LOG.txt"));
  const input = { scope, store: "fixture", log, provenance };
  assert.deepEqual(await importOptmem(target, principal, input), {
    imported: 6,
    skipped: 0,
    refused: [],
  });
  assert.deepEqual(await importOptmem(target, principal, input), {
    imported: 0,
    skipped: 6,
    refused: [],
  });
});
