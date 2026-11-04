import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRelembra, EgressDeniedError, type EgressFilter } from "relembra";
import { createMemoryExtension, WAKE_UNAVAILABLE } from "relembra/pi-durable";
import { openSqliteStore, type SqliteStore } from "relembra/sqlite";
import {
  answer,
  capturing,
  context,
  MEMORY_SCOPE,
  openHarness,
  piPolicy,
  piProvenance,
  run,
} from "./pi-durable-support.js";
import { selfKilled } from "./platform-support.js";
import { tempDir } from "./sqlite-support.js";

const CHILD = join(import.meta.dir, "pi-durable-wake-crash-child.ts");
const MARKER = "REVOKED_WAKE_ROUND2";
const LATER = "A fact noted while the writer was down.";

/**
 * Turn 1 renders a wake carrying MARKER; the process dies inside turn 2's model request, after
 * pi-durable committed the request's preparation; the host reopens with a new egress filter and
 * resumes turn 2. The resumed request must carry the wake as it renders now.
 */
describe("pi-durable wake after a crash inside a model request", () => {
  let dir: ReturnType<typeof tempDir>;
  let storePath: string;
  let piPath: string;
  let store: SqliteStore | undefined;
  beforeEach(() => {
    dir = tempDir();
    storePath = join(dir.path, "store", "relembra.db");
    piPath = join(dir.path, "pi.sqlite");
  });
  afterEach(async () => {
    await store?.close();
    store = undefined;
    dir.remove();
  });

  async function crashThenResume(egress: EgressFilter) {
    const seed = openSqliteStore({ path: storePath });
    await createRelembra({ store: seed, policy: piPolicy }).note(
      { user: "agent" },
      { scope: MEMORY_SCOPE, text: `${MARKER} names the old plan.`, provenance: piProvenance },
    );
    await seed.close();

    const child = spawnSync(process.execPath, [CHILD, piPath, storePath], { encoding: "utf8" });
    expect(selfKilled(child), child.stderr).toBe(true);

    store = openSqliteStore({ path: storePath });
    const relembra = createRelembra({ store, policy: piPolicy, egress });
    await relembra.note(
      { user: "agent" },
      { scope: MEMORY_SCOPE, text: LATER, provenance: piProvenance },
    );
    const extension = createMemoryExtension({
      relembra,
      hostNamespace: "wake-crash/journal-1",
      resolve: () => ({
        context: { user: "agent" },
        scope: MEMORY_SCOPE,
        provenance: piProvenance,
      }),
    });
    const requests: string[] = [];
    const { harness, root } = await openHarness(
      await openNodeSqliteStorage(piPath),
      [extension],
      [capturing(requests, answer("Two."))],
    );
    harness.resume();
    expect((await run(root, "Second turn.", "r2")).status).toBe("done");
    await harness.close(context);
    return { relembra, requests };
  }

  test("a wake revoked while the process was down is not resent by the resumed request", async () => {
    const { relembra, requests } = await crashThenResume((rendering) =>
      rendering.includes(MARKER)
        ? { allow: false, reason: "revoked" }
        : { allow: true, text: rendering },
    );

    // The host's filter now denies the wake.
    await expect(relembra.wake({ user: "agent" })).rejects.toThrow(EgressDeniedError);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain(MARKER);
    expect(requests[0]).toContain(WAKE_UNAVAILABLE.replaceAll('"', '\\"'));
  }, 60_000);

  test("control: with the filter still allowing, the resumed request carries the wake as it renders now", async () => {
    const { requests } = await crashThenResume((rendering) => ({ allow: true, text: rendering }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.split(MARKER)).toHaveLength(2);
    // Fresh: the memory noted after the crash is in it.
    expect(requests[0]).toContain(LATER);
  }, 60_000);
});
