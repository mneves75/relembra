import assert from "node:assert/strict";
import type {
  Event,
  Memory,
  MemoryStatus,
  NewEvent,
  NoteEvent,
  OpRecord,
  Principal,
  Scope,
  SourceRevision,
  Trust,
} from "../model.js";
import type { Carrier, CarrierSettlement, Clock, Ids, Store, TermIndexRead } from "../ports.js";
import { type QueryTerm, type Ranked, rank } from "../ranking.js";
import { advanceFence, createRelembra } from "../relembra.js";

/** A store opened for one conformance case. */
export interface OpenedStore {
  /** A fresh, empty store. */
  readonly store: Store;
  /**
   * Opens another handle on the same data. Stores that persist provide it, and the suite then
   * checks that committed writes survive and rolled-back ones do not.
   */
  reopen?(): Store | Promise<Store>;
  /**
   * Every committed event, in seq order, read from storage without going through the store
   * under test. Durable targets must provide it: the suite checks that appended events persist
   * and that a rolled-back append leaves nothing.
   */
  inspectEvents?(): readonly Event[] | Promise<readonly Event[]>;
  /**
   * Every byte the store holds at rest (its files, or whatever stands for them), read without
   * going through the store under test and without checkpointing or compacting anything first.
   * Durable targets must provide it: the suite checks that a redacted memory's text is gone from
   * it, beside a planted copy that is found.
   */
  rawBytes?(): Uint8Array | Promise<Uint8Array>;
  /** Releases every handle and removes whatever `open` created. */
  close(): void | Promise<void>;
}

/** How the suite opens the store under test: once per case, always empty. */
export interface ConformanceTarget {
  open(): OpenedStore | Promise<OpenedStore>;
  /**
   * True when the store persists; every opened store must then provide `reopen`, `inspectEvents`
   * and `rawBytes`.
   */
  readonly durable?: boolean;
}

/** One check. `run` resolves when the store conforms and rejects with the reason when it does not. */
export interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

/**
 * The behaviour every store adapter must have, as framework-neutral cases. Register each one with
 * your test runner, for example `for (const c of storeConformanceCases(target)) test(c.name, c.run)`.
 */
