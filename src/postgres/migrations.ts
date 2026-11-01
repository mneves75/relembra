import { SchemaTooNewError } from "../errors.js";
import type { SqlClient, SqlQuery } from "./client.js";

export { SchemaTooNewError };

/**
 * One forward-only schema step: statements run one at a time (a host's driver may not accept
 * several in one query), each given the store's schema name. Versions start at 1 and increase by 1.
 */
export interface Migration {
  readonly version: number;
  readonly statements: (schema: string) => readonly string[];
}

/**
 * Version 1 is SQLite's version 4, the first Postgres schema: the event log, the derived view,
 * tombstones, op records, fences, the erasure outbox, import checkpoints, ticket 19's term index,
 * and the store-lock row every mutation takes first (IMPLEMENTATION-PLAN §4.4). Each later version
 * matches the SQLite version after it: version 2 is SQLite's 5, version 3 SQLite's 6.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: (s) => [
      `CREATE TABLE ${s}.store_lock (id integer PRIMARY KEY CHECK (id = 1))`,
      `INSERT INTO ${s}.store_lock (id) VALUES (1)`,
      `CREATE TABLE ${s}.events (
        seq bigint PRIMARY KEY,
        kind text NOT NULL,
        memory_id text NOT NULL,
        scope text NOT NULL,
        body text NOT NULL
      )`,
      `CREATE INDEX events_by_memory ON ${s}.events (memory_id)`,
      `CREATE INDEX events_by_scope ON ${s}.events (scope, seq)`,
      `CREATE TABLE ${s}.memories (
        position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        scope text NOT NULL,
        seq bigint NOT NULL,
        pinned boolean NOT NULL,
        noted_at bigint NOT NULL,
        revision_number integer NOT NULL,
        text text NOT NULL,
        revised_at bigint NOT NULL,
        provenance text NOT NULL,
        status text NOT NULL CHECK (status IN ('live', 'retracted', 'superseded')),
        superseded_by text,
        sources text
      )`,
      `CREATE INDEX memories_by_scope ON ${s}.memories (scope, position)`,
      `CREATE TABLE ${s}.tombstones (
        id text PRIMARY KEY,
        scope text NOT NULL,
        seq bigint NOT NULL
      )`,
      `CREATE TABLE ${s}.ops (
        principal_id text NOT NULL,
        op_id text NOT NULL,
        fingerprint text,
        memory_id text NOT NULL,
        at bigint NOT NULL,
        seq bigint NOT NULL,
        PRIMARY KEY (principal_id, op_id)
      )`,
      `CREATE INDEX ops_by_memory ON ${s}.ops (memory_id)`,
      `CREATE TABLE ${s}.fences (
        key text PRIMARY KEY,
        epoch bigint NOT NULL
      )`,
      `CREATE TABLE ${s}.erasure_outbox (
        seq bigint PRIMARY KEY,
        memory_id text NOT NULL,
        carriers text NOT NULL
      )`,
      `CREATE TABLE ${s}.import_checkpoints (
        source text PRIMARY KEY,
        bytes bigint NOT NULL,
        width integer NOT NULL
      )`,
      `CREATE TABLE ${s}.term_scopes (
        scope text PRIMARY KEY,
        memories bigint NOT NULL,
        length_all bigint NOT NULL,
        length_kept bigint NOT NULL
      )`,
      `CREATE TABLE ${s}.term_docs (
        position bigint PRIMARY KEY,
        memory_id text NOT NULL,
        scope text NOT NULL,
        seq bigint NOT NULL,
        length_all integer NOT NULL,
        length_kept integer NOT NULL
      )`,
      `CREATE TABLE ${s}.term_postings (
        scope text NOT NULL,
        form smallint NOT NULL,
        term text NOT NULL,
        position bigint NOT NULL,
        count_all integer NOT NULL,
        count_kept integer NOT NULL,
        PRIMARY KEY (scope, form, term, position)
      )`,
      `CREATE INDEX term_postings_by_position ON ${s}.term_postings (position)`,
    ],
  },
  {
    // SQLite's version 5 (ticket 17): a promoted copy's origin, read by `derived` so redaction
    // reaches the copy. Each index matches one arm of `derived`'s OR (src/postgres/queries.ts):
    // with only one, the planner cannot combine them and scans the table.
    version: 2,
    statements: (s) => [
      `ALTER TABLE ${s}.memories ADD COLUMN origin text`,
      `CREATE INDEX memories_by_origin ON ${s}.memories (((origin::jsonb) ->> 'memoryId'))
        WHERE origin IS NOT NULL`,
      `CREATE INDEX memories_by_sources ON ${s}.memories
        USING gin ((sources::jsonb) jsonb_path_ops) WHERE sources IS NOT NULL`,
    ],
  },
  {
    // SQLite's version 6 (ticket 16): which carriers received which memories (ids only), and each
    // carrier's outcome per outbox row.
    version: 3,
    statements: (s) => [
      `CREATE TABLE ${s}.exposures (
        carrier_id text NOT NULL,
        memory_id text NOT NULL,
        carrier_kind text NOT NULL,
        first_seen bigint NOT NULL,
        PRIMARY KEY (carrier_id, memory_id)
      )`,
      `CREATE INDEX exposures_by_memory ON ${s}.exposures (memory_id)`,
      `CREATE TABLE ${s}.erasure_deliveries (
        seq bigint NOT NULL,
        carrier_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('acknowledged', 'unsupported')),
        settled_at bigint NOT NULL,
        PRIMARY KEY (seq, carrier_id)
      )`,
      `CREATE TABLE ${s}.erasure_pending (
        seq bigint NOT NULL,
        carrier_id text NOT NULL,
        carrier_kind text NOT NULL,
        PRIMARY KEY (seq, carrier_id)
      )`,
      `INSERT INTO ${s}.erasure_pending (seq, carrier_id, carrier_kind)
        SELECT o.seq, c.value ->> 'id', c.value ->> 'kind'
        FROM ${s}.erasure_outbox AS o, jsonb_array_elements(o.carriers::jsonb) AS c(value)`,
    ],
  },
];

/**
 * Brings `schema` up to the last migration (IMPLEMENTATION-PLAN §4.5). A schema newer than
 * `migrations` is refused before anything is written. Otherwise one transaction takes migration
 * ownership (a transaction-level advisory lock on the schema's name), creates the schema and the
 * version table if missing, rereads the version, and applies every pending migration with its
 * version row, so a failure leaves the schema as it was and concurrent openers apply each step
 * once.
 */
