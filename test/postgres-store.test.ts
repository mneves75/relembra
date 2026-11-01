import { afterEach, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  advanceFence,
  createRelembra,
  FencedError,
  importOptmem,
  MemoryRedactedError,
  MemoryStateError,
  OpConflictError,
  type Principal,
  type Store,
} from "relembra";
import {
  openPostgresStore,
  type SqlClient,
  type SqlQuery,
  StoreBusyError,
  StoreCommitUnknownError,
  StoreRetryError,
} from "relembra/postgres";
import {
  bunClient,
  describePostgres,
  dropSchema,
  freshSchema,
  pool,
  tableText,
} from "./postgres-support.js";

const SCOPE = "pg/shared";
const owner: Principal = {
  id: "pg-owner",
  readable: [SCOPE],
  writable: [SCOPE],
  promotable: [],
  owned: [SCOPE],
};
const provenance = { agent: "a", harness: "h", model: "m", host: "pg-test" };

/** What an instrumented client does around the real one. */
interface Hooks {
  /** Runs before each statement inside a transaction; may wait or throw. */
  before?(text: string): void | Promise<void>;
  /** Replaces a statement's text inside a transaction. */
  rewrite?(text: string): string;
  /** Runs after the work of a transaction resolves, before its COMMIT; may throw. */
  beforeCommit?(): void | Promise<void>;
  /** Runs after a transaction committed; may throw. */
  afterCommit?(): void | Promise<void>;
  /** Runs after a transaction failed and rolled back, before its error reaches the store. */
  afterFailure?(): void | Promise<void>;
  /** Called for each statement run outside a transaction. */
  outside?(text: string): void;
}

function instrumented(inner: SqlClient, hooks: Hooks): SqlClient {
  return {
    query(text, params) {
      hooks.outside?.(text);
      return inner.query(text, params);
    },
    async transaction(work) {
      const result = await inner
        .transaction(async (q) => {
          const tx: SqlQuery = {
            async query(text, params) {
              await hooks.before?.(text);
              return q.query(hooks.rewrite ? hooks.rewrite(text) : text, params);
            },
          };
          const value = await work(tx);
          await hooks.beforeCommit?.();
          return value;
        })
        .catch(async (error: unknown) => {
          await hooks.afterFailure?.();
          throw error;
        });
      await hooks.afterCommit?.();
      return result;
    },
  };
}

/** An error as a driver reports a server error with `sqlState`. */
function serverError(state: string): Error {
  return Object.assign(new Error(`server error ${state}`), { errno: state });
}

/** An error as a driver reports a dropped connection: no SQLSTATE. */
function connectionLost(): Error {
  return Object.assign(new Error("Connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" });
}

/**
 * A pause the first `parties` callers share: each resolves when all have arrived, or after
 * `timeoutMs` when the others cannot arrive (they wait on a lock the first holds).
 */
function rendezvous(parties: number, timeoutMs: number) {
  let waiting: (() => void)[] = [];
  let used = 0;
  return () =>
    new Promise<void>((resolve) => {
      if (used >= parties) return resolve();
      used += 1;
      waiting.push(resolve);
      if (waiting.length === parties) {
        for (const release of waiting) release();
        waiting = [];
      } else {
        setTimeout(resolve, timeoutMs);
      }
    });
}

