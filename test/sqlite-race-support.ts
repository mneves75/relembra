/**
 * Interleavings of an open of a rollback-journal store with another process that converts it to
 * WAL and commits a newer schema, shared by the Bun tests and the Node smoke test.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openSqliteStore } from "relembra/sqlite";
import { MIGRATIONS } from "../src/sqlite/migrations.js";

const CHILD = join(fileURLToPath(new URL(".", import.meta.url)), "sqlite-upgrader-child.ts");

/**
 * - `converted-before-the-lock`: after the open read the header as rollback mode and before its
 *   switch takes the lock, another process switches the file to WAL, commits a newer schema and
 *   is killed.
 * - `upgraded-after-the-commit`: another connection switches the file to WAL before the lock; the
 *   switch reads the current version, and right after its COMMIT another process commits a newer
 *   schema and is killed.
 */
export type Interleaving = "converted-before-the-lock" | "upgraded-after-the-commit";
export const INTERLEAVINGS: readonly Interleaving[] = [
  "converted-before-the-lock",
  "upgraded-after-the-commit",
];

export interface RaceResult {
  /** sha256 of the main file, -wal and -shm (null when absent) once the killed commit is there. */
  readonly before: readonly (string | null)[] | undefined;
  readonly after: readonly (string | null)[];
  /** What the open threw. */
  readonly refusal: unknown;
}

/** Creates a schema-2 store at `path` in rollback-journal mode, then opens it through `interleaving`. */
export async function openDuringUpgrade(
  path: string,
  interleaving: Interleaving,
): Promise<RaceResult> {
  await openSqliteStore({ path, busyTimeoutMs: 1_000 }).close();
  const setup = new DatabaseSync(path);
  setup.exec("PRAGMA journal_mode = DELETE");
  setup.close();
  const files = [path, `${path}-wal`, `${path}-shm`];
  const hashes = () =>
    files.map((file) =>
      existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null,
    );
  const upgrade = (wal: boolean) => {
    const args = [CHILD, path, String(MIGRATIONS.length + 1), ...(wal ? ["wal"] : [])];
    const child = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (child.signal !== "SIGKILL") throw new Error(`upgrader was not killed: ${child.stderr}`);
  };

  const exec = DatabaseSync.prototype.exec;
  let phase: "waiting" | "locking" | "done" = "waiting";
  let before: (string | null)[] | undefined;
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN EXCLUSIVE" && phase === "waiting") {
      phase = "locking";
      if (interleaving === "converted-before-the-lock") {
        upgrade(true);
        before = hashes();
        phase = "done";
      } else {
        const convert = new DatabaseSync(path);
        exec.call(convert, "PRAGMA journal_mode = WAL");
        convert.close();
      }
    }
    exec.call(this, sql);
    if (sql === "COMMIT" && phase === "locking") {
      phase = "done";
      upgrade(false);
      before = hashes();
    }
  } as typeof exec;
  let refusal: unknown;
  try {
    await openSqliteStore({ path, busyTimeoutMs: 1_000 }).close();
  } catch (error) {
    refusal = error;
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  return { before, after: hashes(), refusal };
}
