import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Mirrors `Trust` in src/model.ts. */
export type Trust = "owner" | "agent" | "untrusted";
export const TRUST_LEVELS: readonly Trust[] = ["owner", "agent", "untrusted"];

/** Mirrors `Principal` in src/model.ts, plus `pinnable` (implementation plan §4.1). */
export interface EvalPrincipal {
  readonly id: string;
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  readonly promotable: readonly string[];
  readonly trustCeiling: Trust;
  readonly pinnable: boolean;
}

/** What the candidate must do to a memory after noting it. */
export type MemoryState = "live" | "retracted" | "redacted";

export type Lang = "pt-BR" | "en";

/** One memory of the synthetic corpus. `key` is the corpus's own name; candidates never see it. */
export interface CorpusMemory {
  readonly key: string;
  readonly set: string;
  readonly scope: string;
  readonly lang: Lang;
  readonly text: string;
  /** Epoch milliseconds from the generator's deterministic clock. */
  readonly at: number;
  readonly trust: Trust;
  readonly pinned: boolean;
  readonly state: MemoryState;
  /** The key of the memory this one supersedes. */
  readonly supersedes?: string;
  /** A token planted in the text so a partial rendering is still caught as a leak. */
  readonly canary?: string;
  /** An instruction-shaped planted memory: it must only ever be rendered labelled. */
  readonly poison?: true;
}

export const CATEGORIES = [
  "basic",
  "pt-en-fold",
  "contradiction",
  "poisoning",
  "abstention",
  "scope",
] as const;
export type Category = (typeof CATEGORIES)[number];

interface ProbeBase {
  readonly key: string;
  readonly set: string;
  readonly category: Category;
  readonly principal: EvalPrincipal;
}

/**
 * A question: one `find` and one `brief` for `query` by `principal`.
 * - `gold` lists the keys that answer it, or `"absent"`.
 * - `relevant` (absent questions only): the keys whose appearance means the candidate did not
 *   abstain, or `"any"` when no memory at all may be returned.
 * - `control` (scope questions only): a principal that can read the denied scope, and the keys
 *   its `find` for the same query must return.
 */
export interface FindProbe extends ProbeBase {
  readonly kind: "find";
  readonly query: string;
  readonly gold: readonly string[] | "absent";
  readonly relevant?: readonly string[] | "any";
  readonly control?: { readonly principal: EvalPrincipal; readonly expect: readonly string[] };
}

/** A session start: `wake` for `principal` in `scope`, which must contain every `expect` key. */
export interface WakeProbe extends ProbeBase {
  readonly kind: "wake";
  readonly scope: string;
  readonly budgetBytes: number;
  readonly expect: readonly string[];
}

export type Probe = FindProbe | WakeProbe;

export interface EvalSet {
  readonly seed: number;
  readonly corpus: readonly CorpusMemory[];
  readonly probes: readonly Probe[];
}

/**
 * Throws unless every memory's text is distinct and no text equals a canary: a response is then
 * never ambiguous about which memory a text names.
 */
export function assertDistinctTexts(corpus: readonly CorpusMemory[]): void {
  const byText = new Map<string, string>();
  for (const m of corpus) {
    const other = byText.get(m.text);
    if (other !== undefined) throw new Error(`memories ${other} and ${m.key} have the same text`);
    byText.set(m.text, m.key);
  }
  for (const m of corpus) {
    if (m.canary === undefined) continue;
    const echo = byText.get(m.canary);
    if (echo !== undefined) throw new Error(`memory ${echo}'s text is the canary of ${m.key}`);
  }
}

export const CORPUS_FILE = "corpus.jsonl";
export const PROBES_FILE = "questions.jsonl";
export const MANIFEST_FILE = "manifest.json";

function jsonl(items: readonly unknown[]): string {
  return items.map((item) => `${JSON.stringify(item)}\n`).join("");
}

/** Writes the set as three files. The same set always gives the same bytes. */
export function writeSet(dir: string, set: EvalSet): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify({ seed: set.seed }, null, 2)}\n`);
  writeFileSync(join(dir, CORPUS_FILE), jsonl(set.corpus));
  writeFileSync(join(dir, PROBES_FILE), jsonl(set.probes));
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Reads a set written by `writeSet`. The files are the generator's own output, trusted as such. */
export function readSet(dir: string): EvalSet {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as { seed: number };
  return {
    seed: manifest.seed,
    corpus: readJsonl<CorpusMemory>(join(dir, CORPUS_FILE)),
    probes: readJsonl<Probe>(join(dir, PROBES_FILE)),
  };
}
