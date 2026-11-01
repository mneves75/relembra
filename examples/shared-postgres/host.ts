// What both example hosts share: the database link and the commands. Who a host is lives in its
// own program (host-a.ts, host-b.ts): each brings its own Policy, and so its own principal.
//
// One command per run, one JSON document on stdout:
//   DATABASE_URL=postgres://… bun examples/shared-postgres/host-a.ts note shared "some fact"
//   … find <query> [scope] | recall [scope] | zoom <memory id> | redact <memory id>
// DATABASE_SCHEMA names the Postgres schema (default relembra); both hosts must use the same one.
import { SQL } from "bun";
import { createRelembra, type Memory, type Policy, type StoredMemory } from "relembra";
import { openPostgresStore, type SqlClient } from "relembra/postgres";

/** The scope both example policies grant. */
export const SHARED = "shared";

/** The host's own authenticated context; here, just which machine is asking. */
export interface HostContext {
  readonly host: string;
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Runs the command in process.argv as `context.host`, under `policy`, then exits. */
export async function runHost(context: HostContext, policy: Policy<HostContext>): Promise<void> {
  const { DATABASE_URL: url, DATABASE_SCHEMA: schema } = process.env;
  if (url === undefined || url === "") {
    print({ ok: false, error: "UsageError", message: "set DATABASE_URL" }, 2);
    return;
  }
  // A pool of this process's own: nothing but the database links two hosts. It is made inside
  // `try`, so a malformed URL still gets the one JSON document.
  let sql: SQL | undefined;
  try {
    sql = new SQL(url, { max: 2 });
    const store = await openPostgresStore({
      client: bunClient(sql),
      schema: schema || "relembra",
    });
    const memory = createRelembra({ store, policy });
    const data = await run(memory, context, process.argv.slice(2));
    print({ ok: true, data }, 0);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    print({ ok: false, error: name, message }, error instanceof UsageError ? 2 : 1);
  } finally {
    await sql?.close();
  }
}

type Memories = ReturnType<typeof createRelembra<HostContext>>;

async function run(memory: Memories, context: HostContext, argv: readonly string[]) {
  const [command, first, second] = argv;
  const need = (value: string | undefined, what: string) => {
    if (value === undefined || value === "") throw new UsageError(`${command} needs ${what}`);
    return value;
  };
  const scope = (value: string | undefined) => (value === undefined ? {} : { scope: value });
  switch (command) {
    case "note": {
      const noted = await memory.note(context, {
        scope: need(first, "a scope"),
        text: need(second, "a text"),
        provenance: { agent: "example", harness: "bun", model: "none", host: context.host },
      });
      return { id: noted.id, scope: noted.scope };
    }
    case "find": {
      const found = await memory.find(context, { query: need(first, "a query"), ...scope(second) });
      return found.map((result) => view(result.memory));
    }
    case "recall":
      return (await memory.recall(context, scope(first))).map(view);
    case "zoom":
      return view(await memory.zoom(context, { memoryId: need(first, "a memory id") }));
    case "redact":
      return memory.redact(context, { memoryId: need(first, "a memory id") });
    default:
      throw new UsageError("commands: note, find, recall, zoom, redact");
  }
}

/** A memory as the host prints it; a tombstone has no text left to print. */
function view(memory: Memory | StoredMemory) {
  if (memory.status === "redacted") {
    return { id: memory.id, scope: memory.scope, status: memory.status };
  }
  const { id, scope, revision } = memory;
  return { id, scope, text: revision.text, host: revision.provenance.host };
}

/** The SqlClient over Bun's built-in SQL (README, Postgres). */
function bunClient(sql: SQL): SqlClient {
  return {
    query: async (text, params = []) => [...(await sql.unsafe(text, [...params]))],
    transaction: (work) =>
      sql.begin((tx) =>
        work({ query: async (text, params = []) => [...(await tx.unsafe(text, [...params]))] }),
      ) as never,
  };
}

function print(document: unknown, exitCode: number): void {
  console.log(JSON.stringify(document));
  process.exitCode = exitCode;
}
