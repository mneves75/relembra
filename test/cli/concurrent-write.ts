/**
 * A second process writing while the CLI waits at its owner prompt, through its own connection:
 *
 *     bun concurrent-write.ts summary <store> <scope> <memoryId>
 *     bun concurrent-write.ts edit <store> <scope> <memoryId>
 *
 * `summary`: the host (an owner principal) summarizes the memory with owner trust. `edit`: the
 * memory's text is rewritten in place in the store, keeping its id, seq, revision number, status
 * and trust, as a foreign writer could.
 */
import { createRelembra } from "../../src/index.js";
import { openSqliteStore } from "../../src/sqlite/index.js";

const [mode, path, scope, memoryId] = process.argv.slice(2) as [string, string, string, string];
const store = openSqliteStore({ path });
try {
  const relembra = createRelembra<null>({
    store,
    policy: () => ({
      id: "host",
      readable: [scope],
      writable: [scope],
      promotable: [],
      owned: [scope],
      trustCeiling: "owner",
    }),
  });
  const source = await relembra.zoom(null, { memoryId });
  if (source.status === "redacted") throw new Error(`${memoryId} is redacted`);
  if (mode === "edit") {
    const text = "Concurrent in-place text.";
    await store.transaction((tx) =>
      tx.putMemory({ ...source, revision: { ...source.revision, text } }),
    );
  } else if (mode === "summary") {
    await relembra.submitSummary(null, {
      scope,
      sources: [{ memoryId, revision: source.revision.number }],
      text: "Concurrent owner summary.",
      provenance: { agent: "human", harness: "test", model: "none", host: "test", trust: "owner" },
    });
  } else throw new Error(`unknown mode ${mode}`);
} finally {
  await store.close();
}
