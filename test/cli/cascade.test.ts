import { afterEach, describe, expect } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { createRelembra, type Memory, type Relembra } from "../../src/index.js";
import { openSqliteStore } from "../../src/sqlite/index.js";
import { cliTest, ok, refused, type Sandbox, sandbox } from "./support.js";

const DAY = 86_400_000;
let box: Sandbox;
afterEach(() => box.remove());

/** Runs `fn` with the library as the host, at time `at`, with an owner-ceiling principal. */
async function asHost<T>(at: number, fn: (relembra: Relembra<null>) => Promise<T>): Promise<T> {
  const store = openSqliteStore({ path: box.store });
  try {
    const relembra = createRelembra<null>({
      store,
      clock: { now: () => at },
      policy: () => ({
        id: "host",
        readable: [box.scope],
        writable: [box.scope],
        promotable: [],
        pinnable: [box.scope],
        owned: [box.scope],
        trustCeiling: "owner",
      }),
    });
    return await fn(relembra);
  } finally {
    await store.close();
  }
}

const provenance = (trust: "owner" | "agent") => ({
  agent: "human",
  harness: "test",
  model: "none",
  host: "test",
  trust,
});

const noTty = (args: string[]) => {
  const result = refused(box, args, 1, "owner-confirmation-required");
  expect(result.json?.ok === false && result.json.error.rule).toBe("no-tty");
};

describe("owner confirmation covers everything a command would change, not just its target", () => {
  cliTest(
    "sweep: a superseded owner memory, which recall does not list, still needs the terminal",
    async () => {
      box = sandbox();
      ok(box, ["init"]);
      // Sol's repro: an owner rule from 400 days ago, superseded today by an agent memory.
      const old = await asHost(Date.now() - 400 * DAY, (r) =>
        r.note(null, {
          scope: box.scope,
          text: "Keep the audit log on.",
          provenance: provenance("owner"),
        }),
      );
      await asHost(Date.now(), (r) =>
        r.supersede(null, {
          memoryId: old.id,
          text: "Keep it on for a year.",
          provenance: provenance("agent"),
        }),
      );
      noTty(["sweep", "--max-age-days", "30"]);
      expect(ok(box, ["zoom", old.id]).memory.status).toBe("superseded");
      // Positive control: a sweep that expires nothing of the owner's runs unattended.
      expect(ok(box, ["sweep", "--max-age-days", "1000"])).toEqual({ redacted: [], derived: [] });
    },
  );

  cliTest(
    "redact, retract and supersede: an owner summary derived from the target needs it",
    async () => {
      box = sandbox();
      ok(box, ["init"]);
      const [source, summary] = await asHost(Date.now(), async (r) => {
        const a: Memory = await r.note(null, {
          scope: box.scope,
          text: "Deploys need two approvals.",
          provenance: provenance("owner"),
        });
        const s = await r.submitSummary(null, {
          scope: box.scope,
          sources: [{ memoryId: a.id, revision: 1 }],
          text: "Two approvals per deploy.",
          provenance: provenance("owner"),
        });
        return [a, s] as const;
      });
      // The library never lets a summary outrank its sources; data from elsewhere (an import, an
      // older or foreign writer) can. Lower the source to agent trust directly in the store.
      const raw = new DatabaseSync(box.store);
      raw
        .prepare(
          "UPDATE memories SET provenance = json_set(provenance, '$.trust', 'agent') WHERE id = ?",
        )
        .run(source.id);
      raw.close();
      expect(ok(box, ["zoom", source.id]).memory.revision.provenance.trust).toBe("agent");
      noTty(["redact", source.id]);
      noTty(["retract", source.id]);
      noTty(["supersede", source.id, "Deploys need one approval."]);
      expect(ok(box, ["zoom", summary.id]).memory.status).toBe("live");
      expect(ok(box, ["zoom", source.id]).memory.status).toBe("live");
      // Positive control: an agent memory with an agent summary is redacted with no terminal.
      const fact = ok(box, ["note", "Builds run nightly."]).memory;
      const agentSummary = ok(box, ["summarize", "Nightly builds.", "--of", `${fact.id}@1`]).memory;
      expect(ok(box, ["redact", fact.id])).toEqual({
        redacted: [fact.id],
        derived: [agentSummary.id],
      });
    },
  );
});
