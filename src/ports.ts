import type {
  AuthorityFence,
  Event,
  ImportCheckpoint,
  Memory,
  MemoryId,
  NewEvent,
  OpId,
  OpRecord,
  Principal,
  Scope,
  StoredMemory,
  Tombstone,
} from "./model.js";
import type { QueryTerm } from "./ranking.js";

/** The host's rule that turns its authenticated context into a principal. */
export type Policy<Context> = (context: Context) => Principal | Promise<Principal>;

export type EgressDecision =
  | { readonly allow: true; readonly text: string }
  | { readonly allow: false; readonly reason: string };

/** The host's rule applied to every rendering before it leaves relembra for a principal. */
export type EgressFilter = (
  rendering: string,
  principal: Principal,
) => EgressDecision | Promise<EgressDecision>;

/**
 * Anything outside relembra a rendering took memory text to (a conversation, an MCP server
 * process), recorded so a redaction can reach it. Both fields pass the identifier rule.
 */
export interface Carrier {
  /**
   * The host's name for it, unique across kinds: an exposure is keyed by carrier id and memory id,
   * and keeps the kind it was first recorded with. At most 512 UTF-8 bytes.
   */
  readonly id: string;
  /** What it is, such as `pi-durable` or `mcp`. At most 64 UTF-8 bytes. */
  readonly kind: string;
}

/** That `carrier` received the text of each of `memoryIds`, at `at` (epoch milliseconds). */
export interface Exposure {
  readonly carrier: Carrier;
  /** Distinct, in ascending order. */
  readonly memoryIds: readonly MemoryId[];
  readonly at: number;
}

/**
 * Erasure work a redaction records, in the same transaction, for delivery to the host after
 * commit: the memory and the carriers recorded as having received its text.
 */
export interface ErasureWork {
  /** The seq of the redact event. */
  readonly seq: number;
  readonly memoryId: MemoryId;
  /** The carriers with an exposure of the memory when it was redacted, in id order. */
  readonly carriers: readonly Carrier[];
}

/**
 * Where a carrier stands for one piece of erasure work. `pending` until the host's hook answers
 * for it; `acknowledged` when the hook said it handled the copy (purged, quarantined: the host's
 * word, which relembra cannot check); `unsupported` when the hook said the carrier cannot erase.
 * Nothing in relembra ever reports an external copy as erased.
 */
export type CarrierStatus = "pending" | "acknowledged" | "unsupported";

/** A status the hook can give, and the store keeps: once given, it never changes. */
export type CarrierOutcome = Exclude<CarrierStatus, "pending">;

/** A page of pending erasure work (Store.pendingErasures). */
export interface PendingErasuresQuery {
  /** Only rows with a seq above this one; from the first row when absent. */
  readonly after?: number;
  /** At most this many rows, a positive whole number. */
  readonly limit: number;
}

/** What is still pending across the outbox (Store.pendingErasureCount). */
export interface PendingErasureCount {
  /** Outbox rows with at least one pending carrier. */
  readonly work: number;
  /** Pending carriers, over every row. */
  readonly carriers: number;
}

/** A carrier's outcome for one outbox row, as stored. */
export interface CarrierSettlement {
  /** The outbox row's seq (ErasureWork.seq). */
  readonly seq: number;
  readonly carrierId: string;
  readonly status: CarrierOutcome;
  /** Epoch milliseconds, when the outcome was recorded. */
  readonly at: number;
}

/**
 * What a hook answers for one piece of work: an outcome per carrier id it handled, as an own
 * property holding exactly `"acknowledged"` or `"unsupported"`. A carrier it leaves out, or gives
 * anything else, stays pending.
 */
export type ErasureReceipt = Readonly<Record<string, CarrierOutcome>>;

/**
 * The host's delivery of erasure work, called by `Relembra.deliverErasures` after the redaction
 * committed, once per outbox row with pending carriers, given only those carriers. It must be
 * idempotent: a carrier left pending (no answer for it, no receipt, or a throw) is sent again on
 * the next delivery, and two deliveries running at once may both send it.
 */
export type ErasureHook = (
  work: ErasureWork,
) => ErasureReceipt | undefined | Promise<ErasureReceipt | undefined>;

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export interface Ids {
  memoryId(): MemoryId;
  opId(): OpId;
}

/**
 * What a store reads: only live memories in `scopes`, plus the retracted ones in the scopes that
 * are also in `retracted`, newest first, at most `limit` in all. Superseded memories and
 * tombstones are never returned.
 */
export interface StoreRecallQuery {
  readonly scopes: readonly Scope[];
  readonly limit: number;
  /** Scopes whose retracted memories are returned too, marked by their status. None when absent. */
  readonly retracted?: readonly Scope[];
}

