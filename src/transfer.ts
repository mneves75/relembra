/**
 * The JSONL export and its import (docs/FORMAT.md, "JSONL export"). Both take the principal the
 * host's policy gave: an export is the owner view of the scopes it names, and an import replays
 * events into scopes the principal owns.
 */
import {
  type GuardRule,
  IdentifierError,
  ImportError,
  ProvenanceError,
  ScopeDeniedError,
} from "./errors.js";
import { findGuardViolation, MAX_MEMORY_BYTES } from "./guard.js";
import {
  EVENT_FORMAT,
  type Event,
  LATEST_EVENT_FORMAT,
  type Memory,
  type MemoryId,
  PROMOTE_FORMAT,
  type Principal,
  type PromoteEvent,
  type Provenance,
  type RedactedNoteEvent,
  type RedactedPromoteEvent,
  type RedactedSummarizeEvent,
  type RedactionCause,
  type RetractEvent,
  type Revision,
  type Scope,
  type SourceRevision,
  type StoredMemory,
  type SupersedeEvent,
  TRUSTS,
  type Trust,
} from "./model.js";
import { type Clock, type Store, type StoreTransaction, systemClock } from "./ports.js";
import {
  acceptanceTime,
  checkFence,
  checkPrincipal,
  checkProvenance,
  checkSources,
  enforceCeiling,
  enforceFence,
  liveDerived,
  lowerTrust,
  MAX_PRINCIPAL_ID_BYTES,
  owns,
  redactionPlan,
  redactWithDerived,
  retractAll,
  trustCeiling,
} from "./relembra.js";
import { isSummary, MAX_ID_BYTES, MAX_SCOPE_BYTES, utf8Bytes } from "./render.js";
import { RELEMBRA_VERSION } from "./version.js";

/** The first line of an export. */
export interface ExportHeader {
  readonly export: "relembra";
  /**
   * The newest event format of the lines after it: 1 when none is a promote event, so a format 1
   * reader still reads it, and 2 when one is.
   */
  readonly format: number;
  /** The relembra version that wrote the export. */
  readonly relembra: string;
  /** The scopes exported; every event's scope is one of them. */
  readonly scopes: readonly Scope[];
}

/**
 * How far past the import's acceptance time (the store's time when it keeps one, else the host's
 * clock) an imported revision may be dated: clock skew between the machine that wrote an export and
 * the one importing it. Later dates are refused, so a file cannot keep a memory younger than a
 * retention rule by dating it in the future.
 */
export const MAX_IMPORT_SKEW_MS = 5 * 60_000;

/**
 * The most UTF-8 bytes an import reads: a JSONL export (its whole text) or an OptMem log. A real
 * note line is about 600 bytes, so 64 MiB holds the event cap's 100,000 lines of that size.
 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
/**
 * The most UTF-8 bytes of one line of an export, its newline left out. The longest event format 1
 * can hold, a summary of 100 sources whose 128-byte ids all need JSON escapes, with every
 * provenance field at its cap, is under 40 KiB; this leaves room for a header naming several
 * hundred scopes.
 */
export const MAX_IMPORT_LINE_BYTES = 256 * 1024;
/** The most events an export, or records an OptMem log, may hold. */
export const MAX_IMPORT_EVENTS = 100_000;
/** The most UTF-8 bytes of the header's informational `relembra` version. */
const MAX_VERSION_BYTES = 64;

export interface ImportOptions {
  /**
   * The host's clock, which bounds imported revision times on a store without a time of its own.
   * The system clock when absent.
   */
  readonly clock?: Clock;
}

export interface ExportInput {
  /** One scope to export; every scope the principal owns when absent. */
  readonly scope?: Scope;
}

/** A line an import left out because its text broke a guard rule. Never carries the text. */
export interface ImportRefusal {
  /** The 1-based line (or record) of the source. */
  readonly line: number;
  readonly rule: GuardRule;
}

export interface ImportReport {
  /**
   * Lines that changed the store: one memory per OptMem record; for an export, one event per
   * line, plus the retractions and redactions of derived summaries it cascades to.
   */
  readonly imported: number;
  /**
   * Lines the store already reflected: memories it holds, tombstones, and an export's cascade
   * lines whose work an earlier line's cascade did.
   */
  readonly skipped: number;
  /** Lines left out by the guard (OptMem only: a relembra export is refused whole instead). */
  readonly refused: readonly ImportRefusal[];
}