/** A promise's outcome, without rejecting. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

/** Resolves after `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relembraOver(store: Store, prefix: string, now = 1_000) {
  let next = 0;
  return createRelembra<null>({
    store,
    policy: () => owner,
    clock: { now: () => now },
    ids: { memoryId: () => `${prefix}-${++next}`, opId: () => `${prefix}-op-${++next}` },
  });
}

describePostgres("postgres store: contention and transactions (IMPLEMENTATION-PLAN §4.4)", () => {
  let schema: string;
  let pools: SQL[];
  let admin: SQL;
  const client = (hooks: Hooks = {}, connection: Record<string, string> = {}) => {
    const sql = pool(4, connection);
    pools.push(sql);
    return instrumented(bunClient(sql), hooks);
  };
  const open = (
    hooks: Hooks = {},
    options: { lockTimeoutMs?: number; maxAttempts?: number } = {},
    connection: Record<string, string> = {},
  ) => openPostgresStore({ client: client(hooks, connection), schema, ...options });

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

  test("a mutation locks the store row first, and every statement after it uses the transaction's connection", async () => {
    const statements: string[] = [];
    const outside: string[] = [];
    let inside = false;
    const store = await open({
      before: (text) => {
        statements.push(text);
      },
      outside: (text) => {
        if (inside) outside.push(text);
      },
    });
    statements.length = 0;
    inside = true;
    await relembraOver(store, "one").note(null, {
      scope: SCOPE,
      text: "Locked first.",
      provenance,
    });
    inside = false;

    expect(statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(statements[1]).toMatch(/^SET LOCAL lock_timeout/);
    expect(statements[2]).toBe(`SELECT id FROM ${schema}.store_lock WHERE id = 1 FOR UPDATE`);
    // Positive control: the work after the lock read and wrote through the same handle.
    expect(statements.slice(3).some((s) => s.includes(`${schema}.ops`))).toBe(true);
    expect(statements.slice(3).some((s) => s.includes(`INSERT INTO ${schema}.events`))).toBe(true);
    expect(outside).toEqual([]);
  });

  test("a transaction waits while another holds the store row, and fails with StoreBusyError after lockTimeoutMs", async () => {
    const store = await open({}, { lockTimeoutMs: 300 });
    const patient = await open({}, { lockTimeoutMs: 20_000 });
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((done) => {
      locked = done;
    });
    const holder = admin.begin(async (tx) => {
      await tx.unsafe(`SELECT id FROM ${schema}.store_lock WHERE id = 1 FOR UPDATE`);
      locked();
      await held;
    });
    await isLocked;

    await expect(
      relembraOver(store, "busy").note(null, { scope: SCOPE, text: "Blocked.", provenance }),
    ).rejects.toBeInstanceOf(StoreBusyError);
    let done = false;
    const waiting = relembraOver(patient, "wait")
      .note(null, { scope: SCOPE, text: "Waits its turn.", provenance })
      .then((m) => {
        done = true;
        return m;
      });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);

    release();
    await holder;
    // Positive control: once the row is free, the waiting write commits.
    expect((await waiting).revision.text).toBe("Waits its turn.");
    expect(
      (await store.recall({ scopes: [SCOPE], limit: 10 })).map((m) => m.revision.text),
    ).toEqual(["Waits its turn."]);
  });

  test("40001 and 40P01 are retried up to maxAttempts; other errors are not", async () => {
    let failures: string[] = [];
    const store = await open(
      {
        before: (text) => {
          if (text.includes("FOR UPDATE") && failures.length > 0) {
            throw serverError(failures.shift() as string);
          }
        },
      },
      { maxAttempts: 3 },
    );
    const relembra = relembraOver(store, "retry");

    failures = ["40001", "40P01"];
    const noted = await relembra.note(null, { scope: SCOPE, text: "Third time.", provenance });
    expect(failures).toEqual([]);
    expect((await store.recall({ scopes: [SCOPE], limit: 10 })).map((m) => m.id)).toEqual([
      noted.id,
    ]);

    failures = ["40001", "40001", "40001", "40001"];
    const exhausted = relembra.note(null, { scope: SCOPE, text: "Never lands.", provenance });
    await expect(exhausted).rejects.toBeInstanceOf(StoreRetryError);
    expect(failures).toEqual(["40001"]);

    failures = ["23505"];
    await expect(
      relembra.note(null, { scope: SCOPE, text: "Not retried.", provenance }),
    ).rejects.toMatchObject({ errno: "23505" });
    expect(failures).toEqual([]);
    expect((await store.recall({ scopes: [SCOPE], limit: 10 })).length).toBe(1);
  });

  test("a commit whose answer was lost is resolved by its op id", async () => {
    let loseAfterCommit = false;
    let loseBeforeCommit = false;
    const store = await open({
      beforeCommit: () => {
        if (loseBeforeCommit) {
          loseBeforeCommit = false;
          // The work ran, the transaction rolls back, and the client sees only a lost connection.
          throw connectionLost();
        }
      },
      afterCommit: () => {
        if (loseAfterCommit) {
          loseAfterCommit = false;
          throw connectionLost();
        }
      },
    });
    const relembra = relembraOver(store, "lost");

    // It landed: the op record is there, so the write's own result is returned, once.
    loseAfterCommit = true;
    const landed = await relembra.note(null, {
      scope: SCOPE,
      text: "Committed, answer lost.",
      provenance,
      opId: "op-landed",
    });
    expect(loseAfterCommit).toBe(false);
    const retried = await relembra.note(null, {
      scope: SCOPE,
      text: "Committed, answer lost.",
      provenance,
      opId: "op-landed",
    });
    expect(retried).toEqual(landed);

    // It did not land: no op record, so it runs again and commits once.
    loseBeforeCommit = true;
    const rerun = await relembra.note(null, {
      scope: SCOPE,
      text: "Rolled back, answer lost.",
      provenance,
      opId: "op-rerun",
    });
    expect(loseBeforeCommit).toBe(false);
    expect((await store.recall({ scopes: [SCOPE], limit: 10 })).map((m) => m.id)).toEqual([
      rerun.id,
      landed.id,
    ]);

    // A write without an op id cannot be resolved, and says so.
    loseAfterCommit = true;
    await expect(relembra.retract(null, { memoryId: rerun.id })).rejects.toBeInstanceOf(
      StoreCommitUnknownError,
    );
    // A transaction that wrote nothing has nothing to resolve.
    loseAfterCommit = true;
    expect(await store.transaction((tx) => tx.memory(landed.id))).toEqual(landed);
  });

  for (const level of ["read committed", "repeatable read", "serializable"]) {
    test(`a writer whose epoch was advanced while it waited for the store row is fenced (client default ${level})`, async () => {
      const lease = "pg-lease";
      await advanceFence(await open(), { key: lease, epoch: 1 });
      const staleStore = await open({}, {}, { default_transaction_isolation: level });
      const stale = createRelembra<null>({
        store: staleStore,
        policy: () => ({ ...owner, fence: { key: lease, epoch: 1 } }),
      });
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((done) => {
        locked = done;
      });
      // Another host takes over: it advances the epoch to 2 while holding the store row.
      const takeover = admin.begin(async (tx) => {
        await tx.unsafe(`SELECT id FROM ${schema}.store_lock WHERE id = 1 FOR UPDATE`);
        await tx.unsafe(`UPDATE ${schema}.fences SET epoch = 2 WHERE key = $1`, [lease]);
        locked();
        await held;
      });
      await isLocked;
      // The paused writer starts, and waits for the row, before the takeover commits.
      const outcome = stale.note(null, { scope: SCOPE, text: "Stale write.", provenance }).then(
        () => "committed",
        (error: unknown) => error,
      );
      await pause(300);
      release();
      await takeover;

      expect(await outcome).toBeInstanceOf(FencedError);
      expect(await staleStore.recall({ scopes: [SCOPE], limit: 10 })).toEqual([]);
      // Positive control: a writer holding epoch 2, on the same client default, commits.
      const current = createRelembra<null>({
        store: staleStore,
        policy: () => ({ ...owner, fence: { key: lease, epoch: 2 } }),
      });
      await current.note(null, { scope: SCOPE, text: "Current write.", provenance });
      expect((await staleStore.recall({ scopes: [SCOPE], limit: 10 })).length).toBe(1);
    });
  }

  test("a lost commit is resolved by the op record: another host's commit under the op id with other text is a conflict", async () => {
    // A's work completes, its transaction rolls back, and A sees only a lost connection. Before A
    // looks again, B commits the same op id with the same generated memory id (and so the same
    // rolled-back seq) but other text.
    const b = relembraOver(await open(), "same");
    let lose = true;
    const a = relembraOver(
      await open({
        beforeCommit: () => {
          if (lose) throw connectionLost();
        },
        afterFailure: async () => {
          if (!lose) return;
          lose = false;
          await b.note(null, { scope: SCOPE, text: "B's text.", provenance, opId: "op-shared" });
        },
      }),
      "same",
    );

    await expect(
      a.note(null, { scope: SCOPE, text: "A's text.", provenance, opId: "op-shared" }),
    ).rejects.toBeInstanceOf(OpConflictError);
    const stored = await (await open()).recall({ scopes: [SCOPE], limit: 10 });
    expect(stored.map((m) => m.revision.text)).toEqual(["B's text."]);
    // Positive control: A's own payload under a fresh op id commits as usual.
    await a.note(null, { scope: SCOPE, text: "A's text.", provenance, opId: "op-own" });
  });

  test("a lost commit returns the persisted outcome: another host's commit of the same payload, with its time", async () => {
    // As above, but B commits the same payload, later by the database clock than A's rolled-back
    // attempt. A gets B's record (its notedAt), not its own attempt's result.
    const b = relembraOver(await open(), "same");
    let lose = true;
    let attempt: number | undefined;
    const a = relembraOver(
      await open({
        beforeCommit: () => {
          if (lose) throw connectionLost();
        },
        afterFailure: async () => {
          if (!lose) return;
          lose = false;
          await pause(20);
          const first = await b.note(null, {
            scope: SCOPE,
            text: "Same text.",
            provenance,
            opId: "op-same",
          });
          attempt = first.notedAt;
        },
      }),
      "same",
    );

    const result = await a.note(null, {
      scope: SCOPE,
      text: "Same text.",
      provenance,
      opId: "op-same",
    });
    const store = await open();
    const [stored] = await store.recall({ scopes: [SCOPE], limit: 10 });
    expect(result.notedAt).toBe(attempt as number);
    expect(stored?.notedAt).toBe(result.notedAt);
    expect(await store.transaction((tx) => tx.memory(result.id))).toEqual(result);
  });

  test("a lost commit whose memory was redacted before the store looked again reports the redaction", async () => {
    let mode: "redact" | "lose" | undefined = "redact";
    const other = relembraOver(await open(), "other");
    const a = relembraOver(
      await open({
        afterCommit: async () => {
          const now = mode;
          mode = undefined;
          // The commit landed; before the answer reaches A, the memory may be redacted.
          if (now === "redact") await other.redact(null, { memoryId: "red-1" });
          if (now !== undefined) throw connectionLost();
        },
      }),
      "red",
    );

    await expect(
      a.note(null, { scope: SCOPE, text: "Redacted soon.", provenance, opId: "op-red" }),
    ).rejects.toBeInstanceOf(MemoryRedactedError);
    // Positive control: the same lost answer with no redaction in between returns the memory.
    mode = "lose";
    const kept = await a.note(null, { scope: SCOPE, text: "Kept.", provenance, opId: "op-kept" });
    expect(mode).toBeUndefined();
    expect(kept.revision.text).toBe("Kept.");
  });

  test("an OptMem import is accepted at database time; the caller's time stays as revision.at", async () => {
    const store = await open();
    const before = Date.now() - 60_000;
    const log = Buffer.from(`${"An imported fact.".padEnd(31, " ")}\n`);
    await importOptmem(store, owner, {
      scope: SCOPE,
      store: "pg",
      log,
      clock: { now: () => 0 },
      provenance: { agent: "importer", harness: "optmem", model: "none", host: "pg-test" },
    });
    const [imported] = await store.recall({ scopes: [SCOPE], limit: 10 });
    expect(imported?.revision.at).toBe(0);
    expect(imported?.notedAt).toBeGreaterThan(before);
  });

  test("writes are accepted at database time; the caller's time stays as revision.at", async () => {
    const store = await open();
    const dbNow = async () =>
      Number(
        (
          (await admin.unsafe(
            "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now",
          )) as { now: string }[]
        )[0]?.now,
      );
    const before = await dbNow();
    const noted = await relembraOver(store, "time", 1_000).note(null, {
      scope: SCOPE,
      text: "Database clock.",
      provenance,
    });
    const after = await dbNow();

    expect(noted.revision.at).toBe(1_000);
    expect(noted.notedAt).toBeGreaterThanOrEqual(before);
    expect(noted.notedAt).toBeLessThanOrEqual(after);
    const [row] = (await admin.unsafe(
      `SELECT noted_at, revised_at FROM ${schema}.memories WHERE id = $1`,
      [noted.id],
    )) as { noted_at: string; revised_at: string }[];
    expect([Number(row?.noted_at), Number(row?.revised_at)]).toEqual([noted.notedAt, 1_000]);
  });

  test("race: the same op id from two hosts at once stores one memory and both get its outcome", async () => {
    const meet = rendezvous(2, 1_000);
    const hooks: Hooks = {
      before: (text) => (text.includes(`FROM ${schema}.ops`) ? meet() : undefined),
    };
    const a = relembraOver(await open(hooks), "host-a");
    const b = relembraOver(await open(hooks), "host-b");
    const input = { scope: SCOPE, text: "Exactly once.", provenance, opId: "op-race" };

    const [fromA, fromB] = await Promise.all([a.note(null, input), b.note(null, input)]);

    expect(fromB).toEqual(fromA);
    const stored = await (await open()).recall({ scopes: [SCOPE], limit: 10 });
    expect(stored.map((m) => m.id)).toEqual([fromA.id]);
    // Positive control: different op ids at once are two memories.
    const [x, y] = await Promise.all([
      a.note(null, { ...input, opId: "op-x" }),
      b.note(null, { ...input, opId: "op-y" }),
    ]);
    expect(new Set([x.id, y.id, fromA.id]).size).toBe(3);
  });

  test("race, negative control: without the store row lock, two hosts with the same op id collide", async () => {
    const meet = rendezvous(2, 1_000);
    const hooks: Hooks = {
      before: (text) => (text.includes(`FROM ${schema}.ops`) ? meet() : undefined),
      rewrite: (text) => (text.includes("store_lock") ? "SELECT 1" : text),
    };
    const a = relembraOver(await open(hooks), "host-a");
    const b = relembraOver(await open(hooks), "host-b");
    const input = { scope: SCOPE, text: "Exactly once.", provenance, opId: "op-race" };

    const results = await Promise.allSettled([a.note(null, input), b.note(null, input)]);

    // Both read before either wrote: one commits, the other hits a unique violation.
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ errno: "23505" });
  });

  test("race: two hosts superseding one memory at once: one replaces it, the other is refused", async () => {
    const setup = relembraOver(await open(), "setup");
    const target = await setup.note(null, { scope: SCOPE, text: "Old rule.", provenance });
    const other = await setup.note(null, { scope: SCOPE, text: "Other rule.", provenance });
    const meet = rendezvous(2, 1_000);
    const hooks: Hooks = {
      before: (text) => (text.includes(`FROM ${schema}.ops`) ? meet() : undefined),
    };
    const a = relembraOver(await open(hooks), "host-a");
    const b = relembraOver(await open(hooks), "host-b");

    const results = await Promise.allSettled([
      a.supersede(null, { memoryId: target.id, text: "Rule by A.", provenance }),
      b.supersede(null, { memoryId: target.id, text: "Rule by B.", provenance }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(MemoryStateError);
    const live = await setup.recall(null);
    expect(live.map((m) => m.id).filter((id) => id.startsWith("host-")).length).toBe(1);
    // Positive control: superseding two different memories at once both succeed.
    const [first, second] = await Promise.all([
      a.supersede(null, { memoryId: other.id, text: "Other by A.", provenance }),
      b.supersede(null, {
        memoryId: (live.find((m) => m.id.startsWith("host-")) as { id: string }).id,
        text: "Newest by B.",
        provenance,
      }),
    ]);
    expect([first.revision.text, second.revision.text]).toEqual(["Other by A.", "Newest by B."]);
  });

  test("race: a redaction and a summary of its memory at once never leave a summary of redacted text", async () => {
    const setup = relembraOver(await open(), "setup");
    const secret = "The vault code is heron-teal-58.";
    const summaryText = "Summary: the vault code, marker osprey-plum-36.";
    for (const first of ["summary", "redaction"] as const) {
      const source = await setup.note(null, { scope: SCOPE, text: secret, provenance });
      // The first writer, holding the store row, stops at its first memory read until the second
      // writer has started and is waiting for the row: the two are in flight at once, and the
      // lock decides that the first commits first.
      let holding!: () => void;
      const holds = new Promise<void>((resolve) => {
        holding = resolve;
      });
      let stopped = false;
      const firstHooks: Hooks = {
        before: async (text) => {
          if (stopped || !text.includes(`FROM ${schema}.memories WHERE id`)) return;
          stopped = true;
          holding();
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
      };
      const summarizer = relembraOver(
        await open(first === "summary" ? firstHooks : {}),
        `sum-${first}`,
      );
      const redactor = relembraOver(
        await open(first === "redaction" ? firstHooks : {}),
        `red-${first}`,
      );
      const summarize = () =>
        summarizer.submitSummary(null, {
          scope: SCOPE,
          text: summaryText,
          sources: [{ memoryId: source.id, revision: 1 }],
          provenance,
        });
      const redact = () => redactor.redact(null, { memoryId: source.id });
      let summarized: Promise<Awaited<ReturnType<typeof summarize>>>;
      let redacted: Promise<Awaited<ReturnType<typeof redact>>>;
      if (first === "summary") {
        summarized = summarize();
        await holds;
        redacted = redact();
      } else {
        redacted = redact();
        await holds;
        summarized = summarize();
      }
      const summary = await settle(summarized);
      const redaction = await settle(redacted);

      if (redaction.error !== undefined) throw redaction.error;
      expect(redaction.value?.redacted).toEqual([source.id]);
      if (first === "summary") {
        // The summary committed first: the redaction took it along as derived.
        expect(summary.error).toBeUndefined();
        expect(redaction.value?.derived).toEqual([summary.value?.id as string]);
      } else {
        // The redaction committed first: the source was redacted when the summary read it.
        expect((summary.error as Error).name).toBe("SourceChangedError");
        expect(redaction.value?.derived).toEqual([]);
      }
      const text = await tableText(admin, schema);
      expect(text.includes(secret)).toBe(false);
      expect(text.includes(summaryText)).toBe(false);
    }
    // Positive control: without the race, the summary commits and the scan finds both texts.
    const source = await setup.note(null, { scope: SCOPE, text: secret, provenance });
    const summary = await setup.submitSummary(null, {
      scope: SCOPE,
      text: summaryText,
      sources: [{ memoryId: source.id, revision: 1 }],
      provenance,
    });
    const text = await tableText(admin, schema);
    expect(text.includes(secret) && text.includes(summaryText)).toBe(true);
    expect(await setup.redact(null, { memoryId: source.id })).toEqual({
      redacted: [source.id],
      derived: [summary.id],
    });
  });
});