/** What wake, brief and pending read: every live memory in `scopes`. */
export interface StoreLiveQuery {
  readonly scopes: readonly Scope[];
}

/**
 * How often a term occurs in one memory's tokens: counting every token (`all`), and counting
 * only the tokens that are not stop words (`kept`). The ranker uses `kept`, or `all` for a query
 * of only stop words (docs/specs/ranking-algorithm.md §3).
 */
export interface TermCounts {
  readonly all: number;
  readonly kept: number;
}

/** One live memory that holds at least one query term, in its exact form or as a stem. */
export interface TermPosting {
  readonly memoryId: MemoryId;
  /** The memory's store sequence. */
  readonly seq: number;
  /** Its length in tokens, every token counted. */
  readonly lengthAll: number;
  /** Its length in tokens, stop words not counted. */
  readonly lengthKept: number;
  /** Per query term, in the query's order: the occurrences of the term's exact form. */
  readonly exact: readonly TermCounts[];
  /** Per query term, in the query's order: the tokens whose stem is the term's stem. */
  readonly stem: readonly TermCounts[];
}

/** What the term index holds about the live memories in some scopes, for some query terms. */
export interface TermIndexRead {
  /** N: how many live memories the scopes hold, with or without any query term. */
  readonly memories: number;
  /** The sum of their lengths, every token counted. */
  readonly lengthAll: number;
  /** The sum of their lengths, stop words not counted. */
  readonly lengthKept: number;
  /** One per live memory holding a query term's exact form or stem, in no particular order. */
  readonly postings: readonly TermPosting[];
}

/** What find reads through the term index. */
export interface StoreFindQuery {
  readonly scopes: readonly Scope[];
  /** Distinct, at most 32 (the ranker's cap). */
  readonly terms: readonly QueryTerm[];
  /**
   * Picks the memories to load from what the index holds, best first. Pure and synchronous: the
   * store calls it once, inside the same read snapshot as the index read and the load.
   */
  readonly choose: (index: TermIndexRead) => readonly MemoryId[];
}

/** The writes available inside one store transaction. */
export interface StoreTransaction {
  /**
   * The store's own time, in whole epoch milliseconds, for a store that keeps one (the Postgres
   * store reads the database clock). When present, the core uses it, not the Clock, as a write's
   * acceptance time (`notedAt` and the op record's `at`) and as the time a retention sweep counts
   * from; the caller's Clock reading stays as `revision.at`, provenance only. Absent, the Clock's
   * reading is both.
   */
  now?(): Promise<number>;
  /** Appends an event and returns it with the seq the store assigned. */
  append(event: NewEvent): Promise<Event>;
  /** Inserts or replaces the derived view of one memory, its status and sources included. */
  putMemory(memory: Memory): Promise<void>;
  /** The memory stored under `id` in any status, committed or written earlier in this transaction. */
  memory(id: MemoryId): Promise<StoredMemory | undefined>;
  /**
   * The ids of the memories, in any status but redacted, derived from `id`: the summaries that
   * list it among their sources, and the copies promoted from it (`origin.memoryId` is `id`).
   */
  derived(id: MemoryId): Promise<readonly MemoryId[]>;
  /**
   * The memories in `scope`, in any status but redacted, first noted before `before` (epoch
   * milliseconds, exclusive), in store order: what a retention sweep redacts.
   */
  expiring(scope: Scope, before: number): Promise<readonly Memory[]>;
  /**
   * Replaces memory `tombstone.id` with its tombstone and removes every copy of its text the store
   * holds: the memory's row, the text and provenance of its events (each rewritten to
   * `redactedEvent`'s form), and the fingerprint of every op record whose outcome is the memory.
   * Deleted bytes must not stay readable in the store's files (see the SQLite store's
   * secure_delete and checkpoint).
   */
  redact(tombstone: Tombstone): Promise<void>;
  /** Records erasure work in the outbox, its carriers pending. */
  putErasure(work: ErasureWork): Promise<void>;
  /**
   * The carriers with an exposure of `memoryId` (Store.recordExposure), in any order, from a read
   * that no exposure can slip past: a recordExposure that has not committed when this read runs
   * waits for this transaction to end before it commits (or this read waits for it). The
   * Postgres store takes an exclusive advisory lock for that; stores whose writers already run
   * one at a time need nothing more.
   */
  exposures(memoryId: MemoryId): Promise<readonly Carrier[]>;
  /**
   * Records a carrier's outcome for one outbox row. The first outcome stored for a (seq, carrier
   * id) pair stays: a later one changes nothing.
   */
  settle(settlement: CarrierSettlement): Promise<void>;
  /**
   * The op record of `principalId` for `opId`, committed or written earlier in this transaction.
   * Another principal's record under the same op id is never returned.
   */
  op(principalId: string, opId: OpId): Promise<OpRecord | undefined>;
  /**
   * Stores an op record. Rejects when the principal already has a record for `record.opId`: op
   * ids are unique per principal per store.
   */
  putOp(record: OpRecord): Promise<void>;
  /** The highest epoch stored for `key`, committed or written earlier in this transaction. */
  fenceEpoch(key: string): Promise<number | undefined>;
  /** Stores `fence.epoch` as the epoch for `fence.key`. The core never lowers it. */
  putFence(fence: AuthorityFence): Promise<void>;
  /** The import checkpoint stored for `source`, committed or written earlier in this transaction. */
  checkpoint(source: string): Promise<ImportCheckpoint | undefined>;
  /** Stores `checkpoint`, replacing any checkpoint for its source. */
  putCheckpoint(checkpoint: ImportCheckpoint): Promise<void>;
}

