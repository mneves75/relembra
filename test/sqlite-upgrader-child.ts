/**
 * A child process for test/sqlite-race-support.ts (not a test file itself).
 *
 *   sqlite-upgrader-child.ts <db path> <version> [wal]
 *     Commits schema version <version> through a raw connection (switching the file to WAL first
 *     when `wal` is given), then kills itself with SIGKILL, so the commit stays in the -wal file,
 *     uncheckpointed. It imports nothing from relembra, so Bun and Node run it alike.
 */
import { DatabaseSync } from "node:sqlite";

const [path = "", version = "", wal = ""] = process.argv.slice(2);
const raw = new DatabaseSync(path);
raw.exec("PRAGMA busy_timeout = 5000");
if (wal === "wal") raw.exec("PRAGMA journal_mode = WAL");
raw.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${Number(version)}, 0)`);
process.kill(process.pid, "SIGKILL");
