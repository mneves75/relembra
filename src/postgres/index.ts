import { StoreBusyError } from "../errors.js";
import { detachEvent } from "../frozen.js";
import {
  type Event,
  type Memory,
  type MemoryStatus,
  type OpRecord,
  type Provenance,
  redactedEvent,
  type SourceRevision,
} from "../model.js";
import type {
  Carrier,
  CarrierOutcome,
  CarrierSettlement,
  ErasureWork,
  Store,
  StoreTransaction,
} from "../ports.js";
import { type SqlClient, type SqlQuery, sqlState } from "./client.js";
import { MIGRATIONS, migrate } from "./migrations.js";
import { derivedQuery } from "./queries.js";
import { indexMemory, readIndex, unindexMemory } from "./term-index.js";

export { SchemaTooNewError, StoreBusyError } from "../errors.js";
export type { SqlClient, SqlQuery } from "./client.js";

export interface PostgresStoreOptions {
  /** The host's SQL client (see SqlClient); relembra opens no connection of its own. */
  readonly client: SqlClient;
  /**
   * The schema that holds the store's tables, created if missing: lower-case letters, digits and
   * underscores, starting with a letter or underscore, at most 63 bytes. Default `relembra`.
   */
  readonly schema?: string;
  /**
   * How long a transaction waits for the store lock, or any other lock, before it fails with
   * StoreBusyError (Postgres `lock_timeout`). Default 5000.
   */
  readonly lockTimeoutMs?: number;
  /**
   * How many times a transaction, recordExposure's included, runs in all when Postgres aborts it
   * with a serialization failure (40001) or a deadlock (40P01), or its COMMIT got no answer after
   * it wrote an op record (it then runs again, so the op-id check resolves it). Then it fails with
   * StoreRetryError. Default 5.
   */
  readonly maxAttempts?: number;
}

/**
 * A transaction's work finished but its COMMIT failed without an answer from the server (the
 * connection was lost), and it wrote no op record that could show whether it landed. A write with
 * an op id is resolved by that id instead (the store runs it again, and the op-id check returns
 * the persisted outcome or refuses a conflicting payload), so this reaches only writes without
 * one (retract, redact, sweep, fence advances, imports). Check the store, or retry: those writes
 * have no second effect.
 */
export class StoreCommitUnknownError extends Error {
  override readonly name = "StoreCommitUnknownError";
  constructor(options: { cause: unknown }) {
    super("the store lost the connection during COMMIT; whether it committed is unknown", options);
  }
}

/** The store gave up after `attempts` serialization failures, deadlocks or lost commits. */
export class StoreRetryError extends Error {
  override readonly name = "StoreRetryError";
  readonly attempts: number;
  constructor(attempts: number, options: { cause: unknown }) {
    super(`the store transaction did not commit after ${attempts} attempts`, options);
    this.attempts = attempts;
  }
}

const DEFAULT_SCHEMA = "relembra";
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_LOCK_TIMEOUT_MS = 2_147_483_647;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const RETRYABLE = new Set(["40001", "40P01"]);
const MEMORY_COLUMNS =
  "id, scope, seq, pinned, noted_at, revision_number, text, revised_at, provenance, status, superseded_by, sources, origin";

/**
 * Opens (and creates or migrates) a relembra store in a Postgres schema, through the host's
 * SqlClient. Rejects with SchemaTooNewError, having written nothing, when a newer relembra wrote
 * the schema.
 *
 * Contention (IMPLEMENTATION-PLAN §4.4): every transaction runs at READ COMMITTED, whatever the
 * client's default, first locks the store's one lock row (`SELECT … FOR UPDATE`), then reads and
 * writes through the same connection, so transactions on the store, from any process or machine,
 * run one at a time and each statement sees every earlier commit. The client must therefore send
 * nothing inside the transaction before `work` runs.
 * Reads outside a transaction (recall, liveMemories, events, erasures) are single statements;
 * findByTerms reads its index and memories in one REPEATABLE READ snapshot.
 *
 * Time: StoreTransaction.now reads the database clock after the lock, so writes are accepted, and
 * retention counts, by one clock for every host.
 *
 * Erasure: a redaction removes the memory's text from every table and index row relembra keeps,
 * and scrubs its op fingerprints, in the redaction's transaction. Postgres keeps the old row
 * versions in the table and index files until VACUUM reclaims them, and VACUUM marks the space
 * free without overwriting it; the WAL, replicas, archives and backups keep their copies. Those
 * are the database operator's to erase (VACUUM FULL rewrites the tables).
 */
