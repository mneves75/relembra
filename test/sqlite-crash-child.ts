/**
 * A child process for test/sqlite-crash.test.ts (not a test file itself).
 *
 *   sqlite-crash-child.ts die-in-transaction <db path> <barrier dir>
 *     Commits m-committed, then opens a transaction that writes m-uncommitted, signals `inside`
 *     and never finishes. The parent kills it there.
 *   sqlite-crash-child.ts open-fresh <db path> <barrier dir> <name>
 *     Waits for `go`, opens the (missing) store, writes one memory named <name>, and exits.
 *   sqlite-crash-child.ts die-in-migration <db path> <barrier dir>
 *     Runs migration 1 with a pause between two of its DDL statements, signals `inside` there and
 *     never finishes. The parent kills it there.
 *   sqlite-crash-child.ts die-holding-wal <db path> <barrier dir> <future|current>
 *     Opens the store, commits a memory (and, for `future`, the next schema version) in WAL mode through
 *     handles it never closes, signals `inside` and never finishes. The parent kills it there, so
 *     the commits stay in the -wal file, uncheckpointed.
 *   sqlite-crash-child.ts commit-future-and-die <db path>
 *     Commits the next schema version to an existing WAL store through a raw connection, then
 *     kills itself with SIGKILL, so the commit stays in the -wal file, uncheckpointed.
 *   sqlite-crash-child.ts restore-after <db path> <barrier dir> <full copy>
 *     Signals `ready`, waits for `go`, then writes the full copy over the store file in place from
 *     offset 0, without truncating it, as a writer finishing its pages would.
 */
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Memory, NewEvent } from "relembra";
import { openSqliteStore } from "relembra/sqlite";
import { MIGRATIONS, migrate } from "../src/sqlite/migrations.js";

const CRASH_SCOPE = "crash/one-file";

const [mode, path = "", barrier = "", name = "child"] = process.argv.slice(2);

function crashMemory(id: string): Memory {
  return {
    id,
    scope: CRASH_SCOPE,
    seq: 1,
    pinned: false,
    notedAt: 1,
    status: "live",
    revision: {
      number: 1,
      text: `Memory ${id}.`,
      at: 1,
      provenance: { agent: id, harness: "h", model: "m", host: "h", trust: "agent", opId: id },
    },
  };
}

function noteEvent(memory: Memory): NewEvent {
  return {
    format: 1,
    kind: "note",
    memoryId: memory.id,
    scope: memory.scope,
    principalId: "crash",
    pinned: false,
    revision: memory.revision,
  };
}

function signal(file: string): void {
  writeFileSync(join(barrier, file), "");
}

/** Blocks the whole process, event loop included, until it is killed. */
function hang(): never {
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}

async function waitFor(file: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(join(barrier, file))) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`);
    await new Promise((done) => setTimeout(done, 2));
  }
}

if (mode === "die-in-transaction") {
  const store = openSqliteStore({ path });
  const committed = crashMemory("m-committed");
  await store.transaction(async (tx) => {
    await tx.append(noteEvent(committed));
    await tx.putMemory(committed);
  });
  await store.transaction(async (tx) => {
    const uncommitted = crashMemory("m-uncommitted");
    await tx.append(noteEvent(uncommitted));
    await tx.putMemory(uncommitted);
    signal("inside");
    hang();
  });
} else if (mode === "open-fresh") {
  signal(`ready-${name}`);
  await waitFor("go");
  const store = openSqliteStore({ path, busyTimeoutMs: 15_000 });
  const memory = crashMemory(name);
  await store.transaction(async (tx) => {
    await tx.append(noteEvent(memory));
    await tx.putMemory(memory);
  });
  await store.close();
} else if (mode === "die-in-migration") {
  const db = new DatabaseSync(path, { defensive: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.function("relembra_pause", () => {
    signal("inside");
    hang();
  });
  const sql = MIGRATIONS[0]?.sql ?? "";
  const split = sql.indexOf("CREATE TABLE memories");
  if (split < 0) throw new Error("migration 1 changed; update the pause point");
  migrate(db, [
    { version: 1, sql: `${sql.slice(0, split)} SELECT relembra_pause(); ${sql.slice(split)}` },
  ]);
} else if (mode === "die-holding-wal") {
  const store = openSqliteStore({ path });
  const memory = crashMemory("m-in-wal");
  await store.transaction(async (tx) => {
    await tx.append(noteEvent(memory));
    await tx.putMemory(memory);
  });
  if (name === "future") {
    const raw = new DatabaseSync(path);
    raw.exec(
      `INSERT INTO schema_version (version, applied_at) VALUES (${MIGRATIONS.length + 1}, 0)`,
    );
  }
  signal("inside");
  hang();
} else if (mode === "commit-future-and-die") {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${MIGRATIONS.length + 1}, 0)`);
  process.kill(process.pid, "SIGKILL");
  hang();
} else if (mode === "restore-after") {
  signal("ready");
  await waitFor("go");
  // The same file, not a rename: on macOS SQLite reports a replaced file as an I/O error.
  const full = readFileSync(name);
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, full, 0, full.length, 0);
  } finally {
    closeSync(fd);
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
