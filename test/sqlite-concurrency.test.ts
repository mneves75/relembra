import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSqliteStore } from "relembra/sqlite";
import { tempDir } from "./sqlite-support.js";

const WRITER = join(import.meta.dir, "sqlite-writer.ts");
const SCOPE = "concurrency/one-file";
const WRITERS = ["alpha", "beta"] as const;
const PER_WRITER = 200;
// 400 synchronous=FULL commits ran past 30 s on a hosted Windows runner, whose flushes are slow.
const BUDGET_MS = process.platform === "win32" ? 120_000 : 30_000;

describe("two writer processes on one sqlite file", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.remove());

  async function runWriters(mode: "store" | "lossy") {
    const path = join(dir.path, "relembra.db");
    const barrier = join(dir.path, "barrier");
    mkdirSync(barrier);
    // Create and migrate the file first, so the writers race only on writes.
    await openSqliteStore({ path }).close();

    const children: ChildProcess[] = [];
    try {
      const exits = WRITERS.map((name) => {
        const child = spawn(
          process.execPath,
          [WRITER, mode, path, barrier, name, String(PER_WRITER)],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        return new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`${name} exited ${code}: ${stderr}`)),
          );
        });
      });
      await waitFor(() => WRITERS.every((name) => existsSync(join(barrier, `ready-${name}`))));
      writeFileSync(join(barrier, "go"), "");
      await Promise.all(exits);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }

    const store = openSqliteStore({ path });
    try {
      const all = await store.recall({ scopes: [SCOPE], limit: 10 * PER_WRITER });
      const writers = all.map((memory) => memory.revision.provenance.agent);
      const switches = writers.filter((writer, i) => i > 0 && writer !== writers[i - 1]).length;
      return { count: all.length, switches, distinctIds: new Set(all.map((m) => m.id)).size };
    } finally {
      await store.close();
    }
  }

  test(
    "lose no write",
    async () => {
      const result = await runWriters("store");

      expect(result.count).toBe(WRITERS.length * PER_WRITER);
      expect(result.distinctIds).toBe(WRITERS.length * PER_WRITER);
      // Evidence the writers overlapped rather than ran one after the other.
      expect(result.switches).toBeGreaterThan(1);
    },
    BUDGET_MS,
  );

  test(
    "negative control: the same count check catches writers that lose writes",
    async () => {
      const result = await runWriters("lossy");

      // Each lossy writer overwrites the table with its own snapshot, so one writer's rows remain.
      expect(result.count).toBe(PER_WRITER);
      expect(result.count).not.toBe(WRITERS.length * PER_WRITER);
    },
    BUDGET_MS,
  );
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("writers never reached the start barrier");
    await new Promise((done) => setTimeout(done, 5));
  }
}
