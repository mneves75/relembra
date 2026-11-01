/**
 * One process of the pi-durable crash test. Usage:
 *
 *   bun pi-durable-crash-child.ts <commit-and-die|resume> <pi.sqlite> <relembra.db> <out.json>
 *     <op-id|none> <clock offset ms>
 *
 * `commit-and-die` asks the faux model for one memory_note call. Right after relembra commits the
 * memory, inside the tool's execute() and so before pi-durable stores the tool result (its journal
 * ack), it writes the memory's id and timestamp to <out.json> and SIGKILLs itself.
 * `resume` reopens both stores, lets pi-durable rerun the interrupted call, waits for the run to
 * settle, and writes how many notes ran and the tool results to <out.json>.
 * `none` drops the op id before relembra sees it: the control without op-id enforcement.
 */
import { writeFileSync } from "node:fs";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRelembra, type NoteInput, type Relembra } from "relembra";
import { createMemoryExtension } from "relembra/pi-durable";
import { openSqliteStore } from "relembra/sqlite";
import {
  answer,
  callTool,
  context,
  MEMORY_SCOPE,
  openHarness,
  type PiHostContext,
  piPolicy,
  piProvenance,
  resultText,
  run,
  toolResults,
} from "./pi-durable-support.js";

const CRASH_NAMESPACE = "crash-host/journal-1";
const CRASH_TEXT = "Deploys wait for the release branch.";
const INPUT = "Remember the deploy rule.";

const [mode, piPath, storePath, out, enforcement, offset] = process.argv.slice(2) as [
  "commit-and-die" | "resume",
  string,
  string,
  string,
  "op-id" | "none",
  string,
];

const store = openSqliteStore({ path: storePath, busyTimeoutMs: 5_000 });
const real = createRelembra({
  store,
  policy: piPolicy,
  clock: { now: () => Date.now() + Number(offset) },
});
let notes = 0;
const relembra: Relembra<PiHostContext> = {
  ...real,
  async note(host, input) {
    notes += 1;
    const memory = await real.note(host, enforcement === "none" ? withoutOpId(input) : input);
    if (mode === "commit-and-die") {
      writeFileSync(out, JSON.stringify({ id: memory.id, at: memory.revision.at }));
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    return memory;
  },
};

const extension = createMemoryExtension({
  relembra,
  hostNamespace: CRASH_NAMESPACE,
  resolve: () => ({ context: { user: "agent" }, scope: MEMORY_SCOPE, provenance: piProvenance }),
});
const script =
  mode === "commit-and-die"
    ? [callTool("memory_note", { text: CRASH_TEXT }, "call-1"), answer("Noted.")]
    : [answer("Noted.")];
const { harness, root } = await openHarness(
  await openNodeSqliteStorage(piPath),
  [extension],
  script,
);

if (mode === "commit-and-die") {
  await run(root, INPUT, "r1");
  throw new Error("the run settled: the tool never committed a memory");
}

harness.resume();
// The same request id finds the submission the killed process admitted.
const settled = await run(root, INPUT, "r1");
const results = (await toolResults(root)).map((r) => ({ isError: r.isError, text: resultText(r) }));
writeFileSync(out, JSON.stringify({ status: settled.status, notes, results }));
await harness.close(context);
await store.close();

function withoutOpId(input: NoteInput): NoteInput {
  const { opId: _dropped, ...rest } = input;
  return rest;
}
