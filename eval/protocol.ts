/**
 * The candidate protocol, version 1 (eval/PROTOCOL.md): request and response types, and the
 * validators the scorer applies to every response before it scores anything.
 */
import { type EvalPrincipal, type MemoryState, TRUST_LEVELS, type Trust } from "./set.js";

export const PROTOCOL_VERSION = 1;

/**
 * Memory ids are opaque strings, but restricted to this shape so that an id is unambiguous as a
 * token inside rendered text: the leak check matches it bounded by characters outside the class.
 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** One memory to note. `supersedes` is an id the candidate returned for an earlier batch. */
export interface NoteItem {
  readonly scope: string;
  readonly text: string;
  readonly at: number;
  readonly trust: Trust;
  readonly pinned: boolean;
  readonly state: MemoryState;
  readonly supersedes?: string;
}

export interface FindHit {
  readonly id: string;
  readonly text: string;
  readonly trust: Trust;
}

export interface Requests {
  reset: Record<string, never>;
  note: { readonly principal: EvalPrincipal; readonly memories: readonly NoteItem[] };
  find: { readonly principal: EvalPrincipal; readonly query: string; readonly limit: number };
  brief: {
    readonly principal: EvalPrincipal;
    readonly topic: string;
    readonly budgetBytes: number;
  };
  wake: { readonly principal: EvalPrincipal; readonly scope: string; readonly budgetBytes: number };
  stop: Record<string, never>;
}

export interface Results {
  reset: { readonly protocol: number; readonly name: string; readonly version: string };
  note: { readonly ids: readonly string[] };
  find: { readonly results: readonly FindHit[] };
  brief: { readonly text: string };
  wake: { readonly text: string; readonly pinned: readonly string[] };
  stop: Record<string, never>;
}

export type Command = keyof Requests;

export interface Request<C extends Command = Command> {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly cmd: C;
  readonly args: Requests[C];
}

/** A response envelope, parsed but not yet checked against its request. */
export type Envelope =
  | { readonly kind: "ok"; readonly result: Fields }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** The fields the protocol reads from candidate JSON; every one may be missing or mistyped. */
export type Fields = {
  readonly [K in
    | "id"
    | "ok"
    | "result"
    | "error"
    | "code"
    | "message"
    | "protocol"
    | "name"
    | "version"
    | "ids"
    | "results"
    | "text"
    | "trust"
    | "pinned"]?: unknown;
};

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the envelope of one response line against the request id. A failure here means the
 * stream can no longer be trusted (the scorer restarts the candidate).
 */
export function parseEnvelope(value: unknown, requestId: string): Checked<Envelope> {
  if (!isObject(value)) return fail("response is not a JSON object");
  if (typeof value.id !== "string" || value.id !== requestId) {
    return fail(`response id does not answer request ${requestId}`);
  }
  if (value.ok === true) {
    const result = value.result;
    if (!isObject(result)) return fail("ok response without a result object");
    return { ok: true, value: { kind: "ok", result } };
  }
  if (value.ok === false) {
    const error = value.error;
    if (!isObject(error) || typeof error.code !== "string" || typeof error.message !== "string") {
      return fail("error response without error.code and error.message strings");
    }
    return { ok: true, value: { kind: "error", code: error.code, message: error.message } };
  }
  return fail("response ok is not a boolean");
}

/** Whether `value` has a key outside `allowed`. The key itself is never reported: it may be text. */
function hasUnexpected(value: Fields, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

/**
 * Why a parsed envelope holds a field the protocol does not define, or undefined. Unlike
 * parseEnvelope's failures, this one leaves the stream trustworthy: the request fails alone.
 */
export function envelopeFault(value: Fields): string | undefined {
  const body = value.ok === true ? "result" : "error";
  if (hasUnexpected(value, ["id", "ok", body])) return "unexpected field in the envelope";
  if (body === "error" && isObject(value.error) && hasUnexpected(value.error, ["code", "message"]))
    return "unexpected field in the error";
  return undefined;
}

/**
 * Characters no label may hold: controls (ESC among them), format characters, lone surrogates,
 * private-use and unassigned code points, line and paragraph separators and default-ignorable
 * code points.
 */
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Whether `value` is a label the scorer may print: a string of 1 to 100 characters on one line,
 * with nothing UNPRINTABLE, no `|` (it ends a Markdown table cell) and no leading or trailing
 * whitespace (eval/PROTOCOL.md, `reset`). A candidate's name and version reach the terminal and
 * the Markdown reports.
 */
export function isLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    value.trim() === value &&
    !value.includes("|") &&
    !UNPRINTABLE.test(value)
  );
}

