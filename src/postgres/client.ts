/**
 * Runs one SQL statement. `text` uses `$1`, `$2`, … placeholders, `params` holds their values
 * (strings, numbers, booleans or null), and the promise resolves with the rows as objects keyed by
 * column name. relembra accepts `bigint` and `numeric` columns as numbers, strings or BigInts, as
 * drivers differ.
 */
export interface SqlQuery {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly Row[]>;
}

/**
 * The SQL client a host gives the Postgres store: relembra depends on no driver. `query` may run
 * on any pooled connection. `transaction` runs `work` on one connection between BEGIN and COMMIT,
 * every query of the `tx` it gets on that connection; it rolls back and rejects with the work's
 * error when the work rejects, and rejects when the COMMIT fails.
 *
 * A server error must reach relembra with its SQLSTATE, as `code` (pg, postgres.js), `errno`
 * (Bun's SQL) or `sqlState`: relembra retries `40001` and `40P01`, and reads `55P03` as a lock
 * timeout. An error without one, during COMMIT, is a commit whose outcome is unknown.
 */
export interface SqlClient extends SqlQuery {
  transaction<T>(work: (tx: SqlQuery) => Promise<T>): Promise<T>;
}

/** The SQLSTATE a driver error carries, or undefined when the server sent none. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, errno, sqlState: state } = error as Record<string, unknown>;
  for (const candidate of [state, errno, code]) {
    if (typeof candidate === "string" && SQLSTATE.test(candidate)) return candidate;
  }
  return undefined;
}

// Five characters, in one of the classes Postgres defines (appendix A of its manual): digits
// first, or F0, HV, P0, XX. Node's own codes (EPIPE, ECONNRESET, …) do not match.
const SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;