/**
 * The JSONL export of `scope`, or of every scope the principal owns: a header line, then every
 * event of those scopes in seq order, as the store holds them, so a redacted memory appears only
 * in its tombstone form. Each line ends with `\n`. Needs ownership of every exported scope, since
 * the export shows retracted and redacted memories (ScopeDeniedError `own`).
 */
export async function exportJsonl(
  store: Store,
  principal: Principal,
  input: ExportInput = {},
): Promise<string> {
  const { scope } = input;
  const owned = checkPrincipal(principal).owned ?? [];
  // Each scope once: an import refuses a header that names a scope twice.
  const scopes = scope === undefined ? [...new Set(owned)] : [scope];
  if (scopes.length === 0 || scopes.some((exported) => !owned.includes(exported))) {
    throw new ScopeDeniedError("own");
  }
  const events = await store.events({ scopes });
  const header: ExportHeader = {
    export: "relembra",
    format: events.reduce((newest, event) => Math.max(newest, event.format), EVENT_FORMAT),
    relembra: RELEMBRA_VERSION,
    scopes,
  };
  // format, kind and seq lead every line; the other fields follow in the order the store keeps.
  const lines = [
    header,
    ...events.map(({ format, kind, seq, ...rest }) => ({ format, kind, seq, ...rest })),
  ];
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/**
 * Replays a relembra export into `store`, in one transaction: all of it or nothing.
 * - Memories keep their ids. One the store already holds with the same scope and text is skipped,
 *   so importing a file twice adds nothing.
 * - A memory the store holds as a tombstone, with text in the file, refuses the import
 *   (`redacted-in-target`): a stale export never resurrects a redaction.
 * - A redaction in the file reaches the store's copy of the memory and the summaries derived
 *   from it there.
 * - Imported memories are never pinned, and their trust is at most `agent` (and the principal's
 *   ceiling). Events carry the importing principal's id; no op records are written.
 * - Needs ownership of, and write access to, every scope the header names.
 */
export async function importJsonl(
  store: Store,
  principal: Principal,
  jsonl: string,
  options: ImportOptions = {},
): Promise<ImportReport> {
  if (typeof jsonl !== "string") throw new TypeError("an export is a string of JSON lines");
  checkPrincipal(principal);
  // Read before the transaction: no host callback runs while the store is locked.
  const hostNow = (options.clock ?? systemClock).now();
  const fence = principal.fence === undefined ? undefined : checkFence(principal.fence);
  const cap = lowerTrust(trustCeiling(principal), "agent");
  return store.transaction(async (tx) => {
    // Revision times are bounded by the store's time when it keeps one, else the host's clock;
    // the file is parsed under that bound inside the transaction, so refusals keep line order.
    const latest = (await acceptanceTime(tx, hostNow)) + MAX_IMPORT_SKEW_MS;
    const { header, events } = parseExport(jsonl, latest);
    for (const scope of header.scopes) {
      if (!owns(principal, scope)) throw new ScopeDeniedError("own");
      if (!principal.writable.includes(scope)) throw new ScopeDeniedError("write");
    }
    if (fence !== undefined) await enforceFence(tx, fence);
    const replay = new Replay(tx, principal, cap);
    for (const parsed of events) await replay.apply(parsed);
    return replay.finish();
  });
}

/** One event of an export, checked, with the line it came from. */
interface Parsed {
  readonly line: number;
  readonly event: Event;
}

/** The header and events of an export, each checked against docs/FORMAT.md. */
function parseExport(jsonl: string, latest: number): { header: ExportHeader; events: Parsed[] } {
  // Each UTF-16 code unit encodes to at least one UTF-8 byte, so a longer string is over the cap.
  if (jsonl.length > MAX_IMPORT_BYTES) throw new ImportError("too-large", 0, "file");
  const lines = jsonl.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new ImportError("malformed", 1);
  checkBounds(lines);
  const header = checkHeader(parseLine(lines[0] as string, 1));
  const events: Parsed[] = [];
  let lastSeq = 0;
  lines.slice(1).forEach((text, index) => {
    const line = index + 2;
    const event = checkEvent(parseLine(text, line), line, header, latest);
    if (event.seq <= lastSeq) throw new ImportError("malformed", line);
    lastSeq = event.seq;
    // A memory is never its own replacement. Where the replacement must already be (the store,
    // or an earlier line of this file, in the same scope) is checked at replay, since an import
    // that skips a note the store holds leaves the two lines apart in the store's own export.
    if (event.kind === "supersede" && event.by === event.memoryId) {
      throw new ImportError("malformed", line);
    }
    // Nor its own origin.
    if (event.kind === "promote" && event.origin.memoryId === event.memoryId) {
      throw new ImportError("malformed", line);
    }
    events.push({ line, event });
  });
  return { header, events };
}

/**
 * The event count, each line's bytes and the file's, checked before any line is parsed
 * (docs/FORMAT.md, "Import limits"): `too-large`, detail `events`, `line` or `file`.
 */
function checkBounds(lines: readonly string[]): void {
  if (lines.length - 1 > MAX_IMPORT_EVENTS) {
    throw new ImportError("too-large", MAX_IMPORT_EVENTS + 2, "events");
  }
  let total = 0;
  lines.forEach((text, index) => {
    const bytes = text.length > MAX_IMPORT_LINE_BYTES ? Infinity : utf8Bytes(text);
    if (bytes > MAX_IMPORT_LINE_BYTES) throw new ImportError("too-large", index + 1, "line");
    total += bytes + 1;
  });
  if (total > MAX_IMPORT_BYTES) throw new ImportError("too-large", 0, "file");
}

/** A parsed line: the fields docs/FORMAT.md names, each still unchecked. */
type Json = Partial<
  Record<
    | "export"
    | "format"
    | "relembra"
    | "scopes"
    | "kind"
    | "seq"
    | "memoryId"
    | "scope"
    | "principalId"
    | "pinned"
    | "redacted"
    | "revision"
    | "sources"
    | "origin"
    | "by"
    | "cause"
    | "number"
    | "text"
    | "at"
    | "provenance"
    | "agent"
    | "harness"
    | "model"
    | "host"
    | "source"
    | "trust"
    | "opId",
    unknown
  >
>;

function parseLine(text: string, line: number): Json {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ImportError("malformed", line);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImportError("malformed", line);
  }
  return value as Json;
}