/**
 * A label as Markdown inline text: U+FFFD in place of anything UNPRINTABLE, then a backslash
 * before each character Markdown could read as markup (`\`, `` ` ``, `*`, `_`, `[`, `]`, `<`,
 * `>`, `&`, `~`, `|`), so even an unchecked value stays one line of plain text in one cell.
 */
export function markdownLabel(label: string): string {
  return label
    .replace(new RegExp(UNPRINTABLE.source, "gu"), "\ufffd")
    .replace(/[\\`*_[\]<>&~|]/g, (c) => `\\${c}`);
}

/** The fields each result holds (eval/PROTOCOL.md); one more fails the request. */
const RESULT_FIELDS: { readonly [C in Command]: readonly string[] } = {
  reset: ["protocol", "name", "version"],
  note: ["ids"],
  find: ["results"],
  brief: ["text"],
  wake: ["text", "pinned"],
  stop: [],
};
const FIND_HIT_FIELDS = ["id", "text", "trust"] as const;

/** What a result is checked against: its request, and the ids noted in this session so far. */
export interface ResultContext<C extends Command> {
  readonly args: Requests[C];
  readonly knownIds: ReadonlySet<string>;
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

function distinctKnownIds(
  ids: unknown,
  knownIds: ReadonlySet<string>,
  field: string,
): Checked<readonly string[]> {
  if (!Array.isArray(ids)) return fail(`${field} is not an array`);
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") return fail(`${field} holds a non-string id`);
    if (seen.has(id)) return fail(`${field} repeats an id`);
    if (!knownIds.has(id)) return fail(`${field} holds an id this session never noted`);
    seen.add(id);
  }
  return { ok: true, value: ids as string[] };
}

type Validator<C extends Command> = (
  result: Fields,
  context: ResultContext<C>,
) => Checked<Results[C]>;

const validators: { [C in Command]: Validator<C> } = {
  reset(result) {
    if (result.protocol !== PROTOCOL_VERSION) return fail("reset: unsupported protocol version");
    for (const field of ["name", "version"] as const) {
      if (!isLabel(result[field])) {
        return fail(`reset: ${field} must be a single-line label of 1 to 100 characters`);
      }
    }
    return { ok: true, value: result as unknown as Results["reset"] };
  },
  note(result, { args, knownIds }) {
    const ids = result.ids;
    if (!Array.isArray(ids)) return fail("note: ids is not an array");
    if (ids.length !== args.memories.length) return fail("note: one id per memory is required");
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        return fail("note: an id does not match the id pattern");
      }
      if (seen.has(id) || knownIds.has(id)) return fail("note: ids must be distinct");
      seen.add(id);
    }
    return { ok: true, value: { ids: ids as string[] } };
  },
  find(result, { args, knownIds }) {
    const results = result.results;
    if (!Array.isArray(results)) return fail("find: results is not an array");
    if (results.length > args.limit) return fail(`find: more than ${args.limit} results`);
    for (const hit of results) {
      if (!isObject(hit) || typeof hit.text !== "string") {
        return fail("find: a result is not an object with id, text and trust");
      }
      if (!TRUST_LEVELS.includes(hit.trust as Trust))
        return fail("find: a result has no valid trust");
      if (hasUnexpected(hit, FIND_HIT_FIELDS))
        return fail("find: unexpected field in a result entry");
    }
    const ids = distinctKnownIds(
      results.map((hit: Fields) => hit.id),
      knownIds,
      "find: results",
    );
    if (!ids.ok) return ids;
    return { ok: true, value: { results: results as FindHit[] } };
  },
  brief(result, { args }) {
    const text = result.text;
    if (typeof text !== "string") return fail("brief: text is not a string");
    if (utf8Bytes(text) > args.budgetBytes) return fail("brief: text exceeds the byte budget");
    return { ok: true, value: { text } };
  },
  wake(result, { args, knownIds }) {
    const text = result.text;
    if (typeof text !== "string") return fail("wake: text is not a string");
    if (utf8Bytes(text) > args.budgetBytes) return fail("wake: text exceeds the byte budget");
    const pinned = distinctKnownIds(result.pinned, knownIds, "wake: pinned");
    if (!pinned.ok) return pinned;
    return { ok: true, value: { text, pinned: pinned.value } };
  },
  stop() {
    return { ok: true, value: {} };
  },
};

/** Checks a result against its command's schema, its request and the session's known ids. */
export function validateResult<C extends Command>(
  cmd: C,
  result: Fields,
  context: ResultContext<C>,
): Checked<Results[C]> {
  if (hasUnexpected(result, RESULT_FIELDS[cmd]))
    return fail(`${cmd}: unexpected field in the result`);
  return (validators[cmd] as Validator<C>)(result, context);
}
