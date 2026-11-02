import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openSqliteStore } from "relembra/sqlite";
import { MEMORY_SCOPE } from "./pi-durable-support.js";
import { selfKilled } from "./platform-support.js";
import { tempDir } from "./sqlite-support.js";

const CHILD = join(import.meta.dir, "pi-durable-crash-child.ts");
/** The reopened process's clock runs an hour ahead: the outcome must come from the store. */
const LATER = 3_600_000;

interface Committed {
  readonly id: string;
  readonly at: number;
}
interface Resumed {
  readonly status: string;
  readonly notes: number;
  readonly results: readonly { readonly isError: boolean; readonly text: string }[];
}

describe("pi-durable crash between the memory commit and the journal ack", () => {
  let dir: ReturnType<typeof tempDir>;
  let piPath: string;
  let storePath: string;
  beforeEach(() => {
    dir = tempDir();
    piPath = join(dir.path, "pi.sqlite");
    storePath = join(dir.path, "relembra.db");
  });
  afterEach(() => dir.remove());

  function child(mode: "commit-and-die" | "resume", enforcement: "op-id" | "none", out: string) {
    const offset = mode === "resume" ? LATER : 0;
    const process_ = spawn(
      process.execPath,
      [CHILD, mode, piPath, storePath, out, enforcement, String(offset)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    process_.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    return new Promise<{ code: number | null; signal: string | null; stderr: string }>(
      (resolve, reject) => {
        process_.on("error", reject);
        process_.on("exit", (code, signal) => resolve({ code, signal, stderr }));
      },
    );
  }

  async function stored(): Promise<Committed[]> {
    const store = openSqliteStore({ path: storePath, busyTimeoutMs: 5_000 });
    try {
      const memories = await store.recall({ scopes: [MEMORY_SCOPE], limit: 100 });
      return memories.map((memory) => ({ id: memory.id, at: memory.revision.at }));
    } finally {
      await store.close();
    }
  }

  async function crashAndResume(enforcement: "op-id" | "none") {
    const committedOut = join(dir.path, "committed.json");
    const killed = await child("commit-and-die", enforcement, committedOut);
    expect(
      selfKilled({ status: killed.code, signal: killed.signal, stderr: killed.stderr }),
      killed.stderr,
    ).toBe(true);
    const committed: Committed = JSON.parse(readFileSync(committedOut, "utf8"));
    // Positive control: the memory committed before the kill.
    expect(await stored()).toEqual([committed]);

    const resumedOut = join(dir.path, "resumed.json");
    const reopened = await child("resume", enforcement, resumedOut);
    expect(reopened.code, reopened.stderr).toBe(0);
    const resumed: Resumed = JSON.parse(readFileSync(resumedOut, "utf8"));
    expect(resumed.status).toBe("done");
    // pi-durable reran the call: the killed process never stored its result.
    expect(resumed.notes).toBe(1);
    return { committed, resumed };
  }

  test("the reopened run finds exactly one memory, with the same id and timestamp", async () => {
    const { committed, resumed } = await crashAndResume("op-id");

    expect(await stored()).toEqual([committed]);
    expect(resumed.results).toEqual([{ isError: false, text: `Noted memory ${committed.id}.` }]);
  }, 120_000);

  test("control: without op-id enforcement the same crash leaves two memories", async () => {
    const { committed } = await crashAndResume("none");

    const memories = await stored();
    expect(memories).toHaveLength(2);
    expect(memories.map((m) => m.id)).toContain(committed.id);
    expect(new Set(memories.map((m) => m.id)).size).toBe(2);
  }, 120_000);
});