function checkFormat(format: unknown, line: number): asserts format is number {
  if (!Number.isSafeInteger(format) || (format as number) < 1) {
    throw new ImportError("malformed", line);
  }
  if ((format as number) > LATEST_EVENT_FORMAT) throw new ImportError("format-too-new", line);
}

function checkHeader(value: Json): ExportHeader {
  if (value.export !== "relembra") throw new ImportError("malformed", 1);
  checkFormat(value.format, 1);
  const { relembra, scopes } = value;
  if (typeof relembra !== "string" || !Array.isArray(scopes)) {
    throw new ImportError("malformed", 1);
  }
  checkIdentifier("relembra", relembra, MAX_VERSION_BYTES, 1);
  for (const scope of scopes) checkScope(scope, 1);
  if (new Set(scopes).size !== scopes.length) throw new ImportError("malformed", 1);
  return { export: "relembra", format: value.format as number, relembra, scopes };
}

/** An identifier field of an import file, named as an ImportError's detail names it. */
type IdentifierField =
  | "memoryId"
  | "by"
  | "sources"
  | "origin"
  | "scope"
  | "principalId"
  | "relembra";

/**
 * The identifier rule (docs/FORMAT.md, "Import of an export"): a string, well-formed Unicode
 * (`malformed` otherwise, as before), then the guard's rules within `maxBytes`, so an identifier
 * is one visible line holding no control, format, bidi, zero-width or invisible character and no
 * credential, as a memory's text is. A broken rule is `malformed`, detail `<field>:<rule>`.
 */
function checkIdentifier(
  field: IdentifierField,
  value: unknown,
  maxBytes: number,
  line: number,
): asserts value is string {
  if (typeof value !== "string" || value === "" || !value.isWellFormed()) {
    throw new ImportError("malformed", line);
  }
  const rule = findGuardViolation(value, maxBytes);
  if (rule !== undefined) throw new ImportError("malformed", line, `${field}:${rule}`);
}

function checkScope(scope: unknown, line: number): asserts scope is Scope {
  checkIdentifier("scope", scope, MAX_SCOPE_BYTES, line);
}

function checkId(
  id: unknown,
  line: number,
  field: IdentifierField = "memoryId",
): asserts id is MemoryId {
  checkIdentifier(field, id, MAX_ID_BYTES, line);
}

