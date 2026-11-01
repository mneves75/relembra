import type { TermCounts, TermIndexRead, TermPosting } from "../ports.js";
import { documentTerms, type QueryTerm } from "../ranking.js";
import type { SqlQuery } from "./client.js";

/**
 * Ticket 19's term index in Postgres, the same tables as SQLite's (term_scopes, term_docs,
 * term_postings; see src/sqlite/term-index.ts) and the same exact integers, so find ranks
 * byte-identically on both. Only live memories are indexed, and every row is written through the
 * transaction that changes the memory.
 */
const EXACT = 0;
const STEM = 1;

/** Indexes the live memory stored at `position`. It must not be indexed already. */
export async function indexMemory(
  q: SqlQuery,
  s: string,
  position: number,
  memory: {
    readonly id: string;
    readonly scope: string;
    readonly seq: number;
    readonly text: string;
  },
): Promise<void> {
  const terms = documentTerms(memory.text);
  const postings = [
    ...[...terms.exact].map(([term, c]) => [EXACT, term, c.all, c.kept]),
    ...[...terms.stems].map(([term, c]) => [STEM, term, c.all, c.kept]),
  ];
  await q.query(
    `WITH doc AS (
       INSERT INTO ${s}.term_docs (position, memory_id, scope, seq, length_all, length_kept)
       VALUES ($1::bigint, $2::text, $3::text, $4::bigint, $5::integer, $6::integer)
     ), totals AS (
       INSERT INTO ${s}.term_scopes AS t (scope, memories, length_all, length_kept)
       VALUES ($3::text, 1, $5::integer, $6::integer)
       ON CONFLICT (scope) DO UPDATE SET
         memories = t.memories + 1,
         length_all = t.length_all + excluded.length_all,
         length_kept = t.length_kept + excluded.length_kept
     )
     INSERT INTO ${s}.term_postings (scope, form, term, position, count_all, count_kept)
     SELECT $3::text, (p->>0)::smallint, p->>1, $1::bigint, (p->>2)::integer, (p->>3)::integer
     FROM jsonb_array_elements($7::text::jsonb) AS p`,
    [
      position,
      memory.id,
      memory.scope,
      memory.seq,
      terms.lengthAll,
      terms.lengthKept,
      JSON.stringify(postings),
    ],
  );
}

/** Takes memory `id`'s current row, if any, out of the index; nothing when it holds nothing. */
export async function unindexMemory(q: SqlQuery, s: string, id: string): Promise<void> {
  const removed = await q.query(
    `WITH doc AS (
       DELETE FROM ${s}.term_docs AS d USING ${s}.memories AS m
       WHERE m.id = $1::text AND d.position = m.position
       RETURNING d.position, d.scope, d.length_all, d.length_kept
     ), gone AS (
       DELETE FROM ${s}.term_postings WHERE position IN (SELECT position FROM doc)
     )
     UPDATE ${s}.term_scopes AS t
     SET memories = t.memories - 1,
         length_all = t.length_all - doc.length_all,
         length_kept = t.length_kept - doc.length_kept
     FROM doc WHERE t.scope = doc.scope
     RETURNING t.scope`,
    [id],
  );
  if (removed.length > 0) {
    await q.query(`DELETE FROM ${s}.term_scopes WHERE memories = 0`);
  }
}

/** The statistics over `scopes` (each once) and the postings of `terms` in them. */
export async function readIndex(
  q: SqlQuery,
  s: string,
  scopes: readonly string[],
  terms: readonly QueryTerm[],
): Promise<TermIndexRead> {
  const [statistics] = await q.query<Record<"memories" | "length_all" | "length_kept", unknown>>(
    `SELECT coalesce(sum(memories), 0) AS memories,
            coalesce(sum(length_all), 0) AS length_all,
            coalesce(sum(length_kept), 0) AS length_kept
     FROM ${s}.term_scopes WHERE scope IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
    [JSON.stringify(scopes)],
  );
  const rows = await q.query<PostingRow>(
    `SELECT p.form, p.term, p.position, p.count_all, p.count_kept,
            d.memory_id, d.seq, d.length_all, d.length_kept
     FROM ${s}.term_postings AS p JOIN ${s}.term_docs AS d ON d.position = p.position
     WHERE p.scope IN (SELECT jsonb_array_elements_text($1::text::jsonb))
       AND ((p.form = ${EXACT} AND p.term IN (SELECT jsonb_array_elements_text($2::text::jsonb)))
         OR (p.form = ${STEM} AND p.term IN (SELECT jsonb_array_elements_text($3::text::jsonb))))`,
    [
      JSON.stringify(scopes),
      JSON.stringify(terms.map((t) => t.exact)),
      JSON.stringify(terms.map((t) => t.stem)),
    ],
  );
  const postings = new Map<string, Posting>();
  for (const row of rows) {
    const key = String(row.position);
    let posting = postings.get(key);
    if (posting === undefined) {
      posting = {
        memoryId: row.memory_id,
        seq: Number(row.seq),
        lengthAll: Number(row.length_all),
        lengthKept: Number(row.length_kept),
        exact: terms.map(() => NONE),
        stem: terms.map(() => NONE),
      };
      postings.set(key, posting);
    }
    const counts: TermCounts = { all: Number(row.count_all), kept: Number(row.count_kept) };
    const form = Number(row.form);
    // Two query terms can share a stem, and one term's exact form can be another's stem.
    terms.forEach((term, i) => {
      if (form === EXACT && term.exact === row.term) posting.exact[i] = counts;
      if (form === STEM && term.stem === row.term) posting.stem[i] = counts;
    });
  }
  return {
    memories: Number(statistics?.memories ?? 0),
    lengthAll: Number(statistics?.length_all ?? 0),
    lengthKept: Number(statistics?.length_kept ?? 0),
    postings: [...postings.values()],
  };
}

const NONE: TermCounts = Object.freeze({ all: 0, kept: 0 });

type Posting = TermPosting & { exact: TermCounts[]; stem: TermCounts[] };

interface PostingRow {
  readonly form: unknown;
  readonly term: string;
  readonly position: unknown;
  readonly count_all: unknown;
  readonly count_kept: unknown;
  readonly memory_id: string;
  readonly seq: unknown;
  readonly length_all: unknown;
  readonly length_kept: unknown;
}
