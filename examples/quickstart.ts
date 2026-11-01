// relembra quickstart: one SQLite file, one principal, every step of the tutorial.
// Run from a clone of the repository: bun examples/quickstart.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelembra, GuardError, type Principal } from "relembra";
import { openSqliteStore } from "relembra/sqlite";

// Policy: the host turns its own authenticated context into a principal.
type Context = { readonly user: string };
const owner: Principal = {
  id: "dev",
  readable: ["project-a"],
  writable: ["project-a"],
  promotable: [],
  pinnable: ["project-a"],
  owned: ["project-a"],
};
const policy = (_context: Context): Principal => owner;

// Store: one SQLite file, created with mode 0600.
const dir = mkdtempSync(join(tmpdir(), "relembra-"));
const store = openSqliteStore({ path: join(dir, "memory.db") });
const memory = createRelembra({ store, policy });

const me: Context = { user: "dev" };
const scope = "project-a";
const provenance = { agent: "quickstart", harness: "bun", model: "none", host: "laptop" };

try {
  // Note: one line, at most 280 bytes.
  await memory.note(me, {
    scope,
    text: "Migrations run with `bun run migrate`, never by hand.",
    provenance,
    pinned: true,
  });
  const port = await memory.note(me, {
    scope,
    text: "The API listens on port 8080 in development.",
    provenance,
  });
  await memory.note(me, {
    scope,
    text: "Tests need TZ=UTC or the date suite fails.",
    provenance,
  });

  // Find: ranked search (BM25) over the scopes this principal may read.
  console.log("find:");
  for (const { memory: found, score } of await memory.find(me, { query: "migrations" })) {
    console.log(`  ${score.toFixed(3)}  ${found.revision.text}`);
  }

  // Wake: the bounded block a session starts with.
  const wake = await memory.wake(me, { scope });
  console.log(`\nwake (${new TextEncoder().encode(wake.text).length} of 9500 bytes):`);
  console.log(wake.text);

  // Brief: a bounded block for one topic.
  const brief = await memory.brief(me, { topic: "which port does the api use", budgetBytes: 1000 });
  console.log("\nbrief:");
  console.log(brief.text);

  // Guard: a credential never becomes a memory.
  try {
    await memory.note(me, { scope, text: "Deploy with token=hunter2-2026", provenance });
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    console.log(`\nguard: ${error.message}`);
  }

  // Redact: the text becomes a tombstone everywhere.
  const redaction = await memory.redact(me, { memoryId: port.id });
  console.log(`\nredacted: ${redaction.redacted.length}, derived: ${redaction.derived.length}`);
  console.log((await memory.wake(me, { scope })).text);
} finally {
  // Close: wait for queued work, then release the file.
  await store.close();
  rmSync(dir, { recursive: true, force: true });
}
