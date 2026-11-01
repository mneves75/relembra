import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SQL } from "bun";
import { openPostgresStore, SchemaTooNewError, type SqlClient } from "relembra/postgres";
import { MIGRATIONS, migrate, schemaVersion } from "../src/postgres/migrations.js";
import { derivedQuery } from "../src/postgres/queries.js";
import {
  FIXTURE_JSON,
  FIXTURE_SCHEMA,
  FIXTURE_SQL,
  fixtureContents,
  populateFixture,
} from "./postgres-fixture.js";
import {
  bunClient,
  describePostgres,
  dropSchema,
  freshSchema,
  pool,
  tableText,
} from "./postgres-support.js";

describePostgres("postgres migrations (IMPLEMENTATION-PLAN §4.5)", () => {
  let schema: string;
  let pools: SQL[];
  let admin: SQL;
  const client = (
    wrap: (inner: SqlClient) => SqlClient = (inner) => inner,
    connection: Record<string, string> = {},
  ) => {
    const sql = pool(4, connection);
    pools.push(sql);
    return wrap(bunClient(sql));
  };
  const LATEST = MIGRATIONS.length;
  const ALL = MIGRATIONS.map((m) => m.version);
  const versions = async () =>
    (
      (await admin.unsafe(`SELECT version FROM ${schema}.schema_version ORDER BY version`)) as {
        version: number;
      }[]
    ).map((row) => row.version);
  const tables = async () =>
    (
      (await admin.unsafe(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
        [schema],
      )) as { table_name: string }[]
    ).map((row) => row.table_name);
  /** The columns of every table in `name`, as information_schema describes them. */
  const columns = async (name: string) =>
    (await admin.unsafe(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, column_name`,
      [name],
    )) as Record<string, unknown>[];
  /** Restores the golden fixture into `target`. */
  const restoreFixture = async (target: string) => {
    const text = readFileSync(FIXTURE_SQL, "utf8").replaceAll(FIXTURE_SCHEMA, target);
    // One connection of its own: the dump sets search_path for its session.
    const restore = pool(1);
    try {
      await restore.unsafe(text);
    } finally {
      await restore.close();
    }
  };

  beforeEach(() => {
    schema = freshSchema();
    pools = [];
    admin = pool(2);
  });
  afterEach(async () => {
    for (const sql of pools) await sql.close();
    await dropSchema(admin, schema);
    await admin.close();
  });

  test("opening creates the schema at the latest version once; opening again changes nothing", async () => {
    await openPostgresStore({ client: client(), schema });
    await openPostgresStore({ client: client(), schema });
    expect(await versions()).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await tables()).toContain("store_lock");
    const [lock] = (await admin.unsafe(`SELECT id FROM ${schema}.store_lock`)) as { id: number }[];
    expect(lock?.id).toBe(1);
  });

  test("hosts opening a new schema at once apply each migration once", async () => {
    const opened = await Promise.allSettled(
      Array.from({ length: 6 }, () => openPostgresStore({ client: client(), schema })),
    );
    expect(opened.map((o) => o.status)).toEqual(Array(6).fill("fulfilled"));
    expect(await versions()).toEqual(ALL);
  });

  for (const level of ["read committed", "repeatable read", "serializable"]) {
    test(`a host that waited for the migration lock sees the migration it waited for (client default ${level})`, async () => {
      // The first opener holds the lock until the second has asked for it, so the second's
      // statement starts, and under a snapshot isolation would take its snapshot, before the
      // first commits.
      let locked!: () => void;
      const firstLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let asked!: () => void;
      const secondAsked = new Promise<void>((resolve) => {
        asked = resolve;
      });
      const holding = (inner: SqlClient): SqlClient => ({
        query: (text, params) => inner.query(text, params),
        transaction: (work) =>
          inner.transaction((q) =>
            work({
              async query<Row>(text: string, params?: readonly unknown[]) {
                const rows = await q.query<Row>(text, params);
                if (text.includes("pg_advisory_xact_lock")) {
                  locked();
                  await secondAsked;
                  await new Promise((r) => setTimeout(r, 300));
                }
                return rows;
              },
            }),
          ),
      });
      const waiting = (inner: SqlClient): SqlClient => ({
        query: (text, params) => inner.query(text, params),
        transaction: (work) =>
          inner.transaction((q) =>
            work({
              query<Row>(text: string, params?: readonly unknown[]) {
                const rows = q.query<Row>(text, params);
                if (text.includes("pg_advisory_xact_lock")) asked();
                return rows;
              },
            }),
          ),
      });
      const settings = { default_transaction_isolation: level };
      const first = openPostgresStore({ client: client(holding, settings), schema });
      await firstLocked;
      const second = openPostgresStore({ client: client(waiting, settings), schema });
      const opened = await Promise.allSettled([first, second]);
      expect(opened.map((o) => (o.status === "rejected" ? String(o.reason) : o.status))).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      expect(await versions()).toEqual(ALL);
    });
  }

  test("negative control: without the migration lock, hosts opening a new schema at once collide", async () => {
    // Each opener stops after its first statement in the transaction until the other has
    // started too, as concurrent hosts would; without the advisory lock both then migrate.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unlocked = (inner: SqlClient): SqlClient => ({
      query: (text, params) => inner.query(text, params),
      transaction: (work) =>
        inner.transaction((q) =>
          work({
            async query(text, params) {
              if (text.includes("pg_advisory_xact_lock")) {
                arrived += 1;
                if (arrived === 2) release();
                await Promise.race([both, new Promise((r) => setTimeout(r, 2_000))]);
                return q.query("SELECT 1");
              }
              return q.query(text, params);
            },
          }),
        ),
    });
    const opened = await Promise.allSettled([
      openPostgresStore({ client: client(unlocked), schema }),
      openPostgresStore({ client: client(unlocked), schema }),
    ]);
    expect(opened.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  test("a failing migration leaves the schema at the version it had", async () => {
    const sql = client();
    await migrate(sql, schema, 5000, MIGRATIONS);
    const broken = {
      version: LATEST + 1,
      statements: (s: string) => [`CREATE TABLE ${s}.added (x integer)`, "CREATE TABLE broken ("],
    };
    await expect(migrate(sql, schema, 5000, [...MIGRATIONS, broken])).rejects.toThrow();
    expect(await versions()).toEqual(ALL);
    expect(await tables()).not.toContain("added");

    // Positive control: the same step without the broken statement applies.
    const fixed = {
      version: LATEST + 1,
      statements: (s: string) => [`CREATE TABLE ${s}.added (x integer)`],
    };
    await migrate(sql, schema, 5000, [...MIGRATIONS, fixed]);
    expect(await versions()).toEqual([...ALL, LATEST + 1]);
    expect(await tables()).toContain("added");
  });

  test("a migration interrupted before its version row leaves nothing, not even the schema", async () => {
    const dropping = (inner: SqlClient): SqlClient => ({
      query: (text, params) => inner.query(text, params),
      transaction: (work) =>
        inner.transaction((q) =>
          work({
            query(text, params) {
              if (text.includes("INSERT INTO") && text.includes("schema_version")) {
                throw Object.assign(new Error("Connection closed"), { code: "ERR_CLOSED" });
              }
              return q.query(text, params);
            },
          }),
        ),
    });
    await expect(openPostgresStore({ client: client(dropping), schema })).rejects.toThrow(
      "Connection closed",
    );
    const [found] = (await admin.unsafe("SELECT to_regnamespace($1)::text AS found", [schema])) as {
      found: string | null;
    }[];
    expect(found?.found).toBeNull();
    // Positive control: the same open with the connection intact succeeds.
    await openPostgresStore({ client: client(), schema });
    expect(await versions()).toEqual(ALL);
  });

  test("a schema newer than this relembra is refused, untouched", async () => {
    await openPostgresStore({ client: client(), schema });
    await admin.unsafe(
      `INSERT INTO ${schema}.schema_version (version, applied_at) VALUES (${LATEST + 1}, 0)`,
    );
    const before = await tableText(admin, schema);
    const statements: string[] = [];
    const recording = (inner: SqlClient): SqlClient => ({
      query: (text, params) => {
        statements.push(text);
        return inner.query(text, params);
      },
      transaction: (work) => {
        statements.push("BEGIN");
        return inner.transaction(work);
      },
    });

    const refused = openPostgresStore({ client: client(recording), schema });
    await expect(refused).rejects.toBeInstanceOf(SchemaTooNewError);
    await expect(refused).rejects.toMatchObject({ found: LATEST + 1, supported: LATEST });
    expect(await tableText(admin, schema)).toBe(before);
    expect(statements.every((s) => s.trimStart().startsWith("SELECT"))).toBe(true);
    // Positive control: at the version this relembra supports, it opens.
    await admin.unsafe(`DELETE FROM ${schema}.schema_version WHERE version = ${LATEST + 1}`);
    await openPostgresStore({ client: client(), schema });
  });

  test("the golden schema-v1 fixture opens with its contents intact", async () => {
    await restoreFixture(schema);
    expect(await schemaVersion(client(), schema)).toBe(1);
    const store = await openPostgresStore({ client: client(), schema });
    const expected = JSON.parse(readFileSync(FIXTURE_JSON, "utf8"));
    expect(JSON.parse(JSON.stringify(await fixtureContents(store)))).toEqual(expected);
    // Positive control: a write to the restored store lands after its sequences.
    await store.transaction((tx) => tx.putFence({ key: "fixture-lease", epoch: 4 }));
    expect(await store.transaction((tx) => tx.fenceEpoch("fixture-lease"))).toBe(4);
  });

  test("migration 1 still builds exactly the fixture's schema", async () => {
    const restored = freshSchema("relembra_golden");
    try {
      await restoreFixture(restored);
      await migrate(client(), schema, 5000, MIGRATIONS.slice(0, 1));
      const named = (rows: Record<string, unknown>[], name: string) =>
        rows.map(({ column_default: value, ...row }) => ({
          ...row,
          column_default: String(value ?? "").replaceAll(name, "<schema>"),
        }));
      expect(named(await columns(schema), schema)).toEqual(
        named(await columns(restored), restored),
      );
      expect((await columns(schema)).length).toBeGreaterThan(40);
    } finally {
      await dropSchema(admin, restored);
    }
  });

  test("derived finds summaries and copies through indexes, never a table scan", async () => {
    await openPostgresStore({ client: client(), schema });
    const plan = await admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      return (await tx.unsafe(`EXPLAIN (FORMAT JSON) ${derivedQuery(schema)}`, ["m-1"])) as {
        "QUERY PLAN": unknown;
      }[];
    });
    const text = JSON.stringify(plan);
    // With table scans priced out, a Seq Scan means one arm of the OR has no usable index.
    expect(text).not.toContain("Seq Scan");
    expect(text).toContain("memories_by_origin");
    expect(text).toContain("memories_by_sources");
  });

  test("migration 2 adds only memories.origin and its indexes on the origin's and sources' memory ids", async () => {
    const sql = client();
    await migrate(sql, schema, 5000, MIGRATIONS.slice(0, 1));
    const before = await columns(schema);
    await migrate(sql, schema, 5000, MIGRATIONS.slice(0, 2));
    const after = await columns(schema);
    expect(after.filter((row) => !before.some((old) => Bun.deepEquals(old, row)))).toEqual([
      {
        table_name: "memories",
        column_name: "origin",
        data_type: "text",
        is_nullable: "YES",
        column_default: null,
        is_identity: "NO",
      },
    ]);
    expect(after.length).toBe(before.length + 1);
    const indexes = (await admin.unsafe(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname IN ('memories_by_origin', 'memories_by_sources')
       ORDER BY indexname`,
      [schema],
    )) as { indexdef: string }[];
    expect(indexes.map((row) => row.indexdef.replaceAll(schema, "<schema>"))).toEqual([
      "CREATE INDEX memories_by_origin ON <schema>.memories USING btree ((((origin)::jsonb ->> 'memoryId'::text))) WHERE (origin IS NOT NULL)",
      "CREATE INDEX memories_by_sources ON <schema>.memories USING gin (((sources)::jsonb) jsonb_path_ops) WHERE (sources IS NOT NULL)",
    ]);
  });

  test("migration 3 makes every carrier of a stored outbox row pending, and none of an empty row", async () => {
    await migrate(client(), schema, 5000, MIGRATIONS.slice(0, 2));
    await admin.unsafe(
      `INSERT INTO ${schema}.erasure_outbox (seq, memory_id, carriers) VALUES
         (4, 'm-old', '[{"id":"c-old","kind":"k"},{"id":"b-old","kind":"j"}]'),
         (6, 'm-empty', '[]')`,
    );
    const store = await openPostgresStore({ client: client(), schema });
    expect(await versions()).toEqual([1, 2, 3]);
    expect(await store.pendingErasures({ limit: 10 })).toEqual([
      {
        seq: 4,
        memoryId: "m-old",
        carriers: [
          { id: "b-old", kind: "j" },
          { id: "c-old", kind: "k" },
        ],
      },
    ]);
    expect(await store.pendingErasureCount()).toEqual({ work: 1, carriers: 2 });
  });

  test("the golden schema-v1 fixture migrates to 3: its memories have no origin, and a copy written after is derived", async () => {
    await restoreFixture(schema);
    const store = await openPostgresStore({ client: client(), schema });
    expect(await versions()).toEqual([1, 2, 3]);
    const expected = JSON.parse(readFileSync(FIXTURE_JSON, "utf8"));
    const contents = JSON.parse(JSON.stringify(await fixtureContents(store)));
    expect(contents).toEqual(expected);
    expect(JSON.stringify(contents)).not.toContain('"origin"');
    const [origins] = (await admin.unsafe(
      `SELECT count(*)::integer AS n FROM ${schema}.memories WHERE origin IS NOT NULL`,
    )) as { n: number }[];
    expect(origins?.n).toBe(0);

    const kept = await store.transaction((tx) => tx.memory("m-pinned"));
    if (kept === undefined || kept.status === "redacted") throw new Error("m-pinned is missing");
    const copy = {
      ...kept,
      id: "m-copy",
      scope: "fixture/b",
      pinned: false,
      origin: { memoryId: kept.id, revision: 1 },
    };
    await store.transaction((tx) => tx.putMemory(copy));
    const read = await store.transaction(async (tx) => ({
      copy: await tx.memory(copy.id),
      derived: await tx.derived(kept.id),
    }));
    expect(read).toEqual({ copy, derived: [copy.id] });
    // Negative control: a memory without copies or summaries has nothing derived.
    expect(await store.transaction((tx) => tx.derived("m-other"))).toEqual([]);
    // Version 3: the fixture's outbox rows keep their (empty) carriers, with no outcome and no
    // exposure, and an exposure recorded after is read back.
    expect(await store.settlements()).toEqual([]);
    const carrier = { id: "carrier-1", kind: "kind-a" };
    expect(await store.recordExposure({ carrier, memoryIds: [kept.id], at: 1 })).toEqual([]);
    expect(await store.transaction((tx) => tx.exposures(kept.id))).toEqual([carrier]);
  });

  test("a later migration keeps the fixture's tombstones, op records and term index", async () => {
    await restoreFixture(schema);
    const later = {
      version: LATEST + 1,
      statements: (s: string) => [`ALTER TABLE ${s}.memories ADD COLUMN later text`],
    };
    await migrate(client(), schema, 5000, [...MIGRATIONS, later]);
    expect(await versions()).toEqual([...ALL, LATEST + 1]);
    const expected = JSON.parse(readFileSync(FIXTURE_JSON, "utf8"));
    // Read with this relembra's statements, which name their columns, over the migrated schema.
    const store = await openPostgresStore({ client: client(), schema }).catch((e) => e);
    expect(store).toBeInstanceOf(SchemaTooNewError);
    const rows = (await admin.unsafe(
      `SELECT id, scope, seq FROM ${schema}.tombstones ORDER BY id`,
    )) as { id: string; scope: string; seq: string }[];
    expect(rows.map((r) => ({ ...r, seq: Number(r.seq), status: "redacted" }))).toEqual(
      expected.memories.filter((m: { status: string } | null) => m?.status === "redacted"),
    );
    const ops = (await admin.unsafe(
      `SELECT op_id, fingerprint FROM ${schema}.ops ORDER BY op_id`,
    )) as { op_id: string; fingerprint: string | null }[];
    expect(ops.map((o) => [o.op_id, o.fingerprint !== null])).toEqual(
      expected.ops
        .map((o: { opId: string; fingerprint?: string }) => [o.opId, o.fingerprint !== undefined])
        .sort(),
    );
    const [postings] = (await admin.unsafe(
      `SELECT count(*)::integer AS n FROM ${schema}.term_postings`,
    )) as { n: number }[];
    expect(postings?.n).toBeGreaterThan(0);
  });

  test("the fixture's populate script reproduces the fixture's contents on a fresh store", async () => {
    const store = await openPostgresStore({ client: client(), schema });
    await populateFixture(store);
    const expected = JSON.parse(readFileSync(FIXTURE_JSON, "utf8"));
    const actual = JSON.parse(JSON.stringify(await fixtureContents(store)));
    // Database time differs between runs; everything else must match.
    type Contents = {
      memories: ({ notedAt?: number } | null)[];
      ops: { at?: number }[];
      recall: { notedAt: number }[];
    };
    const timeless = (contents: Contents) => ({
      ...contents,
      memories: contents.memories.map((m) => (m === null ? m : { ...m, notedAt: 0 })),
      ops: contents.ops.map((o) => ({ ...o, at: 0 })),
      recall: contents.recall.map((m) => ({ ...m, notedAt: 0 })),
    });
    expect(timeless(actual)).toEqual(timeless(expected));
  });
});