export function storeConformanceCases(target: ConformanceTarget): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const define = (name: string, check: (opened: OpenedStore) => Promise<void>) => {
    cases.push({
      name,
      async run() {
        const opened = await target.open();
        try {
          await check(opened);
        } finally {
          await opened.close();
        }
      },
    });
  };

  define("a committed memory is recalled with every field intact", async ({ store }) => {
    const plain = memory("m-plain", SCOPE_A, 1);
    const sourced = memory("m-sourced", SCOPE_A, 2, {
      source: "docs/notes.md",
      pinned: true,
      trust: "owner",
    });
    const untrusted = memory("m-untrusted", SCOPE_A, 3, { trust: "untrusted" });

    await commit(store, plain);
    await commit(store, sourced);
    await commit(store, untrusted);

    assert.deepStrictEqual(await store.recall({ scopes: [SCOPE_A], limit: 10 }), [
      untrusted,
      sourced,
      plain,
    ]);
  });

  define(
    "append returns the event with a seq that increases in commit order",
    async ({ store }) => {
      const first = memory("m-1", SCOPE_A, 1);
      const second = memory("m-2", SCOPE_A, 2);

      const firstEvent = await store.transaction((tx) => tx.append(noteEvent(first)));
      const secondEvent = await store.transaction((tx) => tx.append(noteEvent(second)));

      assert.deepStrictEqual(firstEvent, { ...noteEvent(first), seq: firstEvent.seq });
      assert.deepStrictEqual(secondEvent, { ...noteEvent(second), seq: secondEvent.seq });
      assert.ok(
        Number.isSafeInteger(firstEvent.seq) && firstEvent.seq > 0,
        "seq is a positive integer",
      );
      assert.ok(secondEvent.seq > firstEvent.seq, "a later commit gets a larger seq");
    },
  );

  define("transaction returns what its work returns", async ({ store }) => {
    assert.equal(await store.transaction(async () => "result"), "result");
  });

  define("recall returns only memories in the requested scopes", async ({ store }) => {
    const inA = memory("m-a", SCOPE_A, 1);
    const inB = memory("m-b", SCOPE_B, 2);
    await commit(store, inA);
    await commit(store, inB);

    // Positive control: each scope's own reader sees its memory.
    assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A], limit: 10 })), ["m-a"]);
    assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_B], limit: 10 })), ["m-b"]);
    assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A, SCOPE_B], limit: 10 })), [
      "m-b",
      "m-a",
    ]);
    assert.deepStrictEqual(await store.recall({ scopes: [SCOPE_C], limit: 10 }), []);
  });

  define("recall with no scopes returns nothing", async ({ store }) => {
    await commit(store, memory("m-a", SCOPE_A, 1));

    // Positive control: the memory is there for a reader of its scope.
    assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A], limit: 10 })), ["m-a"]);
    assert.deepStrictEqual(await store.recall({ scopes: [], limit: 10 }), []);
  });

  define("recall filters by scope before it applies the limit", async ({ store }) => {
    for (let i = 1; i <= 3; i++) await commit(store, memory(`m-a${i}`, SCOPE_A, i));
    // Newer memories in another scope must not crowd the readable ones out of the limit.
    for (let i = 4; i <= 8; i++) await commit(store, memory(`m-b${i}`, SCOPE_B, i));

    assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A], limit: 3 })), [
      "m-a3",
      "m-a2",
      "m-a1",
    ]);
  });

  define("recall returns the newest memories first, at most limit", async ({ store }) => {
    for (let i = 1; i <= 4; i++) await commit(store, memory(`m-${i}`, SCOPE_A, i));

    assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A], limit: 2 })), [
      "m-4",
      "m-3",
    ]);
  });

  define("putting a memory again replaces it and keeps its place", async ({ store }) => {
    const original = memory("m-1", SCOPE_A, 1);
    await commit(store, original);
    await commit(store, memory("m-2", SCOPE_A, 2));
    const replacement: Memory = {
      ...original,
      seq: 1003,
      pinned: true,
      revision: { ...original.revision, number: 2, text: "Replacement text.", at: 3 },
    };

    await commit(store, replacement);

    assert.deepStrictEqual(await store.recall({ scopes: [SCOPE_A], limit: 10 }), [
      memory("m-2", SCOPE_A, 2),
      replacement,
    ]);
  });

  define(
    "liveMemories returns every memory in the requested scopes and none outside them",
    async ({ store }) => {
      const a1 = memory("m-a1", SCOPE_A, 1, { source: "docs/a.md", trust: "owner" });
      const a2 = memory("m-a2", SCOPE_A, 2, { pinned: true });
      const a3 = memory("m-a3", SCOPE_A, 4, { trust: "untrusted" });
      const b1 = memory("m-b1", SCOPE_B, 3);
      for (const noted of [a1, a2, b1, a3]) await commit(store, noted);

      // Positive control: a reader of each scope gets its memories, every field intact (trust
      // and the pinned flag included: wake composes from them).
      assert.deepStrictEqual(byId(await store.liveMemories({ scopes: [SCOPE_A] })), [a1, a2, a3]);
      assert.deepStrictEqual(byId(await store.liveMemories({ scopes: [SCOPE_B] })), [b1]);
      assert.deepStrictEqual(byId(await store.liveMemories({ scopes: [SCOPE_A, SCOPE_B] })), [
        a1,
        a2,
        a3,
        b1,
      ]);
      assert.deepStrictEqual(await store.liveMemories({ scopes: [SCOPE_C] }), []);
      assert.deepStrictEqual(await store.liveMemories({ scopes: [] }), []);
    },
  );

  define("liveMemories applies no limit", async ({ store }) => {
    // More than recall's default (50) and find's maximum (100): the ranker needs the whole set.
    const count = 150;
    await store.transaction(async (tx) => {
      for (let i = 1; i <= count; i++) await tx.putMemory(memory(`m-a${i}`, SCOPE_A, i));
      await tx.putMemory(memory("m-b", SCOPE_B, count + 1));
    });

    assert.equal((await store.liveMemories({ scopes: [SCOPE_A] })).length, count);
    // Positive control: the other scope's memory exists and is counted only for its own reader.
    assert.equal((await store.liveMemories({ scopes: [SCOPE_A, SCOPE_B] })).length, count + 1);
  });

  define("liveMemories returns each memory once, in its current revision", async ({ store }) => {
    const original = memory("m-1", SCOPE_A, 1);
    const current: Memory = {
      ...original,
      seq: 1002,
      revision: { ...original.revision, number: 2, text: "Current text.", at: 2 },
    };
    await commit(store, original);
    await commit(store, memory("m-2", SCOPE_A, 3));
    await commit(store, current);

    assert.deepStrictEqual(byId(await store.liveMemories({ scopes: [SCOPE_A] })), [
      current,
      memory("m-2", SCOPE_A, 3),
    ]);
  });

  define("liveMemories never sees uncommitted writes", async ({ store }) => {
    const uncommitted = memory("m-uncommitted", SCOPE_A, 1);
    const written = deferred();
    const release = deferred();

    const rolledBack = store.transaction(async (tx) => {
      await tx.putMemory(uncommitted);
      written.resolve();
      await release.promise;
      throw new Error("roll back");
    });
    await written.promise;
    const read = store.liveMemories({ scopes: [SCOPE_A] });
    release.resolve();
    await assert.rejects(rolledBack);

    assert.deepStrictEqual(await read, []);

    // Positive control: the same write, committed, is read.
    await commit(store, uncommitted);
    assert.deepStrictEqual(await store.liveMemories({ scopes: [SCOPE_A] }), [uncommitted]);
  });

  define("a transaction whose work rejects commits none of its writes", async ({ store }) => {
    const failure = new Error("work failed");
    const rolledBack = memory("m-rolled-back", SCOPE_A, 1);

    await assert.rejects(
      store.transaction(async (tx) => {
        await tx.append(noteEvent(rolledBack));
        await tx.putMemory(rolledBack);
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepStrictEqual(await store.recall({ scopes: [SCOPE_A], limit: 10 }), []);

    // Positive control: the next transaction, with the same writes and no failure, commits.
    const committed = memory("m-committed", SCOPE_A, 2);
    await commit(store, committed);
    assert.deepStrictEqual(await store.recall({ scopes: [SCOPE_A], limit: 10 }), [committed]);
  });

  define("committed state is detached from the caller's objects", async ({ store }) => {
    const mutable = structuredClone(memory("m-1", SCOPE_A, 1, { text: "before" }));
    const event = structuredClone(noteEvent(mutable));
    await store.transaction(async (tx) => {
      await tx.append(event);
      await tx.putMemory(mutable);
    });

    // A later transaction mutates the caller's object, puts it, and rolls back.
    await assert.rejects(
      store.transaction(async (tx) => {
        (mutable.revision as { text: string }).text = "after";
        (mutable.revision.provenance as { agent: string }).agent = "intruder";
        await tx.putMemory(mutable);
        throw new Error("roll back");
      }),
    );

    const [recalled] = await store.recall({ scopes: [SCOPE_A], limit: 1 });
    assert.equal(recalled?.revision.text, "before");
    assert.equal(recalled?.revision.provenance.agent, "test-agent");

    // What recall hands out cannot change what the store holds either.
    try {
      (recalled?.revision as { text: string }).text = "changed by a reader";
    } catch {
      // A frozen result refuses the write, which also conforms.
    }
    const [again] = await store.recall({ scopes: [SCOPE_A], limit: 1 });
    assert.equal(again?.revision.text, "before");

    // Positive control: the same change, put in a transaction that commits, is stored.
    const changed: Memory = { ...mutable, revision: { ...mutable.revision, text: "after" } };
    await commit(store, changed);
    const [latest] = await store.recall({ scopes: [SCOPE_A], limit: 1 });
    assert.equal(latest?.revision.text, "after");
  });

  define(
    "a read during an open transaction never sees its uncommitted writes",
    async ({ store }) => {
      const uncommitted = memory("m-uncommitted", SCOPE_A, 1);
      const written = deferred();
      const release = deferred();

      const rolledBack = store.transaction(async (tx) => {
        await tx.putMemory(uncommitted);
        written.resolve();
        await release.promise;
        throw new Error("roll back");
      });
      await written.promise;
      // Not awaited yet: a store may answer at once or after the open transaction ends.
      const read = store.recall({ scopes: [SCOPE_A], limit: 10 });
      const terms = [{ exact: "uncommitted", stem: "uncommitted" }];
      const indexed = indexRead(store, [SCOPE_A], terms);
      release.resolve();
      await assert.rejects(rolledBack);

      assert.deepStrictEqual(await read, []);
      assert.deepStrictEqual(await indexed, {
        memories: 0,
        lengthAll: 0,
        lengthKept: 0,
        postings: [],
      });

      // Positive control: the same write, committed, is read.
      await commit(store, uncommitted);
      assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A], limit: 10 })), [
        "m-uncommitted",
      ]);
      assert.equal((await indexRead(store, [SCOPE_A], terms)).memories, 1);
    },
  );

  define("transactions on one store do not interleave", async ({ store }) => {
    const order: string[] = [];
    const firstStarted = deferred();
    const release = deferred();

    const first = store.transaction(async (tx) => {
      order.push("first:start");
      firstStarted.resolve();
      await release.promise;
      await tx.putMemory(memory("m-1", SCOPE_A, 1));
      order.push("first:end");
    });
    await firstStarted.promise;
    const second = store.transaction(async (tx) => {
      order.push("second:start");
      await tx.putMemory(memory("m-2", SCOPE_A, 2));
      order.push("second:end");
    });
    // Give the second transaction every chance to start early.
    await tick();
    release.resolve();
    await Promise.all([first, second]);

    assert.deepStrictEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  });

  define("concurrent transactions lose no write", async ({ store }) => {
    const count = 25;
    const writes = Array.from({ length: count }, (_, i) =>
      store.transaction(async (tx) => {
        const noted = memory(`m-${i}`, SCOPE_A, i + 1);
        await tick();
        const event = await tx.append(noteEvent(noted));
        await tick();
        await tx.putMemory(noted);
        return event.seq;
      }),
    );

    const seqs = await Promise.all(writes);

    assert.equal(new Set(seqs).size, count, "every write got its own seq");
    assert.equal((await store.recall({ scopes: [SCOPE_A], limit: count * 2 })).length, count);
  });

  define("a transaction handle refuses writes after its transaction ends", async ({ store }) => {
    let leaked: Parameters<Parameters<Store["transaction"]>[0]>[0] | undefined;
    await store.transaction(async (tx) => {
      leaked = tx;
    });
    assert.ok(leaked);

    await assert.rejects(leaked.putMemory(memory("m-late", SCOPE_A, 1)));
    assert.deepStrictEqual(await store.recall({ scopes: [SCOPE_A], limit: 10 }), []);

    // Positive control: the same write through a handle whose transaction is open is kept.
    const inTime = memory("m-in-time", SCOPE_A, 2);
    await store.transaction((tx) => tx.putMemory(inTime));
    assert.deepStrictEqual(
      (await store.recall({ scopes: [SCOPE_A], limit: 10 })).map((m) => m.id),
      [inTime.id],
    );
  });

  define("an op record commits with its transaction and is read back intact", async ({ store }) => {
    const noted = memory("m-op", SCOPE_A, 1);
    const record = opRecord("op-1", noted);

    const seenInside = await store.transaction(async (tx) => {
      assert.equal(await tx.op(OWNER, "op-1"), undefined, "no record before it is written");
      await tx.append(noteEvent(noted));
      await tx.putMemory(noted);
      await tx.putOp(record);
      return tx.op(OWNER, "op-1");
    });

    assert.deepStrictEqual(seenInside, record, "a record is visible later in its transaction");
    assert.deepStrictEqual(await store.transaction((tx) => tx.op(OWNER, "op-1")), record);
    assert.equal(await store.transaction((tx) => tx.op(OWNER, "op-unknown")), undefined);
  });

  define("an op record written by a transaction that rejects is not kept", async ({ store }) => {
    const noted = memory("m-op", SCOPE_A, 1);
    await assert.rejects(
      store.transaction(async (tx) => {
        await tx.putOp(opRecord("op-1", noted));
        throw new Error("roll back");
      }),
    );

    assert.equal(await store.transaction((tx) => tx.op(OWNER, "op-1")), undefined);

    // Positive control: the same record, committed, is kept.
    await store.transaction((tx) => tx.putOp(opRecord("op-1", noted)));
    assert.deepStrictEqual(
      await store.transaction((tx) => tx.op(OWNER, "op-1")),
      opRecord("op-1", noted),
    );
  });

  define("an op id has at most one record per principal", async ({ store }) => {
    const first = opRecord("op-1", memory("m-first", SCOPE_A, 1));
    const second = opRecord("op-1", memory("m-second", SCOPE_A, 2), "f".repeat(64));
    await store.transaction((tx) => tx.putOp(first));

    await assert.rejects(store.transaction((tx) => tx.putOp(second)));

    assert.deepStrictEqual(await store.transaction((tx) => tx.op(OWNER, "op-1")), first);
    // The same op id under another principal is a separate record, invisible to the first.
    const theirs = { ...second, principalId: "someone-else" };
    await store.transaction((tx) => tx.putOp(theirs));
    assert.deepStrictEqual(await store.transaction((tx) => tx.op("someone-else", "op-1")), theirs);
    assert.deepStrictEqual(await store.transaction((tx) => tx.op(OWNER, "op-1")), first);
    assert.equal(await store.transaction((tx) => tx.op("nobody", "op-1")), undefined);
    // Positive control: another op id is stored beside it.
    const other = opRecord("op-2", memory("m-second", SCOPE_A, 2));
    await store.transaction((tx) => tx.putOp(other));
    assert.deepStrictEqual(await store.transaction((tx) => tx.op(OWNER, "op-2")), other);
  });

  define(
    "a retried note returns the first outcome and stores one memory, even from a new relembra with another clock and ids",
    async (opened) => {
      const input = { ...NOTE_INPUT, opId: "op-retry" };
      const before = await storeNow(opened.store);
      const first = await core(opened.store, 1_000, "first").note(WRITER, input);
      const after = await storeNow(opened.store);

      // A later process: a fresh relembra whose clock and ids would produce other values.
      const retried = await core(opened.store, 9_000, "second").note(WRITER, input);

      assert.deepStrictEqual(retried, first);
      assert.equal(first.id, "first-memory-1");
      // The caller's time is kept as revision.at; a store with its own time accepts at that time.
      assert.equal(first.revision.at, 1_000);
      if (before === undefined || after === undefined) {
        assert.equal(first.notedAt, 1_000);
      } else {
        assert.ok(
          before <= first.notedAt && first.notedAt <= after,
          "accepted at the store's time, between two readings taken around the write",
        );
      }
      if (opened.reopen) {
        const reopened = await core(await opened.reopen(), 5_000, "third").note(WRITER, input);
        assert.deepStrictEqual(reopened, first);
      }
      assert.deepStrictEqual(ids(await opened.store.recall({ scopes: [SCOPE_A], limit: 10 })), [
        first.id,
      ]);
      // Positive control: another op id with the same payload is a new memory.
      await core(opened.store, 2_000, "fourth").note(WRITER, { ...input, opId: "op-other" });
      assert.equal((await opened.store.recall({ scopes: [SCOPE_A], limit: 10 })).length, 2);
    },
  );

  define(
    "the same op id with a different payload is refused and stores nothing new",
    async ({ store }) => {
      const relembra = core(store, 1_000, "first");
      const first = await relembra.note(WRITER, { ...NOTE_INPUT, opId: "op-1" });

      await assert.rejects(
        relembra.note(WRITER, { ...NOTE_INPUT, text: "A different fact.", opId: "op-1" }),
        { name: "OpConflictError" },
      );

      assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A], limit: 10 })), [first.id]);
      // Positive control: the original payload under the same op id is a replay.
      assert.deepStrictEqual(await relembra.note(WRITER, { ...NOTE_INPUT, opId: "op-1" }), first);
    },
  );

  define(
    "an op id belongs to its principal: another principal's write under it is a new operation",
    async ({ store }) => {
      const as = (principal: Principal, prefix: string) =>
        createRelembra<string>({
          store,
          policy: () => principal,
          clock: { now: () => 2_000 },
          ids: { memoryId: () => `${prefix}-memory`, opId: () => `${prefix}-op` },
        });
      const a = core(store, 1_000, "a");
      const fromA = await a.note(WRITER, { ...NOTE_INPUT, opId: "op-shared" });

      // B pre-claiming or reusing A's op id with another payload is not blocked.
      const b = as({ ...WRITER_PRINCIPAL, id: "conformance-b" }, "b");
      const input = { ...NOTE_INPUT, text: "B's own fact.", opId: "op-shared" };
      const fromB = await b.note(WRITER, input);
      assert.equal(fromB.id, "b-memory");
      assert.equal(fromB.revision.text, "B's own fact.");
      assert.deepStrictEqual(await b.note(WRITER, input), fromB, "B's retry replays B's outcome");

      // C sending A's exact payload under A's op id gets its own memory, never A's outcome.
      const c = as({ ...WRITER_PRINCIPAL, id: "conformance-c" }, "c");
      const probe = await c.note(WRITER, { ...NOTE_INPUT, opId: "op-shared" });
      assert.equal(probe.id, "c-memory");
      assert.notEqual(probe.notedAt, fromA.notedAt);

      // Positive control: A's retry still returns A's outcome.
      assert.deepStrictEqual(await a.note(WRITER, { ...NOTE_INPUT, opId: "op-shared" }), fromA);
      assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A], limit: 10 })), [
        probe.id,
        fromB.id,
        fromA.id,
      ]);
    },
  );

  define(
    "a fence epoch commits with its transaction and a rolled-back one is not kept",
    async ({ store }) => {
      const seenInside = await store.transaction(async (tx) => {
        assert.equal(await tx.fenceEpoch("lease"), undefined, "no epoch before one is put");
        await tx.putFence({ key: "lease", epoch: 3 });
        return tx.fenceEpoch("lease");
      });
      assert.equal(seenInside, 3, "an epoch is visible later in its transaction");
      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.putFence({ key: "lease", epoch: 9 });
          await tx.putFence({ key: "other", epoch: 9 });
          throw new Error("roll back");
        }),
      );

      assert.equal(await store.transaction((tx) => tx.fenceEpoch("lease")), 3);
      assert.equal(await store.transaction((tx) => tx.fenceEpoch("other")), undefined);
      // Positive control: the same epochs, committed, are kept, each under its own key.
      await store.transaction(async (tx) => {
        await tx.putFence({ key: "lease", epoch: 9 });
        await tx.putFence({ key: "other", epoch: 4 });
      });
      assert.equal(await store.transaction((tx) => tx.fenceEpoch("lease")), 9);
      assert.equal(await store.transaction((tx) => tx.fenceEpoch("other")), 4);
    },
  );

  define(
    "a paused writer whose fence epoch was advanced commits nothing, and the current writer commits",
    async (opened) => {
      const paused = fenced(opened.store, 1);
      const committed = await paused.note(WRITER, { ...NOTE_INPUT, opId: "op-before" });

      // The host takes over, from another handle when the store has one.
      const host = opened.reopen ? await opened.reopen() : opened.store;
      await advanceFence(host, { key: FENCE_KEY, epoch: 2 });

      await assert.rejects(paused.note(WRITER, { ...NOTE_INPUT, opId: "op-after" }), {
        name: "FencedError",
      });
      // Current authority beats replay: the stale writer's own committed op is refused too.
      await assert.rejects(paused.note(WRITER, { ...NOTE_INPUT, opId: "op-before" }), {
        name: "FencedError",
      });
      assert.deepStrictEqual(ids(await opened.store.recall({ scopes: [SCOPE_A], limit: 10 })), [
        committed.id,
      ]);

      // Positive control: the current writer commits, and replays the committed op.
      const current = fenced(host, 2);
      const fresh = await current.note(WRITER, { ...NOTE_INPUT, opId: "op-after" });
      assert.deepStrictEqual(
        await current.note(WRITER, { ...NOTE_INPUT, opId: "op-before" }),
        committed,
      );
      assert.deepStrictEqual(ids(await opened.store.recall({ scopes: [SCOPE_A], limit: 10 })), [
        fresh.id,
        committed.id,
      ]);
    },
  );

  define(
    "advancing a fence never lowers it, and a write's epoch advances it",
    async ({ store }) => {
      await advanceFence(store, { key: FENCE_KEY, epoch: 5 });

      await assert.rejects(advanceFence(store, { key: FENCE_KEY, epoch: 4 }), {
        name: "FencedError",
      });
      // The same epoch again is accepted, so a host may retry its takeover.
      await advanceFence(store, { key: FENCE_KEY, epoch: 5 });
      // Another key keeps its own epoch.
      await advanceFence(store, { key: "another-lease", epoch: 1 });

      // A write with a higher epoch than the store holds commits and raises the epoch.
      await fenced(store, 7).note(WRITER, { ...NOTE_INPUT, opId: "op-7" });
      await assert.rejects(advanceFence(store, { key: FENCE_KEY, epoch: 6 }), {
        name: "FencedError",
      });
      await assert.rejects(fenced(store, 6).note(WRITER, { ...NOTE_INPUT, opId: "op-6" }), {
        name: "FencedError",
      });
      assert.equal((await store.recall({ scopes: [SCOPE_A], limit: 10 })).length, 1);
    },
  );

  define(
    "a memory's status, replacement and summary sources survive the round trip",
    async ({ store }) => {
      const live = memory("m-live", SCOPE_A, 1);
      const retracted = memory("m-retracted", SCOPE_A, 2, { status: "retracted" });
      const superseded = memory("m-superseded", SCOPE_A, 3, {
        status: "superseded",
        supersededBy: "m-live",
      });
      const summary = memory("m-summary", SCOPE_A, 4, {
        sources: [
          { memoryId: "m-live", revision: 1 },
          { memoryId: "m-retracted", revision: 1 },
        ],
      });
      for (const noted of [live, retracted, superseded, summary]) await commit(store, noted);

      const read = await store.transaction(async (tx) => ({
        live: await tx.memory("m-live"),
        retracted: await tx.memory("m-retracted"),
        superseded: await tx.memory("m-superseded"),
        summary: await tx.memory("m-summary"),
        unknown: await tx.memory("m-unknown"),
      }));
      assert.deepStrictEqual(read, { live, retracted, superseded, summary, unknown: undefined });
      // The live summary is served with its sources.
      assert.deepStrictEqual(byId(await store.liveMemories({ scopes: [SCOPE_A] })), [
        live,
        summary,
      ]);
    },
  );

  define(
    "tx.memory reads a memory written earlier in its transaction, and nothing it rolled back",
    async ({ store }) => {
      const original = memory("m-1", SCOPE_A, 1);
      await commit(store, original);
      const retracted: Memory = { ...original, status: "retracted" };

      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.putMemory(retracted);
          await tx.putMemory(memory("m-2", SCOPE_A, 2));
          assert.deepStrictEqual(await tx.memory("m-1"), retracted);
          assert.deepStrictEqual(await tx.memory("m-2"), memory("m-2", SCOPE_A, 2));
          throw new Error("roll back");
        }),
        { message: "roll back" },
      );

      // Positive control: the committed memory is read unchanged, and the rolled-back one is gone.
      assert.deepStrictEqual(await store.transaction((tx) => tx.memory("m-1")), original);
      assert.equal(await store.transaction((tx) => tx.memory("m-2")), undefined);
    },
  );

  define("liveMemories and recall serve only live memories", async ({ store }) => {
    const live = memory("m-live", SCOPE_A, 1);
    const retracted = memory("m-retracted", SCOPE_A, 2, { status: "retracted" });
    const superseded = memory("m-superseded", SCOPE_A, 3, {
      status: "superseded",
      supersededBy: "m-live",
    });
    for (const noted of [live, retracted, superseded]) await commit(store, noted);

    assert.deepStrictEqual(await store.liveMemories({ scopes: [SCOPE_A] }), [live]);
    assert.deepStrictEqual(await store.recall({ scopes: [SCOPE_A], limit: 10 }), [live]);

    // Positive control: the same memories put back as live are served again.
    await commit(store, { ...retracted, status: "live" });
    await commit(store, memory("m-superseded", SCOPE_A, 3));
    assert.deepStrictEqual(ids(await store.recall({ scopes: [SCOPE_A], limit: 10 })), [
      "m-superseded",
      "m-retracted",
      "m-live",
    ]);
    assert.equal((await store.liveMemories({ scopes: [SCOPE_A] })).length, 3);
  });

  define(
    "recall returns retracted memories, marked, only in the scopes it names as retracted",
    async ({ store }) => {
      const liveA = memory("m-live-a", SCOPE_A, 1);
      const retractedA = memory("m-retracted-a", SCOPE_A, 2, { status: "retracted" });
      const retractedB = memory("m-retracted-b", SCOPE_B, 3, { status: "retracted" });
      const supersededA = memory("m-superseded-a", SCOPE_A, 4, {
        status: "superseded",
        supersededBy: "m-live-a",
      });
      for (const noted of [liveA, retractedA, retractedB, supersededA]) await commit(store, noted);
      const both = [SCOPE_A, SCOPE_B];

      assert.deepStrictEqual(
        await store.recall({ scopes: both, limit: 10, retracted: [SCOPE_A] }),
        [retractedA, liveA],
      );
      assert.deepStrictEqual(
        await store.recall({ scopes: both, limit: 10, retracted: [SCOPE_B] }),
        [retractedB, liveA],
      );
      // A retracted scope outside the read scopes adds nothing.
      assert.deepStrictEqual(
        await store.recall({ scopes: [SCOPE_A], limit: 10, retracted: [SCOPE_B] }),
        [liveA],
      );
      assert.deepStrictEqual(await store.recall({ scopes: both, limit: 10, retracted: [] }), [
        liveA,
      ]);
      // The limit counts the retracted memories it returns.
      assert.deepStrictEqual(
        await store.recall({ scopes: both, limit: 1, retracted: [SCOPE_A, SCOPE_B] }),
        [retractedB],
      );
    },
  );

  define(
    "wake and brief render the store's memories with their pinned flag and trust, the same from every handle",
    async (opened) => {
      const writer = renderer(opened.store);
      await writer.note(RENDER, {
        ...RENDER_NOTE,
        text: "Pinned rule.",
        pinned: true,
        trust: "owner",
      });
      await writer.note(RENDER, { ...RENDER_NOTE, text: "Deploys run from the release branch." });
      await writer.note(RENDER, {
        ...RENDER_NOTE,
        text: "Copied from a web page.",
        trust: "untrusted",
      });
      await writer.note(RENDER, { ...RENDER_NOTE, scope: SCOPE_B, text: "Only in scope B." });
      const line = (id: string, second: number, trust: Trust, text: string) =>
        `<memory id="${id}" scope="${SCOPE_A}" rev="1" at="1970-01-01T00:00:0${second}.000Z" trust="${trust}">${text}</memory>`;
      const expectedWake = [
        "<wake>",
        line("render-memory-1", 1, "owner", "Pinned rule."),
        line("render-memory-2", 2, "agent", "Deploys run from the release branch."),
        line("render-memory-3", 3, "untrusted", "Copied from a web page."),
        "</wake>",
      ].join("\n");
      const expectedBrief = [
        "<brief>",
        line("render-memory-2", 2, "agent", "Deploys run from the release branch."),
        "</brief>",
      ].join("\n");

      const handles = [opened.store, ...(opened.reopen ? [await opened.reopen()] : [])];
      for (const handle of handles) {
        const reader = renderer(handle);
        assert.equal((await reader.wake(RENDER)).text, expectedWake);
        assert.equal((await reader.brief(RENDER, { topic: "release branch" })).text, expectedBrief);
      }
      // Positive control: the scope-B memory is there for a reader of scope B.
      const scopeB = await opened.store.liveMemories({ scopes: [SCOPE_B] });
      assert.deepStrictEqual(ids(scopeB), ["render-memory-4"]);
    },
  );

  define(
    "a retracted memory vanishes from find, recall, wake and brief, and its owner's recall shows it marked",
    async (opened) => {
      const relembra = curator(opened.store);
      const kept = await relembra.note(WRITER, {
        ...NOTE_INPUT,
        text: "Deploys use the release branch.",
      });
      const hidden = await relembra.note(WRITER, {
        ...NOTE_INPUT,
        text: "Deploys pause on Fridays.",
      });
      const served = async (context: string) => ({
        recall: ids(await relembra.recall(context)),
        find: (await relembra.find(context, { query: "deploys" })).map((r) => r.memory.id).sort(),
        wake: [...(await relembra.wake(context)).memoryIds].sort(),
        brief: [...(await relembra.brief(context, { topic: "deploys" })).memoryIds].sort(),
      });
      // Positive control: before the retraction both memories are served everywhere.
      const both = [kept.id, hidden.id].sort();
      assert.deepStrictEqual(await served(WRITER), {
        recall: [hidden.id, kept.id],
        find: both,
        wake: both,
        brief: both,
      });

      await relembra.retract(CURATOR, { memoryId: hidden.id });
      // A repeat is the same retraction: it succeeds and records nothing more.
      await relembra.retract(CURATOR, { memoryId: hidden.id });

      for (const context of [WRITER, CURATOR]) {
        assert.deepStrictEqual(await served(context), {
          recall: [kept.id],
          find: [kept.id],
          wake: [kept.id],
          brief: [kept.id],
        });
      }
      const handles = [opened.store, ...(opened.reopen ? [await opened.reopen()] : [])];
      for (const handle of handles) {
        assert.deepStrictEqual(await curator(handle).recall(CURATOR, { includeRetracted: true }), [
          { ...hidden, status: "retracted" },
          kept,
        ]);
      }
      if (opened.inspectEvents) {
        const retracts = (await opened.inspectEvents()).filter((e) => e.kind === "retract");
        assert.deepStrictEqual(
          retracts.map(({ seq: _seq, ...event }) => event),
          [
            {
              format: 1,
              kind: "retract",
              memoryId: hidden.id,
              scope: SCOPE_A,
              principalId: CURATOR_PRINCIPAL.id,
            },
          ],
        );
      }
    },
  );

  define(
    "a redacted memory's text is gone from every view, derived summary, event, op record and stored byte, while a planted copy is found",
    async (opened) => {
      if (target.durable) assert.ok(opened.rawBytes, "a durable target provides rawBytes");
      const relembra = curator(opened.store);
      const secret = "Planted secret: the vault opens with amber-falcon-41.";
      const summaryText = "Summary of the vault rules, marker summary-heron-77.";
      const victim = await relembra.note(WRITER, {
        ...NOTE_INPUT,
        text: secret,
        opId: "op-target",
      });
      const copy = await relembra.note(WRITER, { ...NOTE_INPUT, text: secret, opId: "op-copy" });
      const kept = await relembra.note(WRITER, { ...NOTE_INPUT, text: "The vault is in room 4." });
      const summary = memory("m-summary", SCOPE_A, 9, {
        text: summaryText,
        sources: [
          { memoryId: victim.id, revision: 1 },
          { memoryId: kept.id, revision: 1 },
        ],
      });
      await commit(opened.store, summary);
      const fingerprint = (
        await opened.store.transaction((tx) => tx.op(WRITER_PRINCIPAL.id, "op-target"))
      )?.fingerprint;
      assert.ok(fingerprint, "a committed note keeps its fingerprint");

      /** Every place the text could be: views for the writer and the owner, events, bytes. */
      const surfaces = async () => {
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const views = [
          await relembra.recall(WRITER),
          await relembra.recall(CURATOR, { includeRetracted: true }),
          await relembra.find(WRITER, { query: "vault amber falcon summary heron" }),
          (await relembra.wake(WRITER)).text,
          (await relembra.brief(WRITER, { topic: "vault amber falcon summary heron" })).text,
          await opened.store.liveMemories({ scopes: [SCOPE_A] }),
        ];
        return [
          JSON.stringify(views),
          JSON.stringify(await opened.inspectEvents?.()) ?? "",
          opened.rawBytes ? decoder.decode(await opened.rawBytes()) : "",
        ];
      };
      const holds = (texts: string[], needle: string) =>
        texts.some((text) => text.includes(needle));
      /** Whether any 16-character piece of `needle` (at 8-character steps) survives anywhere. */
      const holdsAny = (texts: string[], needle: string) => {
        for (let at = 0; at + 16 <= needle.length; at += 8) {
          if (holds(texts, needle.slice(at, at + 16))) return true;
        }
        return false;
      };

      // Positive control: before any redaction the scan finds both texts on every surface.
      for (const text of await surfaces()) {
        if (text === "") continue;
        assert.ok(text.includes(secret), "the scan sees the secret before redaction");
        assert.ok(text.includes(summaryText), "the scan sees the summary before redaction");
      }
      if (opened.rawBytes) {
        assert.ok(holds(await surfaces(), fingerprint), "the stored bytes hold the fingerprint");
      }

      const redaction = await relembra.redact(CURATOR, { memoryId: victim.id });
      assert.deepStrictEqual(redaction, { redacted: [victim.id], derived: [summary.id] });

      // The planted copy still holds the same text, and the scan still finds it.
      assert.ok(holds(await surfaces(), secret), "the planted copy is found");
      assert.ok(!holdsAny(await surfaces(), summaryText), "the derived summary is gone");
      assert.deepStrictEqual(ids(await relembra.recall(WRITER)), [kept.id, copy.id]);

      await relembra.redact(CURATOR, { memoryId: copy.id });
      const after = await surfaces();
      assert.ok(!holdsAny(after, secret), "no surface holds any piece of the redacted text");
      assert.ok(!holdsAny(after, summaryText), "no surface holds any piece of the summary text");
      assert.ok(!holds(after, fingerprint), "no surface holds the scrubbed fingerprint");
      assert.deepStrictEqual(ids(await relembra.recall(WRITER)), [kept.id]);

      const state = await opened.store.transaction(async (tx) => ({
        victim: await tx.memory(victim.id),
        summary: await tx.memory(summary.id),
        op: await tx.op(WRITER_PRINCIPAL.id, "op-target"),
      }));
      const erasures = await opened.store.erasures();
      assert.deepStrictEqual(
        erasures.map((work) => [work.memoryId, work.carriers]),
        [
          [victim.id, []],
          [summary.id, []],
          [copy.id, []],
        ],
      );
      const [victimWork, summaryWork] = erasures;
      assert.deepStrictEqual(state, {
        victim: { id: victim.id, scope: SCOPE_A, seq: victimWork?.seq, status: "redacted" },
        summary: { id: summary.id, scope: SCOPE_A, seq: summaryWork?.seq, status: "redacted" },
        op: {
          principalId: WRITER_PRINCIPAL.id,
          opId: "op-target",
          memoryId: victim.id,
          at: victim.notedAt,
          seq: victim.seq,
        },
      });
      if (opened.inspectEvents) {
        const events = await opened.inspectEvents();
        const redacts = events.filter((e) => e.kind === "redact");
        assert.deepStrictEqual(
          redacts.map(({ seq: _seq, ...event }) => event),
          [
            {
              format: 1,
              kind: "redact",
              memoryId: victim.id,
              scope: SCOPE_A,
              cause: "request",
              principalId: CURATOR_PRINCIPAL.id,
            },
            {
              format: 1,
              kind: "redact",
              memoryId: summary.id,
              scope: SCOPE_A,
              cause: "source",
              principalId: CURATOR_PRINCIPAL.id,
            },
            {
              format: 1,
              kind: "redact",
              memoryId: copy.id,
              scope: SCOPE_A,
              cause: "request",
              principalId: CURATOR_PRINCIPAL.id,
            },
          ],
        );
        const note = events.find((e) => e.kind === "note" && e.memoryId === victim.id);
        assert.deepStrictEqual(note, {
          format: 1,
          kind: "note",
          seq: victim.seq,
          memoryId: victim.id,
          scope: SCOPE_A,
          principalId: WRITER_PRINCIPAL.id,
          pinned: false,
          redacted: true,
        });
      }
    },
  );

  define(
    "a retried note whose memory was redacted gets a terminal redacted outcome, whatever its payload",
    async (opened) => {
      const relembra = curator(opened.store);
      const input = { ...NOTE_INPUT, text: "Erased later.", opId: "op-erased" };
      const noted = await relembra.note(WRITER, input);
      // Positive control: before redaction a different payload is a conflict, the same a replay.
      await assert.rejects(relembra.note(WRITER, { ...input, text: "Another fact." }), {
        name: "OpConflictError",
      });
      assert.deepStrictEqual(await relembra.note(WRITER, input), noted);

      await relembra.redact(CURATOR, { memoryId: noted.id });

      const handles = [opened.store, ...(opened.reopen ? [await opened.reopen()] : [])];
      for (const handle of handles) {
        for (const retry of [input, { ...input, text: "Another fact." }]) {
          const error = await curator(handle)
            .note(WRITER, retry)
            .then(
              () => assert.fail("a retry after redaction must not succeed"),
              (caught: unknown) => caught,
            );
          assert.ok(error instanceof Error && error.name === "MemoryRedactedError");
          assert.equal((error as Error & { memoryId?: string }).memoryId, noted.id);
          assert.ok(!JSON.stringify({ ...error, message: error.message }).includes("Erased later"));
        }
      }
      assert.deepStrictEqual(await opened.store.recall({ scopes: [SCOPE_A], limit: 10 }), []);
    },
  );

  define(
    "a redaction that rolls back leaves the memory, its events and op record whole, and no outbox row",
    async (opened) => {
      const relembra = curator(opened.store);
      const noted = await relembra.note(WRITER, { ...NOTE_INPUT, opId: "op-kept" });
      const record = await opened.store.transaction((tx) => tx.op(WRITER_PRINCIPAL.id, "op-kept"));
      const eventsBefore = await opened.inspectEvents?.();

      await assert.rejects(
        opened.store.transaction(async (tx) => {
          await tx.redact({ id: noted.id, scope: SCOPE_A, seq: 99, status: "redacted" });
          await tx.putErasure({ seq: 99, memoryId: noted.id, carriers: [] });
          throw new Error("roll back");
        }),
        { message: "roll back" },
      );

      assert.deepStrictEqual(await opened.store.erasures(), []);
      assert.deepStrictEqual(await opened.store.transaction((tx) => tx.memory(noted.id)), noted);
      assert.deepStrictEqual(
        await opened.store.transaction((tx) => tx.op(WRITER_PRINCIPAL.id, "op-kept")),
        record,
      );
      assert.deepStrictEqual(await opened.inspectEvents?.(), eventsBefore);

      // Positive control: the same redaction, committed, leaves a tombstone and one outbox row.
      const redaction = await relembra.redact(CURATOR, { memoryId: noted.id });
      assert.deepStrictEqual(redaction, { redacted: [noted.id], derived: [] });
      assert.deepStrictEqual(
        (await opened.store.erasures()).map((work) => work.memoryId),
        [noted.id],
      );
      // A repeat is the same redaction: nothing more is redacted or queued.
      assert.deepStrictEqual(await relembra.redact(CURATOR, { memoryId: noted.id }), {
        redacted: [],
        derived: [],
      });
      assert.equal((await opened.store.erasures()).length, 1);
    },
  );

  define("retracting a memory retracts the summaries derived from it", async ({ store }) => {
    const relembra = curator(store);
    const source = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Source fact." });
    const other = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Unrelated fact." });
    const summary = memory("m-summary", SCOPE_A, 9, {
      text: "Summary of the source.",
      sources: [{ memoryId: source.id, revision: 1 }],
    });
    const unrelated = memory("m-unrelated-summary", SCOPE_A, 10, {
      text: "Summary of the unrelated fact.",
      sources: [{ memoryId: other.id, revision: 1 }],
    });
    await commit(store, summary);
    await commit(store, unrelated);

    await relembra.retract(CURATOR, { memoryId: source.id });

    // Positive control: the summary of the other memory is still served.
    assert.deepStrictEqual(ids(await relembra.recall(WRITER)), [unrelated.id, other.id]);
    assert.deepStrictEqual(
      (await relembra.recall(CURATOR, { includeRetracted: true })).map((m) => [m.id, m.status]),
      [
        [unrelated.id, "live"],
        [summary.id, "retracted"],
        [other.id, "live"],
        [source.id, "retracted"],
      ],
    );
  });

  define(
    "a superseded memory stops being served and its replacement is, along a chain, and a retried supersede returns the first replacement",
    async (opened) => {
      const relembra = curator(opened.store);
      const first = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Deploys run on Mondays." });
      const second = await relembra.supersede(CURATOR, {
        memoryId: first.id,
        text: "Deploys run on Tuesdays.",
        provenance: NOTE_INPUT.provenance,
        opId: "op-second",
      });
      const third = await relembra.supersede(CURATOR, {
        memoryId: second.id,
        text: "Deploys run on Wednesdays.",
        provenance: NOTE_INPUT.provenance,
        opId: "op-third",
      });

      assert.equal(second.scope, SCOPE_A);
      assert.equal(second.revision.text, "Deploys run on Tuesdays.");
      const served = async (handle: Store) => {
        const reader = curator(handle);
        return {
          recall: ids(await reader.recall(WRITER)),
          find: (await reader.find(WRITER, { query: "deploys" })).map((r) => r.memory.id),
          wake: (await reader.wake(WRITER)).memoryIds,
          brief: (await reader.brief(WRITER, { topic: "deploys" })).memoryIds,
        };
      };
      const handles = [opened.store, ...(opened.reopen ? [await opened.reopen()] : [])];
      for (const handle of handles) {
        assert.deepStrictEqual(await served(handle), {
          recall: [third.id],
          find: [third.id],
          wake: [third.id],
          brief: [third.id],
        });
        // A retried supersede, from a new relembra on any handle, returns the first replacement.
        const retried = await curator(handle).supersede(CURATOR, {
          memoryId: first.id,
          text: "Deploys run on Tuesdays.",
          provenance: NOTE_INPUT.provenance,
          opId: "op-second",
        });
        assert.deepStrictEqual(retried, second);
      }
      const stored = await opened.store.transaction(async (tx) => [
        await tx.memory(first.id),
        await tx.memory(second.id),
      ]);
      assert.deepStrictEqual(stored, [
        { ...first, status: "superseded", supersededBy: second.id },
        { ...second, status: "superseded", supersededBy: third.id },
      ]);
      if (opened.inspectEvents) {
        const events = (await opened.inspectEvents()).map(({ seq: _seq, ...event }) => event);
        assert.deepStrictEqual(
          events.filter((e) => e.kind === "supersede"),
          [
            {
              format: 1,
              kind: "supersede",
              memoryId: first.id,
              scope: SCOPE_A,
              principalId: CURATOR_PRINCIPAL.id,
              by: second.id,
            },
            {
              format: 1,
              kind: "supersede",
              memoryId: second.id,
              scope: SCOPE_A,
              principalId: CURATOR_PRINCIPAL.id,
              by: third.id,
            },
          ],
        );
        assert.equal(events.filter((e) => e.kind === "note").length, 3);
      }
    },
  );

  define(
    "superseding a retracted or redacted memory is refused and writes nothing",
    async ({ store }) => {
      const relembra = curator(store);
      const retracted = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Retracted fact." });
      const redacted = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Redacted fact." });
      const live = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Live fact." });
      await relembra.retract(CURATOR, { memoryId: retracted.id });
      await relembra.redact(CURATOR, { memoryId: redacted.id });
      const replace = (context: string, memoryId: string) =>
        relembra.supersede(context, {
          memoryId,
          text: "A replacement.",
          provenance: NOTE_INPUT.provenance,
        });

      // A writer that does not own the scope cannot see either memory.
      for (const memoryId of [retracted.id, redacted.id]) {
        await assert.rejects(replace(WRITER, memoryId), { name: "MemoryNotFoundError" });
      }
      // The owner sees them, and the refusal names their status.
      await assert.rejects(replace(CURATOR, retracted.id), {
        name: "MemoryStateError",
        status: "retracted",
      });
      await assert.rejects(replace(CURATOR, redacted.id), {
        name: "MemoryStateError",
        status: "redacted",
      });
      assert.deepStrictEqual(ids(await relembra.recall(CURATOR, { includeRetracted: true })), [
        live.id,
        retracted.id,
      ]);

      // Positive control: the live memory is superseded.
      const replacement = await replace(CURATOR, live.id);
      assert.deepStrictEqual(ids(await relembra.recall(WRITER)), [replacement.id]);
    },
  );

  define(
    "superseding a summary is refused and writes nothing, so redacting its source still reaches every copy of its fact",
    async ({ store }) => {
      const relembra = curator(store);
      const secret = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Secret fact X." });
      const summary = await relembra.submitSummary(CURATOR, {
        scope: SCOPE_A,
        sources: [{ memoryId: secret.id, revision: 1 }],
        text: "Summary of X.",
        provenance: NOTE_INPUT.provenance,
      });

      await assert.rejects(
        relembra.supersede(CURATOR, {
          memoryId: summary.id,
          text: "Secret fact X, restated.",
          provenance: NOTE_INPUT.provenance,
          opId: "op-restate",
        }),
        { name: "SummarySupersedeError" },
      );
      assert.deepStrictEqual(await store.transaction((tx) => tx.memory(summary.id)), summary);

      await relembra.redact(CURATOR, { memoryId: secret.id });
      assert.deepStrictEqual(await relembra.recall(CURATOR, { includeRetracted: true }), []);
      // The refused supersede left no op record to replay.
      await assert.rejects(
        relembra.supersede(CURATOR, {
          memoryId: summary.id,
          text: "Secret fact X, restated.",
          provenance: NOTE_INPUT.provenance,
          opId: "op-restate",
        }),
        { name: "MemoryStateError", status: "redacted" },
      );
    },
  );

  define(
    "superseding a pinned memory needs pin rights, and one above the principal's trust ceiling is refused, writing nothing",
    async ({ store }) => {
      const relembra = curator(store);
      const ownerProvenance = { ...NOTE_INPUT.provenance, trust: "owner" as const };
      // At agent trust, so only the pin is above what the reviser may displace.
      const rule = await relembra.note(CURATOR, {
        ...NOTE_INPUT,
        text: "Never deploy on Fridays.",
        pinned: true,
      });
      const reviewed = await relembra.note(CURATOR, {
        ...NOTE_INPUT,
        text: "Owner-reviewed fact.",
        provenance: ownerProvenance,
      });
      const replace = (context: string, memoryId: string, more = {}) =>
        relembra.supersede(context, {
          memoryId,
          text: "A replacement.",
          provenance: NOTE_INPUT.provenance,
          ...more,
        });

      await assert.rejects(replace(REVISER, rule.id), { name: "ScopeDeniedError", access: "pin" });
      await assert.rejects(replace(REVISER, reviewed.id), {
        name: "ProvenanceError",
        field: "trust",
        rule: "above-ceiling",
      });
      assert.deepStrictEqual(ids(await relembra.recall(WRITER)), [reviewed.id, rule.id]);

      // Positive control: the owner supersedes its own pinned rule.
      const replacement = await replace(CURATOR, rule.id, { pinned: true });
      assert.deepStrictEqual(
        (await relembra.recall(WRITER)).map((m) => [m.id, m.pinned]),
        [
          [replacement.id, true],
          [reviewed.id, false],
        ],
      );
    },
  );

  define("superseding a memory retracts the summaries derived from it", async ({ store }) => {
    const relembra = curator(store);
    const source = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Source fact." });
    const other = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Unrelated fact." });
    const summary = memory("m-summary", SCOPE_A, 9, {
      text: "Summary of the source.",
      sources: [{ memoryId: source.id, revision: 1 }],
    });
    const unrelated = memory("m-unrelated-summary", SCOPE_A, 10, {
      text: "Summary of the unrelated fact.",
      sources: [{ memoryId: other.id, revision: 1 }],
    });
    await commit(store, summary);
    await commit(store, unrelated);

    const replacement = await relembra.supersede(CURATOR, {
      memoryId: source.id,
      text: "Source fact, corrected.",
      provenance: NOTE_INPUT.provenance,
    });

    // Positive control: the summary of the other memory is still served.
    assert.deepStrictEqual(ids(await relembra.recall(WRITER)), [
      replacement.id,
      unrelated.id,
      other.id,
    ]);
    assert.deepStrictEqual(
      (await relembra.recall(CURATOR, { includeRetracted: true })).map((m) => [m.id, m.status]),
      [
        [replacement.id, "live"],
        [unrelated.id, "live"],
        [summary.id, "retracted"],
        [other.id, "live"],
      ],
    );
  });

  define(
    "pending lists live, unpinned, unsummarized memories oldest first, and a submitted summary covers its sources",
    async (opened) => {
      const relembra = curator(opened.store);
      const a = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Builds use Bun." });
      const b = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Tests run with bun test." });
      await relembra.note(CURATOR, { ...NOTE_INPUT, text: "Always lint.", pinned: true });
      const c = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Lint with Biome." });

      assert.deepStrictEqual(ids(await relembra.pending(WRITER)), [a.id, b.id, c.id]);
      const input = {
        scope: SCOPE_A,
        sources: [
          { memoryId: b.id, revision: 1 },
          { memoryId: a.id, revision: 1 },
        ],
        text: "The toolchain is Bun, tests included.",
        provenance: NOTE_INPUT.provenance,
        opId: "op-summary",
      };
      const summary = await relembra.submitSummary(WRITER, input);

      assert.deepStrictEqual(summary.sources, [
        { memoryId: a.id, revision: 1 },
        { memoryId: b.id, revision: 1 },
      ]);
      assert.equal(summary.scope, SCOPE_A);
      assert.equal(summary.pinned, false);
      assert.equal(summary.status, "live");
      assert.equal(summary.revision.text, input.text);
      assert.deepStrictEqual(ids(await relembra.pending(WRITER)), [c.id]);
      const handles = [opened.store, ...(opened.reopen ? [await opened.reopen()] : [])];
      for (const handle of handles) {
        assert.deepStrictEqual(await curator(handle).submitSummary(WRITER, input), summary);
        assert.deepStrictEqual(await handle.transaction((tx) => tx.memory(summary.id)), summary);
      }
      if (opened.inspectEvents) {
        const summarize = (await opened.inspectEvents()).filter((e) => e.kind === "summarize");
        assert.deepStrictEqual(summarize, [
          {
            format: 1,
            kind: "summarize",
            seq: summary.seq,
            memoryId: summary.id,
            scope: SCOPE_A,
            principalId: WRITER_PRINCIPAL.id,
            sources: summary.sources,
            revision: summary.revision,
          },
        ]);
      }
      // Only a live summary covers: retracting it makes its sources due again.
      await relembra.retract(CURATOR, { memoryId: summary.id });
      assert.deepStrictEqual(ids(await relembra.pending(WRITER)), [a.id, b.id, c.id]);
    },
  );

  define(
    "submitSummary is refused when a source revision changed since it was read, and writes nothing",
    async ({ store }) => {
      const relembra = curator(store);
      const a = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Fact A." });
      const b = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Fact B." });
      const c = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Fact C." });
      const read = await relembra.pending(WRITER);
      const submit = (sources: readonly Memory[], revision = 1, context = WRITER) =>
        relembra.submitSummary(context, {
          scope: SCOPE_A,
          sources: sources.map((m) => ({ memoryId: m.id, revision })),
          text: "A summary.",
          provenance: NOTE_INPUT.provenance,
        });
      assert.deepStrictEqual(ids(read), [a.id, b.id, c.id]);

      // b is superseded, c retracted, and a gets a new revision, all after pending().
      await relembra.supersede(CURATOR, {
        memoryId: b.id,
        text: "Fact B, corrected.",
        provenance: NOTE_INPUT.provenance,
      });
      await relembra.retract(CURATOR, { memoryId: c.id });
      const revised: Memory = {
        ...a,
        revision: { ...a.revision, number: 2, text: "Fact A, revised." },
      };
      await store.transaction((tx) => tx.putMemory(revised));

      // The owner sees every source, so it learns which changed.
      for (const stale of [[a], [b], [c], [a, b]]) {
        await assert.rejects(submit(stale, 1, CURATOR), { name: "SourceChangedError" });
      }
      // A reader that does not own the scope sees live memories only: a is live at another
      // revision, while the superseded b and the retracted c do not exist for it.
      await assert.rejects(submit([a]), { name: "SourceChangedError" });
      for (const gone of [[b], [c]]) {
        await assert.rejects(submit(gone), { name: "MemoryNotFoundError" });
      }
      const before = ids(await relembra.recall(CURATOR, { includeRetracted: true }));
      assert.equal(before.length, 3);
      // Positive control: the current revision of a is accepted.
      const summary = await submit([a], 2);
      assert.deepStrictEqual(summary.sources, [{ memoryId: a.id, revision: 2 }]);
      assert.deepStrictEqual(ids(await relembra.recall(CURATOR, { includeRetracted: true })), [
        summary.id,
        ...before,
      ]);
    },
  );

  define("a summary's trust is the least of its sources' trust", async ({ store }) => {
    const relembra = curator(store);
    const write = (text: string, trust: Trust) =>
      relembra.note(CURATOR, {
        ...NOTE_INPUT,
        text,
        provenance: { ...NOTE_INPUT.provenance, trust },
      });
    const owned = await write("Owner fact.", "owner");
    const agent = await write("Agent fact.", "agent");
    const external = await write("External fact.", "untrusted");
    const summarize = (sources: readonly Memory[], trust?: Trust) =>
      relembra.submitSummary(CURATOR, {
        scope: SCOPE_A,
        sources: sources.map((m) => ({ memoryId: m.id, revision: 1 })),
        text: "A summary.",
        provenance:
          trust === undefined ? NOTE_INPUT.provenance : { ...NOTE_INPUT.provenance, trust },
      });
    const trustOf = (m: Memory) => m.revision.provenance.trust;

    assert.equal(trustOf(await summarize([owned], "owner")), "owner");
    await assert.rejects(summarize([owned, agent], "owner"), {
      name: "ProvenanceError",
      rule: "above-sources",
    });
    assert.equal(trustOf(await summarize([owned, agent])), "agent");
    assert.equal(trustOf(await summarize([owned, external])), "untrusted");
    assert.equal(trustOf(await summarize([agent, external])), "untrusted");
    // A summary may lower its trust below its sources', never raise it above them.
    assert.equal(trustOf(await summarize([owned], "untrusted")), "untrusted");
    await assert.rejects(summarize([owned, external], "agent"), {
      name: "ProvenanceError",
      field: "trust",
      rule: "above-sources",
    });
  });

  define(
    "summaries fill the wake's slot after recent memories and the brief's after its results",
    async (opened) => {
      const relembra = curator(opened.store);
      const a = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Deploys use tags." });
      const b = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Deploys pause on Fridays." });
      const c = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Lint with Biome." });
      const summary = await relembra.submitSummary(WRITER, {
        scope: SCOPE_A,
        sources: [
          { memoryId: a.id, revision: 1 },
          { memoryId: b.id, revision: 1 },
        ],
        text: "Release rules: tags, never on Fridays.",
        provenance: NOTE_INPUT.provenance,
      });

      const handles = [opened.store, ...(opened.reopen ? [await opened.reopen()] : [])];
      for (const handle of handles) {
        const reader = curator(handle);
        // Wake: recent memories no summary covers, then summaries, then the covered sources.
        assert.deepStrictEqual((await reader.wake(WRITER)).memoryIds, [
          c.id,
          summary.id,
          b.id,
          a.id,
        ]);
        // Brief: the ranked results, then the summaries that cover them.
        assert.deepStrictEqual((await reader.brief(WRITER, { topic: "fridays" })).memoryIds, [
          b.id,
          summary.id,
        ]);
      }
    },
  );

  define(
    "sweep redacts exactly the memories older than their scope's maxAgeDays, with the summaries derived from them, and reports them",
    async (opened) => {
      const { store } = opened;
      const DAY = 86_400_000;
      // A store with its own time counts from that time, which moves on while the case runs: the
      // kept memory is then an hour inside the boundary, and the exact boundary (kept at 30 days,
      // expired a millisecond later) is proven only where the case sets the time.
      const timed = await storeNow(store);
      const now = timed ?? 400 * DAY;
      const boundary = now - 30 * DAY;
      const kept = memory("m-kept", SCOPE_A, timed === undefined ? boundary : boundary + HOUR);
      const expired = memory("m-expired", SCOPE_A, boundary - 1);
      const pinned = memory("m-pinned", SCOPE_A, boundary - DAY, { pinned: true });
      const retracted = memory("m-retracted", SCOPE_A, boundary - 2 * DAY, {
        status: "retracted",
      });
      // Young itself, but it carries the expired memory's fact.
      const summary = memory("m-summary", SCOPE_A, boundary + DAY, {
        sources: [{ memoryId: expired.id, revision: 1 }],
      });
      // Ancient, in a scope with no rule.
      const elsewhere = memory("m-elsewhere", SCOPE_B, 1);
      const all = [kept, expired, pinned, retracted, summary, elsewhere];
      for (const m of all) await commit(store, m);
      const relembra = createRelembra<string>({
        store,
        policy: () => CURATOR_PRINCIPAL,
        retention: [{ scope: SCOPE_A, maxAgeDays: 30 }],
      });

      const report = await relembra.sweep(now);

      assert.deepStrictEqual(
        { redacted: [...report.redacted].sort(), derived: report.derived },
        { redacted: [expired.id, pinned.id, retracted.id].sort(), derived: [summary.id] },
      );
      const statuses = await store.transaction(async (tx) => {
        const found: [string, string | undefined][] = [];
        for (const m of all) found.push([m.id, (await tx.memory(m.id))?.status]);
        return found;
      });
      assert.deepStrictEqual(statuses, [
        [kept.id, "live"],
        [expired.id, "redacted"],
        [pinned.id, "redacted"],
        [retracted.id, "redacted"],
        [summary.id, "redacted"],
        [elsewhere.id, "live"],
      ]);
      if (opened.inspectEvents) {
        const redactions = (await opened.inspectEvents())
          .filter((e) => e.kind === "redact")
          .map((e) => (e.kind === "redact" ? [e.memoryId, e.cause, e.principalId] : []));
        assert.deepStrictEqual(
          [...redactions].sort(),
          [
            [expired.id, "retention", null],
            [pinned.id, "retention", null],
            [retracted.id, "retention", null],
            [summary.id, "source", null],
          ].sort(),
        );
      }
      assert.equal((await store.erasures()).length, 4);
      // A second sweep at the same time finds nothing; a millisecond later, the boundary expires.
      assert.deepStrictEqual(await relembra.sweep(now), { redacted: [], derived: [] });
      if (timed === undefined) {
        assert.deepStrictEqual(await relembra.sweep(now + 1), { redacted: [kept.id], derived: [] });
      }
    },
  );

  define(
    "findByTerms reads N, lengths and term counts over the live memories of the scopes asked, and loads what was chosen, in order",
    async ({ store }) => {
      // Lengths and counts worked out by hand from docs/specs/ranking-algorithm.md §2–§4.
      const agents = memory("m-agents", SCOPE_A, 1, { text: "Agents deploy the agent." });
      const does = memory("m-does", SCOPE_A, 2, { text: "Does the dao run? The does." });
      const empty = memory("m-empty", SCOPE_A, 3, { text: "!! ?" });
      const retracted = memory("m-retracted", SCOPE_A, 4, {
        text: "Agents agents.",
        status: "retracted",
      });
      const superseded = memory("m-superseded", SCOPE_A, 5, {
        text: "The agent dao.",
        status: "superseded",
        supersededBy: "m-agents",
      });
      const later = memory("m-later", SCOPE_A, 6, { text: "Agent dao." });
      const inB = memory("m-b", SCOPE_B, 7, { text: "Agent in scope b." });
      for (const m of [agents, does, empty, retracted, superseded, later, inB]) {
        await commit(store, m);
      }
      // Live when first put, retracted since: the index must follow the change.
      await store.transaction((tx) => tx.putMemory({ ...later, status: "retracted" }));

      const terms = [
        { exact: "agent", stem: "agent" },
        { exact: "dao", stem: "dao" },
      ];
      const read = (scopes: readonly Scope[]) => indexRead(store, scopes, terms);
      const none = { all: 0, kept: 0 };
      const posting = (
        m: Memory,
        lengths: readonly [all: number, kept: number],
        exact: readonly TermCountsLike[],
        stem: readonly TermCountsLike[],
      ) => ({
        memoryId: m.id,
        seq: m.seq,
        lengthAll: lengths[0],
        lengthKept: lengths[1],
        exact,
        stem,
      });
      // "Agents deploy the agent.": 4 tokens, 3 without "the"; stem agent twice.
      const agentsPosting = posting(
        agents,
        [4, 3],
        [{ all: 1, kept: 1 }, none],
        [{ all: 2, kept: 2 }, none],
      );
      // "Does the dao run? The does.": 6 tokens, 2 without stop words; the stop word "does"
      // stems to dao (§4: oes becomes ao), so the stem dao counts 3 tokens, 1 of them kept.
      const doesPosting = posting(
        does,
        [6, 2],
        [none, { all: 1, kept: 1 }],
        [none, { all: 3, kept: 1 }],
      );
      // "Agent in scope b.": 3 tokens ("b" is too short), 2 without "in".
      const bPosting = posting(
        inB,
        [3, 2],
        [{ all: 1, kept: 1 }, none],
        [{ all: 1, kept: 1 }, none],
      );

      // The memory with no tokens counts in N with length 0; retracted and superseded ones not.
      assert.deepStrictEqual(await read([SCOPE_A]), {
        memories: 3,
        lengthAll: 10,
        lengthKept: 5,
        postings: [agentsPosting, doesPosting],
      });
      // Positive control: scope B's own read sees its memory, and both scopes add up.
      assert.deepStrictEqual(await read([SCOPE_B]), {
        memories: 1,
        lengthAll: 3,
        lengthKept: 2,
        postings: [bPosting],
      });
      assert.deepStrictEqual(await read([SCOPE_A, SCOPE_B]), {
        memories: 4,
        lengthAll: 13,
        lengthKept: 7,
        postings: [agentsPosting, bPosting, doesPosting],
      });
      const nothing = { memories: 0, lengthAll: 0, lengthKept: 0, postings: [] };
      assert.deepStrictEqual(await read([SCOPE_C]), nothing);
      assert.deepStrictEqual(await read([]), nothing);

      // The load: what was chosen, in the chosen order, live and in the scopes asked only.
      const loaded = await store.findByTerms({
        scopes: [SCOPE_A],
        terms,
        choose: () => [does.id, retracted.id, inB.id, "m-missing", empty.id, agents.id],
      });
      assert.deepStrictEqual(loaded, [does, empty, agents]);
    },
  );

  define(
    "find ranks exactly as the full scan after every note, retraction, supersession, summary, redaction and sweep, and a rolled-back write changes nothing",
    async ({ store }) => {
      let seconds = 0;
      let next = 0;
      const relembra = createRelembra<string>({
        store,
        policy: () => CURATOR_PRINCIPAL,
        clock: { now: () => ++seconds * 1000 },
        ids: { memoryId: () => `indexed-${++next}`, opId: () => `indexed-op-${++next}` },
        retention: [{ scope: SCOPE_A, maxAgeDays: 1 }],
      });
      const queries = [
        "agents release",
        "deploy branch",
        "migracao agente",
        "the",
        "releases friday",
        "noite",
        "summary agents",
        "zebras",
      ];
      /** find for every query beside the full scan of the same live memories, byte for byte. */
      const check = async (step: string) => {
        const live = await store.liveMemories({ scopes: [SCOPE_A] });
        const found: string[] = [];
        for (const query of queries) {
          const results = await relembra.find(CURATOR, { query, limit: 100 });
          const expected = rank(query, live);
          assert.deepStrictEqual(results, expected, `${step}: "${query}" ranks as the full scan`);
          assert.equal(
            exactly(results),
            exactly(expected),
            `${step}: "${query}" scores, bit for bit`,
          );
          found.push(exactly(results));
        }
        return found.join("\n");
      };
      let previous = "";
      const changed = async (step: string) => {
        const now = await check(step);
        // Positive control: the step reached find, so an index that missed it would show.
        assert.notEqual(now, previous, `${step} changes find's results`);
        previous = now;
      };

      const noted: Memory[] = [];
      for (const text of [
        "Agents deploy the release branch.",
        "The agent reviews each release.",
        "Releases ship on Fridays.",
        "Deploys run from the main branch.",
        "Migrações do banco rodam à noite.",
        "A migração do agente falhou.",
      ]) {
        noted.push(await relembra.note(CURATOR, { ...NOTE_INPUT, text }));
      }
      const [first, second, third, fourth, , sixth] = noted as [
        Memory,
        Memory,
        Memory,
        Memory,
        Memory,
        Memory,
      ];
      await changed("after the notes");
      await relembra.retract(CURATOR, { memoryId: second.id });
      await changed("after a retraction");
      await relembra.supersede(CURATOR, {
        memoryId: fourth.id,
        text: "Deploys run from the release branch now.",
        provenance: NOTE_INPUT.provenance,
      });
      await changed("after a supersession");
      await relembra.submitSummary(CURATOR, {
        scope: SCOPE_A,
        sources: [
          { memoryId: first.id, revision: 1 },
          { memoryId: third.id, revision: 1 },
        ],
        text: "Summary: agents release on Fridays.",
        provenance: NOTE_INPUT.provenance,
      });
      await changed("after a summary");
      await relembra.redact(CURATOR, { memoryId: sixth.id });
      await changed("after a redaction");
      // The first memory was noted at 1 s: a sweep a day and 1.5 s later expires it alone, with
      // the summary derived from it. A store with its own time accepted it at that time, so it is
      // made two days older than the store's time instead; the sweep then counts from that time.
      const timed = await storeNow(store);
      if (timed !== undefined) {
        await store.transaction((tx) => tx.putMemory({ ...first, notedAt: timed - 2 * DAY_MS }));
      }
      const swept = await relembra.sweep(86_400_000 + 1500);
      assert.deepStrictEqual(swept.redacted, [first.id]);
      assert.equal(swept.derived.length, 1);
      await changed("after a sweep");

      const zebra = memory("m-zebra", SCOPE_A, 99, { text: "Zebras release agents." });
      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.append(noteEvent(zebra));
          await tx.putMemory(zebra);
          throw new Error("roll back");
        }),
      );
      assert.equal(
        await check("after a rolled-back write"),
        previous,
        "a rollback changes nothing",
      );
      // Positive control: the same write, committed, is found and changes the statistics.
      await commit(store, zebra);
      await changed("after the same write committed");
      assert.deepStrictEqual(
        ids((await relembra.find(CURATOR, { query: "zebras" })).map((r) => r.memory)),
        [zebra.id],
      );
    },
  );

  define(
    "memories outside the scopes read never change find's scores, and memories inside do",
    async ({ store }) => {
      const relembra = createRelembra<string>({
        store,
        policy: (context) => ({
          id: context,
          readable: context === "both" ? [SCOPE_A, SCOPE_B] : [SCOPE_A],
          writable: [],
          promotable: [],
        }),
      });
      const query = "agents release";
      await commit(store, memory("a-1", SCOPE_A, 1, { text: "Agents release the branch." }));
      await commit(store, memory("a-2", SCOPE_A, 2, { text: "The release train leaves." }));
      await commit(store, memory("a-3", SCOPE_A, 3, { text: "Nothing to see." }));
      const before = await relembra.find("a", { query, limit: 100 });
      assert.equal(before.length, 2);

      // Writes in B with the same terms: one would move df, one avgdl, one is retracted again.
      await commit(store, memory("b-1", SCOPE_B, 4, { text: "Agents agents agents release." }));
      await commit(store, memory("b-2", SCOPE_B, 5, { text: "Release ".repeat(40) }));
      const b3 = memory("b-3", SCOPE_B, 6, { text: "Agents release twice." });
      await commit(store, b3);
      await store.transaction((tx) => tx.putMemory({ ...b3, status: "retracted" }));
      assert.deepStrictEqual(await relembra.find("a", { query, limit: 100 }), before);
      assert.equal(exactly(await relembra.find("a", { query, limit: 100 })), exactly(before));

      // Positive control: a reader of both scopes gets both scopes' statistics.
      const both = await relembra.find("both", { query, limit: 100 });
      assert.deepStrictEqual(
        both,
        rank(query, await store.liveMemories({ scopes: [SCOPE_A, SCOPE_B] })),
      );
      assert.notDeepStrictEqual(
        both.filter((result) => result.memory.scope === SCOPE_A),
        before,
        "B's memories count for a reader of B",
      );
      // Positive control: a write in A changes A's scores.
      await commit(store, memory("a-4", SCOPE_A, 7, { text: "Agents agents release." }));
      const after = await relembra.find("a", { query, limit: 100 });
      assert.deepStrictEqual(after, rank(query, await store.liveMemories({ scopes: [SCOPE_A] })));
      assert.notDeepStrictEqual(
        after.filter((result) => result.memory.id !== "a-4"),
        before,
        "a write in A moves A's scores",
      );
    },
  );

  define(
    "a redacted memory's terms leave the term index and every stored byte, while a planted copy's stay",
    async (opened) => {
      if (target.durable) assert.ok(opened.rawBytes, "a durable target provides rawBytes");
      const relembra = curator(opened.store);
      // Capitalized and accented, so their folded lower-case forms exist only as index terms.
      const secret = "Quokkazephyrines guard the Memóriaxylofonica vault.";
      const needles = ["quokkazephyrine", "memoriaxylofonica"];
      const terms = [
        { exact: "quokkazephyrines", stem: "quokkazephyrine" },
        { exact: "memoriaxylofonica", stem: "memoriaxylofonica" },
      ];
      const victim = await relembra.note(WRITER, {
        ...NOTE_INPUT,
        text: secret,
        opId: "op-victim",
      });
      const copy = await relembra.note(WRITER, { ...NOTE_INPUT, text: secret, opId: "op-copy" });
      const kept = await relembra.note(WRITER, { ...NOTE_INPUT, text: "The vault is in room 4." });

      const indexed = async () => {
        const read = await indexRead(opened.store, [SCOPE_A], terms);
        return { memories: read.memories, holders: read.postings.map((p) => p.memoryId) };
      };
      const stored = async () =>
        opened.rawBytes
          ? new TextDecoder("utf-8", { fatal: false }).decode(await opened.rawBytes())
          : undefined;
      const holds = async (expected: boolean, why: string) => {
        const text = await stored();
        if (text === undefined) return;
        for (const needle of needles)
          assert.equal(text.includes(needle), expected, `${why}: ${needle}`);
      };

      // Positive control: before any redaction the index and the bytes hold the terms.
      assert.deepStrictEqual(await indexed(), {
        memories: 3,
        holders: [copy.id, victim.id].sort(),
      });
      await holds(true, "the stored bytes hold the index terms before redaction");

      await relembra.redact(CURATOR, { memoryId: victim.id });
      assert.deepStrictEqual(await indexed(), { memories: 2, holders: [copy.id] });
      await holds(true, "the planted copy's terms stay");

      await relembra.redact(CURATOR, { memoryId: copy.id });
      assert.deepStrictEqual(await indexed(), { memories: 1, holders: [] });
      await holds(false, "no stored byte holds a redacted term");
      assert.deepStrictEqual(
        ids((await relembra.find(WRITER, { query: "vault" })).map((r) => r.memory)),
        [kept.id],
      );
    },
  );

  define(
    "identifiers with NUL, controls, bidi or zero-width characters are refused before the store, on every store",
    async ({ store }) => {
      // docs/FORMAT.md, "Identifiers": one rule for every scope and id, so no store has to hold
      // a name another store cannot (a text column refuses NUL), and none reaches a rendering.
      const hostile = [
        "probe\u0000other",
        "probe\u001bother",
        "probe\u0085other",
        "probe\u009bother",
        "probe\u202eother",
        "probe\u200bother",
      ];
      const refused = { name: "IdentifierError" };
      for (const name of hostile) {
        const scope = `conformance/${name}`;
        const listing: Principal = {
          id: "conformance-hostile",
          readable: [SCOPE_A, scope],
          writable: [SCOPE_A, scope],
          promotable: [],
          owned: [SCOPE_A, scope],
        };
        const viaScope = createRelembra<string>({ store, policy: () => listing });
        await assert.rejects(viaScope.note(WRITER, { ...NOTE_INPUT, scope }), refused);
        await assert.rejects(viaScope.recall(WRITER, {}), refused);
        const named = createRelembra<string>({
          store,
          policy: () => ({ ...WRITER_PRINCIPAL, id: name }),
        });
        await assert.rejects(named.note(WRITER, NOTE_INPUT), refused);
        const relembra = curator(store);
        await assert.rejects(relembra.zoom(CURATOR, { memoryId: name }), refused);
        await assert.rejects(relembra.retract(CURATOR, { memoryId: name }), refused);
        await assert.rejects(relembra.redact(CURATOR, { memoryId: name }), refused);
        await assert.rejects(
          relembra.supersede(CURATOR, { ...NOTE_INPUT, memoryId: name }),
          refused,
        );
        await assert.rejects(
          relembra.submitSummary(CURATOR, {
            ...NOTE_INPUT,
            sources: [{ memoryId: name, revision: 1 }],
          }),
          refused,
        );
        // The host's Ids port is trusted, but a bad id from it is a host bug, refused loudly.
        const badIds = createRelembra<string>({
          store,
          policy: () => WRITER_PRINCIPAL,
          ids: { memoryId: () => name, opId: () => "conformance-op" },
        });
        await assert.rejects(badIds.note(WRITER, NOTE_INPUT), refused);
      }
      assert.deepStrictEqual(await store.events({ scopes: [SCOPE_A] }), []);

      // Positive control: an ordinary Unicode scope and id round-trip.
      const scope = "projeto/ação";
      const owner: Principal = {
        id: "conformance-dono",
        readable: [scope],
        writable: [scope],
        promotable: [],
        owned: [scope],
      };
      const relembra = createRelembra<string>({
        store,
        policy: () => owner,
        ids: { memoryId: () => "memória-1", opId: () => "op-ação" },
      });
      const noted = await relembra.note(WRITER, { ...NOTE_INPUT, scope });
      assert.equal(noted.id, "memória-1");
      assert.deepStrictEqual(
        (await relembra.recall(WRITER, {})).map((m) => [m.id, m.scope]),
        [["memória-1", scope]],
      );
      assert.equal((await relembra.zoom(WRITER, { memoryId: "memória-1" })).scope, scope);
    },
  );

  define(
    "a promoted copy keeps its origin, and derived lists it beside the summaries until it is redacted",
    async (opened) => {
      const { store } = opened;
      const origin = memory("m-origin", SCOPE_A, 1);
      const copy = memory("m-copy", SCOPE_B, 2, { origin: { memoryId: origin.id, revision: 1 } });
      const summary = memory("m-summary", SCOPE_A, 3, {
        sources: [{ memoryId: origin.id, revision: 1 }],
      });
      const unrelated = memory("m-unrelated", SCOPE_B, 4, {
        origin: { memoryId: "m-elsewhere", revision: 1 },
      });
      for (const noted of [origin, copy, summary, unrelated]) await commit(store, noted);

      const handles = [store, ...(opened.reopen ? [await opened.reopen()] : [])];
      for (const handle of handles) {
        const read = await handle.transaction(async (tx) => ({
          copy: await tx.memory(copy.id),
          derived: [...(await tx.derived(origin.id))].sort(),
        }));
        assert.deepStrictEqual(read, { copy, derived: [copy.id, summary.id] });
        assert.deepStrictEqual(await handle.recall({ scopes: [SCOPE_B], limit: 10 }), [
          unrelated,
          copy,
        ]);
      }
      // A retracted copy is still derived; a redacted one is not.
      await store.transaction((tx) => tx.putMemory({ ...copy, status: "retracted" }));
      assert.deepStrictEqual([...(await store.transaction((tx) => tx.derived(origin.id)))].sort(), [
        copy.id,
        summary.id,
      ]);
      await store.transaction((tx) =>
        tx.redact({ id: copy.id, scope: SCOPE_B, seq: 99, status: "redacted" }),
      );
      assert.deepStrictEqual(await store.transaction((tx) => tx.derived(origin.id)), [summary.id]);
    },
  );

  define(
    "promote writes a copy that find reads in its scope, and redacting the origin erases the copy's text everywhere",
    async (opened) => {
      if (target.durable) assert.ok(opened.rawBytes, "a durable target provides rawBytes");
      const relembra = promoter(opened.store);
      const secret = "Promoted secret: the harbour lantern code is 58-tide.";
      const origin = await relembra.note(PROMOTER, { ...NOTE_INPUT, text: secret });
      const copy = await relembra.promote(PROMOTER, {
        memoryId: origin.id,
        revision: 1,
        scope: SCOPE_B,
        provenance: NOTE_INPUT.provenance,
        opId: "op-promote",
      });
      assert.deepStrictEqual(copy.origin, { memoryId: origin.id, revision: 1 });

      const handles = [opened.store, ...(opened.reopen ? [await opened.reopen()] : [])];
      for (const handle of handles) {
        const reader = promoter(handle);
        assert.deepStrictEqual(await reader.zoom(PROMOTER, { memoryId: copy.id }), copy);
        const found = await reader.find(PROMOTER, { query: "harbour lantern", scope: SCOPE_B });
        assert.deepStrictEqual(
          found.map((r) => r.memory),
          [copy],
        );
      }
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const surfaces = async () => [
        JSON.stringify(await opened.store.events({ scopes: [SCOPE_A, SCOPE_B] })),
        JSON.stringify(await opened.store.liveMemories({ scopes: [SCOPE_A, SCOPE_B] })),
        JSON.stringify(await opened.inspectEvents?.()) ?? "",
        opened.rawBytes ? decoder.decode(await opened.rawBytes()) : "",
      ];
      const piece = "harbour lantern code";
      // Positive control: before the redaction the scan finds the text on every surface.
      for (const text of await surfaces()) {
        if (text === "") continue;
        assert.ok(text.includes(piece), "the scan sees the text before redaction");
      }
      const promoteEvent = (await opened.store.events({ scopes: [SCOPE_B] })).find(
        (e) => e.kind === "promote",
      );
      assert.deepStrictEqual(promoteEvent, {
        format: 2,
        kind: "promote",
        seq: copy.seq,
        memoryId: copy.id,
        scope: SCOPE_B,
        principalId: PROMOTER_PRINCIPAL.id,
        origin: { memoryId: origin.id, revision: 1 },
        revision: copy.revision,
      });

      const redaction = await relembra.redact(PROMOTER, { memoryId: origin.id });
      assert.deepStrictEqual(redaction, { redacted: [origin.id], derived: [copy.id] });
      for (const text of await surfaces()) assert.ok(!text.includes(piece), "the text is gone");
      assert.deepStrictEqual(
        await relembra.find(PROMOTER, { query: "harbour lantern", scope: SCOPE_B }),
        [],
      );
      const erasures = await opened.store.erasures();
      assert.deepStrictEqual(
        erasures.map((work) => work.memoryId),
        [origin.id, copy.id],
      );
      const events = await opened.store.events({ scopes: [SCOPE_A, SCOPE_B] });
      assert.deepStrictEqual(
        events.filter((e) => e.memoryId === copy.id).map(({ seq: _seq, ...e }) => e),
        [
          {
            format: 2,
            kind: "promote",
            memoryId: copy.id,
            scope: SCOPE_B,
            principalId: PROMOTER_PRINCIPAL.id,
            origin: { memoryId: origin.id, revision: 1 },
            redacted: true,
          },
          {
            format: 1,
            kind: "redact",
            memoryId: copy.id,
            scope: SCOPE_B,
            cause: "source",
            principalId: PROMOTER_PRINCIPAL.id,
          },
        ],
      );
    },
  );

  define("retracting the origin leaves its promoted copy live", async ({ store }) => {
    const relembra = promoter(store);
    const origin = await relembra.note(PROMOTER, { ...NOTE_INPUT, text: "Copied fact." });
    const copy = await relembra.promote(PROMOTER, {
      memoryId: origin.id,
      revision: 1,
      scope: SCOPE_B,
      provenance: NOTE_INPUT.provenance,
    });
    await relembra.retract(PROMOTER, { memoryId: origin.id });
    assert.deepStrictEqual(ids(await store.liveMemories({ scopes: [SCOPE_A, SCOPE_B] })), [
      copy.id,
    ]);
    // Positive control: redacting the origin reaches the copy.
    await relembra.redact(PROMOTER, { memoryId: origin.id });
    assert.deepStrictEqual(await store.liveMemories({ scopes: [SCOPE_A, SCOPE_B] }), []);
  });

  define(
    "recordExposure keeps one row per carrier and memory id, as first recorded, ids only, and a transaction reads it",
    async (opened) => {
      const { store } = opened;
      const first: Carrier = { id: "carrier-1", kind: "kind-a" };
      const second: Carrier = { id: "carrier-2", kind: "kind-a" };
      // No store holds m-1 or m-2: an exposure is ids only, with no scope and no lookup.
      assert.deepStrictEqual(
        await store.recordExposure({ carrier: first, memoryIds: ["m-1", "m-2"], at: 1_000 }),
        [],
      );
      // The same carrier again, under another kind: the row stays as first recorded.
      await store.recordExposure({
        carrier: { id: "carrier-1", kind: "kind-b" },
        memoryIds: ["m-1"],
        at: 2_000,
      });
      await store.recordExposure({ carrier: second, memoryIds: ["m-2"], at: 3_000 });

      const read = async (target: Store, memoryId: string) =>
        byCarrierId(await target.transaction((tx) => tx.exposures(memoryId)));
      assert.deepStrictEqual(await read(store, "m-1"), [first]);
      assert.deepStrictEqual(await read(store, "m-2"), [first, second]);
      assert.deepStrictEqual(await read(store, "m-3"), []);
      if (opened.reopen) {
        assert.deepStrictEqual(await read(await opened.reopen(), "m-2"), [first, second]);
      }
    },
  );

  define("concurrent recordExposure calls, from two handles, lose no row", async (opened) => {
    const { store } = opened;
    const other = opened.reopen ? await opened.reopen() : store;
    const carriers: Carrier[] = Array.from({ length: 8 }, (_, n) => ({
      id: `carrier-${n}`,
      kind: "kind-a",
    }));

    const told = await Promise.all(
      carriers.map((carrier, n) =>
        (n % 2 === 0 ? store : other).recordExposure({
          carrier,
          memoryIds: ["m-1", "m-2"],
          at: 1_000 + n,
        }),
      ),
    );

    assert.deepStrictEqual(
      told,
      carriers.map(() => []),
    );
    for (const memoryId of ["m-1", "m-2"]) {
      const carried = await store.transaction((tx) => tx.exposures(memoryId));
      assert.deepStrictEqual(byCarrierId(carried), carriers, `every carrier of ${memoryId}`);
    }
  });

  define(
    "recordExposure reports the ids already redacted, and one racing a redaction is told of it",
    async (opened) => {
      const { store } = opened;
      const relembra = curator(store);
      const carrier: Carrier = { id: "carrier-1", kind: "kind-a" };
      const gone = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Redacted before." });
      const kept = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Kept all along." });
      await relembra.redact(CURATOR, { memoryId: gone.id });

      const both = [gone.id, kept.id].sort();
      assert.deepStrictEqual(await store.recordExposure({ carrier, memoryIds: both, at: 1_000 }), [
        gone.id,
      ]);
      // Recorded all the same: the outcome is the caller's to act on.
      assert.deepStrictEqual(await store.transaction((tx) => tx.exposures(gone.id)), [carrier]);

      // A redaction reads the exposures of a memory; a recorder starts after that read and
      // before the redaction commits. The redaction cannot see it, so the recorder must be told.
      const racing = await relembra.note(WRITER, { ...NOTE_INPUT, text: "Redacted meanwhile." });
      const other = opened.reopen ? await opened.reopen() : store;
      let recording: Promise<readonly string[]> | undefined;
      await store.transaction(async (tx) => {
        assert.deepStrictEqual(await tx.exposures(racing.id), []);
        recording = other.recordExposure({ carrier, memoryIds: [racing.id], at: 2_000 });
        recording.catch(() => undefined);
        // Room for a recorder that does not wait to commit and check before this commit.
        await sleep(50);
        const { seq } = await tx.append({
          format: 1,
          kind: "redact",
          memoryId: racing.id,
          scope: SCOPE_A,
          cause: "request",
          principalId: CURATOR_PRINCIPAL.id,
        });
        await tx.redact({ id: racing.id, scope: SCOPE_A, seq, status: "redacted" });
        await tx.putErasure({ seq, memoryId: racing.id, carriers: [] });
      });
      assert.deepStrictEqual(await recording, [racing.id]);
    },
  );

  define(
    "a carrier's outcome commits with its transaction, the first one stays, and a rolled-back one is not kept",
    async (opened) => {
      const { store } = opened;
      const first: Carrier = { id: "carrier-1", kind: "kind-a" };
      const second: Carrier = { id: "carrier-2", kind: "kind-b" };
      await store.transaction((tx) =>
        tx.putErasure({ seq: 7, memoryId: "m-1", carriers: [first, second] }),
      );
      assert.deepStrictEqual(await store.erasures(), [
        { seq: 7, memoryId: "m-1", carriers: [first, second] },
      ]);

      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.settle({ seq: 7, carrierId: first.id, status: "acknowledged", at: 10 });
          throw new Error("roll back");
        }),
        { message: "roll back" },
      );
      assert.deepStrictEqual(await store.settlements(), []);

      // Positive control: committed outcomes are kept, and the first per carrier stays.
      await store.transaction((tx) =>
        tx.settle({ seq: 7, carrierId: first.id, status: "acknowledged", at: 20 }),
      );
      await store.transaction((tx) =>
        tx.settle({ seq: 7, carrierId: first.id, status: "unsupported", at: 30 }),
      );
      await store.transaction((tx) =>
        tx.settle({ seq: 7, carrierId: second.id, status: "unsupported", at: 40 }),
      );
      const expected = [
        { seq: 7, carrierId: first.id, status: "acknowledged", at: 20 },
        { seq: 7, carrierId: second.id, status: "unsupported", at: 40 },
      ];
      assert.deepStrictEqual(bySettlement(await store.settlements()), expected);
      if (opened.reopen) {
        const reopened = await opened.reopen();
        assert.deepStrictEqual(bySettlement(await reopened.settlements()), expected);
        assert.deepStrictEqual(await reopened.erasures(), [
          { seq: 7, memoryId: "m-1", carriers: [first, second] },
        ]);
      }
    },
  );

  define(
    "pendingErasures pages through the rows with a pending carrier, in seq order, with only those carriers, and the count follows",
    async (opened) => {
      const { store } = opened;
      const a: Carrier = { id: "carrier-a", kind: "kind-a" };
      const b: Carrier = { id: "carrier-b", kind: "kind-b" };
      const c: Carrier = { id: "carrier-c", kind: "kind-a" };
      await store.transaction(async (tx) => {
        await tx.putErasure({ seq: 3, memoryId: "m-3", carriers: [a, b] });
        await tx.putErasure({ seq: 5, memoryId: "m-5", carriers: [c] });
        await tx.putErasure({ seq: 8, memoryId: "m-8", carriers: [] });
        await tx.putErasure({ seq: 9, memoryId: "m-9", carriers: [a] });
      });
      const page = async (target: Store, query: { after?: number; limit: number }) =>
        (await target.pendingErasures(query)).map((work) => ({
          seq: work.seq,
          memoryId: work.memoryId,
          carriers: byCarrierId(work.carriers),
        }));
      // Positive control: before any outcome, every row with a carrier is pending.
      assert.deepStrictEqual(await page(store, { limit: 10 }), [
        { seq: 3, memoryId: "m-3", carriers: [a, b] },
        { seq: 5, memoryId: "m-5", carriers: [c] },
        { seq: 9, memoryId: "m-9", carriers: [a] },
      ]);
      assert.deepStrictEqual(await store.pendingErasureCount(), { work: 3, carriers: 4 });

      await store.transaction(async (tx) => {
        await tx.settle({ seq: 3, carrierId: a.id, status: "acknowledged", at: 10 });
        await tx.settle({ seq: 5, carrierId: c.id, status: "unsupported", at: 10 });
      });
      // A rolled-back outcome leaves its carrier pending.
      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.settle({ seq: 9, carrierId: a.id, status: "acknowledged", at: 20 });
          throw new Error("roll back");
        }),
        { message: "roll back" },
      );

      const expected = [
        { seq: 3, memoryId: "m-3", carriers: [b] },
        { seq: 9, memoryId: "m-9", carriers: [a] },
      ];
      assert.deepStrictEqual(await page(store, { limit: 10 }), expected);
      assert.deepStrictEqual(await page(store, { limit: 1 }), [expected[0]]);
      assert.deepStrictEqual(await page(store, { after: 3, limit: 1 }), [expected[1]]);
      assert.deepStrictEqual(await page(store, { after: 9, limit: 10 }), []);
      assert.deepStrictEqual(await store.pendingErasureCount(), { work: 2, carriers: 2 });
      if (opened.reopen) {
        const reopened = await opened.reopen();
        assert.deepStrictEqual(await page(reopened, { limit: 10 }), expected);
        assert.deepStrictEqual(await reopened.pendingErasureCount(), { work: 2, carriers: 2 });
      }
    },
  );

  define(
    "erasures returns every committed outbox row in seq order, whatever order they were put in",
    async (opened) => {
      const { store } = opened;
      const carrier: Carrier = { id: "carrier-a", kind: "kind-a" };
      await store.transaction(async (tx) => {
        await tx.putErasure({ seq: 9, memoryId: "m-9", carriers: [carrier] });
        await tx.putErasure({ seq: 3, memoryId: "m-3", carriers: [] });
      });
      await store.transaction((tx) => tx.putErasure({ seq: 5, memoryId: "m-5", carriers: [] }));
      const rows = async (target: Store) =>
        (await target.erasures()).map((work) => ({ seq: work.seq, memoryId: work.memoryId }));
      const expected = [
        { seq: 3, memoryId: "m-3" },
        { seq: 5, memoryId: "m-5" },
        { seq: 9, memoryId: "m-9" },
      ];
      // Positive control: every row is there, whatever the order.
      assert.deepStrictEqual(
        [...(await rows(store))].sort((x, y) => x.seq - y.seq),
        expected,
      );
      assert.deepStrictEqual(await rows(store), expected);
      if (opened.reopen) assert.deepStrictEqual(await rows(await opened.reopen()), expected);
    },
  );

  define(
    "events returns the committed events of the requested scopes in seq order, redacted forms included",
    async (opened) => {
      const { store } = opened;
      const inA = memory("m-a", SCOPE_A, 1, { text: "Events keep their scope." });
      const inB = memory("m-b", SCOPE_B, 2);
      const gone = memory("m-gone", SCOPE_A, 3, { text: "This text leaves every event." });
      const a = await store.transaction((tx) => tx.append(noteEvent(inA)));
      const b = await store.transaction((tx) => tx.append(noteEvent(inB)));
      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.append(noteEvent(memory("m-rolled-back", SCOPE_A, 4)));
          throw new Error("roll back");
        }),
      );
      const noted = await store.transaction(async (tx) => {
        await tx.putMemory(gone);
        return tx.append(noteEvent(gone));
      });
      const redact = await store.transaction(async (tx) => {
        const event = await tx.append({
          format: 1,
          kind: "redact",
          memoryId: gone.id,
          scope: SCOPE_A,
          cause: "request",
          principalId: "test-principal",
        });
        await tx.redact({ id: gone.id, scope: SCOPE_A, seq: event.seq, status: "redacted" });
        return event;
      });
      const { revision: _removed, ...rest } = noted as NoteEvent;
      const redactedNote = { ...rest, redacted: true };

      // A read during an open transaction never sees its uncommitted writes.
      const written = deferred();
      const release = deferred();
      const rolledBack = store.transaction(async (tx) => {
        await tx.append(noteEvent(memory("m-uncommitted", SCOPE_A, 5)));
        written.resolve();
        await release.promise;
        throw new Error("roll back");
      });
      await written.promise;
      // Not awaited yet: a store may answer at once or after the open transaction ends.
      const during = store.events({ scopes: [SCOPE_A] });
      release.resolve();
      await assert.rejects(rolledBack);
      assert.deepStrictEqual(await during, [a, redactedNote, redact]);
      assert.deepStrictEqual(await store.events({ scopes: [SCOPE_A] }), [a, redactedNote, redact]);
      assert.deepStrictEqual(await store.events({ scopes: [SCOPE_B] }), [b]);
      assert.deepStrictEqual(await store.events({ scopes: [SCOPE_C] }), []);
      assert.deepStrictEqual(await store.events({ scopes: [] }), []);
      // Positive control: both scopes together, interleaved in seq order.
      const both = await store.events({ scopes: [SCOPE_B, SCOPE_A] });
      assert.deepStrictEqual(both, [a, b, redactedNote, redact]);
      assert.ok(
        !JSON.stringify(both).includes("This text leaves every event."),
        "a redacted memory's text is in no event",
      );
      assert.ok(JSON.stringify(both).includes("Events keep their scope."));
      if (opened.reopen) {
        const reopened = await opened.reopen();
        assert.deepStrictEqual(await reopened.events({ scopes: [SCOPE_B, SCOPE_A] }), both);
      }
    },
  );

  define(
    "an import checkpoint commits with its transaction, a later one replaces it, and a rolled-back one is not kept",
    async (opened) => {
      const { store } = opened;
      const first = { source: "optmem:a", bytes: 10, width: 10 };
      const seenInside = await store.transaction(async (tx) => {
        assert.equal(await tx.checkpoint("optmem:a"), undefined, "none before one is put");
        await tx.putCheckpoint(first);
        return tx.checkpoint("optmem:a");
      });
      assert.deepStrictEqual(seenInside, first, "a checkpoint is visible later in its transaction");
      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.putCheckpoint({ source: "optmem:a", bytes: 99, width: 9 });
          await tx.putCheckpoint({ source: "optmem:b", bytes: 5, width: 5 });
          throw new Error("roll back");
        }),
      );
      assert.deepStrictEqual(await store.transaction((tx) => tx.checkpoint("optmem:a")), first);
      assert.equal(await store.transaction((tx) => tx.checkpoint("optmem:b")), undefined);

      // Positive control: the same checkpoints, committed, are kept, each under its source.
      const second = { source: "optmem:a", bytes: 20, width: 5 };
      const other = { source: "optmem:b", bytes: 5, width: 5 };
      await store.transaction(async (tx) => {
        await tx.putCheckpoint(second);
        await tx.putCheckpoint(other);
      });
      assert.deepStrictEqual(await store.transaction((tx) => tx.checkpoint("optmem:a")), second);
      assert.deepStrictEqual(await store.transaction((tx) => tx.checkpoint("optmem:b")), other);
      if (opened.reopen) {
        const reopened = await opened.reopen();
        assert.deepStrictEqual(
          await reopened.transaction((tx) => tx.checkpoint("optmem:a")),
          second,
        );
      }
    },
  );

  if (!target.durable) return cases;

  define("a reopened store keeps committed writes and drops rolled-back ones", async (opened) => {
    assert.ok(opened.reopen, "a durable target provides reopen");
    const committed = memory("m-committed", SCOPE_A, 1);
    const rolledBack = memory("m-rolled-back", SCOPE_A, 2);
    await commit(opened.store, committed);
    await assert.rejects(
      opened.store.transaction(async (tx) => {
        await tx.putMemory(rolledBack);
        throw new Error("roll back");
      }),
    );

    const reopened = await opened.reopen();

    assert.deepStrictEqual(await reopened.recall({ scopes: [SCOPE_A], limit: 10 }), [committed]);
    // Positive control: the reopened handle can write, and the first handle sees it.
    await commit(reopened, rolledBack);
    assert.deepStrictEqual(ids(await opened.store.recall({ scopes: [SCOPE_A], limit: 10 })), [
      "m-rolled-back",
      "m-committed",
    ]);
  });

  define(
    "committed events persist in seq order and a rolled-back append leaves none",
    async (opened) => {
      assert.ok(opened.inspectEvents, "a durable target provides inspectEvents");
      const first = await opened.store.transaction((tx) =>
        tx.append(noteEvent(memory("m-1", SCOPE_A, 1))),
      );
      const second = await opened.store.transaction((tx) =>
        tx.append(noteEvent(memory("m-2", SCOPE_A, 2))),
      );
      await assert.rejects(
        opened.store.transaction(async (tx) => {
          await tx.append(noteEvent(memory("m-rolled-back", SCOPE_A, 3)));
          throw new Error("roll back");
        }),
      );

      assert.deepStrictEqual(await opened.inspectEvents(), [first, second]);
      // Positive control: the same append, committed, is persisted after them.
      const third = await opened.store.transaction((tx) =>
        tx.append(noteEvent(memory("m-rolled-back", SCOPE_A, 3))),
      );
      assert.deepStrictEqual(await opened.inspectEvents(), [first, second, third]);
    },
  );

  define("seq keeps increasing across reopened handles", async (opened) => {
    assert.ok(opened.reopen && opened.inspectEvents, "a durable target provides both");
    const first = await opened.store.transaction((tx) =>
      tx.append(noteEvent(memory("m-1", SCOPE_A, 1))),
    );

    const reopened = await opened.reopen();
    const second = await reopened.transaction((tx) =>
      tx.append(noteEvent(memory("m-2", SCOPE_A, 2))),
    );
    const third = await opened.store.transaction((tx) =>
      tx.append(noteEvent(memory("m-3", SCOPE_A, 3))),
    );

    assert.ok(second.seq > first.seq, "a reopened handle continues after the first's seq");
    assert.ok(third.seq > second.seq, "the first handle continues after the reopened one's seq");
    assert.deepStrictEqual(await opened.inspectEvents(), [first, second, third]);
  });

  return cases;
}

