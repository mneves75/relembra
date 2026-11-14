/**
 * An opaque key, defined by the host, that names where a memory lives. The core compares scopes
 * for equality and never parses them or derives them from model input.
 */
export type Scope = string;

/** A memory's stable identity. */
export type MemoryId = string;

/** The key that makes a write idempotent. */
export type OpId = string;

/**
 * How far a memory's text may be relied on. `owner`: established by the host independently of any
 * model. `agent`: model-authored and unreviewed. `untrusted`: known to come from external content.
 */
export type Trust = "owner" | "agent" | "untrusted";

/** Every trust tier, highest first. */
export const TRUSTS: readonly Trust[] = ["owner", "agent", "untrusted"];

/**
 * A writer's authority as the host grants it: a fencing key and the epoch this writer holds. The
 * store keeps the highest epoch it has seen per key. A write whose epoch is lower commits
 * nothing; an equal epoch commits; a higher one commits and becomes the highest. The host
 * advances the epoch when authority changes hands (`advanceFence`).
 */
export interface AuthorityFence {
  /** Names one authority, such as a conversation lease. Never empty. */
  readonly key: string;
  /** A non-negative safe integer. */
  readonly epoch: number;
}

/** The identity a host derives from its own authenticated context. */
export interface Principal {
  readonly id: string;
  readonly readable: readonly Scope[];
  readonly writable: readonly Scope[];
  readonly promotable: readonly Scope[];
  /** The scopes this principal may note pinned memories into. None when absent. */
  readonly pinnable?: readonly Scope[];
  /**
   * The scopes this principal owns: it may retract and redact their memories, and see retracted
   * ones (the owner view). None when absent.
   */
  readonly owned?: readonly Scope[];
  /** The highest trust this principal's writes may carry. Default `agent`. */
  readonly trustCeiling?: Trust;
  /** The authority this principal's writes carry. Unfenced when absent. */
  readonly fence?: AuthorityFence;
}

/** Who and what produced a revision. */
export interface Provenance {
  readonly agent: string;
  readonly harness: string;
  readonly model: string;
  readonly host: string;
  readonly source?: string;
  readonly trust: Trust;
  readonly opId: OpId;
}

/** One version of a memory's text. A memory's revisions are numbered from 1. */
export interface Revision {
  readonly number: number;
  readonly text: string;
  /** Epoch milliseconds from the Clock port. */
  readonly at: number;
  readonly provenance: Provenance;
}

/**
 * Whether a memory is served. `live`: served to every reader of its scope. `retracted`: hidden
 * from agents; an owner of its scope still sees it. `superseded`: replaced by another memory and
 * no longer served. A redacted memory is no longer a memory but a Tombstone.
 */
export type MemoryStatus = "live" | "retracted" | "superseded";

/** One source of a summary: a memory at the exact revision the summary was written from. */
export interface SourceRevision {
  readonly memoryId: MemoryId;
  readonly revision: number;
}

/** One curated fact: a stable identity in a scope, and its current revision. */
export interface Memory {
  readonly id: MemoryId;
  readonly scope: Scope;
  /** Store order: the seq of the event that produced the current revision. Higher is newer. */
  readonly seq: number;
  readonly pinned: boolean;
  /**
   * Epoch milliseconds when the store accepted revision 1: the Clock's reading, or the store's
   * own time when it keeps one (StoreTransaction.now, the database clock on Postgres).
   */
  readonly notedAt: number;
  readonly revision: Revision;
  readonly status: MemoryStatus;
  /** The memory that replaced this one; present when `status` is `superseded`. */
  readonly supersededBy?: MemoryId;
  /** Present on a summary: the memories, at their revisions, it was written from. */
  readonly sources?: readonly SourceRevision[];
  /**
   * Present on a promoted copy: the memory, at the exact revision, it was copied from, in another
   * scope. Redacting that memory redacts the copy.
   */
  readonly origin?: SourceRevision;
}

/** What remains of a redacted memory: its identity and the fact of redaction, without its text. */
export interface Tombstone {
  readonly id: MemoryId;
  readonly scope: Scope;
  /** The seq of the redact event. */
  readonly seq: number;
  readonly status: "redacted";
}

/** What a store holds under a memory id: the memory, or its tombstone once it is redacted. */
export type StoredMemory = Memory | Tombstone;

/**
 * The record that makes a write idempotent: its principal and op id, the fingerprint of its
 * payload, and the outcome of its first commit, written in the same transaction as the write. An
 * op id belongs to the principal that used it: another principal's record is invisible to it.
 */
export interface OpRecord {
  readonly principalId: string;
  readonly opId: OpId;
  /**
   * SHA-256 (hex) of the write's canonical payload; see the core's fingerprint. Absent once the
   * memory the write created is redacted: a hash of the text could confirm a guess of it.
   */
  readonly fingerprint?: string;
  /** The memory the first commit created. */
  readonly memoryId: MemoryId;
  /** The first commit's acceptance time, as the memory's `notedAt`. */
  readonly at: number;
  /** The seq of the first commit's event. */
  readonly seq: number;
}

/**
 * How far an import has read one source: its first `bytes` bytes, cut into records of `width`
 * bytes. A later import of the same source refuses one shorter than that, or with another width.
 * It holds no hash of the bytes: a hash of a record would outlive the record's redaction as a
 * fingerprint of the erased text.
 */
export interface ImportCheckpoint {
  /** Names the source, such as `optmem:<scope key>:<store>`. */
  readonly source: string;
  readonly bytes: number;
  /** The record width, in bytes; 0 for a source that had no records. */
  readonly width: number;
}

/**
 * The event format of the kinds format 1 defines (note, retract, redact, supersede, summarize),
 * which every event of those kinds carries (docs/FORMAT.md).
 */
