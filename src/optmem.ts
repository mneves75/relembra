/**
 * Imports an OptMem store's LOG.txt (docs/FORMAT.md, "OptMem import"). The layout is read from
 * OptMem's public README and CHANGELOG and from the bytes of a real log, never from its code;
 * FORMAT.md separates what each shows. No I/O: the host reads the file and passes its bytes.
 */
import { createHash } from "node:crypto";
import { ImportError, ScopeDeniedError } from "./errors.js";
import { findGuardViolation, MAX_MEMORY_BYTES } from "./guard.js";
import {
  EVENT_FORMAT,
  type Principal,
  type Provenance,
  type Revision,
  type Scope,
} from "./model.js";
import { type Clock, type Store, systemClock } from "./ports.js";
import {
  acceptanceTime,
  checkFence,
  checkName,
  checkPrincipal,
  checkProvenance,
  enforceFence,
  lowerTrust,
  type NoteProvenance,
  owns,
  trustCeiling,
} from "./relembra.js";
import { MAX_SCOPE_BYTES, utf8Bytes } from "./render.js";
import {
  type ImportRefusal,
  type ImportReport,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_EVENTS,
} from "./transfer.js";

export interface OptmemImportInput {
  /** The scope every record is imported into. Needs ownership and write access. */
  readonly scope: Scope;
  /**
   * Names the OptMem store in each record's source (`optmem:<store>:<record>`, then
   * `:<YYYY-MM-DD>` when the record carries a date prefix), memory id and
   * checkpoint: 1 to 64 ASCII letters, digits, `.`, `_` or `-` (RangeError otherwise), forming a
   * source the guard accepts (ProvenanceError otherwise, as for a direct note's source).
   */
  readonly store: string;
  /** The bytes of the store's LOG.txt. */
  readonly log: Uint8Array;
  /**
   * The host's clock: the revision time of every memory this import writes, and its acceptance
   * time on a store without a time of its own. System clock when absent.
   */
  readonly clock?: Clock;
  /** Who imports: agent, harness, model and host. Trust and source are set by the import. */
  readonly provenance: Omit<NoteProvenance, "trust" | "source">;
}

const STORE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const NEWLINE = 0x0a;
const SPACE = 0x20;

/**
 * Imports the records of an OptMem log into `input.scope`, in one transaction:
 * - record `n` becomes the memory `optmemId(scope, store, n)`, its text the record without its
 *   padding and its provenance source `optmem:<store>:<n>`; a record that begins with
 *   `#<digits> <YYYY-MM-DD> ` carries OptMem's prefix, whatever its text was meant to be: the prefix
 *   is removed from its text and its date appended to the source
 *   (`optmem:<store>:<n>:<YYYY-MM-DD>`); a log is all prefixed, counted from 0 with real dates, or
 *   all plain, and is `not-optmem` otherwise; the id is minted per destination
 *   scope, so one OptMem store imported into two scopes gives two independent sets of memories,
 *   each with its own checkpoint `optmem:<scope key>:<store>`;
 * - a record whose memory the store holds with the same text, or as a tombstone, is skipped; the
 *   same memory with another text, or with a record now unreadable or refused by the guard,
 *   refuses the import (`modified`);
 * - a record without a memory that the guard refuses is reported by line, on every import, and
 *   never imported;
 * - the log must keep the checkpoint's record width (`modified`) and be at least as long as it
 *   says (`truncated`); the checkpoint then moves to the log's end. It keeps no hash, so a
 *   redacted record leaves no fingerprint;
 * - trust is `agent` (or the principal's lower ceiling), never pinned, and no op records;
 * - every memory is dated by the host's clock (`revision.at`), never by the file, and accepted
 *   (`notedAt`, which retention counts from) at the store's time when it keeps one;
 * - needs ownership of, and write access to, the scope, checked before anything is read;
 * - the provenance, record sources included, passes the checks a direct note's does, before
 *   anything is written: a store name the guard refuses in a source writes no checkpoint either.
 */
