// A consumer of the packed relembra tarball. scripts/pack-smoke.ts copies it into a fresh
// directory outside the repository, next to node_modules/relembra, and runs it there.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelembra, ScopeDeniedError } from "relembra";
import { createMemoryExtension } from "relembra/pi-durable";
import { openPostgresStore } from "relembra/postgres";
import { openSqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "relembra/testing";

const SCOPE = "smoke/packed";
const principal = { id: "smoke", readable: [SCOPE], writable: [SCOPE], promotable: [] };
const policy = () => principal;
const provenance = { agent: "smoke-agent", harness: "pack-smoke", model: "none", host: "ci" };
const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;

const dir = mkdtempSync(join(tmpdir(), "relembra-smoke-"));
try {
  const path = join(dir, "home", "relembra.db");
  const store = openSqliteStore({ path });
  const relembra = createRelembra({ store, policy });
  const build = await relembra.note(
    {},
    { scope: SCOPE, text: "The packed build runs from dist.", provenance },
  );
  const other = await relembra.note(
    {},
    { scope: SCOPE, text: "Deploys wait for the release branch.", provenance },
  );

  const found = await relembra.find({}, { query: "packed dist", scope: SCOPE });
  assert.deepEqual(
    found.map((result) => result.memory.id),
    [build.id],
  );
  const recalled = await relembra.recall({}, { scope: SCOPE });
  assert.deepEqual(
    recalled.map((memory) => memory.id),
    [other.id, build.id],
  );
  await assert.rejects(relembra.recall({}, { scope: "smoke/elsewhere" }), ScopeDeniedError);
  await store.close();

  // The SQLite file keeps what was written.
  const reopened = openSqliteStore({ path });
  const again = await createRelembra({ store: reopened, policy }).recall({}, { scope: SCOPE });
  assert.deepEqual(
    again.map((memory) => memory.revision.text),
    ["Deploys wait for the release branch.", "The packed build runs from dist."],
  );
  await reopened.close();

  // relembra/testing: the in-memory store behind the same API.
  const memory = createRelembra({ store: createMemoryStore(), policy });
  const noted = await memory.note({}, { scope: SCOPE, text: "In memory.", provenance });
  assert.deepEqual(
    (await memory.recall({}, { scope: SCOPE })).map((m) => m.id),
    [noted.id],
  );

  // relembra/postgres: loads without a driver and drives the host's client. This fake client
  // answers every statement with no rows, enough to open a new schema and read one fence.
  const statements = [];
  const fake = {
    query: async (text) => {
      statements.push(text);
      return [];
    },
  };
  const client = { ...fake, transaction: (work) => work(fake) };
  const postgres = await openPostgresStore({ client, schema: "smoke" });
  statements.length = 0;
  assert.equal(await postgres.transaction((tx) => tx.fenceEpoch("smoke")), undefined);
  assert.equal(statements[0], "SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  assert.match(statements[2], /^SELECT id FROM "smoke"\.store_lock WHERE id = 1 FOR UPDATE$/);

  // relembra/pi-durable loads without its optional peer installed: it imports pi-durable's types only.
  assert.throws(() => import.meta.resolve("@earendil-works/pi-durable"));
  const extension = createMemoryExtension({
    relembra: memory,
    hostNamespace: "smoke/journal",
    resolve: () => ({ context: {}, scope: SCOPE, provenance }),
  });
  assert.deepEqual(
    extension.tools.map((tool) => tool.name),
    ["memory_note", "memory_find", "memory_brief"],
  );

  console.log(
    `pack smoke passed on ${runtime}: note, find, recall, the pi-durable extension and the postgres store from the installed tarball`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
