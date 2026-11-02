import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { createRelembra } from "relembra";
import { openSqliteStore, SchemaTooNewError, StoreUnverifiedError } from "relembra/sqlite";
import { selfKilled } from "./platform-support.js";
import { INTERLEAVINGS, openDuringUpgrade } from "./sqlite-race-support.js";
import { tempDir } from "./sqlite-support.js";
import { hostPolicy, provenance, SCOPE } from "./support.js";

const CHILD = join(import.meta.dir, "sqlite-crash-child.ts");
const CRASH_SCOPE = "crash/one-file";

describe("sqlite crash and first-open processes", () => {
  let dir: ReturnType<typeof tempDir>;
  let path: string;
  let barrier: string;
  const children: ChildProcess[] = [];
  beforeEach(() => {
    dir = tempDir();
    path = join(dir.path, "relembra.db");
    barrier = join(dir.path, "barrier");
    mkdirSync(barrier);
  });
  afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
    dir.remove();
  });

  function start(...args: string[]) {
    const child = spawn(process.execPath, [CHILD, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve(signal === null ? code : -1));
    });
    return { child, exit, stderr: () => stderr };
  }

  async function killAt(file: string, run: ReturnType<typeof start>) {
    await waitFor(() => existsSync(join(barrier, file)) || run.child.exitCode !== null);
    if (run.child.exitCode !== null) throw new Error(`child exited early: ${run.stderr()}`);
    run.child.kill("SIGKILL");
    expect(await run.exit).toBe(-1);
  }

  const memoryIds = async () => {
    const store = openSqliteStore({ path, busyTimeoutMs: 1_000 });
    try {
      const all = await store.recall({ scopes: [CRASH_SCOPE], limit: 100 });
      return all.map((memory) => memory.id).sort();
    } finally {
      await store.close();
    }
  };

  test("a writer killed inside a transaction releases the lock and leaves committed contents unchanged", async () => {
    const writer = start("die-in-transaction", path, barrier);
    await killAt("inside", writer);

    // Positive control: the commit before the kill is there; the open transaction left nothing.
    expect(await memoryIds()).toEqual(["m-committed"]);
    // The lock is recovered: a new writer commits well within a short busy timeout.
    const store = openSqliteStore({ path, busyTimeoutMs: 1_000 });
    const relembra = createRelembra({ store, policy: hostPolicy });
    await relembra.note({ user: "writer" }, { scope: SCOPE, text: "After the crash.", provenance });
    expect(await relembra.recall({ user: "reader" })).toHaveLength(1);
    await store.close();
    expect(await memoryIds()).toEqual(["m-committed"]);
  }, 30_000);

  test("a newer schema left in the WAL by a killed writer is refused without changing any file", async () => {
    const files = [path, `${path}-wal`, `${path}-shm`];
    const snapshot = () => files.map((file) => (existsSync(file) ? readFileSync(file) : null));

    await killAt("inside", start("die-holding-wal", path, barrier, "future"));
    const before = snapshot();
    expect(before.map((bytes) => bytes !== null)).toEqual([true, true, true]);

    expect(() => openSqliteStore({ path, busyTimeoutMs: 1_000 })).toThrow(SchemaTooNewError);

    expect(snapshot()).toEqual(before);
  }, 30_000);

  test("a newer schema committed between the read-only probe and the writable open is refused without changing any file", async () => {
    await openSqliteStore({ path, busyTimeoutMs: 1_000 }).close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    const files = [path, `${path}-wal`, `${path}-shm`];
    const snapshot = () => files.map((file) => (existsSync(file) ? readFileSync(file) : null));
    // The first connection the open closes is its read-only probe. Right after it, another
    // process commits the next schema version and is killed, leaving the commit in the WAL.
    const close = DatabaseSync.prototype.close;
    let before: (Buffer | null)[] | undefined;
    DatabaseSync.prototype.close = function (this: DatabaseSync) {
      close.call(this);
      if (before !== undefined) return;
      const child = spawnSync(process.execPath, [CHILD, "commit-future-and-die", path], {
        encoding: "utf8",
      });
      expect(selfKilled(child), child.stderr).toBe(true);
      before = snapshot();
    };
    try {
      expect(() => openSqliteStore({ path, busyTimeoutMs: 1_000 })).toThrow(SchemaTooNewError);
    } finally {
      DatabaseSync.prototype.close = close;
    }

    // Positive control: the killed writer's commit is in the WAL, uncheckpointed.
    expect(before?.map((bytes) => bytes !== null)).toEqual([true, true, true]);
    // The main file and the WAL are byte for byte the same, and no sidecar was deleted. The
    // -shm is SQLite's rebuildable wal-index: the write-capable connection that found the newer
    // version had to read the file, which updates its read marks and header.
    const after = snapshot();
    const [mainBefore, walBefore] = before ?? [];
    expect(after[0]?.equals(mainBefore as Buffer)).toBe(true);
    expect(after[1]?.equals(walBefore as Buffer)).toBe(true);
    expect(after[2]).not.toBeNull();
  }, 30_000);

  test("a rollback-journal store: no upgrader commits between the version check and the switch to WAL", async () => {
    await openSqliteStore({ path, busyTimeoutMs: 1_000 }).close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode = DELETE");
    raw.close();
    const files = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
    const hashes = () =>
      files.map((file) =>
        existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null,
      );
    expect(readFileSync(path).subarray(18, 20)).toEqual(Buffer.from([1, 1]));
    // Another connection tries to commit a newer schema version at two moments: right after the
    // writable side's version check (the second version read; the first is the read-only probe),
    // and right before the first switch to WAL.
    const outcomes: ("committed" | "busy")[] = [];
    let before: (string | null)[] | undefined;
    const upgrade = () => {
      const upgrader = new DatabaseSync(path);
      try {
        upgrader.exec("PRAGMA busy_timeout = 0");
        upgrader.exec(
          `INSERT INTO schema_version (version, applied_at) VALUES (${90 + outcomes.length}, 0)`,
        );
        outcomes.push("committed");
        before = hashes();
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        outcomes.push("busy");
      } finally {
        upgrader.close();
      }
    };
    const get = StatementSync.prototype.get;
    const prepare = DatabaseSync.prototype.prepare;
    let reads = 0;
    let switches = 0;
    StatementSync.prototype.get = function (this: StatementSync, ...args) {
      const row = get.apply(this, args as Parameters<typeof get>);
      if (/FROM schema_version$/.test(this.sourceSQL.trim()) && ++reads === 2) upgrade();
      return row;
    } as typeof get;
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA journal_mode = WAL" && ++switches === 1) upgrade();
      return prepare.call(this, sql);
    } as typeof prepare;
    let refusal: unknown;
    try {
      await openSqliteStore({ path, busyTimeoutMs: 1_000 }).close();
    } catch (error) {
      refusal = error;
    } finally {
      StatementSync.prototype.get = get;
      DatabaseSync.prototype.prepare = prepare;
    }

    if (outcomes.includes("committed")) {
      // The race happened: the refusal must still leave every file byte for byte as it was.
      expect(refusal).toBeInstanceOf(SchemaTooNewError);
      expect(hashes()).toEqual(before as (string | null)[]);
    }
    // It cannot happen: the version is checked and the journal switched under one exclusive lock.
    expect(outcomes).toEqual(["busy", "busy"]);
    expect(refusal).toBeUndefined();
    expect(readFileSync(path).subarray(18, 20)).toEqual(Buffer.from([2, 2]));
  }, 30_000);

  for (const interleaving of INTERLEAVINGS) {
    test(`a store converted to WAL and upgraded concurrently (${interleaving}) is refused without changing the main file or the WAL`, async () => {
      const { before, after, refusal } = await openDuringUpgrade(path, interleaving);

      expect(refusal).toBeInstanceOf(SchemaTooNewError);
      // Positive control: the killed upgrader's commit sits in the WAL.
      expect(before?.[1]).not.toBeNull();
      expect(after.slice(0, 2)).toEqual((before ?? []).slice(0, 2));
      expect(after[2]).not.toBeNull();
    }, 30_000);
  }

  for (const damage of ["removed", "damaged"] as const) {
    test(`a newer schema in the WAL is refused without changing any file when the -shm is ${damage}`, async () => {
      const files = [path, `${path}-wal`, `${path}-shm`];
      const snapshot = () => files.map((file) => (existsSync(file) ? readFileSync(file) : null));

      await killAt("inside", start("die-holding-wal", path, barrier, "future"));
      damageShm(path, damage);
      const before = snapshot();

      expect(() => openSqliteStore({ path, busyTimeoutMs: 1_000 })).toThrow(SchemaTooNewError);

      expect(snapshot()).toEqual(before);
    }, 30_000);

    test(`control: at the current schema, a ${damage} -shm still opens and the WAL commit is read`, async () => {
      await killAt("inside", start("die-holding-wal", path, barrier, "current"));
      damageShm(path, damage);

      expect(await memoryIds()).toEqual(["m-in-wal"]);
    }, 30_000);
  }

  test("a WAL that cannot be replayed read-only is refused with a named error, changing no file", async () => {
    const files = [path, `${path}-wal`, `${path}-shm`];
    const snapshot = () => files.map((file) => (existsSync(file) ? readFileSync(file) : null));
    await killAt("inside", start("die-holding-wal", path, barrier, "current"));
    damageShm(path, "removed");
    const wal = readFileSync(`${path}-wal`);
    wal.writeUInt32BE(0xdeadbeef, 0);
    writeFileSync(`${path}-wal`, wal);
    const before = snapshot();

    expect(() => openSqliteStore({ path, busyTimeoutMs: 1_000 })).toThrow(StoreUnverifiedError);

    expect(snapshot()).toEqual(before);
  }, 30_000);

  test("control: the same killed writer at the current schema opens, and its WAL commit is read", async () => {
    await killAt("inside", start("die-holding-wal", path, barrier, "current"));
    expect(existsSync(`${path}-wal`)).toBe(true);

    expect(await memoryIds()).toEqual(["m-in-wal"]);
  }, 30_000);

  test("a killed writer's damaged wal-index still opens: the read-only probe hands recovery to the writer", async () => {
    await killAt("inside", start("die-holding-wal", path, barrier, "current"));
    // A writer killed while updating the wal-index leaves a -shm that needs recovery.
    const shm = readFileSync(`${path}-shm`);
    shm.fill(0, 0, 136);
    writeFileSync(`${path}-shm`, shm);

    expect(await memoryIds()).toEqual(["m-in-wal"]);
  }, 30_000);

  /**
   * What another process's half-done writes can leave of a store, and what SQLite answers to it:
   * pages missing (the header promises more than the file has: SQLITE_CORRUPT), or a first page
   * whose header is not written yet (SQLITE_NOTADB).
   */
  const TEARS = [
    { tear: "cut to its first page", errcode: 11, message: /malformed/ },
    { tear: "missing its header", errcode: 26, message: /not a database/ },
  ] as const;

  /** A closed store (no -wal or -shm), torn as `tear` says. Returns the full bytes. */
  async function tornStore(tear: (typeof TEARS)[number]["tear"]): Promise<Buffer> {
    await openSqliteStore({ path, busyTimeoutMs: 1_000 }).close();
    const full = readFileSync(path);
    const torn =
      tear === "cut to its first page"
        ? full.subarray(0, 4096)
        : Buffer.concat([Buffer.alloc(100), full.subarray(100)]);
    writeFileSync(path, torn);
    // Positive control: the tear changed the file, and the lock-free read is the one in play.
    expect(readFileSync(path).equals(full)).toBe(false);
    expect([`${path}-wal`, `${path}-shm`].map(existsSync)).toEqual([false, false]);
    return full;
  }

  for (const { tear, errcode, message } of TEARS) {
    test(`a store read while another process writes it (${tear}) opens once the writes land`, async () => {
      const full = await tornStore(tear);
      const copy = join(dir.path, "full-copy");
      writeFileSync(copy, full, { mode: 0o600 });
      const restorer = start("restore-after", path, barrier, copy);
      await waitFor(() => existsSync(join(barrier, "ready")) || restorer.child.exitCode !== null);
      if (restorer.child.exitCode !== null) throw new Error(`child exited: ${restorer.stderr()}`);

      // `go` is written only once the open has met the torn file, so the restore always comes
      // after a failed read and the open succeeds only by retrying.
      const torn: number[] = [];
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
        try {
          return prepare.call(this, sql);
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (torn.length === 0 && code !== undefined) {
            torn.push(code & 0xff);
            writeFileSync(join(barrier, "go"), "");
          }
          throw error;
        }
      } as typeof prepare;
      let store: ReturnType<typeof openSqliteStore>;
      try {
        store = openSqliteStore({ path, busyTimeoutMs: 10_000 });
      } finally {
        DatabaseSync.prototype.prepare = prepare;
      }
      expect(torn).toEqual([errcode]);
      const relembra = createRelembra({ store, policy: hostPolicy });
      await relembra.note(
        { user: "writer" },
        { scope: SCOPE, text: "After the tear.", provenance },
      );
      expect(await relembra.recall({ user: "reader" })).toHaveLength(1);
      await store.close();

      expect({ code: await restorer.exit, stderr: restorer.stderr() }).toEqual({
        code: 0,
        stderr: "",
      });
    }, 30_000);

    test(`a store that stays torn (${tear}) is refused with SQLite's error after the busy timeout, changing no file`, async () => {
      await tornStore(tear);
      const torn = readFileSync(path);

      const started = Date.now();
      let refusal: unknown;
      try {
        openSqliteStore({ path, busyTimeoutMs: 300 });
      } catch (error) {
        refusal = error;
      }
      const waited = Date.now() - started;

      expect(refusal).toBeInstanceOf(Error);
      expect(((refusal as { errcode?: number }).errcode ?? 0) & 0xff).toBe(errcode);
      expect((refusal as Error).message).toMatch(message);
      // It retried for the whole busy timeout before refusing.
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(readFileSync(path).equals(torn)).toBe(true);
      expect([`${path}-wal`, `${path}-shm`].map(existsSync)).toEqual([false, false]);
    }, 30_000);

    test(`control: with a busy timeout of 0, a torn store (${tear}) is refused at once`, async () => {
      await tornStore(tear);

      const started = Date.now();
      expect(() => openSqliteStore({ path, busyTimeoutMs: 0 })).toThrow(message);
      // Well under the default 5 s timeout, so no retry ran.
      expect(Date.now() - started).toBeLessThan(1_000);
    }, 30_000);
  }

  test("two processes opening a missing file at once both migrate it once and write", async () => {
    for (let round = 0; round < 5; round++) {
      const roundDir = join(dir.path, `round-${round}`);
      mkdirSync(roundDir);
      path = join(roundDir, "relembra.db");
      barrier = roundDir;
      const runs = ["alpha", "beta"].map((name) => start("open-fresh", path, barrier, name));
      await waitFor(() => ["alpha", "beta"].every((n) => existsSync(join(barrier, `ready-${n}`))));
      writeFileSync(join(barrier, "go"), "");

      const codes = await Promise.all(runs.map((run) => run.exit));
      expect({ codes, stderr: runs.map((run) => run.stderr()) }).toEqual({
        codes: [0, 0],
        stderr: ["", ""],
      });
      // Positive control: both committed writes are there, on a schema migrated exactly once.
      expect(await memoryIds()).toEqual(["alpha", "beta"]);
      const raw = new DatabaseSync(path);
      expect(raw.prepare("SELECT version FROM schema_version").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
      ]);
      raw.close();
    }
  }, 60_000);

  test("a migration killed between DDL statements leaves nothing, and the next open completes it", async () => {
    // A committed row from before the migration, which the interruption must not touch.
    const before = new DatabaseSync(path);
    before.exec("PRAGMA journal_mode = WAL");
    before.exec("CREATE TABLE keep (x INTEGER); INSERT INTO keep VALUES (42);");
    before.close();
    chmodSync(path, 0o600);

    const migrator = start("die-in-migration", path, barrier);
    await killAt("inside", migrator);

    const raw = new DatabaseSync(path);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => name);
    // Positive control: the committed row survived; none of the migration's tables did.
    expect(raw.prepare("SELECT x FROM keep").all()).toEqual([{ x: 42 }]);
    expect(tables).toEqual(["keep"]);
    raw.close();

    const store = openSqliteStore({ path, busyTimeoutMs: 1_000 });
    const relembra = createRelembra({ store, policy: hostPolicy });
    await relembra.note(
      { user: "writer" },
      { scope: SCOPE, text: "Migrated after all.", provenance },
    );
    expect(await relembra.recall({ user: "reader" })).toHaveLength(1);
    await store.close();
    const after = new DatabaseSync(path);
    expect(after.prepare("SELECT version FROM schema_version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);
    expect(after.prepare("SELECT x FROM keep").all()).toEqual([{ x: 42 }]);
    after.close();
  }, 30_000);
});

/** What a crash can leave of the wal-index: none, or a header that needs recovery. */
function damageShm(path: string, damage: "removed" | "damaged"): void {
  if (damage === "removed") {
    unlinkSync(`${path}-shm`);
    return;
  }
  const shm = readFileSync(`${path}-shm`);
  shm.fill(0, 0, 136);
  writeFileSync(`${path}-shm`, shm);
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a child process");
    await new Promise((done) => setTimeout(done, 5));
  }
}
