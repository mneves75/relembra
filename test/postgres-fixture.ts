/**
 * The golden Postgres fixture (IMPLEMENTATION-PLAN §4.5): a store at schema version 1 with every
 * kind of row, and its expected logical contents. `bun test/postgres-fixture.ts <container>`
 * writes both files from a store built through the library, dumped with the container's own
 * pg_dump; run it only when a release ships a new schema version, and keep older files.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRelembra, type Principal, type Store } from "relembra";
import { openPostgresStore } from "relembra/postgres";
import { bunClient, dropSchema, pool } from "./postgres-support.js";

/** The schema name inside the fixture; a test replaces it with a fresh one. */
export const FIXTURE_SCHEMA = "relembra_fixture";
export const FIXTURE_SQL = new URL("fixtures/postgres/schema-v1.sql", import.meta.url);
export const FIXTURE_JSON = new URL("fixtures/postgres/schema-v1.json", import.meta.url);

const SCOPES = ["fixture/a", "fixture/b"];
const principal: Principal = {
  id: "fixture-owner",
  readable: SCOPES,
  writable: SCOPES,
  promotable: [],
  owned: SCOPES,
  pinnable: SCOPES,
  trustCeiling: "owner",
};
const provenance = { agent: "fixture-agent", harness: "fixture", model: "none", host: "fixture" };
const IDS = ["m-pinned", "m-old", "m-new", "m-sourced", "m-summary", "m-other", "m-gone"];
const OPS = ["op-pinned", "op-old", "op-new", "op-sourced", "op-summary", "op-other", "op-gone"];

/** Notes, supersedes, summarizes, retracts, redacts, fences and checkpoints, in two scopes. */
export async function populateFixture(store: Store): Promise<void> {
  let seconds = 0;
  let next = 0;
  const relembra = createRelembra<null>({
    store,
    policy: () => ({ ...principal, fence: { key: "fixture-lease", epoch: 3 } }),
    clock: { now: () => ++seconds * 1000 },
    ids: { memoryId: () => IDS[next++] as string, opId: () => "unused" },
  });
  const note = (scope: string, text: string, opId: string, pinned = false) =>
    relembra.note(null, {
      scope,
      text,
      opId,
      pinned,
      provenance: { ...provenance, trust: "owner" },
    });
  const [a, b] = SCOPES as [string, string];
  await note(a, "Releases are cut on Thursdays.", "op-pinned", true);
  const old = await note(a, "Deploys run from the main branch.", "op-old");
  await relembra.supersede(null, {
    memoryId: old.id,
    text: "Deploys run from the release branch.",
    opId: "op-new",
    provenance,
  });
  const sourced = await note(a, "The agent reviews each release.", "op-sourced");
  await relembra.submitSummary(null, {
    scope: a,
    text: "Summary: releases are reviewed.",
    sources: [{ memoryId: sourced.id, revision: 1 }],
    opId: "op-summary",
    provenance,
  });
  await relembra.retract(null, { memoryId: sourced.id });
  await note(b, "Migrações do banco rodam à noite.", "op-other");
  const gone = await note(a, "Temporary secret fixture text, redacted.", "op-gone");
  await relembra.redact(null, { memoryId: gone.id });
  await store.transaction((tx) =>
    tx.putCheckpoint({ source: "optmem:fixture", bytes: 96, width: 32 }),
  );
}

/** What the fixture holds, read through the store: the expected logical contents. */
export async function fixtureContents(store: Store) {
  const relembra = createRelembra<null>({ store, policy: () => principal });
  const read = await store.transaction(async (tx) => ({
    memories: await Promise.all(IDS.map((id) => tx.memory(id))),
    ops: await Promise.all(OPS.map((opId) => tx.op(principal.id, opId))),
    fence: await tx.fenceEpoch("fixture-lease"),
    checkpoint: await tx.checkpoint("optmem:fixture"),
  }));
  return {
    ...read,
    events: await store.events({ scopes: SCOPES }),
    erasures: await store.erasures(),
    recall: await store.recall({ scopes: SCOPES, limit: 100, retracted: SCOPES }),
    find: (await relembra.find(null, { query: "release branch noite" })).map((r) => ({
      id: r.memory.id,
      score: r.score,
    })),
  };
}

if (import.meta.main) {
  const container = process.argv[2];
  if (container === undefined) throw new Error("usage: bun test/postgres-fixture.ts <container>");
  const sql = pool(2);
  try {
    await dropSchema(sql, FIXTURE_SCHEMA);
    const store = await openPostgresStore({ client: bunClient(sql), schema: FIXTURE_SCHEMA });
    await populateFixture(store);
    const dump = execFileSync(
      "docker",
      ["exec", container, "pg_dump", "--username=postgres", `--schema=${FIXTURE_SCHEMA}`].concat([
        "--no-owner",
        "--no-privileges",
        "--inserts",
        "postgres",
      ]),
      { encoding: "utf8" },
    );
    // psql meta-commands (\restrict) are not SQL; a test runs the file through a driver.
    const sqlText = dump
      .split("\n")
      .filter((line) => !line.startsWith("\\"))
      .join("\n");
    writeFileSync(FIXTURE_SQL, sqlText);
    writeFileSync(FIXTURE_JSON, `${JSON.stringify(await fixtureContents(store), null, 2)}\n`);
    await dropSchema(sql, FIXTURE_SCHEMA);
  } finally {
    await sql.close();
  }
}