export async function importOptmem(
  store: Store,
  principal: Principal,
  input: OptmemImportInput,
): Promise<ImportReport> {
  const { scope, store: name, log } = input;
  // Authorization first, so a refused principal learns nothing of what the store holds. Its scopes
  // are well-formed, so an ill-formed scope is never owned: ids and keys never collide.
  checkPrincipal(principal);
  if (!owns(principal, scope)) throw new ScopeDeniedError("own");
  if (!principal.writable.includes(scope)) throw new ScopeDeniedError("write");
  if (typeof scope !== "string" || scope === "" || utf8Bytes(scope) > MAX_SCOPE_BYTES) {
    throw new RangeError(`a scope must be 1 to ${MAX_SCOPE_BYTES} UTF-8 bytes`);
  }
  checkName("scope", scope);
  if (typeof name !== "string" || !STORE_NAME.test(name)) {
    throw new RangeError("an OptMem store name is 1 to 64 letters, digits, '.', '_' or '-'");
  }
  if (!(log instanceof Uint8Array)) throw new TypeError("an OptMem log is a Uint8Array");
  if (log.length > MAX_IMPORT_BYTES) throw new ImportError("too-large", 0, "file");
  // Read before the transaction: no host callback runs while the store is locked.
  const at = (input.clock ?? systemClock).now();
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new RangeError("the clock must give whole epoch milliseconds");
  }
  const { agent, harness, model, host } = input.provenance;
  const trust = lowerTrust(trustCeiling(principal), "agent");
  // Screened before anything is read or written, with a stand-in op id and a plain first record's
  // source: the store name reaches every record's source and the checkpoint, so a name the guard
  // refuses in a source (a credential shape) is refused here, as on the direct note path. Each
  // record's own provenance is screened again below; a refusal there rolls the import back.
  checkProvenance({
    agent,
    harness,
    model,
    host,
    source: `optmem:${name}:1`,
    trust,
    opId: "optmem",
  });
  const fence = principal.fence === undefined ? undefined : checkFence(principal.fence);
  const { width, count } = readLog(log);
  if (count > MAX_IMPORT_EVENTS)
    throw new ImportError("too-large", MAX_IMPORT_EVENTS + 1, "records");
  const prefixes = readPrefixes(log, width, count);
  const source = `optmem:${sha256(utf8(scope)).slice(0, 16)}:${name}`;

  return store.transaction(async (tx) => {
    if (fence !== undefined) await enforceFence(tx, fence);
    const accepted = await acceptanceTime(tx, at);
    // The checkpoint holds only a length and a record width: the records it covers are checked
    // against the memories they became, so nothing outlives a redaction as a fingerprint of the
    // erased text. A changed width moves every record boundary, so it is refused before replay.
    const checkpoint = await tx.checkpoint(source);
    if (checkpoint !== undefined && checkpoint.bytes > 0) {
      if (checkpoint.bytes > count * width) throw new ImportError("truncated", 0);
      if (checkpoint.width !== width) throw new ImportError("modified", 0);
    }
    let imported = 0;
    let skipped = 0;
    const refused: ImportRefusal[] = [];
    for (let index = 0; index < count; index++) {
      const line = index + 1;
      const memoryId = optmemId(scope, name, line);
      const prefix = prefixes?.[index];
      const start = index * width + (prefix?.length ?? 0);
      const text = recordText(log.subarray(start, (index + 1) * width - 1));
      // The memory first, so a guard refusal cannot hide a change to a record imported before.
      const stored = await tx.memory(memoryId);
      if (stored !== undefined) {
        // Another scope's memory under this id was planted there: never compare its content.
        if (stored.scope !== scope) throw new ImportError("conflict", line);
        // The same record imported before; a different text means the log changed under it. A
        // redacted record cannot be compared: that would need a fingerprint of the erased text.
        const same = stored.status === "redacted" || stored.revision.text === text;
        if (!same) throw new ImportError("modified", line);
        skipped++;
        continue;
      }
      const rule = text === undefined ? "ill-formed" : findGuardViolation(text, MAX_MEMORY_BYTES);
      if (rule !== undefined || text === undefined) {
        refused.push(Object.freeze({ line, rule: rule ?? "ill-formed" }));
        continue;
      }
      const provenance: Provenance = checkProvenance({
        agent,
        harness,
        model,
        host,
        source:
          prefix === undefined ? `optmem:${name}:${line}` : `optmem:${name}:${line}:${prefix.date}`,
        trust,
        opId: memoryId,
      });
      const revision: Revision = Object.freeze({ number: 1, text, at, provenance });
      const { seq } = await tx.append({
        format: EVENT_FORMAT,
        kind: "note",
        memoryId,
        scope,
        principalId: principal.id,
        pinned: false,
        revision,
      });
      await tx.putMemory({
        id: memoryId,
        scope,
        seq,
        pinned: false,
        notedAt: accepted,
        revision,
        status: "live",
      });
      imported++;
    }
    await tx.putCheckpoint({ source, bytes: count * width, width });
    return Object.freeze({ imported, skipped, refused: Object.freeze(refused) });
  });
}