function checkPrincipalId(id: unknown, line: number): asserts id is string {
  checkIdentifier("principalId", id, MAX_PRINCIPAL_ID_BYTES, line);
}

const CAUSES: readonly RedactionCause[] = ["request", "retention", "source"];

/** One event line, checked field by field; anything else in the line is ignored. */
function checkEvent(value: Json, line: number, header: ExportHeader, latest: number): Event {
  const { scopes } = header;
  checkFormat(value.format, line);
  // The header names the newest format of its lines.
  if (value.format > header.format) throw new ImportError("malformed", line);
  const { kind, seq, memoryId, scope, principalId } = value;
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) throw new ImportError("malformed", line);
  checkId(memoryId, line);
  checkScope(scope, line);
  if (!scopes.includes(scope)) throw new ImportError("malformed", line);
  const common = { format: EVENT_FORMAT, seq: seq as number, memoryId, scope } as const;
  if (kind === "redact") {
    const { cause } = value;
    if (!CAUSES.includes(cause as RedactionCause)) throw new ImportError("malformed", line);
    if (principalId !== null) checkPrincipalId(principalId, line);
    return { ...common, kind, cause: cause as RedactionCause, principalId };
  }
  checkPrincipalId(principalId, line);
  switch (kind) {
    case "retract":
      return { ...common, kind, principalId };
    case "supersede":
      checkId(value.by, line, "by");
      return { ...common, kind, principalId, by: value.by };
    case "note": {
      if (typeof value.pinned !== "boolean") throw new ImportError("malformed", line);
      const base = { ...common, kind, principalId, pinned: value.pinned };
      if (isRedactedForm(value, line)) return { ...base, redacted: true };
      return { ...base, revision: checkRevision(value.revision, line, latest) };
    }
    case "summarize": {
      let sources: readonly SourceRevision[];
      try {
        sources = checkSources(value.sources as SourceRevision[]);
      } catch (error) {
        // checkSources applies the core's identifier rule to each source's id.
        const detail = error instanceof IdentifierError ? `sources:${error.rule}` : undefined;
        throw new ImportError("malformed", line, detail);
      }
      const base = { ...common, kind, principalId, sources };
      if (isRedactedForm(value, line)) return { ...base, redacted: true };
      return { ...base, revision: checkRevision(value.revision, line, latest) };
    }
    case "promote": {
      // Format 1 has no promote event: a format 1 line of this kind is malformed.
      if (value.format < PROMOTE_FORMAT) throw new ImportError("malformed", line);
      const base = {
        ...common,
        format: PROMOTE_FORMAT as typeof PROMOTE_FORMAT,
        kind,
        principalId,
        origin: checkOrigin(value.origin, line),
      };
      if (isRedactedForm(value, line)) return { ...base, redacted: true };
      const revision = checkRevision(value.revision, line, latest);
      // A copy is a new memory: the direct promote always writes its revision 1.
      if (revision.number !== 1) throw new ImportError("malformed", line);
      return { ...base, revision };
    }
    default:
      throw new ImportError("malformed", line);
  }
}

/** A promote line's origin: a memory id and a positive revision. */
function checkOrigin(value: unknown, line: number): SourceRevision {
  if (typeof value !== "object" || value === null) throw new ImportError("malformed", line);
  const { memoryId, revision } = value as { memoryId?: unknown; revision?: unknown };
  checkId(memoryId, line, "origin");
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new ImportError("malformed", line);
  }
  return Object.freeze({ memoryId, revision: revision as number });
}

/** Whether a note, summarize or promote line is in its redacted form: `redacted: true`, no revision. */
function isRedactedForm(value: Json, line: number): boolean {
  if (value.redacted === undefined) return false;
  if (value.redacted !== true || value.revision !== undefined) {
    throw new ImportError("malformed", line);
  }
  return true;
}

/** A revision's fields, checked; `latest` is the last epoch millisecond its `at` may be. */
function checkRevision(value: unknown, line: number, latest: number): Revision {
  if (typeof value !== "object" || value === null) throw new ImportError("malformed", line);
  const { number, text, at, provenance } = value as Json;
  if (!Number.isSafeInteger(number) || (number as number) < 1) {
    throw new ImportError("malformed", line);
  }
  if (!Number.isSafeInteger(at) || (at as number) < 0) throw new ImportError("malformed", line);
  if ((at as number) > latest) throw new ImportError("future-time", line);
  if (typeof text !== "string") throw new ImportError("malformed", line);
  const rule = findGuardViolation(text, MAX_MEMORY_BYTES);
  if (rule !== undefined) throw new ImportError("guard", line, rule);
  return Object.freeze({
    number: number as number,
    text,
    at: at as number,
    provenance: checkImportedProvenance(provenance, line),
  });
}

