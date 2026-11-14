/**
 * Which access a principal lacked. `own`: retract, redact, or see retracted memories. `promote`:
 * copy a memory into the scope.
 */
export type ScopeAccess = "read" | "write" | "pin" | "own" | "promote";

/**
 * The principal may not read, write, pin, promote into or own the requested scope. The message
 * never names the scope.
 */
export class ScopeDeniedError extends Error {
  override readonly name = "ScopeDeniedError";
  readonly access: ScopeAccess;

  constructor(access: ScopeAccess) {
    super(
      access === "own"
        ? "scope denied: the principal does not own this scope"
        : access === "promote"
          ? "scope denied: the principal may not promote into this scope"
          : `scope denied: the principal may not ${access} this scope`,
    );
    this.access = access;
  }
}

/**
 * No memory this principal may see has the id: it does not exist, lives in a scope the principal
 * cannot read, or is not served (retracted, superseded or redacted) and the principal does not own
 * its scope. The message never names the id, so a refusal cannot confirm that a memory exists.
 */
export class MemoryNotFoundError extends Error {
  override readonly name = "MemoryNotFoundError";

  constructor() {
    super("memory not found");
  }
}

/** The memory exists and the principal may see it, but the operation refuses its status. */
export class MemoryStateError extends Error {
  override readonly name = "MemoryStateError";
  readonly status: "retracted" | "superseded" | "redacted";

  constructor(status: "retracted" | "superseded" | "redacted") {
    super(`the memory is ${status}`);
    this.status = status;
  }
}

/**
 * A summary cannot be superseded: its replacement would carry its sources' facts without their
 * lineage, so redacting a source would not reach it. Retract the summary and submit a new one,
 * which is checked against its sources' current revisions and trust.
 */
export class SummarySupersedeError extends Error {
  override readonly name = "SummarySupersedeError";

  constructor() {
    super("a summary cannot be superseded; retract it and submit a new summary");
  }
}

/** A provenance field the core screens. */
export type ProvenanceField = "agent" | "harness" | "model" | "host" | "source" | "trust" | "opId";

/**
 * Why a provenance field was refused: a guard rule, a missing value, a trust value that is not a
 * tier, trust above the principal's ceiling, or a summary's trust above its sources'.
 */
export type ProvenanceRule =
  | GuardRule
  | "missing"
  | "unknown-tier"
  | "above-ceiling"
  | "above-sources";

/**
 * A write's provenance field is refused (ProvenanceRule: a guard rule, missing, not a tier, above
 * the principal's ceiling or above a summary's sources); note, summary, promote and supersede throw
 * it. The message names the field and the rule, never the value.
 */
export class ProvenanceError extends Error {
  override readonly name = "ProvenanceError";
  readonly field: ProvenanceField;
  readonly rule: ProvenanceRule;

  constructor(field: ProvenanceField, rule: ProvenanceRule) {
    super(`provenance rejected: ${field} (${rule})`);
    this.field = field;
    this.rule = rule;
  }
}

/** The guard rule a memory's text broke. */
export type GuardRule =
  | "blank"
  | "too-long"
  | "ill-formed"
  | "multi-line"
  | "bidi-character"
  | "zero-width-character"
  | "control-character"
  | "format-character"
  | "invisible-character"
  | "credential";

/** The guard refused a memory's text. The message names the rule and never echoes the text. */
export class GuardError extends Error {
  override readonly name = "GuardError";
  readonly rule: GuardRule;

  constructor(rule: GuardRule) {
    super(`guard rejected the memory: ${rule}`);
    this.rule = rule;
  }
}

/**
 * The op id was already used for a write with a different payload. The message never echoes the
 * payload or the op id.
 */
export class OpConflictError extends Error {
  override readonly name = "OpConflictError";

  constructor() {
    super("op id conflict: the op id was already used for a different payload");
  }
}

/**
 * The write carried an authority fence epoch lower than the one the store holds for its key, so
 * its writer's authority has ended. Nothing was committed.
 */
export class FencedError extends Error {
  override readonly name = "FencedError";

  constructor() {
    super("fenced: the writer's epoch is lower than the store's for this authority");
  }
}

/**
 * The byte budget cannot hold even the rendering's frame, after the egress filter. Nothing is
 * rendered: a rendering is never cut mid-entry and never over budget.
 */
export class BudgetError extends Error {
  override readonly name = "BudgetError";
  readonly budgetBytes: number;

  constructor(budgetBytes: number) {
    super(`the budget of ${budgetBytes} bytes cannot hold the rendering's frame`);
    this.budgetBytes = budgetBytes;
  }
}

/** The host's egress filter denied a rendering for this principal. Nothing left relembra. */
export class EgressDeniedError extends Error {
  override readonly name = "EgressDeniedError";
  /** The filter's reason, as the host wrote it. */
  readonly reason: string;

  constructor(reason: string) {
    super("egress denied the rendering");
    this.reason = reason;
  }
}

/**
 * Terminal: the memory this operation wrote was redacted, so a retry of the operation can never
 * return it. Carries the memory's id (its tombstone keeps it) and nothing of its text.
 */
export class MemoryRedactedError extends Error {
  override readonly name = "MemoryRedactedError";
  readonly memoryId: string;

  constructor(memoryId: string) {
    super("the memory this operation wrote has been redacted");
    this.memoryId = memoryId;
  }
}

/**
 * A rendering for a carrier carried a memory that was redacted while it was rendered (after the
 * read, before its exposure was recorded), three times in a row. It is not returned: the carrier
 * was recorded, but the redaction's outbox row could not name it. Render again.
 */
export class ExposureRedactedError extends Error {
  override readonly name = "ExposureRedactedError";