function byCarrierId(carriers: readonly Carrier[]): Carrier[] {
  return [...carriers]
    .map(({ id, kind }) => ({ id, kind }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function bySettlement(settlements: readonly CarrierSettlement[]): CarrierSettlement[] {
  return [...settlements]
    .map(({ seq, carrierId, status, at }) => ({ seq, carrierId, status, at }))
    .sort((a, b) => a.seq - b.seq || (a.carrierId < b.carrierId ? -1 : 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

const HOUR = 3_600_000;
const DAY_MS = 86_400_000;

/** The store's own time (StoreTransaction.now), or undefined for a store without one. */
async function storeNow(store: Store): Promise<number | undefined> {
  return store.transaction(async (tx) => (tx.now === undefined ? undefined : tx.now()));
}

const SCOPE_A: Scope = "conformance/a";
const SCOPE_B: Scope = "conformance/b";
const SCOPE_C: Scope = "conformance/c";

function memory(
  id: string,
  scope: Scope,
  at: number,
  options: {
    readonly text?: string;
    readonly source?: string;
    readonly pinned?: boolean;
    readonly trust?: Trust;
    readonly status?: MemoryStatus;
    readonly supersededBy?: string;
    readonly sources?: readonly SourceRevision[];
    readonly origin?: SourceRevision;
  } = {},
): Memory {
  const provenance = {
    agent: "test-agent",
    harness: "test-harness",
    model: "test-model",
    host: "test-host",
    trust: options.trust ?? "agent",
    opId: `op-${id}`,
    ...(options.source === undefined ? {} : { source: options.source }),
  };
  return {
    id,
    scope,
    // Distinct from `at`, so a store that mixes up the two columns fails the round trip.
    seq: 1000 + at,
    pinned: options.pinned ?? false,
    notedAt: at,
    revision: { number: 1, text: options.text ?? `Fact ${id}.`, at, provenance },
    status: options.status ?? "live",
    ...(options.supersededBy === undefined ? {} : { supersededBy: options.supersededBy }),
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  };
}

function noteEvent(noted: Memory): NewEvent {
  return {
    format: 1,
    kind: "note",
    memoryId: noted.id,
    scope: noted.scope,
    principalId: "test-principal",
    pinned: noted.pinned,
    revision: noted.revision,
  };
}

/** The suite's host: one principal that writes SCOPE_A. */
const WRITER = "writer";
const WRITER_PRINCIPAL: Principal = {
  id: "conformance-writer",
  readable: [SCOPE_A],
  writable: [SCOPE_A],
  promotable: [],
};
const NOTE_INPUT = {
  scope: SCOPE_A,
  text: "Retries return the first outcome.",
  provenance: {
    agent: "test-agent",
    harness: "test-harness",
    model: "test-model",
    host: "test-host",
  },
};

/**
 * The suite's owner: it reads, writes, pins and owns SCOPE_A (retract and redact there), up to
 * owner trust.
 */
const CURATOR = "curator";
const CURATOR_PRINCIPAL: Principal = {
  id: "conformance-curator",
  readable: [SCOPE_A],
  writable: [SCOPE_A],
  promotable: [],
  owned: [SCOPE_A],
  pinnable: [SCOPE_A],
  trustCeiling: "owner",
};

/** Owns SCOPE_A, but may not pin, and writes at most agent trust (the default ceiling). */
const REVISER = "reviser";
const REVISER_PRINCIPAL: Principal = {
  id: "conformance-reviser",
  readable: [SCOPE_A],
  writable: [SCOPE_A],
  promotable: [],
  owned: [SCOPE_A],
};

/**
 * A relembra over `store` for the suite's writer (WRITER), owner (CURATOR) and REVISER, whose
 * clock reads 1 s, 2 s, … and whose ids start with curated- (memory and op ids share one counter).
 */
function curator(store: Store) {
  let next = 0;
  let seconds = 0;
  return createRelembra<string>({
    store,
    policy: (context) =>
      context === CURATOR
        ? CURATOR_PRINCIPAL
        : context === REVISER
          ? REVISER_PRINCIPAL
          : WRITER_PRINCIPAL,
    clock: { now: () => ++seconds * 1000 },
    ids: { memoryId: () => `curated-${++next}`, opId: () => `curated-op-${++next}` },
  });
}

/** Reads and owns SCOPE_A, reads SCOPE_B and may promote into it, up to owner trust. */
const PROMOTER = "promoter";
const PROMOTER_PRINCIPAL: Principal = {
  id: "conformance-promoter",
  readable: [SCOPE_A, SCOPE_B],
  writable: [SCOPE_A],
  promotable: [SCOPE_B],
  owned: [SCOPE_A],
  trustCeiling: "owner",
};

/** A relembra over `store` for PROMOTER, whose ids start with promoted- (one shared counter). */
function promoter(store: Store) {
  let next = 0;
  let seconds = 0;
  return createRelembra<string>({
    store,
    policy: () => PROMOTER_PRINCIPAL,
    clock: { now: () => ++seconds * 1000 },
    ids: { memoryId: () => `promoted-${++next}`, opId: () => `promoted-op-${++next}` },
  });
}

/** A relembra over `store` whose clock reads `now` and whose ids start with `prefix`. */
function core(store: Store, now: number, prefix: string) {
  let next = 0;
  const clock: Clock = { now: () => now };
  const generated: Ids = {
    memoryId: () => `${prefix}-memory-${++next}`,
    opId: () => `${prefix}-op-${++next}`,
  };
  return createRelembra<string>({ store, policy: () => WRITER_PRINCIPAL, clock, ids: generated });
}

/** The suite's rendering host: one principal that reads SCOPE_A, writes A and B, and pins A. */
const RENDER = "renderer";
const RENDER_PRINCIPAL: Principal = {
  id: "conformance-renderer",
  readable: [SCOPE_A],
  writable: [SCOPE_A, SCOPE_B],
  promotable: [],
  pinnable: [SCOPE_A],
  trustCeiling: "owner",
};
const RENDER_NOTE = {
  scope: SCOPE_A,
  provenance: NOTE_INPUT.provenance,
};

/**
 * A relembra over `store` for RENDER_PRINCIPAL whose clock reads 1 s, 2 s, … and whose memory ids
 * are render-memory-1, -2, …. The note helper takes the text, trust and pin per call.
 */
function renderer(store: Store) {
  let next = 0;
  let seconds = 0;
  const relembra = createRelembra<string>({
    store,
    policy: () => RENDER_PRINCIPAL,
    clock: { now: () => ++seconds * 1000 },
    ids: { memoryId: () => `render-memory-${++next}`, opId: () => `render-op-${next}` },
  });
  return {
    note: (
      context: string,
      input: {
        scope: Scope;
        text: string;
        pinned?: boolean;
        trust?: Trust;
        provenance: typeof NOTE_INPUT.provenance;
      },
    ) => {
      const { trust, provenance, ...rest } = input;
      return relembra.note(context, {
        ...rest,
        provenance: trust === undefined ? provenance : { ...provenance, trust },
      });
    },
    wake: relembra.wake,
    brief: relembra.brief,
  };
}

const FENCE_KEY = "conformance-lease";

/** A relembra whose principal writes under the suite's fence key at `epoch`. */
function fenced(store: Store, epoch: number) {
  const principal: Principal = { ...WRITER_PRINCIPAL, fence: { key: FENCE_KEY, epoch } };
  return createRelembra<string>({ store, policy: () => principal });
}

/** The principal that owns the op records the store-level cases write. */
const OWNER = "op-owner";

function opRecord(opId: string, noted: Memory, fingerprint = "0".repeat(64)): OpRecord {
  return {
    principalId: OWNER,
    opId,
    fingerprint,
    memoryId: noted.id,
    at: noted.notedAt,
    seq: noted.seq,
  };
}

async function commit(store: Store, noted: Memory): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.append(noteEvent(noted));
    await tx.putMemory(noted);
  });
}

/** liveMemories promises no order, so compare by id. */
function byId(memories: readonly Memory[]): Memory[] {
  return [...memories].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function ids(memories: readonly Memory[]): string[] {
  return memories.map((m) => m.id);
}

type TermCountsLike = { readonly all: number; readonly kept: number };

/** What `store`'s term index holds for `terms` in `scopes`, postings in memory id order. */
async function indexRead(
  store: Store,
  scopes: readonly Scope[],
  terms: readonly QueryTerm[],
): Promise<TermIndexRead> {
  let seen: TermIndexRead | undefined;
  const loaded = await store.findByTerms({
    scopes,
    terms,
    choose(index) {
      seen = index;
      return [];
    },
  });
  assert.deepStrictEqual(loaded, [], "nothing chosen, nothing loaded");
  assert.ok(seen, "findByTerms calls choose");
  const postings = [...seen.postings].sort((a, b) =>
    a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0,
  );
  return {
    memories: seen.memories,
    lengthAll: seen.lengthAll,
    lengthKept: seen.lengthKept,
    postings: postings.map((p) => ({
      memoryId: p.memoryId,
      seq: p.seq,
      lengthAll: p.lengthAll,
      lengthKept: p.lengthKept,
      exact: p.exact.map(({ all, kept }) => ({ all, kept })),
      stem: p.stem.map(({ all, kept }) => ({ all, kept })),
    })),
  };
}

/** Ranked results as text: ids, seqs and every score's IEEE 754 bits, so equal means identical. */
function exactly(results: readonly Ranked[]): string {
  const bits = new DataView(new ArrayBuffer(8));
  return results
    .map(({ memory: m, score }) => {
      bits.setFloat64(0, score);
      return `${m.id} ${m.seq} ${bits.getBigUint64(0).toString(16).padStart(16, "0")}`;
    })
    .join("\n");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((done) => setTimeout(done, 1));
}
