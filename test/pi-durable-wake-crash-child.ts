/**
 * The process the wake-recovery test kills. Usage:
 *
 *   bun pi-durable-wake-crash-child.ts <pi.sqlite> <relembra.db>
 *
 * With an egress filter that allows everything, it runs turn 1 ("First turn.", request id r1) to
 * the end, then submits turn 2 ("Second turn.", r2) and SIGKILLs itself inside the second model
 * request's beforeRequest hooks: after pi-durable committed the request's preparation, before any
 * provider call. The test reopens both stores and resumes turn 2.
 */
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRelembra } from "relembra";
import { createMemoryExtension } from "relembra/pi-durable";
import { openSqliteStore } from "relembra/sqlite";
import {
  answer,
  context,
  MEMORY_SCOPE,
  openHarness,
  piPolicy,
  piProvenance,
  run,
} from "./pi-durable-support.js";

const [piPath, storePath] = process.argv.slice(2) as [string, string];

const store = openSqliteStore({ path: storePath, busyTimeoutMs: 5_000 });
const relembra = createRelembra({ store, policy: piPolicy });
let requests = 0;
const killer = {
  name: "killer",
  hooks: [
    {
      task: "pi.generation",
      handlers: {
        beforeRequest() {
          requests += 1;
          if (requests === 2) process.kill(process.pid, "SIGKILL");
          return undefined;
        },
      },
    },
  ],
};
const memory = createMemoryExtension({
  relembra,
  hostNamespace: "wake-crash/journal-1",
  resolve: () => ({ context: { user: "agent" }, scope: MEMORY_SCOPE, provenance: piProvenance }),
});
const { root } = await openHarness(
  await openNodeSqliteStorage(piPath),
  [memory, killer],
  [answer("One."), answer("Two.")],
);

await run(root, "First turn.", "r1");
await root.submit({ type: "input", content: "Second turn.", requestId: "r2" }, context);
await new Promise(() => {});
