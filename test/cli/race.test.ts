import { describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRelembra, type Memory } from "../../src/index.js";
import { openSqliteStore } from "../../src/sqlite/index.js";
import { BINARY, ok, ptyCliTest, type Sandbox, sandbox, sandboxEnv } from "./support.js";

const DAY = 86_400_000;
const SUMMARY = "Concurrent owner summary.";

/** A fresh sandbox holding one owner memory the host wrote, `ageDays` old. */
async function seeded(ageDays: number): Promise<{ box: Sandbox; source: Memory }> {
  const box = sandbox();
  ok(box, ["init"]);
  const store = openSqliteStore({ path: box.store });
  try {
    const relembra = createRelembra<null>({
      store,
      clock: { now: () => Date.now() - ageDays * DAY },
      policy: () => ({
        id: "host",
        readable: [box.scope],
        writable: [box.scope],
        promotable: [],
        owned: [box.scope],
        trustCeiling: "owner",
      }),
    });
    const provenance = { agent: "human", harness: "t", model: "none", host: "t", trust: "owner" };
    const source = await relembra.note(null, {
      scope: box.scope,
      text: "Ship on Fridays only after review.",
      provenance: { ...provenance, trust: "owner" as const },
    });
    return { box, source };
  } catch (error) {
    box.remove();
    throw error;
  }
}

/**
 * Runs `args` at a terminal answering its prompts with `answers`; after the first prompt (every
 * prompt with `each`) appears and before it is answered, a second process writes: it summarizes
 * the source, or with `write: "edit"` rewrites its text in place (concurrent-write.ts).
 */
function race(
  box: Sandbox,
  source: Memory,
  answers: string,
  args: string[],
  { each = false, write = "summary" }: { each?: boolean; write?: "summary" | "edit" } = {},
) {
  const between = [process.execPath, join(import.meta.dir, "concurrent-write.ts"), write];
  return spawnSync(
    "python3",
    [
      join(import.meta.dir, "pty-confirm.py"),
      "--between",
      JSON.stringify([...between, box.store, box.scope, source.id]),
      ...(each ? ["--each"] : []),
      answers,
      BINARY,
      ...args,
      "--json",
    ],
    { cwd: box.repo, env: sandboxEnv(box), encoding: "utf8", timeout: 60_000 },
  );
}

/** The output cut at each "Type <CODE> to confirm": piece k holds prompt k+1's listing. */
const prompts = (output: string) => output.split(/Type [A-Z0-9]{6} to confirm/);
const liveSummaries = (box: Sandbox) =>
  ok(box, ["find", "concurrent", "owner", "summary"]).results.length;

const OPS = [
  { name: "redact", ageDays: 0, args: (id: string) => ["redact", id] },
  { name: "retract", ageDays: 0, args: (id: string) => ["retract", id] },
  { name: "supersede", ageDays: 0, args: (id: string) => ["supersede", id, "Ship any day."] },
  { name: "sweep", ageDays: 400, args: () => ["sweep", "--max-age-days", "30"] },
] as const;

describe("a confirmation approves one plan: a write landing while the prompt waits is shown again", () => {
  for (const op of OPS) {
    ptyCliTest(`${op.name}: the unseen summary survives and the new prompt shows it`, async () => {
      const { box, source } = await seeded(op.ageDays);
      try {
        const result = race(box, source, "right,wrong", op.args(source.id));
        // The right code for the first prompt did not apply it to a plan that had grown.
        expect(liveSummaries(box)).toBe(1);
        expect(ok(box, ["zoom", source.id]).memory.status).toBe("live");
        const [first = "", second = ""] = prompts(result.stdout);
        expect(first).not.toContain(SUMMARY);
        expect(second).toContain(SUMMARY);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('"mismatch"');
      } finally {
        box.remove();
      }
    });

    ptyCliTest(
      `${op.name}: positive control, the same race confirmed again goes through`,
      async () => {
        const { box, source } = await seeded(op.ageDays);
        try {
          const result = race(box, source, "right,right", op.args(source.id));
          expect(prompts(result.stdout)[1]).toContain(SUMMARY);
          expect(result.status).toBe(0);
          expect(liveSummaries(box)).toBe(0);
          expect(ok(box, ["zoom", source.id]).memory.status).not.toBe("live");
        } finally {
          box.remove();
        }
      },
    );
  }

  ptyCliTest("a plan that keeps changing stops with plan-changed and writes nothing", async () => {
    const { box, source } = await seeded(0);
    try {
      const result = race(box, source, "right,right,right,right", ["redact", source.id], {
        each: true,
      });
      expect(prompts(result.stdout).length - 1).toBe(3);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('"plan-changed"');
      expect(liveSummaries(box)).toBe(3);
      expect(ok(box, ["zoom", source.id]).memory.status).toBe("live");
    } finally {
      box.remove();
    }
  });

  ptyCliTest("redact: text rewritten in place while the prompt waits is shown again", async () => {
    const { box, source } = await seeded(0);
    try {
      const result = race(box, source, "right,wrong", ["redact", source.id], { write: "edit" });
      // Regression: same id, seq, revision and trust, so the old code erased the new text.
      const zoomed = ok(box, ["zoom", source.id]).memory;
      expect(zoomed.status).toBe("live");
      expect(zoomed.revision.text).toBe("Concurrent in-place text.");
      expect(prompts(result.stdout)[1]).toContain("Concurrent in-place text.");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('"mismatch"');
    } finally {
      box.remove();
    }
  });
});
