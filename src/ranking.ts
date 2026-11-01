// Written from docs/specs/ranking-algorithm.md only.
import type { Memory, MemoryId } from "./model.js";
import type { TermCounts, TermIndexRead } from "./ports.js";

const K1 = 1.2;
const B = 0.75;
const STEM_WEIGHT = 0.5;

export interface Ranked {
  readonly memory: Memory;
  readonly score: number;
}

/** §1: NFKD, drop combining marks (Mn), lower-case. */
function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase();
}

// §3, written folded: stop words are compared after §1.
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a o e de da do das dos em no na nos nas um uma uns umas para por com sem que se " +
    "ao aos as os ou mas como mais muito ja nao sim seu sua seus suas ele ela eles elas isso esse " +
    "essa este esta foi ser sao tem ter pra pro pela pelo pelas pelos " +
    "the a an and or of to in on at for with without is are was were be been it its this " +
    "that these those by from as not no yes do does did"
  ).split(" "),
);

/** Characters are code points: a supplementary-plane letter is one character, not two units. */
function characters(token: string): number {
  return [...token].length;
}

/** §2: split on non-letter, non-digit runs; drop single characters other than a digit. */
function tokenize(text: string): string[] {
  return normalise(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => characters(token) > 1 || /^\p{Nd}$/u.test(token));
}

/** True when `query` yields at least one token, so ranking it can find something. */
export function hasTokens(query: string): boolean {
  return tokenize(query).length > 0;
}

function withoutStopWords(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !STOP_WORDS.has(token));
}

/** §4: the first matching rule, once, on tokens of 4 characters or more. */
function stem(token: string): string {
  if (characters(token) < 4) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("oes") || token.endsWith("aes")) return `${token.slice(0, -3)}ao`;
  if (token.endsWith("ais")) return `${token.slice(0, -3)}al`;
  if (token.endsWith("eis")) return `${token.slice(0, -3)}el`;
  if (token.endsWith("ns")) return `${token.slice(0, -2)}m`;
  if (token.endsWith("res") || token.endsWith("ses") || token.endsWith("zes")) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

interface Doc {
  readonly memory: Memory;
  readonly length: number;
  readonly exact: ReadonlyMap<string, number>;
  readonly stems: ReadonlyMap<string, number>;
}

function counts(tokens: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

/** §5: at most this many distinct query terms are scored: the first ones, in query order. */
export const MAX_QUERY_TERMS = 32;

/** A query term as both the ranker and the term index key it: its exact form and its stem. */
export interface QueryTerm {
  readonly exact: string;
  readonly stem: string;
}

export interface ParsedQuery {
  /** Distinct, in query order, at most MAX_QUERY_TERMS. */
  readonly terms: readonly QueryTerm[];
  /** §3 fallback: the query had only stop words, so stop words count, in documents too. */
  readonly keepStopWords: boolean;
}

/** §2–§4 applied to a query: its distinct terms, capped, and whether stop words count. */
export function parseQuery(query: string): ParsedQuery {
  const queryTokens = tokenize(query);
  const kept = withoutStopWords(queryTokens);
  const keepStopWords = kept.length === 0;
  const terms = [...new Set(keepStopWords ? queryTokens : kept)]
    .slice(0, MAX_QUERY_TERMS)
    .map((exact) => ({ exact, stem: stem(exact) }));
  return { terms, keepStopWords };
}

/**
 * Scores `candidates` against `query` and returns those scoring above 0, best first. The full
 * scan: every candidate is tokenized here. `find` reads the term index instead (scoreIndex); this
 * stays the reference the index is tested against, and serves `brief`.
 */
export function rank(query: string, candidates: readonly Memory[]): Ranked[] {
  const { terms, keepStopWords } = parseQuery(query);
  if (terms.length === 0 || candidates.length === 0) return [];

  const docs: Doc[] = candidates.map((memory) => {
    const all = tokenize(memory.revision.text);
    const tokens = keepStopWords ? all : withoutStopWords(all);
    return {
      memory,
      length: tokens.length,
      exact: counts(tokens),
      stems: counts(tokens.map(stem)),
    };
  });
  const n = docs.length;
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / n;
  const idf = (df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5));
  const queryTerms = terms.map(({ exact, stem: stemmed }) => {
    return {
      exact,
      stem: stemmed,
      exactIdf: idf(docs.filter((doc) => doc.exact.has(exact)).length),
      stemIdf: idf(docs.filter((doc) => doc.stems.has(stemmed)).length),
    };
  });

  const ranked: Ranked[] = [];
  for (const doc of docs) {
    const norm = K1 * (1 - B + (B * doc.length) / avgdl);
    const termScore = (termIdf: number, f: number) => (termIdf * f * (K1 + 1)) / (f + norm);
    let score = 0;
    for (const term of queryTerms) {
      const exactF = doc.exact.get(term.exact) ?? 0;
      if (exactF > 0) {
        score += termScore(term.exactIdf, exactF);
        continue;
      }
      const stemF = doc.stems.get(term.stem) ?? 0;
      if (stemF > 0) score += STEM_WEIGHT * termScore(term.stemIdf, stemF);
    }
    if (score > 0) ranked.push({ memory: doc.memory, score });
  }
  return ranked.sort(byScoreThenNewerThenId);
}

