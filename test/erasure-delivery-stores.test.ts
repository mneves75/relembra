import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Carrier, createRelembra, type Principal, type Store } from "relembra";
import { openPostgresStore } from "relembra/postgres";
import { openSqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { bunClient, describePostgres, dropSchema, freshSchema, pool } from "./postgres-support.js";
import { tempDir } from "./sqlite-support.js";
import { provenance, SCOPE } from "./support.js";

const owner: Principal = {
  id: "owner",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  owned: [SCOPE],
};
const CHAT: Carrier = { id: "host/7", kind: "pi-durable" };
const SESSION: Carrier = { id: "mcp:session-1", kind: "mcp" };

/** A store under test: a fresh one, a second handle on the same data, and cleanup. */
interface Target {
  readonly store: Store;
  reopen(): Promise<Store>;
  close(): Promise<void>;
}

/**
 * The whole path on one store: renderings record exposures, a redaction names the carriers, a
 * delivery settles what the hook answers, and a second handle reads the same statuses.
 */
async function lifecycle(target: Target) {
  const relembra = createRelembra<null>({ store: target.store, policy: () => owner });
  const seen = await relembra.note(null, { scope: SCOPE, text: "Deploys on Fridays.", provenance });
  const unseen = await relembra.note(null, { scope: SCOPE, text: "Lunch at noon.", provenance });
  await relembra.findRendering(null, { query: "deploys", carrier: CHAT });
  await relembra.brief(null, { topic: "deploys fridays", carrier: SESSION });
  // A second recording of the same pair changes nothing.
  await relembra.findRendering(null, { query: "deploys", carrier: CHAT });
  await relembra.redact(null, { memoryId: seen.id });
  await relembra.redact(null, { memoryId: unseen.id });

  const delivery = await relembra.deliverErasures(() => ({ [CHAT.id]: "acknowledged" }));
  expect(delivery).toEqual({ acknowledged: 1, unsupported: 0, pending: 1, errors: [] });

  const expected = [
    {
      seq: expect.any(Number),
      memoryId: seen.id,
      carriers: [
        { ...CHAT, status: "acknowledged" as const },
        { ...SESSION, status: "pending" as const },
      ],
    },
    { seq: expect.any(Number), memoryId: unseen.id, carriers: [] },
  ];
  expect(await relembra.erasureStatus()).toEqual(expected);
  const again = createRelembra<null>({ store: await target.reopen(), policy: () => owner });
  expect(await again.erasureStatus()).toEqual(expected);
  // The pending carrier is the only one sent on the next delivery, from either handle.
  const sent: string[][] = [];
  await again.deliverErasures((work) => {
    sent.push(work.carriers.map((c) => c.id));
    return { [SESSION.id]: "unsupported" };
  });
  expect(sent).toEqual([[SESSION.id]]);
  expect((await relembra.erasureStatus())[0]?.carriers.map((c) => c.status)).toEqual([
    "acknowledged",
    "unsupported",
  ]);
}

describe("erasure delivery end to end", () => {
  test("memory store", async () => {
    const store = createMemoryStore();
    await lifecycle({ store, reopen: async () => store, close: async () => {} });
  });

  test("sqlite store", async () => {
    const dir = tempDir();
    const path = join(dir.path, "store", "relembra.db");
    const handles = [openSqliteStore({ path })];
    try {
      await lifecycle({
        store: handles[0] as Store,
        reopen: async () => {
          const handle = openSqliteStore({ path });
          handles.push(handle);
          return handle;
        },
        close: async () => {},
      });
    } finally {
      for (const handle of handles) await handle.close();
      dir.remove();
    }
  });
});

describePostgres("erasure delivery end to end: postgres", () => {
  test("postgres store", async () => {
    const sql = pool(4);
    const schema = freshSchema();
    try {
      const open = () => openPostgresStore({ client: bunClient(sql), schema });
      await lifecycle({ store: await open(), reopen: open, close: async () => {} });
    } finally {
      await dropSchema(sql, schema);
      await sql.close();
    }
  }, 30_000);
});