function checkImportedProvenance(value: unknown, line: number): Provenance {
  if (typeof value !== "object" || value === null) throw new ImportError("malformed", line);
  const { agent, harness, model, host, source, trust, opId } = value as Json;
  if (!TRUSTS.includes(trust as Trust))
    throw new ImportError("provenance", line, "trust:unknown-tier");
  try {
    return checkProvenance({
      agent,
      harness,
      model,
      host,
      ...(source === undefined ? {} : { source }),
      trust,
      opId,
    } as Provenance);
  } catch (error) {
    if (error instanceof ProvenanceError) {
      throw new ImportError("provenance", line, `${error.field}:${error.rule}`);
    }
    throw error;
  }
}

/** A memory the file noted only in its redacted form, while its replay waits for its tombstone. */
interface Pending {
  readonly line: number;
  readonly scope: Scope;
  readonly summary: boolean;
  readonly copy: boolean;
  status: "live" | "retracted" | "superseded";
}

/** Applies checked events to a store, inside the import's transaction. */
class Replay {
  private imported = 0;
  private skipped = 0;
  /**
   * Memories the file noted only in their redacted form, absent from the store: their redact
   * event must follow, and writes their tombstone. Mapped to the line that noted them, their
   * scope, which every later event about them must name, and the status their retract and
   * supersede lines give them, as a stored memory's would change.
   */
  private readonly awaitingTombstone = new Map<MemoryId, Pending>();

  private readonly tx: StoreTransaction;
  private readonly principal: Principal;
  /** The highest trust an imported memory may carry. */
  private readonly cap: Trust;

  constructor(tx: StoreTransaction, principal: Principal, cap: Trust) {
    this.tx = tx;
    this.principal = principal;
    this.cap = cap;
  }

  async apply({ line, event }: Parsed): Promise<void> {
    const stored = await this.tx.memory(event.memoryId);
    // Memory ids are one namespace across scopes, so an id another scope holds cannot be written
    // here: the refusal tells a caller who already knows that id that it exists (never its text
    // or state), where an absent id imports. Ids are unguessable to keep that narrow: randomIds
    // gives random UUIDs, and OptMem ids are minted per scope (docs/FORMAT.md, Identity).
    if (stored !== undefined && stored.scope !== event.scope)
      throw new ImportError("conflict", line);
    const wrote = await this.write(line, event, stored);
    if (wrote) this.imported++;
    else this.skipped++;
  }

  finish(): ImportReport {
    for (const { line } of this.awaitingTombstone.values())
      throw new ImportError("malformed", line);
    return Object.freeze({ imported: this.imported, skipped: this.skipped, refused: [] });
  }

