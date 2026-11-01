import type { DatabaseSync } from "node:sqlite";
import type { TermCounts, TermIndexRead, TermPosting } from "../ports.js";
import { documentTerms, type QueryTerm } from "../ranking.js";

/**
 * Ticket 19's term index, in the same file as the memories (schema version 4). Only live
 * memories are indexed, and every row is written in the transaction that changes the memory.
 * - `term_scopes`: per scope, N (`memories`) and the sums of the lengths, the integers find
 *   divides once for avgdl.
 * - `term_docs`: per indexed memory, keyed by its `memories.position`, its id, scope, seq and
 *   lengths.
 * - `term_postings`: per indexed memory and distinct term, in its exact form (`form` 0) and as a
 *   stem (`form` 1), the counts with and without stop words. df is the number of a term's rows.
 */
export const TERM_INDEX_SQL = `
  CREATE TABLE term_scopes (
    scope TEXT PRIMARY KEY,
    memories INTEGER NOT NULL,
    length_all INTEGER NOT NULL,
    length_kept INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE term_docs (
    position INTEGER PRIMARY KEY,
    memory_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    seq INTEGER NOT NULL,
    length_all INTEGER NOT NULL,
    length_kept INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE term_postings (
    scope TEXT NOT NULL,
    form INTEGER NOT NULL,
    term TEXT NOT NULL,
    position INTEGER NOT NULL,
    count_all INTEGER NOT NULL,
    count_kept INTEGER NOT NULL,
    PRIMARY KEY (scope, form, term, position)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX term_postings_by_position ON term_postings (position);
`;

const EXACT = 0;
const STEM = 1;

/** The fields of a live memory the index needs. */
export interface IndexedMemory {
  readonly id: string;
  readonly scope: string;
  readonly seq: number;
  readonly text: string;
}

export interface TermIndex {
  /** Indexes the live memory stored at `position`. It must not be indexed already. */
  add(position: number, memory: IndexedMemory): void;
  /** Removes whatever the index holds for `position`; nothing when it holds nothing. */
  remove(position: number): void;
  /** The statistics over `scopes` (each once) and the postings of `terms` in them. */
  read(scopes: readonly string[], terms: readonly QueryTerm[]): TermIndexRead;
}

/** The index's statements on `db`, whose schema must be version 4 or later. */
export function termIndex(db: DatabaseSync): TermIndex {
  const insertDoc = db.prepare(
    "INSERT INTO term_docs (position, memory_id, scope, seq, length_all, length_kept) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const addToScope = db.prepare(`
    INSERT INTO term_scopes (scope, memories, length_all, length_kept) VALUES (?, 1, ?, ?)
    ON CONFLICT (scope) DO UPDATE SET
      memories = memories + 1,
      length_all = length_all + excluded.length_all,
      length_kept = length_kept + excluded.length_kept
  `);
  const insertPosting = db.prepare(
    "INSERT INTO term_postings (scope, form, term, position, count_all, count_kept) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectDoc = db.prepare(
    "SELECT scope, length_all, length_kept FROM term_docs WHERE position = ?",
  );
  const deletePostings = db.prepare("DELETE FROM term_postings WHERE position = ?");
  const deleteDoc = db.prepare("DELETE FROM term_docs WHERE position = ?");
  const removeFromScope = db.prepare(`
    UPDATE term_scopes
    SET memories = memories - 1, length_all = length_all - ?, length_kept = length_kept - ?
    WHERE scope = ?
  `);
  const deleteEmptyScope = db.prepare("DELETE FROM term_scopes WHERE scope = ? AND memories = 0");
  const selectStatistics = db.prepare(`
    SELECT coalesce(sum(memories), 0) AS memories,
           coalesce(sum(length_all), 0) AS length_all,
           coalesce(sum(length_kept), 0) AS length_kept
    FROM term_scopes WHERE scope IN (SELECT value FROM json_each(?))
  `);
  const selectPostings = db.prepare(`
    SELECT p.position, p.count_all, p.count_kept, d.memory_id, d.seq, d.length_all, d.length_kept
    FROM term_postings AS p JOIN term_docs AS d ON d.position = p.position
    WHERE p.scope = ? AND p.form = ? AND p.term = ?
  `);

  return {
    add(position, { id, scope, seq, text }) {
      const terms = documentTerms(text);
      insertDoc.run(position, id, scope, seq, terms.lengthAll, terms.lengthKept);
      addToScope.run(scope, terms.lengthAll, terms.lengthKept);
      for (const [term, counts] of terms.exact) {
        insertPosting.run(scope, EXACT, term, position, counts.all, counts.kept);
      }
      for (const [term, counts] of terms.stems) {
        insertPosting.run(scope, STEM, term, position, counts.all, counts.kept);
      }
    },

    remove(position) {
      const doc = selectDoc.get(position) as DocRow | undefined;
      if (doc === undefined) return;
      // secure_delete (set when the file is opened) zeroes the freed term bytes.
      deletePostings.run(position);
      deleteDoc.run(position);
      removeFromScope.run(doc.length_all, doc.length_kept, doc.scope);
      deleteEmptyScope.run(doc.scope);
    },

    read(scopes, terms) {
      const statistics = selectStatistics.get(JSON.stringify(scopes)) as unknown as StatisticsRow;
      const postings = new Map<number, Posting>();
      for (const scope of scopes) {
        terms.forEach((term, i) => {
          for (const form of [EXACT, STEM]) {
            const key = form === EXACT ? term.exact : term.stem;
            for (const row of selectPostings.all(scope, form, key) as unknown as PostingRow[]) {
              let posting = postings.get(row.position);
              if (posting === undefined) {
                posting = {
                  memoryId: row.memory_id,
                  seq: row.seq,
                  lengthAll: row.length_all,
                  lengthKept: row.length_kept,
                  exact: terms.map(() => NONE),
                  stem: terms.map(() => NONE),
                };
                postings.set(row.position, posting);
              }
              (form === EXACT ? posting.exact : posting.stem)[i] = {
                all: row.count_all,
                kept: row.count_kept,
              };
            }
          }
        });
      }
      return {
        memories: statistics.memories,
        lengthAll: statistics.length_all,
        lengthKept: statistics.length_kept,
        postings: [...postings.values()],
      };
    },
  };
}

/** Indexes every live memory of a store that has none indexed: migration 4's backfill. */
export function backfillTermIndex(db: DatabaseSync): void {
  const index = termIndex(db);
  const live = db
    .prepare("SELECT position, id, scope, seq, text FROM memories WHERE status = 'live'")
    .all() as unknown as (IndexedMemory & { position: number })[];
  for (const memory of live) index.add(memory.position, memory);
}

const NONE: TermCounts = Object.freeze({ all: 0, kept: 0 });

type Posting = TermPosting & { exact: TermCounts[]; stem: TermCounts[] };

interface DocRow {
  readonly scope: string;
  readonly length_all: number;
  readonly length_kept: number;
}

interface StatisticsRow {
  readonly memories: number;
  readonly length_all: number;
  readonly length_kept: number;
}

interface PostingRow {
  readonly position: number;
  readonly count_all: number;
  readonly count_kept: number;
  readonly memory_id: string;
  readonly seq: number;
  readonly length_all: number;
  readonly length_kept: number;
}
