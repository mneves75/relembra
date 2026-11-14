import { describe } from "bun:test";
import { SQL } from "bun";
import type { Event } from "relembra";
import { openPostgresStore, type PostgresStoreOptions, type SqlClient } from "relembra/postgres";
import type { ConformanceTarget } from "relembra/testing";

/**
 * The Postgres the tests run against: RELEMBRA_POSTGRES_URL, as scripts/with-postgres.sh sets it.
 * Without it the Postgres tests fail, unless RELEMBRA_SKIP_POSTGRES=1 says on purpose that no
 * Postgres is available; then they are skipped.
 */
const { RELEMBRA_POSTGRES_URL: URL, RELEMBRA_SKIP_POSTGRES } = process.env;
const SKIP = RELEMBRA_SKIP_POSTGRES === "1";

/** `describe` when a Postgres is configured, `describe.skip` under RELEMBRA_SKIP_POSTGRES=1. */
export const describePostgres: typeof describe =
  URL === undefined && SKIP ? describe.skip : describe;

/** The configured URL; throws, failing the test, when none is set and skipping was not asked. */
export function postgresUrl(): string {
  if (URL === undefined || URL === "") {
    throw new Error(
      "RELEMBRA_POSTGRES_URL is not set: run the tests through scripts/with-postgres.sh, or set RELEMBRA_SKIP_POSTGRES=1 to skip the Postgres tests on purpose",
    );
  }
  return URL;
}

/** A pool of its own on the test database. */
export function pool(max = 4, connection: Record<string, string> = {}): SQL {
  return new SQL(postgresUrl(), { max, idleTimeout: 5, connection });
}

/**
 * The adapter a host writes for Bun's SQL: `query` runs one statement with $n parameters, and
 * `transaction` runs its work on one connection inside BEGIN … COMMIT (Bun rolls back and rethrows
 * when the work rejects).
 */
export function bunClient(sql: SQL): SqlClient {
  return {
    query: async (text, params = []) => [...(await sql.unsafe(text, [...params]))],
    transaction: (work) =>
      sql.begin((tx) =>
        work({ query: async (text, params = []) => [...(await tx.unsafe(text, [...params]))] }),
      ) as never,
  };
}

let schemas = 0;

/** A schema name no other case or test file in this run uses. */
export function freshSchema(prefix = "relembra_test"): string {
  return `${prefix}_${process.pid}_${Date.now().toString(36)}_${++schemas}`;
}

/** Drops `schema` and everything in it. */
export async function dropSchema(sql: SQL, schema: string): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/**
 * Every row of every table in `schema`, as text, read through `sql` (not the store under test):
 * what the store holds in its tables, term index included. The physical pages may hold more (dead
 * tuples until VACUUM, the WAL); see test/postgres.test.ts for that part.
 */
export async function tableText(sql: SQL, schema: string): Promise<string> {
  const tables = (await sql.unsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    [schema],
  )) as { table_name: string }[];
  const parts: string[] = [];
  for (const { table_name: table } of tables) {
    const rows = (await sql.unsafe(
      `SELECT row_to_json(t)::text AS row FROM ${schema}.${table} t`,
    )) as {
      row: string;
    }[];
    parts.push(table, ...rows.map((r) => r.row));
  }
  return parts.join("\n");
}

/** Opens each conformance case on its own schema, dropped when the case ends. */
export function postgresTarget(options: Partial<PostgresStoreOptions> = {}): ConformanceTarget {
  return {
    durable: true,
    async open() {
      const schema = freshSchema();
      const admin = pool(2);
      const pools: SQL[] = [];
      const openStore = async () => {
        const sql = pool();
        pools.push(sql);
        return openPostgresStore({ client: bunClient(sql), schema, ...options });
      };
      const store = await openStore();
      return {
        store,
        reopen: openStore,
        async inspectEvents() {
          const rows = (await admin.unsafe(
            `SELECT seq, body FROM ${schema}.events ORDER BY seq`,
          )) as { seq: string; body: string }[];
          return rows.map((row): Event => ({ ...JSON.parse(row.body), seq: Number(row.seq) }));
        },
        async rawBytes() {
          return new TextEncoder().encode(await tableText(admin, schema));
        },
        async close() {
          try {
            for (const sql of pools) await sql.close();
            await dropSchema(admin, schema);
          } finally {
            await admin.close();
          }
        },
      };
    },
  };
}