export async function migrate(
  client: SqlClient,
  schema: string,
  lockTimeoutMs: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error("migration versions must be 1, 2, 3, …");
  });
  const latest = migrations.length;
  if (checked(await schemaVersion(client, schema), latest) === latest) return;

  await client.transaction(async (q) => {
    // READ COMMITTED whatever the client's default, so the reread after the lock sees a migration
    // another opener committed while this one waited.
    await q.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await q.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
      `relembra migrate ${schema}`,
    ]);
    await q.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await q.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.schema_version (version integer PRIMARY KEY, applied_at bigint NOT NULL)`,
    );
    // Another opener may have migrated between the first read and the lock.
    const current = checked(await schemaVersion(q, schema), latest);
    for (const migration of migrations.slice(current)) {
      for (const statement of migration.statements(schema)) await q.query(statement);
      await q.query(
        `INSERT INTO ${schema}.schema_version (version, applied_at)
         VALUES ($1::integer, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)`,
        [migration.version],
      );
    }
  });
}

/** The highest applied version of `schema`, 0 when it has no version table. */
export async function schemaVersion(client: SqlQuery, schema: string): Promise<number> {
  const [table] = await client.query<{ found: string | null }>(
    "SELECT to_regclass($1::text)::text AS found",
    [`${schema}.schema_version`],
  );
  if (table?.found === null || table?.found === undefined) return 0;
  const [row] = await client.query<{ version: unknown }>(
    `SELECT coalesce(max(version), 0) AS version FROM ${schema}.schema_version`,
  );
  return Number(row?.version ?? 0);
}

function checked(version: number, latest: number): number {
  if (version > latest) throw new SchemaTooNewError(version, latest);
  return version;
}