/**
 * The record width and the number of records written: the records after the last good one are
 * what a crash left (a zero byte, or no newline at the end) and are dropped. A record that is
 * neither, or a bad record before the last good one, is not an OptMem log.
 */
function readLog(log: Uint8Array): { width: number; count: number } {
  if (log.length === 0) return { width: 0, count: 0 };
  const firstNewline = log.indexOf(NEWLINE);
  if (firstNewline < 0) {
    if (log.every((byte) => byte === 0)) return { width: 0, count: 0 };
    throw new ImportError("not-optmem", 1);
  }
  const width = firstNewline + 1;
  const records = Math.ceil(log.length / width);
  const at = (index: number) => log.subarray(index * width, (index + 1) * width);
  const good = (record: Uint8Array) =>
    record.length === width && record.indexOf(NEWLINE) === width - 1 && !record.includes(0);
  let count = records;
  while (count > 0 && !good(at(count - 1))) {
    const record = at(count - 1);
    // Never written: a crash left zeros in it, or cut it before its newline.
    if (!record.includes(0) && record.at(-1) === NEWLINE)
      throw new ImportError("not-optmem", count);
    count--;
  }
  for (let index = 0; index < count; index++) {
    if (!good(at(index))) throw new ImportError("not-optmem", index + 1);
  }
  return { width, count };
}

/** The `#<n> <YYYY-MM-DD> ` that begins a record: its byte length and its date. */
interface RecordPrefix {
  readonly length: number;
  readonly date: string;
}

/**
 * The prefix shape, matched against a record's bytes before its newline read as Latin-1 (one
 * character per byte), so a counter of any length is seen and the text after it is left alone.
 */
const PREFIX = /^#([0-9]+) ([0-9]{4})-([0-9]{2})-([0-9]{2}) /;

/**
 * The prefix of each record, or undefined for a log of plain records. A record that begins with
 * `#<digits> <YYYY-MM-DD> ` carries the prefix; there is no plain reading of one, because OptMem
 * always writes it. The first record decides: when it carries the prefix, every record must, with
 * the counter its position minus one and a real calendar date; a log that mixes the two, a counter
 * out of place or an invalid date is not an OptMem log. The error names the line only, never the
 * record's bytes.
 */
function readPrefixes(
  log: Uint8Array,
  width: number,
  count: number,
): readonly RecordPrefix[] | undefined {
  const prefixes: (RecordPrefix | undefined)[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * width;
    const record = log.subarray(start, start + width - 1);
    const match = PREFIX.exec(new TextDecoder("latin1").decode(record));
    if (match === null) {
      prefixes.push(undefined);
    } else {
      const [whole, counter = "", year = "", month = "", day = ""] = match;
      if (counter !== String(index) || !isCalendarDate(+year, +month, +day)) {
        throw new ImportError("not-optmem", index + 1);
      }
      prefixes.push({ length: whole.length, date: `${year}-${month}-${day}` });
    }
    if ((prefixes[index] === undefined) !== (prefixes[0] === undefined)) {
      throw new ImportError("not-optmem", index + 1);
    }
  }
  return prefixes[0] === undefined ? undefined : (prefixes as RecordPrefix[]);
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** The text of a record (its bytes before the newline) without its trailing spaces, or undefined when not UTF-8. */
function recordText(bytes: Uint8Array): string | undefined {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === SPACE) end--;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, end),
    );
  } catch {
    return undefined;
  }
}

/**
 * The memory id of record `n` of OptMem store `name` imported into `scope`: `om-` and the first
 * 32 hex characters of the sha256 of `<scope>\0optmem:<name>\0<n>`. Deterministic, so importing
 * again finds the memory, and minted per scope, so the same record in two scopes never collides.
 */
function optmemId(scope: Scope, name: string, n: number): string {
  return `om-${sha256(utf8(`${scope}\0optmem:${name}\0${n}`)).slice(0, 32)}`;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
