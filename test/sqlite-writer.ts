/**
 * A writer process for the concurrent-writers test (not a test file itself).
 *
 *   sqlite-writer.ts <store|lossy> <db path> <barrier dir> <writer name> <count>
 *
 * `store` writes <count> memories through openSqliteStore, one transaction each.
 * `lossy` is the negative control: it snapshots the memories table, then (after every writer has
 * taken its snapshot) replaces the table with its snapshot plus its own rows, the classic lost
 * update. Both wait at a start barrier so the writers really run at the same time.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Memory } from "relembra";
import { openSqliteStore } from "relembra/sqlite";

const WRITER_SCOPE = "concurrency/one-file";

const [mode, path, barrier, name, countArg] = process.argv.slice(2);
if (mode === undefined || path === undefined || barrier === undefined || name === undefined) {
  throw new Error("usage: sqlite-writer.ts <store|lossy> <db> <barrier> <name> <count>");
}
const count = Number(countArg);

function memory(i: number): Memory {
  const id = `${name}-${i}`;
  return {
    id,
    scope: WRITER_SCOPE,
    seq: i,
    pinned: false,
    notedAt: i,
    status: "live",
    revision: {
      number: 1,
      text: `Written by ${name}, number ${i}.`,
      at: i,
      provenance: {
        agent: name ?? "",
        harness: "test",
        model: "test",
        host: "test",
        trust: "agent",
        opId: id,
      },
    },
  };
}

async function startTogether(): Promise<void> {
  writeFileSync(join(barrier ?? "", `ready-${name}`), "");
  const deadline = Date.now() + 15_000;
  while (!existsSync(join(barrier ?? "", "go"))) {
    if (Date.now() > deadline) throw new Error("the start barrier never opened");
    await new Promise((done) => setTimeout(done, 2));
  }
}

if (mode === "store") {
  const store = openSqliteStore({ path, busyTimeoutMs: 15_000 });
  await startTogether();
  for (let i = 1; i <= count; i++) {
    const noted = memory(i);
    await store.transaction(async (tx) => {
      await tx.append({
        format: 1,
        kind: "note",
        memoryId: noted.id,
        scope: noted.scope,
        principalId: name,
        pinned: false,
        revision: noted.revision,
      });
      await tx.putMemory(noted);
    });
    // A pause between writes, as real agents have; a hot loop can hold the lock for its whole run.
    await new Promise((done) => setTimeout(done, 1));
  }
  await store.close();
} else if (mode === "lossy") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 15000");
  const snapshot = db.prepare("SELECT * FROM memories ORDER BY position").all();
  await startTogether();
  db.exec("BEGIN IMMEDIATE");
  db.exec("DELETE FROM memories");
  const insert = db.prepare(
    "INSERT INTO memories (id, scope, seq, pinned, noted_at, revision_number, text, revised_at, provenance) VALUES (?, ?, 0, 0, ?, 1, ?, ?, ?)",
  );
  for (const row of snapshot) {
    const { id, scope, noted_at, text, revised_at, provenance } = row;
    insert.run(
      id ?? null,
      scope ?? null,
      noted_at ?? null,
      text ?? null,
      revised_at ?? null,
      provenance ?? null,
    );
  }
  for (let i = 1; i <= count; i++) {
    const noted = memory(i);
    insert.run(
      noted.id,
      noted.scope,
      noted.notedAt,
      noted.revision.text,
      noted.revision.at,
      JSON.stringify(noted.revision.provenance),
    );
  }
  db.exec("COMMIT");
  db.close();
} else {
  throw new Error(`unknown mode ${mode}`);
}
