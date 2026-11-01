import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { advanceFence, createRelembra, type Relembra } from "relembra";
import { createMemoryExtension } from "relembra/pi-durable";
import { openSqliteStore, type SqliteStore } from "relembra/sqlite";
import {
  answer,
  callTool,
  context,
  FENCE_KEY,
  MEMORY_SCOPE,
  openHarness,
  type PiHostContext,
  piPolicy,
  piProvenance,
  resultText,
  run,
  toolResults,
} from "./pi-durable-support.js";
import { tempDir } from "./sqlite-support.js";

/**
 * Two hosts, each the one owner of its own pi-durable storage, write to one relembra store under
 * one authority. Writer A holds epoch 1 and pauses inside its second note; the host takes over by
 * advancing the epoch to 2 and starting writer B; then A resumes.
 */
describe("pi-durable takeover through a host fencing epoch", () => {
  let dir: ReturnType<typeof tempDir>;
  let store: SqliteStore;
  beforeEach(() => {
    dir = tempDir();
    store = openSqliteStore({ path: join(dir.path, "relembra.db") });
  });
  afterEach(async () => {
    await store.close();
    dir.remove();
  });

  function writer(relembra: Relembra<PiHostContext>, name: string, epoch: number | undefined) {
    return createMemoryExtension({
      relembra,
      hostNamespace: `host-${name}/journal-1`,
      resolve: () => ({
        context: epoch === undefined ? { user: "agent" } : { user: "agent", epoch },
        scope: MEMORY_SCOPE,
        provenance: piProvenance,
      }),
    });
  }

  async function takeover(fenced: boolean) {
    const relembra = createRelembra({ store, policy: piPolicy });
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let notes = 0;
    const pausing: Relembra<PiHostContext> = {
      ...relembra,
      async note(host, input) {
        notes += 1;
        if (notes === 2) {
          paused.resolve();
          await release.promise;
        }
        return relembra.note(host, input);
      },
    };

    const a = await openHarness(
      await openNodeSqliteStorage(join(dir.path, "a.sqlite")),
      [writer(pausing, "a", fenced ? 1 : undefined)],
      [
        callTool("memory_note", { text: "Noted before the takeover." }, "a-1"),
        callTool("memory_note", { text: "Noted by the paused writer." }, "a-2"),
        answer("A is done."),
      ],
    );
    const aRun = run(a.root, "Work.");
    await paused.promise;

    await advanceFence(store, { key: FENCE_KEY, epoch: 2 });
    const b = await openHarness(
      await openNodeSqliteStorage(join(dir.path, "b.sqlite")),
      [writer(relembra, "b", fenced ? 2 : undefined)],
      [
        callTool("memory_note", { text: "Noted by the current writer." }, "b-1"),
        answer("B is done."),
      ],
    );
    expect((await run(b.root, "Work.")).status).toBe("done");

    release.resolve();
    expect((await aRun).status).toBe("done");

    const texts = (await relembra.recall({ user: "agent" })).map((m) => m.revision.text);
    const aResults = (await toolResults(a.root)).map((r) => [r.isError, resultText(r)]);
    const bResults = (await toolResults(b.root)).map((r) => r.isError);
    await a.harness.close(context);
    await b.harness.close(context);
    return { texts, aResults, bResults };
  }

  test("a paused writer resuming after the epoch advanced commits nothing; the current writer commits", async () => {
    const { texts, aResults, bResults } = await takeover(true);

    expect(texts.sort()).toEqual(["Noted before the takeover.", "Noted by the current writer."]);
    expect(bResults).toEqual([false]);
    // Positive control: writer A committed at epoch 1, before the takeover.
    expect(aResults[0]?.[0]).toBe(false);
    expect(aResults[1]?.[0]).toBe(true);
    expect(aResults[1]?.[1]).toContain("fenced");
  }, 60_000);

  test("control: without a fencing epoch the paused writer's note commits after the takeover", async () => {
    const { texts, aResults } = await takeover(false);

    expect(texts.sort()).toEqual([
      "Noted before the takeover.",
      "Noted by the current writer.",
      "Noted by the paused writer.",
    ]);
    expect(aResults.map(([isError]) => isError)).toEqual([false, false]);
  }, 60_000);
});