  constructor() {
    super("a memory this rendering carried was redacted while it was rendered; render again");
  }
}

/**
 * A summary's source, or the origin of a promotion, is no longer the revision it was read at: it
 * was revised, superseded, retracted or redacted since. Nothing was written; read it again.
 */
export class SourceChangedError extends Error {
  override readonly name = "SourceChangedError";
  readonly memoryId: string;

  constructor(memoryId: string) {
    super("a memory changed since it was read at that revision");
    this.memoryId = memoryId;
  }
}

/**
 * Why an import was refused:
 * - `format-too-new`: the file's or an event's format is newer than this relembra knows;
 * - `malformed`: a line is not what the format says (bad JSON, a missing header, an unknown kind,
 *   a missing or mistyped field, seqs out of order, an event about a memory never noted);
 * - `guard`, `provenance`: a memory's text or a provenance field broke a guard rule;
 * - `future-time`: a revision is dated later than the import's acceptance time allows (the
 *   store's time when it keeps one, else the host's clock; FORMAT.md);
 * - `redacted-in-target`: the file holds text of a memory the target has redacted (a stale export);
 * - `conflict`: the file and the target disagree about a memory with the same id, or about its
 *   scope;
 * - `denied`: a line needs authority the importer lacks over a memory the target holds, as the
 *   direct operation would (detail `above-ceiling`, `pin` or `promote`);
 * - `truncated`, `modified`: a source already imported is now shorter, or a record it imported
 *   changed;
 * - `not-optmem`: the file is not an OptMem log as docs/FORMAT.md reads one;
 * - `too-large`: the file, a line or the event (or record) count is over its limit
 *   (docs/FORMAT.md, "Import limits"), detail `file`, `line`, `events` or `records`.
 */
export type ImportRule =
  | "format-too-new"
  | "malformed"
  | "guard"
  | "provenance"
  | "future-time"
  | "redacted-in-target"
  | "conflict"
  | "denied"
  | "truncated"
  | "modified"
  | "not-optmem"
  | "too-large";

/** A string that names something, and must be well-formed UTF-16. */
export type NamingField =
  | "scope"
  | "principal id"
  | "memory id"
  | "fence key"
  | "carrier id"
  | "carrier kind";

/**
 * A scope, principal id, memory id, fence key, carrier id or carrier kind holds a lone surrogate
 * (ill-formed UTF-16). Once encoded as UTF-8 it would become U+FFFD, so two different strings
 * would name the same thing in a store, a hash or a file. A TypeError, like the other refusals of
 * a malformed argument. The message names the field, never the value.
 */
export class IllFormedStringError extends TypeError {
  override readonly name = "IllFormedStringError";
  readonly field: NamingField;

  constructor(field: NamingField) {
    super(`a ${field} must be well-formed UTF-16 (no lone surrogate)`);
    this.field = field;
  }
}

/**
 * A scope, principal id, memory id, fence key, carrier id or carrier kind breaks the identifier
 * rule: it is blank, over its byte cap, more than one line, or holds a control, format, bidi,
 * zero-width or other invisible character, or a credential shape (the guard's rules,
 * docs/FORMAT.md "Identifiers"). Refused where it enters, before any store call, so every store
 * holds the same names and no rendering shows one raw. A TypeError, like IllFormedStringError.
 * The message names the field and the rule, never the value.
 */
export class IdentifierError extends TypeError {
  override readonly name = "IdentifierError";
  readonly field: NamingField;
  readonly rule: GuardRule;

  constructor(field: NamingField, rule: GuardRule) {
    super(`a ${field} must pass the identifier rule (${rule})`);
    this.field = field;
    this.rule = rule;
  }
}

/**
 * The import was refused, and wrote nothing. Names the rule and the 1-based line (or record) it
 * was refused at, 0 for the file as a whole, and never echoes the file's content.
 */
export class ImportError extends Error {
  override readonly name = "ImportError";
  readonly reason: ImportRule;
  readonly line: number;
  /**
   * The guard rule, `<field>:<rule>` for provenance and for a malformed identifier (such as
   * `memoryId:control-character`), the `denied` reason (`above-ceiling`, `pin`, `promote`), the
   * malformed line's rule (`summary-supersede`, `copy-replacement`, `summary-promote`) or the
   * `too-large` limit (`file`, `line`, `events`, `records`), when there is one.
   */
  readonly detail: string | undefined;

  constructor(reason: ImportRule, line: number, detail?: string) {
    super(
      `import refused${line > 0 ? ` at line ${line}` : ""}: ${reason}${detail === undefined ? "" : ` (${detail})`}`,
    );
    this.reason = reason;
    this.line = line;
    this.detail = detail;
  }
}

/**
 * The memories a mutation would change are not the ones the caller approved: something was
 * noted, summarized, retracted or revised in between. Nothing was written; preview again.
 */
export class PlanChangedError extends Error {
  override readonly name = "PlanChangedError";

  constructor() {
    super("the memories this would change differ from the approved preview");
  }
}

/** The store's schema was written by a newer relembra; this one never downgrades it. */
export class SchemaTooNewError extends Error {
  override readonly name = "SchemaTooNewError";
  readonly found: number;
  readonly supported: number;
  constructor(found: number, supported: number) {
    super(`store schema version ${found} is newer than the ${supported} this relembra supports`);
    this.found = found;
    this.supported = supported;
  }
}

/** Another writer held the store's lock for longer than the store's timeout. */
export class StoreBusyError extends Error {
  override readonly name = "StoreBusyError";
  constructor(timeoutMs: number, options: { cause: unknown }) {
    super(`another writer held the store for more than ${timeoutMs} ms`, options);
  }
}
