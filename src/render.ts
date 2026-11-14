import { BudgetError, EgressDeniedError } from "./errors.js";
import { replaceUnseen } from "./guard.js";
import type { Memory, MemoryId, Principal, Trust } from "./model.js";
import type { EgressFilter } from "./ports.js";

/** What a wake or brief hands the host: the text, and the memories it carried in full. */
export interface Rendering {
  /** The frame and its lines, after the egress filter, within the byte budget. */
  readonly text: string;
  /**
   * The memories whose text the rendering carries, in rendering order. Index lines carry none, and
   * a rendering the egress filter left empty (or only white space) carries none.
   */
  readonly memoryIds: readonly MemoryId[];
}

/** Which rendering a frame wraps. `find` is ranked find results (`findRendering`, `relembra mcp`). */
export type RenderingKind = "wake" | "brief" | "find";

/** A memory's trust, read fail-closed: anything that is not a tier renders as `untrusted`. */
export function trustOf(memory: Memory): Trust {
  const trust = memory.revision.provenance.trust;
  return trust === "owner" || trust === "agent" ? trust : "untrusted";
}

/** The most UTF-8 bytes a rendered memory id may have. */
export const MAX_ID_BYTES = 128;
/** The most UTF-8 bytes a rendered scope may have. */
export const MAX_SCOPE_BYTES = 256;
/** The largest magnitude a Date accepts, in epoch milliseconds. */
const MAX_TIME = 8.64e15;

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/**
 * Escapes `&`, `<`, `>` and `"`, so evidence cannot open, close or forge an element or attribute.
 * Line breaks and every other code point the guard refuses as unseen (controls, bidi, zero-width
 * and other invisible characters, lone surrogates), which the guard and the import keep out of
 * new memories and ids but a store may still hold, become decimal references, so every element
 * stays on its own line and shows no raw invisible character. What the guard accepts (the emoji
 * joiners and selectors included) is escaped exactly as eval/PROTOCOL.md's rendering says.
 */