/** What events reads: every committed event in `scopes`. */
export interface StoreEventsQuery {
  readonly scopes: readonly Scope[];
}

/** The place memories persist. */
export interface Store {
  /**
   * Runs `work` atomically: every write it made commits when it resolves, and none does when it
   * rejects. Transactions on one store do not interleave.
   */
  transaction<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T>;
  /** Filters by scope in the read itself, so nothing outside `query.scopes` is loaded. */
  recall(query: StoreRecallQuery): Promise<readonly Memory[]>;
  /**
   * Returns every live memory (not retracted, redacted or superseded) in `query.scopes`, filtered
   * by scope in the read itself. No limit and no text filter: brief ranks the whole set, and a
   * prefilter would change its `N`, `df` and `avgdl`.
   */
  liveMemories(query: StoreLiveQuery): Promise<readonly Memory[]>;
  /**
   * Find's read, from one consistent snapshot: the term index over the live memories in
   * `query.scopes` for `query.terms` (TermIndexRead), handed to `query.choose`, then the memories
   * it chose, in its order. Only live memories in `query.scopes` are ever returned.
   *
   * The store keeps the index itself: every `putMemory` and `redact` updates it in its own
   * transaction, from `documentTerms` of the memory's text, and only live memories are indexed.
   * A scope's statistics never count a memory of another scope. A redacted memory leaves no term
   * behind, in the index or in the store's files.
   */
  findByTerms(query: StoreFindQuery): Promise<readonly Memory[]>;
  /** Every committed outbox row, in seq order. */
  erasures(): Promise<readonly ErasureWork[]>;
  /** Every committed carrier outcome (StoreTransaction.settle), in any order. */
  settlements(): Promise<readonly CarrierSettlement[]>;
  /**
   * The committed outbox rows with seq above `after` (0 when absent) that hold at least one
   * pending carrier (no outcome yet), each with only its pending carriers, in seq order, at most
   * `limit` rows. What delivery reads, a page at a time: the SQL stores keep the pending carriers
   * indexed, so the read never touches settled rows.
   */
  pendingErasures(query: PendingErasuresQuery): Promise<readonly ErasureWork[]>;
  /** How many committed outbox rows hold a pending carrier (`work`), and how many carriers. */
  pendingErasureCount(): Promise<PendingErasureCount>;
  /**
   * Records that `exposure.carrier` received each of `exposure.memoryIds`, ids only: one row per
   * (carrier id, memory id), kept as first recorded (its kind and time) when it already exists. It
   * reads nothing else, so it never checks a memory's scope or that the memory exists. Outside
   * any store transaction, and on Postgres without the store lock row: concurrent recorders do
   * not wait for each other, and none is lost.
   *
   * Then, once the rows are committed, it resolves with those of `exposure.memoryIds` that are
   * redacted. A rendering read before a redaction committed may record after it: the redaction's
   * outbox row then lacks the carrier, and this result is how the caller learns the text it holds
   * was erased. See StoreTransaction.exposures for the other half of that ordering.
   */
  recordExposure(exposure: Exposure): Promise<readonly MemoryId[]>;
  /**
   * Every committed event whose scope is in `query.scopes`, in seq order, as stored: a redacted
   * memory's events in their redacted form. Filtered by scope in the read itself.
   */
  events(query: StoreEventsQuery): Promise<readonly Event[]>;
}

export const systemClock: Clock = { now: () => Date.now() };

export const randomIds: Ids = {
  memoryId: () => crypto.randomUUID(),
  opId: () => crypto.randomUUID(),
};