export const EVENT_FORMAT = 1;

/**
 * The event format that adds `promote`. Only promote events carry it, so a log or an export
 * without one stays format 1 and readable by a format 1 reader, which refuses one with it.
 */
export const PROMOTE_FORMAT = 2;

/** The newest event format this relembra reads and writes; a reader refuses a newer one. */
export const LATEST_EVENT_FORMAT = PROMOTE_FORMAT;

/** A memory was written. */
export interface NoteEvent {
  readonly format: typeof EVENT_FORMAT;
  readonly kind: "note";
  /** Store order, assigned by the store when the event is appended. */
  readonly seq: number;
  readonly memoryId: MemoryId;
  readonly scope: Scope;
  readonly principalId: string;
  readonly pinned: boolean;
  readonly revision: Revision;
}

/**
 * A note event after its memory was redacted: the revision (text and provenance) is gone, and
 * `redacted` records that it was taken out.
 */
export interface RedactedNoteEvent {
  readonly format: typeof EVENT_FORMAT;
  readonly kind: "note";
  readonly seq: number;
  readonly memoryId: MemoryId;
  readonly scope: Scope;
  readonly principalId: string;
  readonly pinned: boolean;
  readonly redacted: true;
}

/**
 * Why a memory was redacted: an owner asked (`request`), a retention rule expired it
 * (`retention`), or a memory it was derived from was redacted (`source`): a summary's source, or
 * a promoted copy's origin.
 */
export type RedactionCause = "request" | "retention" | "source";

/** A memory was redacted: replaced by its tombstone, its text removed everywhere relembra holds it. */
export interface RedactEvent {
  readonly format: typeof EVENT_FORMAT;
  readonly kind: "redact";
  readonly seq: number;
  readonly memoryId: MemoryId;
  readonly scope: Scope;
  readonly cause: RedactionCause;
  /** The owner whose request led to it; null for a retention sweep, which the host runs. */
  readonly principalId: string | null;
}

/** A memory was retracted: hidden from agents, still shown to an owner of its scope. */
export interface RetractEvent {
  readonly format: typeof EVENT_FORMAT;
  readonly kind: "retract";
  readonly seq: number;
  readonly memoryId: MemoryId;
  readonly scope: Scope;
  readonly principalId: string;
}

/**
 * A memory was superseded: `by` replaced it (noted earlier: the direct operation writes it by the
 * note event just before, an import may hold it on any earlier line), and it is no longer served.
 */
export interface SupersedeEvent {
  readonly format: typeof EVENT_FORMAT;
  readonly kind: "supersede";
  readonly seq: number;
  readonly memoryId: MemoryId;
  readonly scope: Scope;
  readonly principalId: string;
  readonly by: MemoryId;
}

/** A summary was written: a memory standing for its sources at their exact revisions. */
export interface SummarizeEvent {
  readonly format: typeof EVENT_FORMAT;
  readonly kind: "summarize";
  readonly seq: number;
  /** The summary's id. */
  readonly memoryId: MemoryId;
  readonly scope: Scope;
  readonly principalId: string;
  /** Sorted by memory id. */
  readonly sources: readonly SourceRevision[];
  readonly revision: Revision;
}

/** A summarize event after its summary was redacted: the revision is gone. */
export interface RedactedSummarizeEvent {
  readonly format: typeof EVENT_FORMAT;
  readonly kind: "summarize";
  readonly seq: number;
  readonly memoryId: MemoryId;
  readonly scope: Scope;
  readonly principalId: string;
  readonly sources: readonly SourceRevision[];
  readonly redacted: true;
}

/**
 * A memory was promoted: copied, at the exact revision `origin` names, into `scope`, another
 * scope than the origin's, as a new memory (`memoryId`) that keeps the link.
 */
export interface PromoteEvent {
  readonly format: typeof PROMOTE_FORMAT;
  readonly kind: "promote";
  readonly seq: number;
  /** The copy's id. */
  readonly memoryId: MemoryId;
  /** The copy's scope. */
  readonly scope: Scope;
  readonly principalId: string;
  readonly origin: SourceRevision;
  /** The copy's revision 1: the origin's text, the promoter's provenance, trust floored. */
  readonly revision: Revision;
}

/** A promote event after its copy was redacted: the revision is gone. */
export interface RedactedPromoteEvent {
  readonly format: typeof PROMOTE_FORMAT;
  readonly kind: "promote";
  readonly seq: number;
  readonly memoryId: MemoryId;
  readonly scope: Scope;
  readonly principalId: string;
  readonly origin: SourceRevision;
  readonly redacted: true;
}

/** One recorded change to the store. */
export type Event =
  | NoteEvent
  | RedactedNoteEvent
  | RetractEvent
  | RedactEvent
  | SupersedeEvent
  | SummarizeEvent
  | RedactedSummarizeEvent
  | PromoteEvent
  | RedactedPromoteEvent;

export type EventKind = Event["kind"];

/** An event before the store assigns its seq. */
export type NewEvent = Event extends infer E ? (E extends Event ? Omit<E, "seq"> : never) : never;

/**
 * The form an event takes once its memory is redacted: the text and provenance it carried are
 * removed, and the rest is kept. Events that carry no text are returned as they are. Stores call
 * it when they rewrite their log for a redaction.
 */
export function redactedEvent(event: Event): Event {
  if (event.kind === "note" && "revision" in event) {
    const { revision: _removed, ...rest } = event;
    return { ...rest, redacted: true };
  }
  if (event.kind === "summarize" && "revision" in event) {
    const { revision: _removed, ...rest } = event;
    return { ...rest, redacted: true };
  }
  if (event.kind === "promote" && "revision" in event) {
    const { revision: _removed, ...rest } = event;
    return { ...rest, redacted: true };
  }
  return event;
}