  /** Writes what `event` adds to the store; false when the store already holds it. */
  private async write(line: number, event: Event, stored: StoredMemory | undefined) {
    switch (event.kind) {
      case "note":
      case "summarize":
      case "promote":
        if ("redacted" in event) return this.redactedForm(line, event, stored);
        if (stored?.status === "redacted") throw new ImportError("redacted-in-target", line);
        if (stored !== undefined) {
          if (
            !sameMemory(
              stored,
              event.revision.text,
              event.kind === "summarize" ? event.sources : undefined,
              event.kind === "promote" ? event.origin : undefined,
            )
          ) {
            throw new ImportError("conflict", line);
          }
          return false;
        }
        if (event.kind === "note") await this.note(event.memoryId, event.scope, event.revision);
        else if (event.kind === "summarize") {
          await this.summarize(line, event.memoryId, event.scope, event.revision, event.sources);
        } else await this.promote(line, event);
        return true;
      case "retract":
        if (stored?.status === "redacted") return false;
        if (await this.logOnly(line, event, stored)) return true;
        if (stored?.status === "retracted") return false;
        if (stored?.status !== "live") throw new ImportError("conflict", line);
        {
          const summaries = await liveDerived(this.tx, stored.id);
          this.withinCeiling(line, [stored, ...summaries]);
          await this.tx.append({
            format: EVENT_FORMAT,
            kind: "retract",
            memoryId: stored.id,
            scope: stored.scope,
            principalId: this.principal.id,
          });
          await this.tx.putMemory({ ...stored, status: "retracted" });
          await retractAll(this.tx, summaries, this.principal);
        }
        return true;
      case "supersede": {
        if (stored?.status === "redacted") return false;
        if (await this.logOnly(line, event, stored)) return true;
        if (stored?.status === "superseded") {
          if (stored.supersededBy !== event.by) throw new ImportError("conflict", line);
          return false;
        }
        if (stored?.status !== "live") throw new ImportError("conflict", line);
        // The direct supersede refuses a summary (SummarySupersedeError): format 1 has no such
        // event, so the line is malformed whatever the importer's authority.
        if (isSummary(stored)) throw new ImportError("malformed", line, "summary-supersede");
        // The replacement next, also before any authority check: a summary there is malformed
        // whatever the importer's ceiling or pin rights.
        await this.checkReplacement(line, event.by, stored.scope);
        // As the direct supersede: the ceiling over the target and the live summaries it
        // retracts, then the target's pin (an import never pins the replacement).
        const summaries = await liveDerived(this.tx, stored.id);
        this.withinCeiling(line, [stored, ...summaries]);
        if (stored.pinned && !(this.principal.pinnable ?? []).includes(stored.scope)) {
          throw new ImportError("denied", line, "pin");
        }
        await this.tx.append({
          format: EVENT_FORMAT,
          kind: "supersede",
          memoryId: stored.id,
          scope: stored.scope,
          principalId: this.principal.id,
          by: event.by,
        });
        await this.tx.putMemory({ ...stored, status: "superseded", supersededBy: event.by });
        await retractAll(this.tx, summaries, this.principal);
        return true;
      }
      case "redact": {
        if (stored?.status === "redacted") return false;
        if (stored !== undefined) {
          // The direct path's plan: the memory and its derived closure, read in this transaction.
          // The stored memory is in a scope the importer owns, so the plan's checks pass.
          const plan = await redactionPlan(this.tx, this.principal, stored.id);
          if (plan === undefined) return false;
          this.withinCeiling(line, [plan.memory, ...plan.derived]);
          // Erasing what the store holds is the importer's request, whatever cause the file
          // names: a file cannot pass it off as a retention sweep with no principal.
          await redactWithDerived(this.tx, plan, "request", this.principal.id);
          return true;
        }
        // History of a memory known only from the file: its cause is replayed as written. No
        // ceiling applies to that history: it changes nothing the store held (docs/FORMAT.md).
        const principalId = event.cause === "retention" ? null : this.principal.id;
        this.awaiting(line, event);
        this.awaitingTombstone.delete(event.memoryId);
        const { seq } = await this.tx.append({
          format: EVENT_FORMAT,
          kind: "redact",
          memoryId: event.memoryId,
          scope: event.scope,
          cause: event.cause,
          principalId,
        });
        // No text of this memory was ever in the store: there is nothing to scrub or deliver.
        await this.tx.redact({ id: event.memoryId, scope: event.scope, seq, status: "redacted" });
        return true;
      }
    }
  }

  /**
   * A note or summarize line in its redacted form. The store's tombstone, or its copy that the
   * file's redact event will redact, already stands for it; otherwise the redacted event is
   * written, and the tombstone with the redact event that must follow.
   */
  private async redactedForm(
    line: number,
    event: RedactedNoteEvent | RedactedSummarizeEvent | RedactedPromoteEvent,
    stored: StoredMemory | undefined,
  ): Promise<boolean> {
    if (stored !== undefined) return false;
    if (this.awaitingTombstone.has(event.memoryId)) throw new ImportError("malformed", line);
    // History of a memory whose text is gone: a copy's origin is not checked, since the copy
    // carries nothing of it any more.
    const principalId = this.principal.id;
    await this.tx.append(
      event.kind === "note"
        ? { ...omitSeq(event), principalId, pinned: false }
        : event.kind === "summarize"
          ? { ...omitSeq(event), principalId }
          : { ...omitSeq(event), principalId },
    );
    this.awaitingTombstone.set(event.memoryId, {
      line,
      scope: event.scope,
      summary: event.kind === "summarize",
      copy: event.kind === "promote",
      status: "live",
    });
    return true;
  }

