import type { SQLInputValue, StatementSync } from "node:sqlite";
import { detachEvent } from "../frozen.js";
import {
  type Event,
  type ImportCheckpoint,
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
import {
  checkBusyTimeout,
  createOwnerOnly,
  isBusy,
  openDatabase,
  StoreBusyError,
} from "./database.js";
import { termIndex } from "./term-index.js";

export {
  StoreBusyError,
  StoreFileModeError,
  StoreFileTypeError,
  StoreUnverifiedError,
} from "./database.js";
export { SchemaTooNewError } from "./migrations.js";

export interface SqliteStoreOptions {
  /**
   * The database file. On POSIX, missing directories are created 0700 and the file 0600; on
   * Windows a new store needs an absent folder, created private (docs/CLI.md, Windows).
   */
  readonly path: string;
  /** How long a write waits for another writer's lock before it fails. Default 5000. */
  readonly busyTimeoutMs?: number;
}

export interface SqliteStore extends Store {
  /**
   * Waits for queued work, then closes the file. Rejects with WalScrubError, after closing,
   * when a redaction's old page images could not be truncated from the WAL.
   */
  close(): Promise<void>;
  /**
   * Whether a committed redaction's old page images may still be in the WAL, because a reader
   * held an older snapshot. Each later commit, close and open retries the truncation.
   */
  walScrubPending(): Promise<boolean>;
}

/**
 * A redaction committed, but its old page images could not be truncated from the WAL file within
 * the busy timeout, because a reader held an older snapshot. The text is gone from every read; it
 * may still be on disk until a later commit, close or open completes the truncation.
 */
export class WalScrubError extends Error {
  override readonly name = "WalScrubError";
  constructor(path: string) {
    super(`a redaction's old page images may remain in ${path}-wal until a reader lets go`);
  }
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const MEMORY_COLUMNS =
  "id, scope, seq, pinned, noted_at, revision_number, text, revised_at, provenance, status, superseded_by, sources, origin";

/** Opens (and creates or migrates) a relembra store in one SQLite file, through node:sqlite. */
export function openSqliteStore(options: SqliteStoreOptions): SqliteStore {
  const busyTimeoutMs = checkBusyTimeout(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  createOwnerOnly(options.path);

  const db = openDatabase(options.path, busyTimeoutMs);

  const insertEvent = db.prepare(
    "INSERT INTO events (kind, memory_id, scope, body) VALUES (?, ?, ?, ?)",
  );
  const upsertMemory = db.prepare(`
    INSERT INTO memories (${MEMORY_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    RETURNING position
  `);
  const selectMemory = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`);
  const selectPosition = db.prepare("SELECT position FROM memories WHERE id = ?");
  const terms = termIndex(db);
  const selectLiveByIds = db.prepare(`
    SELECT ${MEMORY_COLUMNS}
    FROM memories
    WHERE id IN (SELECT value FROM json_each(?))
      AND scope IN (SELECT value FROM json_each(?))
      AND status = 'live'
  `);
  const unindex = (id: string) => {
    const row = selectPosition.get(id) as { position: number } | undefined;
    if (row !== undefined) terms.remove(row.position);
  };
  const selectTombstone = db.prepare("SELECT id, scope, seq FROM tombstones WHERE id = ?");
  const selectDerived = db.prepare(`
    SELECT id FROM memories
    WHERE (sources IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(memories.sources) WHERE json_extract(value, '$.memoryId') = ?1))
      OR (origin IS NOT NULL AND json_extract(origin, '$.memoryId') = ?1)
    ORDER BY position
  `);
  const selectExpiring = db.prepare(
    `SELECT ${MEMORY_COLUMNS} FROM memories WHERE scope = ? AND noted_at < ? ORDER BY position`,
  );
  const deleteMemory = db.prepare("DELETE FROM memories WHERE id = ?");
  const insertTombstone = db.prepare("INSERT INTO tombstones (id, scope, seq) VALUES (?, ?, ?)");
  const selectMemoryEvents = db.prepare("SELECT seq, body FROM events WHERE memory_id = ?");
  const updateEventBody = db.prepare("UPDATE events SET body = ? WHERE seq = ?");
  const scrubOps = db.prepare("UPDATE ops SET fingerprint = NULL WHERE memory_id = ?");
  const insertErasure = db.prepare(
    "INSERT INTO erasure_outbox (seq, memory_id, carriers) VALUES (?, ?, ?)",
  );
  const selectErasures = db.prepare(
    "SELECT seq, memory_id, carriers FROM erasure_outbox ORDER BY seq",
  );
  const selectExposures = db.prepare(
    "SELECT carrier_id, carrier_kind FROM exposures WHERE memory_id = ?",
  );
  const countExposed = db.prepare(
    "SELECT count(*) AS n FROM exposures WHERE carrier_id = ? AND memory_id IN (SELECT value FROM json_each(?))",
  );
  // WHERE true: SQLite's parser needs it between a SELECT and ON CONFLICT.
  const insertExposures = db.prepare(`
    INSERT INTO exposures (carrier_id, memory_id, carrier_kind, first_seen)
    SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE true
    ON CONFLICT (carrier_id, memory_id) DO NOTHING
  `);
  const selectTombstoned = db.prepare(
    "SELECT id FROM tombstones WHERE id IN (SELECT value FROM json_each(?))",
  );
  const insertPending = db.prepare(
    "INSERT INTO erasure_pending (seq, carrier_id, carrier_kind) VALUES (?, ?, ?)",
  );
  const deletePending = db.prepare("DELETE FROM erasure_pending WHERE seq = ? AND carrier_id = ?");
  // The page's seqs come from the primary key; only pending rows are read.
  const selectPending = db.prepare(`
    SELECT p.seq, o.memory_id, p.carrier_id, p.carrier_kind
    FROM erasure_pending AS p JOIN erasure_outbox AS o ON o.seq = p.seq
    WHERE p.seq IN (
      SELECT DISTINCT seq FROM erasure_pending WHERE seq > ? ORDER BY seq LIMIT ?)
    ORDER BY p.seq, p.carrier_id
  `);
  const countPending = db.prepare(
    "SELECT count(DISTINCT seq) AS work, count(*) AS carriers FROM erasure_pending",
  );
  const insertSettlement = db.prepare(`
    INSERT INTO erasure_deliveries (seq, carrier_id, status, settled_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (seq, carrier_id) DO NOTHING
  `);
  const selectSettlements = db.prepare(
    "SELECT seq, carrier_id, status, settled_at FROM erasure_deliveries",
  );
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
  const markScrub = db.prepare("UPDATE wal_scrub SET redacted = redacted + 1 WHERE id = 1");
  const selectScrub = db.prepare("SELECT redacted, scrubbed FROM wal_scrub WHERE id = 1");
  const clearScrub = db.prepare("UPDATE wal_scrub SET scrubbed = max(scrubbed, ?) WHERE id = 1");
  const selectOp = db.prepare(
    "SELECT principal_id, op_id, fingerprint, memory_id, at, seq FROM ops WHERE principal_id = ? AND op_id = ?",
  );
  const insertOp = db.prepare(
    "INSERT INTO ops (principal_id, op_id, fingerprint, memory_id, at, seq) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectFence = db.prepare("SELECT epoch FROM fences WHERE key = ?");
  const upsertFence = db.prepare(
    "INSERT INTO fences (key, epoch) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET epoch = excluded.epoch",
  );
  const selectRecall = db.prepare(`
    SELECT ${MEMORY_COLUMNS}
    FROM memories
    WHERE scope IN (SELECT value FROM json_each(?))
      AND (status = 'live' OR (status = 'retracted' AND scope IN (SELECT value FROM json_each(?))))
    ORDER BY position DESC
    LIMIT ?
  `);

  const selectEvents = db.prepare(`
    SELECT seq, body FROM events
    WHERE scope IN (SELECT value FROM json_each(?))
    ORDER BY seq
  `);
  const selectCheckpoint = db.prepare(
    "SELECT source, bytes, width FROM import_checkpoints WHERE source = ?",
  );
  const upsertCheckpoint = db.prepare(`
    INSERT INTO import_checkpoints (source, bytes, width) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET bytes = excluded.bytes, width = excluded.width
  `);

  const selectLive = db.prepare(`
    SELECT ${MEMORY_COLUMNS}
    FROM memories
    WHERE scope IN (SELECT value FROM json_each(?)) AND status = 'live'
  `);

  // One handle runs one thing at a time: a transaction's work can await, and anything else on
  // this connection meanwhile would join its transaction or read its uncommitted writes.
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  // A committed redaction's old page images may still sit in the WAL. The wal_scrub row counts
  // redactions (`redacted`, raised by each redaction's own transaction) and the count the WAL was
  // last truncated after (`scrubbed`); a scrub is pending while redacted > scrubbed. Every handle
  // reads the row (not a flag of the handle that redacted), so neither another handle nor a
  // restart misses it, and it truncates the WAL after its commits, at close and at open, until it
  // succeeds. A scrubber reads `redacted` before truncating and raises `scrubbed` only to that
  // value, so a redaction committed after its truncation stays pending. Then it truncates once
  // more, so the row's own update leaves no frame behind either.
  type ScrubRow = { redacted: number; scrubbed: number };
  const scrubRow = async () =>
    (await withBusyRetry(busyTimeoutMs, () => selectScrub.get())) as ScrubRow;
  const pendingIn = (row: ScrubRow | undefined) => row !== undefined && row.redacted > row.scrubbed;
  const marked = async () => pendingIn(await scrubRow());
  // Unknown counts as pending: a scrub is attempted, never skipped, when the row cannot be read.
  const maybeMarked = () => marked().catch(() => true);
  /** Truncates the WAL and records it; resolves whether a scrub is still pending. Never rejects. */
  const scrubWal = async (): Promise<boolean> => {
    const before = await scrubRow().catch(() => undefined);
    if ((await truncateWal(checkpoint, busyTimeoutMs)) && before !== undefined) {
      try {
        await withBusyRetry(busyTimeoutMs, () => clearScrub.run(before.redacted));
        await truncateWal(checkpoint, busyTimeoutMs);
      } catch {
        // `scrubbed` stays behind, and the next commit, close or open truncates again: harmless.
      }
    }
    return maybeMarked();
  };
  // Before any read: a store that closed with a scrub pending finishes it first.
  if (pendingIn(selectScrub.get() as ScrubRow | undefined)) queue = scrubWal();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("the store is closed"));
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    transaction<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> {
      return enqueue(async () => {
        await withBusyRetry(busyTimeoutMs, () => db.exec("BEGIN IMMEDIATE"));
        let open = true;
        let redacting = false;
        const assertOpen = () => {
          if (!open) throw new Error("store transaction used after it ended");
        };
        const tx: StoreTransaction = {
          async append(event) {
            assertOpen();
            const result = insertEvent.run(
              event.kind,
              event.memoryId,
              event.scope,
              JSON.stringify(event),
            );
            return detachEvent(event, Number(result.lastInsertRowid));
          },
          async putMemory(memory) {
            assertOpen();
            // Whatever the status change, the index ends up holding the memory exactly when live.
            unindex(memory.id);
            const { position } = upsertMemory.get(...memoryRow(memory)) as { position: number };
            if (memory.status === "live") {
              terms.add(position, { ...memory, text: memory.revision.text });
            }
          },
          async memory(id) {
            assertOpen();
            const row = selectMemory.get(id) as MemoryRow | undefined;
            if (row !== undefined) return memoryFromRow(row);
            const tombstone = selectTombstone.get(id) as TombstoneRow | undefined;
            return tombstone === undefined ? undefined : { ...tombstone, status: "redacted" };
          },
          async derived(id) {
            assertOpen();
            return (selectDerived.all(id) as { id: string }[]).map((row) => row.id);
          },
          async expiring(scope, before) {
            assertOpen();
            return (selectExpiring.all(scope, before) as unknown as MemoryRow[]).map(memoryFromRow);
          },
          async redact({ id, scope, seq }) {
            assertOpen();
            // secure_delete (set when the file is opened) zeroes the freed bytes in the pages,
            // the index's term rows included.
            unindex(id);
            deleteMemory.run(id);
            insertTombstone.run(id, scope, seq);
            for (const row of selectMemoryEvents.all(id) as { seq: number; body: string }[]) {
              const event = { ...JSON.parse(row.body), seq: row.seq } as Event;
              const rewritten = redactedEvent(event);
              if (rewritten === event) continue;
              const { seq: _seq, ...body } = rewritten;
              updateEventBody.run(JSON.stringify(body), row.seq);
            }
            scrubOps.run(id);
            markScrub.run();
            redacting = true;
          },
          async putErasure(work) {
            assertOpen();
            const carriers = work.carriers.map(({ id, kind }) => ({ id, kind }));
            insertErasure.run(work.seq, work.memoryId, JSON.stringify(carriers));
            for (const { id, kind } of carriers) insertPending.run(work.seq, id, kind);
          },
          async exposures(memoryId) {
            assertOpen();
            // BEGIN IMMEDIATE holds the write lock: no recorder commits while this is open.
            return (
              selectExposures.all(memoryId) as { carrier_id: string; carrier_kind: string }[]
            ).map((row) => ({ id: row.carrier_id, kind: row.carrier_kind }));
          },
          async settle({ seq, carrierId, status, at }) {
            assertOpen();
            insertSettlement.run(seq, carrierId, status, at);
            deletePending.run(seq, carrierId);
          },
          async op(principalId, opId) {
            assertOpen();
            const row = selectOp.get(principalId, opId) as OpRow | undefined;
            return row === undefined ? undefined : opFromRow(row);
          },
          async putOp(record) {
            assertOpen();
            // The primary key refuses a second record for the same principal and op id.
            insertOp.run(
              record.principalId,
              record.opId,
              record.fingerprint ?? null,
              record.memoryId,
              record.at,
              record.seq,
            );
          },
          async fenceEpoch(key) {
            assertOpen();
            const row = selectFence.get(key) as { epoch: number } | undefined;
            return row?.epoch;
          },
          async putFence({ key, epoch }) {
            assertOpen();
            upsertFence.run(key, epoch);
          },
          async checkpoint(source) {
            assertOpen();
            const row = selectCheckpoint.get(source) as ImportCheckpoint | undefined;
            return row === undefined ? undefined : { ...row };
          },
          async putCheckpoint({ source, bytes, width }) {
            assertOpen();
            upsertCheckpoint.run(source, bytes, width);
          },
        };
        try {
          const result = await work(tx);
          open = false;
          await withBusyRetry(busyTimeoutMs, () => db.exec("COMMIT"));
          if (redacting || (await maybeMarked())) await scrubWal();
          return result;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        } finally {
          open = false;
        }
      });
    },

    recall({ scopes, limit, retracted = [] }) {
      return enqueue(() =>
        withBusyRetry(busyTimeoutMs, () =>
          (
            selectRecall.all(
              JSON.stringify(scopes),
              JSON.stringify(retracted),
              limit,
            ) as unknown as MemoryRow[]
          ).map(memoryFromRow),
        ),
      );
    },

    erasures() {
      return enqueue(() =>
        withBusyRetry(busyTimeoutMs, () =>
          (selectErasures.all() as { seq: number; memory_id: string; carriers: string }[]).map(
            (row): ErasureWork => ({
              seq: row.seq,
              memoryId: row.memory_id,
              carriers: JSON.parse(row.carriers) as Carrier[],
            }),
          ),
        ),
      );
    },

    settlements() {
      return enqueue(() =>
        withBusyRetry(busyTimeoutMs, () =>
          (
            selectSettlements.all() as {
              seq: number;
              carrier_id: string;
              status: string;
              settled_at: number;
            }[]
          ).map(
            (row): CarrierSettlement => ({
              seq: row.seq,
              carrierId: row.carrier_id,
              status: row.status as CarrierOutcome,
              at: row.settled_at,
            }),
          ),
        ),
      );
    },

    pendingErasures({ after = 0, limit }) {
      return enqueue(() =>
        withBusyRetry(busyTimeoutMs, () =>
          groupPending(selectPending.all(after, limit) as unknown as PendingRow[]),
        ),
      );
    },

    pendingErasureCount() {
      return enqueue(() =>
        withBusyRetry(busyTimeoutMs, () => {
          const { work, carriers } = countPending.get() as { work: number; carriers: number };
          return { work, carriers };
        }),
      );
    },

    recordExposure({ carrier, memoryIds, at }) {
      const ids = JSON.stringify(memoryIds);
      // Through the handle's queue, so the insert never joins a transaction open on this handle.
      return enqueue(async () => {
        const { n } = (await withBusyRetry(busyTimeoutMs, () =>
          countExposed.get(carrier.id, ids),
        )) as { n: number };
        // One autocommit statement: it waits for the write lock, so it commits either before a
        // redaction's transaction begins (which then reads it) or after it commits.
        if (n < memoryIds.length) {
          await withBusyRetry(busyTimeoutMs, () =>
            insertExposures.run(carrier.id, carrier.kind, at, ids),
          );
        }
        const rows = (await withBusyRetry(busyTimeoutMs, () => selectTombstoned.all(ids))) as {
          id: string;
        }[];
        const redacted = new Set(rows.map((row) => row.id));
        return memoryIds.filter((id) => redacted.has(id));
      });
    },

    events({ scopes }) {
      return enqueue(() =>
        withBusyRetry(busyTimeoutMs, () =>
          (selectEvents.all(JSON.stringify(scopes)) as { seq: number; body: string }[]).map(
            (row) => ({ ...JSON.parse(row.body), seq: row.seq }) as Event,
          ),
        ),
      );
    },

    liveMemories({ scopes }) {
      return enqueue(() =>
        withBusyRetry(busyTimeoutMs, () =>
          (selectLive.all(JSON.stringify(scopes)) as unknown as MemoryRow[]).map(memoryFromRow),
        ),
      );
    },

    findByTerms({ scopes, terms: queryTerms, choose }) {
      const unique = [...new Set(scopes)];
      return enqueue(() =>
        withBusyRetry(busyTimeoutMs, () => {
          // A deferred transaction that only reads: one WAL snapshot for the index and the load.
          db.exec("BEGIN");
          try {
            const chosen = choose(terms.read(unique, queryTerms));
            const rows = selectLiveByIds.all(
              JSON.stringify(chosen),
              JSON.stringify(unique),
            ) as unknown as MemoryRow[];
            db.exec("COMMIT");
            const byId = new Map(rows.map((row) => [row.id, row]));
            return chosen.flatMap((id) => {
              const row = byId.get(id);
              return row === undefined ? [] : [memoryFromRow(row)];
            });
          } catch (error) {
            if (db.isTransaction) db.exec("ROLLBACK");
            throw error;
          }
        }),
      );
    },

    async close() {
      if (closed) return;
      closed = true;
      await queue;
      const pending = (await maybeMarked()) && (await scrubWal());
      db.close();
      if (pending) throw new WalScrubError(options.path);
    },

    walScrubPending() {
      return enqueue(marked);
    },
  };
}

/** A pending carrier joined to its outbox row, as the pending read returns it. */
interface PendingRow {
  readonly seq: unknown;
  readonly memory_id: string;
  readonly carrier_id: string;
  readonly carrier_kind: string;
}

/** Rows in seq order, grouped into one ErasureWork per seq. */
function groupPending(rows: readonly PendingRow[]): ErasureWork[] {
  const work: { seq: number; memoryId: string; carriers: Carrier[] }[] = [];
  for (const row of rows) {
    const seq = Number(row.seq);
    const last = work.at(-1);
    const carrier = { id: row.carrier_id, kind: row.carrier_kind };
    if (last?.seq === seq) last.carriers.push(carrier);
    else work.push({ seq, memoryId: row.memory_id, carriers: [carrier] });
  }
  return work;
}

/**
 * Checkpoints the whole WAL into the main file and truncates the WAL to zero bytes, so page
 * images written before a redaction (which hold the redacted text) leave the disk. A reader that
 * still holds an older snapshot blocks it; it is retried until `timeoutMs` has passed. Resolves
 * false when it could not complete; it never rejects, because the redaction has committed.
 */
async function truncateWal(checkpoint: StatementSync, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 1; ; delay = Math.min(delay * 2, 32)) {
    try {
      const { busy } = checkpoint.get() as { busy: number };
      if (busy === 0) return true;
    } catch (error) {
      if (!isBusy(error)) return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, delay + Math.random() * delay));
  }
}

/** Runs `step`, retrying while SQLite reports SQLITE_BUSY, until `timeoutMs` has passed. */
async function withBusyRetry<T>(timeoutMs: number, step: () => T): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 1; ; delay = Math.min(delay * 2, 32)) {
    try {
      return step();
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (Date.now() >= deadline) throw new StoreBusyError(timeoutMs, { cause: error });
      await new Promise((done) => setTimeout(done, delay + Math.random() * delay));
    }
  }
}

function memoryRow(memory: Memory): SQLInputValue[] {
  return [
    memory.id,
    memory.scope,
    memory.seq,
    memory.pinned ? 1 : 0,
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

/** A memories row as the selects return it (STRICT tables guarantee the column types). */
interface MemoryRow {
  readonly id: string;
  readonly scope: string;
  readonly seq: number;
  readonly pinned: number;
  readonly noted_at: number;
  readonly revision_number: number;
  readonly text: string;
  readonly revised_at: number;
  readonly provenance: string;
  readonly status: string;
  readonly superseded_by: string | null;
  readonly sources: string | null;
  readonly origin: string | null;
}

interface TombstoneRow {
  readonly id: string;
  readonly scope: string;
  readonly seq: number;
}

function memoryFromRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope,
    seq: row.seq,
    pinned: row.pinned === 1,
    notedAt: row.noted_at,
    revision: {
      number: row.revision_number,
      text: row.text,
      at: row.revised_at,
      provenance: JSON.parse(row.provenance) as Provenance,
    },
    status: row.status as MemoryStatus,
    ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
    ...(row.sources === null ? {} : { sources: JSON.parse(row.sources) as SourceRevision[] }),
    ...(row.origin === null ? {} : { origin: JSON.parse(row.origin) as SourceRevision }),
  };
}

/** An ops row (STRICT tables guarantee the column types). */
interface OpRow {
  readonly principal_id: string;
  readonly op_id: string;
  readonly fingerprint: string | null;
  readonly memory_id: string;
  readonly at: number;
  readonly seq: number;
}

function opFromRow(row: OpRow): OpRecord {
  return {
    principalId: row.principal_id,
    opId: row.op_id,
    ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
    memoryId: row.memory_id,
    at: row.at,
    seq: row.seq,
  };
}