export function escapeText(value: string): string {
  const markup = value.replace(/[&<>"]/g, (char) => ESCAPES[char] as string);
  return replaceUnseen(markup, (char) => `&#${char.codePointAt(0)};`);
}

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * `<memory id="…" scope="…" rev="…" at="…" trust="…">text</memory>`, one line. A memory whose
 * metadata is out of bounds is refused (a store or host bug), never truncated: a cut id would
 * point at another memory. The error names the field, never the value.
 */
export function renderMemory(memory: Memory): string {
  const { id, scope, revision } = memory;
  const { number, at, text } = revision;
  bounded("id", id, MAX_ID_BYTES);
  bounded("scope", scope, MAX_SCOPE_BYTES);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("a stored memory's rev is not a positive integer");
  }
  if (!Number.isFinite(at) || Math.abs(at) > MAX_TIME) {
    throw new TypeError("a stored memory's at is not a time");
  }
  const time = new Date(at).toISOString();
  return `<memory id="${escapeText(id)}" scope="${escapeText(scope)}" rev="${number}" at="${time}" trust="${trustOf(memory)}">${escapeText(text)}</memory>`;
}

function bounded(field: "id" | "scope", value: unknown, maxBytes: number): void {
  if (typeof value !== "string" || value === "" || utf8Bytes(value) > maxBytes) {
    throw new TypeError(`a stored memory's ${field} is not 1 to ${maxBytes} UTF-8 bytes`);
  }
}

/** The frame around the lines, one element per line. */
export function frame(kind: RenderingKind, lines: readonly string[]): string {
  return [`<${kind}>`, ...lines, `</${kind}>`].join("\n");
}

/** Store order, newest first; memory id ascending breaks a tie, so the order is total. */
export function newestFirst(a: Memory, b: Memory): number {
  if (a.seq !== b.seq) return b.seq - a.seq;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** A summary is a memory with sources. */
export function isSummary(memory: Memory): boolean {
  return memory.sources !== undefined;
}

function revisionKey(memoryId: MemoryId, revision: number): string {
  return JSON.stringify([memoryId, revision]);
}

/** Trusted (owner and agent) memories first, then untrusted ones, keeping each group's order. */
function trustedFirst(memories: readonly Memory[]): Memory[] {
  const untrusted = (memory: Memory) => trustOf(memory) === "untrusted";
  return [...memories.filter((m) => !untrusted(m)), ...memories.filter(untrusted)];
}

const TRUST_RANK: Readonly<Record<Trust, number>> = { untrusted: 0, agent: 1, owner: 2 };

/**
 * The ids of the memories among `memories` that a summary among them covers: the summary lists
 * the memory at its current revision, and the summary's trust is at least the memory's. A less
 * trusted summary never displaces what it summarizes in a wake, nor makes it not due in pending.
 */
export function coveredIds(memories: readonly Memory[]): Set<MemoryId> {
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const covered = new Set<MemoryId>();
  for (const summary of memories) {
    for (const { memoryId, revision } of summary.sources ?? []) {
      const source = byId.get(memoryId);
      if (source === undefined || source.revision.number !== revision) continue;
      if (TRUST_RANK[trustOf(summary)] >= TRUST_RANK[trustOf(source)]) covered.add(source.id);
    }
  }
  return covered;
}

/**
 * The wake's memories in composition order:
 * 1. pinned memories, unless untrusted, newest first;
 * 2. recent memories, not summaries, that no summary covers (see coveredIds), newest first;
 * 3. summaries that no summary covers, most trusted first, then newest first, so a summary of a
 *    summary never goes ahead of a more trusted one it summarizes;
 * 4. the memories the summaries cover, summaries among them, newest first, so under a tight
 *    budget they are the first to fall to the index.
 * After the pinned memories, every trusted memory of groups 2 to 4 comes before every untrusted
 * one, each part in group order: an untrusted memory is never pinned and never ahead of a
 * trusted one.
 */
export function wakeOrder(memories: readonly Memory[]): Memory[] {
  const sorted = [...memories].sort(newestFirst);
  const isPinned = (memory: Memory) => memory.pinned && trustOf(memory) !== "untrusted";
  const covered = coveredIds(sorted);
  const isCovered = (memory: Memory) => covered.has(memory.id);
  const rest = sorted.filter((memory) => !isPinned(memory));
  const uncovered = rest.filter((memory) => !isCovered(memory));
  const summaries = uncovered
    .filter(isSummary)
    .sort((a, b) => TRUST_RANK[trustOf(b)] - TRUST_RANK[trustOf(a)] || newestFirst(a, b));
  return [
    ...sorted.filter(isPinned),
    ...trustedFirst([
      ...uncovered.filter((memory) => !isSummary(memory)),
      ...summaries,
      ...rest.filter(isCovered),
    ]),
  ];
}

/**
 * The summaries among `live` that cover any of the `ranked` memories and are not ranked
 * themselves, newest first, trusted before untrusted: a brief's summary slot.
 */
export function briefSummaries(ranked: readonly Memory[], live: readonly Memory[]): Memory[] {
  const shown = new Set(ranked.map((memory) => memory.id));
  const keys = new Set(ranked.map((memory) => revisionKey(memory.id, memory.revision.number)));
  const covering = live
    .filter((memory) => isSummary(memory) && !shown.has(memory.id))
    .filter((memory) =>
      (memory.sources ?? []).some((s) => keys.has(revisionKey(s.memoryId, s.revision))),
    )
    .sort(newestFirst);
  return trustedFirst(covering);
}

/** The default byte budget of a wake or brief. */
export const DEFAULT_BUDGET_BYTES = 9_500;

export function checkBudget(budgetBytes: number): number {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
    throw new RangeError("budgetBytes must be a positive integer");
  }
  return budgetBytes;
}

/** One line of a rendering, and the memory whose text it carries, if any. */
export interface Entry {
  readonly line: string;
  readonly carries?: MemoryId;
}

/** A memory in full: its text, attributed. */
function fullEntry(memory: Memory): Entry {
  return { line: renderMemory(memory), carries: memory.id };
}

/** A memory in the index: `<index id="…"/>`, its id and no text. */
export function indexEntry(memory: Memory): Entry {
  bounded("id", memory.id, MAX_ID_BYTES);
  return { line: `<index id="${escapeText(memory.id)}"/>` };
}

/** The bytes of a frame with no lines. */
export function frameBytes(kind: RenderingKind): number {
  return utf8Bytes(frame(kind, []));
}

/**
 * How many entries, from the first, fit in `room` bytes. The first that does not fit ends the
 * prefix, so the composition order is kept and no entry is ever cut.
 */
function fittingPrefix(entries: readonly Entry[], room: number): number {
  let used = 0;
  for (let count = 0; count < entries.length; count++) {
    used += utf8Bytes((entries[count] as Entry).line) + 1;
    if (used > room) return count;
  }
  return entries.length;
}

/** The core's default egress filter: every rendering leaves as it is. */
export const identityEgress: EgressFilter = (rendering) => ({ allow: true, text: rendering });

/**
 * The rendering of the longest prefix of `entries` whose text, after the host's egress filter,
 * fits in `budgetBytes`. `entries` already fit before filtering, so the filter runs once unless it
 * expands the text; then fewer entries are tried, halving the range each time (exact for a filter
 * whose output never shrinks as entries are added), so a slow filter runs O(log n) times. A deny
 * on any attempt refuses the rendering: an entry is never dropped to get past a deny. When not
 * even the empty frame fits after filtering, BudgetError. A filtered text that is empty or only
 * white space carries no memory, so its `memoryIds` is empty and a carrier records nothing.
 */
export async function fitRendering(
  kind: RenderingKind,
  entries: readonly Entry[],
  budgetBytes: number,
  egress: EgressFilter,
  principal: Principal,
): Promise<Rendering> {
  const filtered = async (count: number): Promise<string | undefined> => {
    const lines = entries.slice(0, count).map((entry) => entry.line);
    const text = await egressText(egress, frame(kind, lines), principal);
    return utf8Bytes(text) <= budgetBytes ? text : undefined;
  };
  // A filter that leaves no text leaves no memory in it: the rendering carries none.
  const rendering = (count: number, text: string): Rendering => ({
    text,
    memoryIds: text.trim() === "" ? [] : carried(entries.slice(0, count)),
  });

  const all = await filtered(entries.length);
  if (all !== undefined) return rendering(entries.length, all);
  let fits = 0;
  let best = entries.length === 0 ? undefined : await filtered(0);
  if (best === undefined) throw new BudgetError(budgetBytes);
  let overflows = entries.length;
  while (overflows - fits > 1) {
    const middle = Math.floor((fits + overflows) / 2);
    const text = await filtered(middle);
    if (text === undefined) {
      overflows = middle;
    } else {
      fits = middle;
      best = text;
    }
  }
  return rendering(fits, best);
}

/** Runs the filter once and reads its decision once; anything but `allow: true` is a deny. */
async function egressText(
  egress: EgressFilter,
  rendering: string,
  principal: Principal,
): Promise<string> {
  const decision = await egress(rendering, principal);
  if (decision.allow !== true) throw new EgressDeniedError(String(decision.reason));
  const { text } = decision;
  if (typeof text !== "string") throw new TypeError("the egress filter allowed a non-string text");
  return text;
}

function carried(entries: readonly Entry[]): MemoryId[] {
  return entries.flatMap((entry) => (entry.carries === undefined ? [] : [entry.carries]));
}

/**
 * The wake's entries within `budgetBytes`: the longest prefix of `ordered` in full, then the
 * longest prefix of the remaining memories as index entries. Each memory is rendered only when
 * its turn comes, and the first entry that does not fit ends its part, so a large scope costs
 * no more rendering than the budget holds.
 */
export function wakeEntries(ordered: readonly Memory[], budgetBytes: number): Entry[] {
  let room = budgetBytes - frameBytes("wake");
  const entries: Entry[] = [];
  let next = 0;
  for (const toEntry of [fullEntry, indexEntry]) {
    for (; next < ordered.length; next++) {
      const entry = toEntry(ordered[next] as Memory);
      const bytes = utf8Bytes(entry.line) + 1;
      if (bytes > room) break;
      room -= bytes;
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * The brief's entries within `budgetBytes`: the longest prefix of the ranked memories in full,
 * then their summaries (briefSummaries). A brief has no index.
 */
export function briefEntries(
  ranked: readonly Memory[],
  summaries: readonly Memory[],
  budgetBytes: number,
): Entry[] {
  const full = [...ranked, ...summaries].map(fullEntry);
  return full.slice(0, fittingPrefix(full, budgetBytes - frameBytes("brief")));
}

/** find's entries within `budgetBytes`: the longest prefix of the ranked memories in full. */
export function findEntries(ranked: readonly Memory[], budgetBytes: number): Entry[] {
  const full = ranked.map(fullEntry);
  return full.slice(0, fittingPrefix(full, budgetBytes - frameBytes("find")));
}
