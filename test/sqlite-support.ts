import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Event } from "relembra";
import { openSqliteStore, type SqliteStore } from "relembra/sqlite";
import type { ConformanceTarget } from "relembra/testing";

/** A fresh temporary directory, removed by the returned function. */
export function tempDir(): { readonly path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), "relembra-sqlite-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/** Opens each conformance case on its own SQLite file, deleted when the case ends. */
export const sqliteTarget: ConformanceTarget = {
  durable: true,
  open() {
    const dir = tempDir();
    const path = join(dir.path, "store", "relembra.db");
    const handles: SqliteStore[] = [openSqliteStore({ path })];
    return {
      store: handles[0] as SqliteStore,
      inspectEvents() {
        // A separate connection, so nothing goes through the store under test. Not readOnly: a
        // read-only connection cannot open a WAL file once every handle has closed (no -shm).
        const raw = new DatabaseSync(path);
        try {
          const rows = raw.prepare("SELECT seq, body FROM events ORDER BY seq").all() as {
            seq: number;
            body: string;
          }[];
          return rows.map((row): Event => ({ ...JSON.parse(row.body), seq: row.seq }));
        } finally {
          raw.close();
        }
      },
      rawBytes() {
        // The files as they are on disk: no checkpoint, so the store's own WAL handling is tested.
        const files = [path, `${path}-wal`, `${path}-shm`].filter((file) => existsSync(file));
        return Buffer.concat(files.map((file) => readFileSync(file)));
      },
      reopen() {
        const handle = openSqliteStore({ path });
        handles.push(handle);
        return handle;
      },
      async close() {
        try {
          for (const handle of handles) await handle.close();
        } finally {
          dir.remove();
        }
      },
    };
  },
};