  /**
   * A retract or supersede of a memory this file noted only in its redacted form: the event is
   * written as it stands in the log, and changes no memory (the tombstone will stand for it).
   * False when the store holds the memory; malformed when nothing earlier noted it.
   */
  private async logOnly(
    line: number,
    event: RetractEvent | SupersedeEvent,
    stored: StoredMemory | undefined,
  ): Promise<boolean> {
    if (stored !== undefined) return false;
    const pending = this.awaiting(line, event);
    // The same rules as for a stored memory: a superseded memory is neither retracted nor
    // superseded again, and a supersede needs a live target and a live replacement.
    if (pending.status === "superseded") throw new ImportError("conflict", line);
    if (event.kind === "supersede") {
      if (pending.status !== "live") throw new ImportError("conflict", line);
      if (pending.summary) throw new ImportError("malformed", line, "summary-supersede");
      await this.checkReplacement(line, event.by, event.scope);
    }
    pending.status = event.kind === "supersede" ? "superseded" : "retracted";
    const { seq: _seq, ...rest } = event;
    await this.tx.append(
      rest.kind === "retract"
        ? { ...rest, principalId: this.principal.id }
        : { ...rest, principalId: this.principal.id },
    );
    return true;
  }

  /**
   * Checks that a supersede's replacement `by` is already there, in `scope`: in the store (noted
   * before this import, or on an earlier line of it), or noted earlier in this file in its
   * redacted form. Malformed otherwise, whatever another scope holds under that id. It must also
   * be live at this point, as a direct supersede's freshly written replacement always is
   * (`conflict` otherwise): a replacement is never already replaced, so supersession never forms
   * a cycle, and no graph walk is needed.
   */
  private async checkReplacement(line: number, by: MemoryId, scope: Scope): Promise<void> {
    const replacement = await this.tx.memory(by);
    const pending = this.awaitingTombstone.get(by);
    const found =
      replacement === undefined
        ? pending?.scope === scope
          ? { status: pending.status, summary: pending.summary, copy: pending.copy }
          : undefined
        : replacement.scope === scope
          ? {
              status: replacement.status,
              summary: replacement.status !== "redacted" && isSummary(replacement),
              copy: replacement.status !== "redacted" && replacement.origin !== undefined,
            }
          : undefined;
    if (found === undefined) throw new ImportError("malformed", line);
    // A direct supersede's replacement is always a fresh note: never a summary, never a copy.
    if (found.summary) throw new ImportError("malformed", line, "summary-supersede");
    if (found.copy) throw new ImportError("malformed", line, "copy-replacement");
    if (found.status !== "live") throw new ImportError("conflict", line);
  }

  /**
   * The direct operations' trust ceiling (enforceCeiling) over every stored memory a line
   * changes, refused as `denied` with detail `above-ceiling` before anything is written.
   */
  private withinCeiling(line: number, memories: readonly Memory[]): void {
    try {
      enforceCeiling(this.principal, memories);
    } catch (error) {
      if (error instanceof ProvenanceError) throw new ImportError("denied", line, "above-ceiling");
      throw error;
    }
  }

  /**
   * Checks that `event` is about a memory this file noted only in its redacted form, in the same
   * scope: malformed when nothing earlier noted it, a conflict when it names another scope.
   */

  private awaiting(line: number, event: Event): Pending {
    const pending = this.awaitingTombstone.get(event.memoryId);
    if (pending === undefined) throw new ImportError("malformed", line);
    if (pending.scope !== event.scope) throw new ImportError("conflict", line);
    return pending;
  }

  private capped(revision: Revision, floor: Trust = this.cap): Revision {
    const trust = lowerTrust(revision.provenance.trust, floor);
    return Object.freeze({
      ...revision,
      provenance: Object.freeze({ ...revision.provenance, trust }),
    });
  }

  private async note(memoryId: MemoryId, scope: Scope, given: Revision): Promise<void> {
    const revision = this.capped(given);
    const { seq } = await this.tx.append({
      format: EVENT_FORMAT,
      kind: "note",
      memoryId,
      scope,
      principalId: this.principal.id,
      pinned: false,
      revision,
    });
    const memory: Memory = {
      id: memoryId,
      scope,
      seq,
      pinned: false,
      notedAt: revision.at,
      revision,
      status: "live",
    };
    await this.tx.putMemory(memory);
  }

