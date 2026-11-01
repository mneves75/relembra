import type { DatabaseSync } from "node:sqlite";
import { SchemaTooNewError } from "../errors.js";
import { backfillTermIndex, TERM_INDEX_SQL } from "./term-index.js";

export { SchemaTooNewError };

/** One forward-only schema step. Versions start at 1 and increase by 1. */
export interface Migration {
  readonly version: number;
  readonly sql: string;
  /** Fills what `sql` created from the data already there, in the same transaction. */
  readonly backfill?: (db: DatabaseSync) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        body TEXT NOT NULL
      ) STRICT;
      CREATE INDEX events_by_memory ON events (memory_id);
      CREATE TABLE memories (
        position INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        seq INTEGER NOT NULL,
        pinned INTEGER NOT NULL,
        noted_at INTEGER NOT NULL,
        revision_number INTEGER NOT NULL,
        text TEXT NOT NULL,
        revised_at INTEGER NOT NULL,
        provenance TEXT NOT NULL
      ) STRICT;
      CREATE INDEX memories_by_scope ON memories (scope, position);
      CREATE TABLE ops (
        principal_id TEXT NOT NULL,
        op_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (principal_id, op_id)
      ) STRICT;
      CREATE TABLE fences (
        key TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    // Ticket 06: memory status, summaries, tombstones, scrubbed op fingerprints, erasure outbox.
    version: 2,
    sql: `
      ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'live';
      ALTER TABLE memories ADD COLUMN superseded_by TEXT;
      ALTER TABLE memories ADD COLUMN sources TEXT;
      CREATE TABLE tombstones (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        seq INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE ops_v2 (
        principal_id TEXT NOT NULL,
        op_id TEXT NOT NULL,
        fingerprint TEXT,
        memory_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (principal_id, op_id)
      ) STRICT;
      INSERT INTO ops_v2 (principal_id, op_id, fingerprint, memory_id, at, seq)
        SELECT principal_id, op_id, fingerprint, memory_id, at, seq FROM ops;
      DROP TABLE ops;
      ALTER TABLE ops_v2 RENAME TO ops;
      CREATE INDEX ops_by_memory ON ops (memory_id);
      CREATE TABLE erasure_outbox (
        seq INTEGER PRIMARY KEY,
        memory_id TEXT NOT NULL,
        carriers TEXT NOT NULL
      ) STRICT;
      CREATE TABLE wal_scrub (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        redacted INTEGER NOT NULL,
        scrubbed INTEGER NOT NULL
      ) STRICT;
      INSERT INTO wal_scrub (id, redacted, scrubbed) VALUES (1, 0, 0);
    `,
  },
  {
    // Ticket 08: import checkpoints, and events read by scope for the export.
    version: 3,
    sql: `
      CREATE TABLE import_checkpoints (
        source TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL,
        width INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX events_by_scope ON events (scope, seq);
    `,
  },
  {
    // Ticket 19: the term index find reads, built from every live memory already stored.
    version: 4,
    sql: TERM_INDEX_SQL,
    backfill: backfillTermIndex,
  },
  {
    // Ticket 17: a promoted copy's origin, read by `derived` so redaction reaches the copy.
    version: 5,
    sql: `
      ALTER TABLE memories ADD COLUMN origin TEXT;
      CREATE INDEX memories_by_origin ON memories (json_extract(origin, '$.memoryId'))
        WHERE origin IS NOT NULL;
    `,
  },
  {
    // Ticket 16: which carriers received which memories (ids only), each carrier's outcome per
    // outbox row, and the carriers still pending (no outcome), which delivery reads by seq.
    version: 6,
    sql: `
      CREATE TABLE exposures (
        carrier_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        carrier_kind TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (carrier_id, memory_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX exposures_by_memory ON exposures (memory_id);
      CREATE TABLE erasure_deliveries (
        seq INTEGER NOT NULL,
        carrier_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('acknowledged', 'unsupported')),
        settled_at INTEGER NOT NULL,
        PRIMARY KEY (seq, carrier_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE erasure_pending (
        seq INTEGER NOT NULL,
        carrier_id TEXT NOT NULL,
        carrier_kind TEXT NOT NULL,
        PRIMARY KEY (seq, carrier_id)
      ) STRICT, WITHOUT ROWID;
      INSERT INTO erasure_pending (seq, carrier_id, carrier_kind)
        SELECT o.seq, json_extract(c.value, '$.id'), json_extract(c.value, '$.kind')
        FROM erasure_outbox AS o, json_each(o.carriers) AS c;
    `,
  },
];

/**
 * Brings the database up to the last migration. Every pending migration and its schema_version
 * row commit in one transaction, so a failure leaves the store at the version it had.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error("migration versions must be 1, 2, 3, …");
  });
  const latest = migrations.length;
  if (checkedVersion(db, latest) === latest) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    // Another process may have migrated between the first check and the lock.
    const current = checkedVersion(db, latest);
    const record = db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)");
    for (const migration of migrations.slice(current)) {
      db.exec(migration.sql);
      migration.backfill?.(db);
      record.run(migration.version, Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** The highest applied version, 0 for a new file. */
export function schemaVersion(db: DatabaseSync): number {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (table === undefined) return 0;
  const { version } = db
    .prepare("SELECT coalesce(max(version), 0) AS version FROM schema_version")
    .get() as { version: number };
  return version;
}

function checkedVersion(db: DatabaseSync, latest: number): number {
  const version = schemaVersion(db);
  if (version > latest) throw new SchemaTooNewError(version, latest);
  return version;
}