/** §5: higher score, then higher store seq, then memory id ascending by code unit. */
function byScoreThenNewerThenId(a: Ranked, b: Ranked): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.memory.seq !== b.memory.seq) return b.memory.seq - a.memory.seq;
  if (a.memory.id === b.memory.id) return 0;
  return a.memory.id < b.memory.id ? -1 : 1;
}

/** What the term index keeps for one memory: its lengths and its term counts. */
export interface DocumentTerms {
  /** Every token counted. */
  readonly lengthAll: number;
  /** Stop words not counted. */
  readonly lengthKept: number;
  /** Each distinct token, with its counts. */
  readonly exact: ReadonlyMap<string, TermCounts>;
  /** Each distinct stem, with the counts of the tokens that have it. */
  readonly stems: ReadonlyMap<string, TermCounts>;
}

/**
 * §2–§4 applied to a memory's text, for both §3 modes at once: what a store indexes so that find
 * gets, without retokenizing, exactly the counts and lengths rank() computes.
 */
export function documentTerms(text: string): DocumentTerms {
  const exact = new Map<string, { all: number; kept: number }>();
  const stems = new Map<string, { all: number; kept: number }>();
  const add = (map: typeof exact, key: string, stop: boolean) => {
    const counts = map.get(key) ?? { all: 0, kept: 0 };
    counts.all += 1;
    if (!stop) counts.kept += 1;
    map.set(key, counts);
  };
  const tokens = tokenize(text);
  let lengthKept = 0;
  for (const token of tokens) {
    const stop = STOP_WORDS.has(token);
    if (!stop) lengthKept += 1;
    add(exact, token, stop);
    add(stems, stem(token), stop);
  }
  return { lengthAll: tokens.length, lengthKept, exact, stems };
}

/** A memory find scored from the term index: rank()'s result before the memory is loaded. */
export interface IndexedScore {
  readonly memoryId: MemoryId;
  readonly seq: number;
  readonly score: number;
}

/**
 * §5 computed from the term index: the same N, df, avgdl, |d| and f as rank() over the same live
 * memories, with the same expressions in the same order, so every score is the same double.
 * Returns those scoring above 0, best first.
 */
export function scoreIndex(query: ParsedQuery, index: TermIndexRead): IndexedScore[] {
  const { terms, keepStopWords } = query;
  const n = index.memories;
  if (terms.length === 0 || n === 0) return [];
  const f = (counts: TermCounts | undefined) =>
    counts === undefined ? 0 : keepStopWords ? counts.all : counts.kept;
  const avgdl = (keepStopWords ? index.lengthAll : index.lengthKept) / n;
  const idf = (df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5));
  const df = (side: "exact" | "stem", i: number) =>
    index.postings.reduce((count, posting) => (f(posting[side][i]) > 0 ? count + 1 : count), 0);
  const exactIdf = terms.map((_, i) => idf(df("exact", i)));
  const stemIdf = terms.map((_, i) => idf(df("stem", i)));

  const scored: IndexedScore[] = [];
  for (const posting of index.postings) {
    const length = keepStopWords ? posting.lengthAll : posting.lengthKept;
    const norm = K1 * (1 - B + (B * length) / avgdl);
    const termScore = (termIdf: number, tf: number) => (termIdf * tf * (K1 + 1)) / (tf + norm);
    let score = 0;
    for (let i = 0; i < terms.length; i++) {
      const exactF = f(posting.exact[i]);
      if (exactF > 0) {
        score += termScore(exactIdf[i] as number, exactF);
        continue;
      }
      const stemF = f(posting.stem[i]);
      if (stemF > 0) score += STEM_WEIGHT * termScore(stemIdf[i] as number, stemF);
    }
    if (score > 0) scored.push({ memoryId: posting.memoryId, seq: posting.seq, score });
  }
  return scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.seq !== b.seq) return b.seq - a.seq;
    if (a.memoryId === b.memoryId) return 0;
    return a.memoryId < b.memoryId ? -1 : 1;
  });
}