export async function openPostgresStore(options: PostgresStoreOptions): Promise<Store> {
  const { client } = options;
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_NAME.test(schema)) {
    throw new RangeError(
      "a Postgres schema name must be 1 to 63 lower-case letters, digits or underscores, not starting with a digit",
    );
  }
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(lockTimeoutMs) ||
    lockTimeoutMs < 1 ||
    lockTimeoutMs > MAX_LOCK_TIMEOUT_MS
  ) {
    throw new RangeError(`lockTimeoutMs must be an integer from 1 to ${MAX_LOCK_TIMEOUT_MS}`);
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  try {
    await migrate(client, schema, lockTimeoutMs, MIGRATIONS);
  } catch (error) {
    throw asStoreBusy(error, lockTimeoutMs);
  }
  const s = schema;
  // The advisory lock that orders exposure recordings against redactions (see recordExposure).
  const exposureLock = `relembra exposures ${schema}`;

  /** One attempt: the lock row, then `work` on the transaction's connection. */
  const attempt = <T>(work: (tx: StoreTransaction) => Promise<T>, outcome: Attempt<T>) =>
    client.transaction(async (q) => {
      // READ COMMITTED whatever the client's default: each statement after the lock then reads
      // every commit before it. Under REPEATABLE READ or SERIALIZABLE the snapshot would date from
      // before the lock wait, and locking an unchanged row does not refresh it, so a fence a
      // takeover advanced meanwhile would read as it was.
      await q.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await q.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      await q.query(`SELECT id FROM ${s}.store_lock WHERE id = 1 FOR UPDATE`);
      let open = true;
      let exposuresLocked = false;
      const use = (): SqlQuery => {
        if (!open) throw new Error("store transaction used after it ended");
        return q;
      };
      const write = (): SqlQuery => {
        const handle = use();
        outcome.wrote = true;
        return handle;
      };
      const tx: StoreTransaction = {
        async now() {
          const [row] = await use().query<{ now: unknown }>(
            "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now",
          );
          return Number(row?.now);
        },
        async append(event) {
          const [row] = await write().query<{ seq: unknown }>(
            `INSERT INTO ${s}.events (seq, kind, memory_id, scope, body)
             SELECT coalesce(max(seq), 0) + 1, $1::text, $2::text, $3::text, $4::text FROM ${s}.events
             RETURNING seq`,
            [event.kind, event.memoryId, event.scope, JSON.stringify(event)],
          );
          return detachEvent(event, Number(row?.seq));
        },
        async putMemory(memory) {
          const handle = write();
          // Whatever the status change, the index ends up holding the memory exactly when live.
          await unindexMemory(handle, s, memory.id);
          const [row] = await handle.query<{ position: unknown }>(
            `INSERT INTO ${s}.memories (${MEMORY_COLUMNS})
             VALUES ($1::text, $2::text, $3::bigint, $4::boolean, $5::bigint, $6::integer, $7::text,
                     $8::bigint, $9::text, $10::text, $11::text, $12::text, $13::text)
             ON CONFLICT (id) DO UPDATE SET
               scope = excluded.scope,
               seq = excluded.seq,
               pinned = excluded.pinned,
               noted_at = excluded.noted_at,
               revision_number = excluded.revision_number,
               text = excluded.text,
               revised_at = excluded.revised_at,
               provenance = excluded.provenance,
               status = excluded.status,
               superseded_by = excluded.superseded_by,
               sources = excluded.sources,
               origin = excluded.origin
             RETURNING position`,
            memoryRow(memory),
          );
          if (memory.status === "live") {
            await indexMemory(handle, s, Number(row?.position), {
              ...memory,
              text: memory.revision.text,
            });
          }
        },
        async memory(id) {
          const handle = use();
          const [row] = await handle.query<MemoryRow>(
            `SELECT ${MEMORY_COLUMNS} FROM ${s}.memories WHERE id = $1::text`,
            [id],
          );
          if (row !== undefined) return memoryFromRow(row);
          const [tombstone] = await handle.query<{ id: string; scope: string; seq: unknown }>(
            `SELECT id, scope, seq FROM ${s}.tombstones WHERE id = $1::text`,
            [id],
          );
          return tombstone === undefined
            ? undefined
            : {
                id: tombstone.id,
                scope: tombstone.scope,
                seq: Number(tombstone.seq),
                status: "redacted",
              };
        },
        async derived(id) {
          const rows = await use().query<{ id: string }>(derivedQuery(s), [id]);
          return rows.map((row) => row.id);
        },
        async expiring(scope, before) {
          const rows = await use().query<MemoryRow>(
            `SELECT ${MEMORY_COLUMNS} FROM ${s}.memories
             WHERE scope = $1::text AND noted_at < $2::bigint ORDER BY position`,
            [scope, before],
          );
          return rows.map(memoryFromRow);
        },
        async redact({ id, scope, seq }) {
          const handle = write();
          await unindexMemory(handle, s, id);
          await handle.query(`DELETE FROM ${s}.memories WHERE id = $1::text`, [id]);
          await handle.query(
            `INSERT INTO ${s}.tombstones (id, scope, seq) VALUES ($1::text, $2::text, $3::bigint)`,
            [id, scope, seq],
          );
          const events = await handle.query<{ seq: unknown; body: string }>(
            `SELECT seq, body FROM ${s}.events WHERE memory_id = $1::text`,
            [id],
          );
          for (const row of events) {
            const event = { ...JSON.parse(row.body), seq: Number(row.seq) } as Event;
            const rewritten = redactedEvent(event);
            if (rewritten === event) continue;
            const { seq: eventSeq, ...body } = rewritten;
            await handle.query(`UPDATE ${s}.events SET body = $1::text WHERE seq = $2::bigint`, [
              JSON.stringify(body),
              eventSeq,
            ]);
          }
          await handle.query(`UPDATE ${s}.ops SET fingerprint = NULL WHERE memory_id = $1::text`, [
            id,
          ]);
        },
        async putErasure(work) {
          const carriers = work.carriers.map(({ id, kind }) => ({ id, kind }));
          const handle = write();
          await handle.query(
            `INSERT INTO ${s}.erasure_outbox (seq, memory_id, carriers) VALUES ($1::bigint, $2::text, $3::text)`,
            [work.seq, work.memoryId, JSON.stringify(carriers)],
          );
          if (carriers.length === 0) return;
          await handle.query(
            `INSERT INTO ${s}.erasure_pending (seq, carrier_id, carrier_kind)
             SELECT $1::bigint, c.value ->> 'id', c.value ->> 'kind'
             FROM jsonb_array_elements($2::text::jsonb) AS c(value)`,
            [work.seq, JSON.stringify(carriers)],
          );
        },
        async exposures(memoryId) {
          const handle = use();
          if (!exposuresLocked) {
            // Exclusive until this transaction ends: a recorder holds the shared lock from before
            // its insert until its commit, so every recording either committed before this read
            // or commits after this transaction, and then finds the tombstone.
            await handle.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
              exposureLock,
            ]);
            exposuresLocked = true;
          }
          const rows = await handle.query<{ carrier_id: string; carrier_kind: string }>(
            `SELECT carrier_id, carrier_kind FROM ${s}.exposures WHERE memory_id = $1::text`,
            [memoryId],
          );
          return rows.map((row) => ({ id: row.carrier_id, kind: row.carrier_kind }));
        },
        async settle({ seq, carrierId, status, at }) {
          const handle = write();
          await handle.query(
            `INSERT INTO ${s}.erasure_deliveries (seq, carrier_id, status, settled_at)
             VALUES ($1::bigint, $2::text, $3::text, $4::bigint)
             ON CONFLICT (seq, carrier_id) DO NOTHING`,
            [seq, carrierId, status, at],
          );
          await handle.query(
            `DELETE FROM ${s}.erasure_pending WHERE seq = $1::bigint AND carrier_id = $2::text`,
            [seq, carrierId],
          );
        },
        async op(principalId, opId) {
          const [row] = await use().query<OpRow>(
            `SELECT principal_id, op_id, fingerprint, memory_id, at, seq FROM ${s}.ops
             WHERE principal_id = $1::text AND op_id = $2::text`,
            [principalId, opId],
          );
          return row === undefined ? undefined : opFromRow(row);
        },
        async putOp(record) {
          // The primary key refuses a second record for the same principal and op id.
          await write().query(
            `INSERT INTO ${s}.ops (principal_id, op_id, fingerprint, memory_id, at, seq)
             VALUES ($1::text, $2::text, $3::text, $4::text, $5::bigint, $6::bigint)`,
            [
              record.principalId,
              record.opId,
              record.fingerprint ?? null,
              record.memoryId,
              record.at,
              record.seq,
            ],
          );
          outcome.ops.push(record);
        },
        async fenceEpoch(key) {
          const [row] = await use().query<{ epoch: unknown }>(
            `SELECT epoch FROM ${s}.fences WHERE key = $1::text`,
            [key],
          );
          return row === undefined ? undefined : Number(row.epoch);
        },
        async putFence({ key, epoch }) {
          await write().query(
            `INSERT INTO ${s}.fences (key, epoch) VALUES ($1::text, $2::bigint)
             ON CONFLICT (key) DO UPDATE SET epoch = excluded.epoch`,
            [key, epoch],
          );
        },
        async checkpoint(source) {
          const [row] = await use().query<{ source: string; bytes: unknown; width: unknown }>(
            `SELECT source, bytes, width FROM ${s}.import_checkpoints WHERE source = $1::text`,
            [source],
          );
          return row === undefined
            ? undefined
            : { source: row.source, bytes: Number(row.bytes), width: Number(row.width) };
        },
        async putCheckpoint({ source, bytes, width }) {
          await write().query(
            `INSERT INTO ${s}.import_checkpoints (source, bytes, width)
             VALUES ($1::text, $2::bigint, $3::integer)
             ON CONFLICT (source) DO UPDATE SET bytes = excluded.bytes, width = excluded.width`,
            [source, bytes, width],
          );
        },
      };
      try {
        const result = await work(tx);
        outcome.finished = { result };
        return result;
      } finally {
        open = false;
      }
    });

  /** A read that must see one snapshot: REPEATABLE READ, read only, on one connection. */
  const snapshot = <T>(read: (q: SqlQuery) => Promise<T>) =>
    client.transaction(async (q) => {
      await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return read(q);
    });

  return {
    async transaction<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> {
      for (let attempts = 1; ; attempts++) {
        const outcome: Attempt<T> = { wrote: false, ops: [], finished: undefined };
        let retry: unknown;
        try {
          return await attempt(work, outcome);
        } catch (error) {
          const state = sqlState(error);
          if (state !== undefined && RETRYABLE.has(state)) {
            retry = error;
          } else if (outcome.finished !== undefined && noAnswer(state)) {
            // The work finished and the COMMIT got no answer. Nothing written, nothing to resolve.
            if (!outcome.wrote) return outcome.finished.result;
            if (outcome.ops.length === 0) throw new StoreCommitUnknownError({ cause: error });
            // It wrote an op record: run it again. If the first attempt landed, or another commit
            // holds the op id, the op-id check reads that record (its fingerprint, the persisted
            // outcome, a redaction since) instead of trusting this attempt's result.
            retry = error;
          } else {
            throw asStoreBusy(error, lockTimeoutMs);
          }
        }
        if (attempts >= maxAttempts) throw new StoreRetryError(attempts, { cause: retry });
        await pause(attempts);
      }
    },

    async recall({ scopes, limit, retracted = [] }) {
      const rows = await client.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM ${s}.memories
         WHERE scope IN (SELECT jsonb_array_elements_text($1::text::jsonb))
           AND (status = 'live'
             OR (status = 'retracted' AND scope IN (SELECT jsonb_array_elements_text($2::text::jsonb))))
         ORDER BY position DESC
         LIMIT $3::bigint`,
        [JSON.stringify(scopes), JSON.stringify(retracted), limit],
      );
      return rows.map(memoryFromRow);
    },

    async liveMemories({ scopes }) {
      const rows = await client.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM ${s}.memories
         WHERE scope IN (SELECT jsonb_array_elements_text($1::text::jsonb)) AND status = 'live'`,
        [JSON.stringify(scopes)],
      );
      return rows.map(memoryFromRow);
    },

    async findByTerms({ scopes, terms, choose }) {
      const unique = [...new Set(scopes)];
      const { chosen, rows } = await snapshot(async (q) => {
        const picked = choose(await readIndex(q, s, unique, terms));
        const loaded = await q.query<MemoryRow>(
          `SELECT ${MEMORY_COLUMNS} FROM ${s}.memories
           WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
             AND scope IN (SELECT jsonb_array_elements_text($2::text::jsonb))
             AND status = 'live'`,
          [JSON.stringify(picked), JSON.stringify(unique)],
        );
        return { chosen: picked, rows: loaded };
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return chosen.flatMap((id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [memoryFromRow(row)];
      });
    },

    async erasures() {
      const rows = await client.query<{ seq: unknown; memory_id: string; carriers: string }>(
        `SELECT seq, memory_id, carriers FROM ${s}.erasure_outbox ORDER BY seq`,
      );
      return rows.map(
        (row): ErasureWork => ({
          seq: Number(row.seq),
          memoryId: row.memory_id,
          carriers: JSON.parse(row.carriers) as Carrier[],
        }),
      );
    },

    async pendingErasures({ after = 0, limit }) {
      // The page's seqs come from the primary key; only pending rows are read.
      const rows = await client.query<{
        seq: unknown;
        memory_id: string;
        carrier_id: string;
        carrier_kind: string;
      }>(
        `SELECT p.seq, o.memory_id, p.carrier_id, p.carrier_kind
         FROM ${s}.erasure_pending AS p JOIN ${s}.erasure_outbox AS o ON o.seq = p.seq
         WHERE p.seq IN (
           SELECT DISTINCT seq FROM ${s}.erasure_pending
           WHERE seq > $1::bigint ORDER BY seq LIMIT $2::bigint)
         ORDER BY p.seq, p.carrier_id COLLATE "C"`,
        [after, limit],
      );
      const work: { seq: number; memoryId: string; carriers: Carrier[] }[] = [];
      for (const row of rows) {
        const seq = Number(row.seq);
        const carrier = { id: row.carrier_id, kind: row.carrier_kind };
        const last = work.at(-1);
        if (last?.seq === seq) last.carriers.push(carrier);
        else work.push({ seq, memoryId: row.memory_id, carriers: [carrier] });
      }
      return work;
    },

    async pendingErasureCount() {
      const [row] = await client.query<{ work: unknown; carriers: unknown }>(
        `SELECT count(DISTINCT seq) AS work, count(*) AS carriers FROM ${s}.erasure_pending`,
      );
      return { work: Number(row?.work ?? 0), carriers: Number(row?.carriers ?? 0) };
    },

    async settlements() {
      const rows = await client.query<{
        seq: unknown;
        carrier_id: string;
        status: string;
        settled_at: unknown;
      }>(`SELECT seq, carrier_id, status, settled_at FROM ${s}.erasure_deliveries`);
      return rows.map(
        (row): CarrierSettlement => ({
          seq: Number(row.seq),
          carrierId: row.carrier_id,
          status: row.status as CarrierOutcome,
          at: Number(row.settled_at),
        }),
      );
    },

    async recordExposure({ carrier, memoryIds, at }) {
      const ids = JSON.stringify(memoryIds);
      // Not the store lock row: recorders run concurrently with each other and with any store
      // transaction but a redaction's exposures read (StoreTransaction.exposures), which holds
      // the exclusive side of this advisory lock until it commits.
      for (let attempts = 1; ; attempts++) {
        try {
          const redacted = await client.transaction(async (q) => {
            await q.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
            await q.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
            await q.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))", [
              exposureLock,
            ]);
            await q.query(
              `INSERT INTO ${s}.exposures (carrier_id, memory_id, carrier_kind, first_seen)
               SELECT $1::text, value, $2::text, $3::bigint
               FROM jsonb_array_elements_text($4::text::jsonb) AS value
               ON CONFLICT (carrier_id, memory_id) DO NOTHING`,
              [carrier.id, carrier.kind, at, ids],
            );
            // A new statement, so it reads every redaction committed before this lock was granted.
            return q.query<{ id: string }>(
              `SELECT id FROM ${s}.tombstones
               WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
              [ids],
            );
          });
          const found = new Set(redacted.map((row) => row.id));
          return memoryIds.filter((id) => found.has(id));
        } catch (error) {
          const state = sqlState(error);
          if (state === undefined || !RETRYABLE.has(state)) throw asStoreBusy(error, lockTimeoutMs);
          if (attempts >= maxAttempts) throw new StoreRetryError(attempts, { cause: error });
          await pause(attempts);
        }
      }
    },

    async events({ scopes }) {
      const rows = await client.query<{ seq: unknown; body: string }>(
        `SELECT seq, body FROM ${s}.events
         WHERE scope IN (SELECT jsonb_array_elements_text($1::text::jsonb))
         ORDER BY seq`,
        [JSON.stringify(scopes)],
      );
      return rows.map((row) => ({ ...JSON.parse(row.body), seq: Number(row.seq) }) as Event);
    },
  };
}

/** What one attempt did, read after it fails. */
interface Attempt<T> {
  wrote: boolean;
  readonly ops: OpRecord[];
  /** Set when the work resolved, before the COMMIT. */
  finished: { readonly result: T } | undefined;
}

/**
 * Whether an error is a lost answer rather than the server's refusal: no SQLSTATE at all, a
 * connection exception (class 08), or the server shutting the connection (57P01 to 57P03).
 */
function noAnswer(state: string | undefined): boolean {
  return state === undefined || state.startsWith("08") || /^57P0[1-3]$/.test(state);
}

/** A lock timeout (55P03) as StoreBusyError; any other error as it is. */
function asStoreBusy(error: unknown, lockTimeoutMs: number): unknown {
  return sqlState(error) === "55P03" ? new StoreBusyError(lockTimeoutMs, { cause: error }) : error;
}

/** A short, growing, jittered wait before attempt `attempts + 1`. */
function pause(attempts: number): Promise<void> {
  const ceiling = Math.min(2 ** attempts, 64);
  return new Promise((done) => setTimeout(done, ceiling / 2 + Math.random() * ceiling));
}

function memoryRow(memory: Memory): unknown[] {
  return [
    memory.id,
    memory.scope,
    memory.seq,
    memory.pinned,
    memory.notedAt,
    memory.revision.number,
    memory.revision.text,
    memory.revision.at,
    JSON.stringify(memory.revision.provenance),
    memory.status,
    memory.supersededBy ?? null,
    memory.sources === undefined ? null : JSON.stringify(memory.sources),
    memory.origin === undefined
      ? null
      : JSON.stringify({ memoryId: memory.origin.memoryId, revision: memory.origin.revision }),
  ];
}

/** A memories row as a driver returns it: int8 columns may come as numbers, strings or BigInts. */
interface MemoryRow {
  readonly id: string;
  readonly scope: string;
  readonly seq: unknown;
  readonly pinned: boolean;
  readonly noted_at: unknown;
  readonly revision_number: unknown;
  readonly text: string;
  readonly revised_at: unknown;
  readonly provenance: string;
  readonly status: string;
  readonly superseded_by: string | null;
  readonly sources: string | null;
  readonly origin: string | null;
}

function memoryFromRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope,
    seq: Number(row.seq),
    pinned: row.pinned === true,
    notedAt: Number(row.noted_at),
    revision: {
      number: Number(row.revision_number),
      text: row.text,
      at: Number(row.revised_at),
      provenance: JSON.parse(row.provenance) as Provenance,
    },
    status: row.status as MemoryStatus,
    ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
    ...(row.sources === null ? {} : { sources: JSON.parse(row.sources) as SourceRevision[] }),
    ...(row.origin === null ? {} : { origin: JSON.parse(row.origin) as SourceRevision }),
  };
}

interface OpRow {
  readonly principal_id: string;
  readonly op_id: string;
  readonly fingerprint: string | null;
  readonly memory_id: string;
  readonly at: unknown;
  readonly seq: unknown;
}

function opFromRow(row: OpRow): OpRecord {
  return {
    principalId: row.principal_id,
    opId: row.op_id,
    ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
    memoryId: row.memory_id,
    at: Number(row.at),
    seq: Number(row.seq),
  };
}
