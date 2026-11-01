/**
 * The memories derived from memory `$1` in schema `s`: summaries citing it as a source and
 * copies promoted from it. Each arm has its own partial index (migration 2), so redaction does
 * not scan the table.
 */
export function derivedQuery(s: string): string {
  return `SELECT id FROM ${s}.memories
             WHERE (sources IS NOT NULL
                 AND sources::jsonb @> jsonb_build_array(jsonb_build_object('memoryId', $1::text)))
               OR (origin IS NOT NULL AND (origin::jsonb) ->> 'memoryId' = $1::text)
             ORDER BY position`;
}