  private async summarize(
    line: number,
    memoryId: MemoryId,
    scope: Scope,
    given: Revision,
    sources: readonly SourceRevision[],
  ): Promise<void> {
    let floor = this.cap;
    for (const { memoryId: sourceId, revision } of sources) {
      const source = await this.tx.memory(sourceId);
      // Scope before status: a source in another scope answers as an absent one, whatever its state.
      if (source === undefined || source.scope !== scope) throw new ImportError("malformed", line);
      if (source.status === "redacted") throw new ImportError("redacted-in-target", line);
      // A summary is written of live sources; here one was retracted or superseded first.
      if (source.status !== "live" || source.revision.number !== revision) {
        throw new ImportError("conflict", line);
      }
      floor = lowerTrust(floor, source.revision.provenance.trust);
    }
    const revision = this.capped(given, floor);
    const { seq } = await this.tx.append({
      format: EVENT_FORMAT,
      kind: "summarize",
      memoryId,
      scope,
      principalId: this.principal.id,
      sources,
      revision,
    });
    await this.tx.putMemory({
      id: memoryId,
      scope,
      seq,
      pinned: false,
      notedAt: revision.at,
      revision,
      status: "live",
      sources,
    });
  }

  /**
   * A promote line for a copy the store lacks, under the direct promote's rules: promote rights
   * on the copy's scope (`denied`, detail `promote`), and an origin in the store that the
   * importer may read, in another scope, live at the line's revision and not a summary. An
   * origin that is absent or that the importer cannot see is refused as `malformed` alike, so an
   * import learns nothing of another scope; one in its own scope or a summary is `malformed`
   * too (detail `summary-promote`); a redacted one is `redacted-in-target`; one retracted,
   * superseded or at another revision is a `conflict`. The copy's text is the stored origin's, as
   * the direct promote copies it: a line whose text differs is a `conflict` too, so a file can
   * never write arbitrary text under a link that names a real memory. Trust is capped by the
   * origin's.
   */
  private async promote(line: number, event: PromoteEvent): Promise<void> {
    const { memoryId, scope, origin: link } = event;
    if (!this.principal.promotable.includes(scope)) {
      throw new ImportError("denied", line, "promote");
    }
    const origin = await this.tx.memory(link.memoryId);
    if (origin === undefined || !seenBy(this.principal, origin)) {
      throw new ImportError("malformed", line);
    }
    if (origin.scope === scope) throw new ImportError("malformed", line);
    if (origin.status === "redacted") throw new ImportError("redacted-in-target", line);
    if (origin.status !== "live" || origin.revision.number !== link.revision) {
      throw new ImportError("conflict", line);
    }
    if (isSummary(origin)) throw new ImportError("malformed", line, "summary-promote");
    if (event.revision.text !== origin.revision.text) throw new ImportError("conflict", line);
    const revision = this.capped(
      { ...event.revision, text: origin.revision.text },
      lowerTrust(this.cap, origin.revision.provenance.trust),
    );
    const { seq } = await this.tx.append({
      format: PROMOTE_FORMAT,
      kind: "promote",
      memoryId,
      scope,
      principalId: this.principal.id,
      origin: link,
      revision,
    });
    await this.tx.putMemory({
      id: memoryId,
      scope,
      seq,
      pinned: false,
      notedAt: revision.at,
      revision,
      status: "live",
      origin: link,
    });
  }
}

/** Whether `principal` may see `stored`: any status in a scope it owns, live in one it reads. */
function seenBy(principal: Principal, stored: StoredMemory): boolean {
  return (
    owns(principal, stored.scope) ||
    (stored.status === "live" && principal.readable.includes(stored.scope))
  );
}

/**
 * Whether the stored memory is the one a line describes: the same text, the same sources and the
 * same origin.
 */
function sameMemory(
  stored: Memory,
  text: string,
  sources: readonly SourceRevision[] | undefined,
  origin: SourceRevision | undefined,
): boolean {
  if (stored.revision.text !== text) return false;
  if ((stored.sources === undefined) !== (sources === undefined)) return false;
  if (JSON.stringify(stored.sources ?? null) !== JSON.stringify(sources ?? null)) return false;
  const link = (o: SourceRevision | undefined) =>
    o === undefined ? null : [o.memoryId, o.revision];
  return JSON.stringify(link(stored.origin)) === JSON.stringify(link(origin));
}

function omitSeq<E extends Event>(event: E): Omit<E, "seq"> {
  const { seq: _seq, ...rest } = event;
  return rest;
}
