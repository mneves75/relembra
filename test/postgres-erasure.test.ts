import { afterEach, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createRelembra, type Principal } from "relembra";
import { openPostgresStore } from "relembra/postgres";
import {
  bunClient,
  describePostgres,
  dropSchema,
  freshSchema,
  pool,
  tableText,
} from "./postgres-support.js";

const SCOPE = "pg/erasure";
const owner: Principal = {
  id: "owner",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  owned: [SCOPE],
};
const provenance = { agent: "a", harness: "h", model: "m", host: "pg-test" };

/**
 * What a redaction leaves in Postgres's files, as the store's docs say: no table row holds the
 * text once it commits, the table and index files still hold the old row versions until VACUUM
 * reclaims them, and VACUUM FULL rewrites the files without them. The WAL and backups are out of
 * this test's reach and relembra's.
 */
describePostgres("postgres store: redacted text on disk", () => {
  let schema: string;
  let sql: SQL;
  beforeEach(() => {
    schema = freshSchema();
    sql = pool(2);
  });
  afterEach(async () => {
    await dropSchema(sql, schema);
    await sql.close();
  });

  /** Every data file of the schema's tables, their indexes and TOAST, after a checkpoint. */
  const files = async () => {
    await sql.unsafe("CHECKPOINT");
    const paths = (await sql.unsafe(
      `SELECT pg_relation_filepath(c.oid) AS path
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'i')
       UNION
       SELECT pg_relation_filepath(t.oid) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class t ON t.oid = c.reltoastrelid
       WHERE n.nspname = $1`,
      [schema],
    )) as { path: string | null }[];
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = "";
    for (const { path } of paths) {
      if (path === null) continue;
      const [row] = (await sql.unsafe("SELECT pg_read_binary_file($1) AS bytes", [path])) as {
        bytes: Uint8Array;
      }[];
      if (row !== undefined) text += decoder.decode(row.bytes);
    }
    return text;
  };

  test("a redaction removes the text from every row at once, and from the files after VACUUM FULL", async () => {
    const store = await openPostgresStore({ client: bunClient(sql), schema });
    const relembra = createRelembra<null>({ store, policy: () => owner });
    const secret = "Physical marker kestrel-quince-93 for the redaction test.";
    const victim = await relembra.note(null, { scope: SCOPE, text: secret, provenance });
    await relembra.note(null, { scope: SCOPE, text: "A memory that stays.", provenance });

    // Positive control: the scan reads the files, and finds the text there before redaction.
    expect(await files()).toContain("kestrel-quince-93");

    await relembra.redact(null, { memoryId: victim.id });
    expect(await tableText(sql, schema)).not.toContain("kestrel");
    // The old row versions are still in the files: Postgres's limit, documented, not relembra's.
    expect(await files()).toContain("kestrel-quince-93");

    const tables = (await sql.unsafe("SELECT tablename FROM pg_tables WHERE schemaname = $1", [
      schema,
    ])) as { tablename: string }[];
    for (const { tablename } of tables) await sql.unsafe(`VACUUM FULL ${schema}.${tablename}`);
    const after = await files();
    expect(after).not.toContain("kestrel");
    expect(after).not.toContain("quince-93");
    // Positive control: the memory that stays is still in the rewritten files.
    expect(after).toContain("A memory that stays.");
  });
});
