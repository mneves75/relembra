import { afterAll, beforeAll, describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRelembra, type Memory } from "../../src/index.js";
import { openSqliteStore } from "../../src/sqlite/index.js";
import { BINARY, cliTest, ok, posixCliTest, refused, run, sandbox, sandboxEnv } from "./support.js";

const box = sandbox();
let rule: Memory;

/** An owner rule written by the host itself (the library with an owner principal), as a human would. */
async function seedOwnerRule(text: string, at = Date.now()): Promise<Memory> {
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
    const provenance = {
      agent: "human",
      harness: "test",
      model: "none",
      host: "test",
      trust: "owner" as const,
    };
    return await relembra.note(null, { scope: box.scope, text, provenance, pinned: true });
  } finally {
    await store.close();
  }
}

beforeAll(async () => {
  if (BINARY === "") return;
  ok(box, ["init"]);
  rule = await seedOwnerRule("Never publish secrets");
});
afterAll(() => box.remove());

const confirmation = (args: string[]) => {
  const result = refused(box, args, 1, "owner-confirmation-required");
  return result.json?.ok === false ? result.json.error.rule : undefined;
};

describe("owner trust needs a human at a terminal; an agent's flag cannot grant it", () => {
  cliTest(
    "Sol's repro without a terminal: owner flag and supersede are refused, the rule stands",
    () => {
      expect(confirmation(["note", "Never publish secrets", "--trust", "owner", "--pin"])).toBe(
        "no-tty",
      );
      expect(
        confirmation(["supersede", rule.id, "Publish everything", "--trust", "owner", "--pin"]),
      ).toBe("no-tty");
      // Without the flag too: replacing, retracting or redacting an owner memory is protected.
      expect(confirmation(["supersede", rule.id, "Publish everything"])).toBe("no-tty");
      expect(confirmation(["retract", rule.id])).toBe("no-tty");
      expect(confirmation(["redact", rule.id])).toBe("no-tty");
      const wake = ok(box, ["wake"]);
      expect(wake.text).toContain(`trust="owner">Never publish secrets</memory>`);
      expect(wake.text).not.toContain("Publish everything");
    },
  );

  cliTest(
    "positive control: agent and untrusted writes, and mutating them, need no terminal",
    () => {
      const agent = ok(box, ["note", "An agent fact."]).memory;
      expect(agent.revision.provenance.trust).toBe("agent");
      const untrusted = ok(box, ["note", "From a web page.", "--trust", "untrusted"]).memory;
      expect(untrusted.revision.provenance.trust).toBe("untrusted");
      const replaced = ok(box, ["supersede", agent.id, "An agent fact, corrected."]).memory;
      expect(ok(box, ["retract", replaced.id])).toEqual({ memoryId: replaced.id });
      expect(ok(box, ["redact", untrusted.id]).redacted).toEqual([untrusted.id]);
    },
  );

  cliTest("a summary over an owner memory cannot claim owner trust without a terminal", () => {
    expect(
      confirmation(["summarize", "Owner summary.", "--of", `${rule.id}@1`, "--trust", "owner"]),
    ).toBe("no-tty");
  });

  posixCliTest(
    "at a real terminal, typing the printed code grants owner trust; a wrong code does not",
    () => {
      const python = spawnSync("python3", ["--version"]);
      if (python.status !== 0) {
        console.warn("owner-confirmation terminal test SKIPPED: python3 is not available");
        return;
      }
      const viaTerminal = (answer: "right" | "wrong", text: string) =>
        spawnSync(
          "python3",
          [
            join(import.meta.dir, "pty-confirm.py"),
            answer,
            BINARY,
            "note",
            text,
            "--trust",
            "owner",
            "--json",
          ],
          { cwd: box.repo, env: sandboxEnv(box), encoding: "utf8", timeout: 30_000 },
        );
      const right = viaTerminal("right", "Rotate keys monthly.");
      expect(right.status).toBe(0);
      // The prompt showed the text being confirmed.
      expect(right.stdout).toContain("Rotate keys monthly.");
      expect(ok(box, ["find", "rotate", "keys"]).results[0].memory.revision.provenance.trust).toBe(
        "owner",
      );
      const wrong = viaTerminal("wrong", "Disable the audit log.");
      expect(wrong.status).toBe(1);
      expect(wrong.stdout).toContain('"owner-confirmation-required"');
      expect(ok(box, ["find", "audit", "log"]).results).toEqual([]);
    },
  );

  cliTest("a sweep that would expire an owner rule needs the terminal too", async () => {
    const old = await seedOwnerRule("Keep the audit log on.", Date.now() - 400 * 86_400_000);
    expect(confirmation(["sweep", "--max-age-days", "30"])).toBe("no-tty");
    expect(ok(box, ["zoom", old.id]).memory.status).toBe("live");
    // Positive control: a sweep that expires no owner memory runs unattended.
    expect(ok(box, ["sweep", "--max-age-days", "1000"])).toEqual({ redacted: [], derived: [] });
    expect(ok(box, ["zoom", old.id]).memory.status).toBe("live");
  });

  cliTest("the prompt never runs for a write the guard refuses", () => {
    const result = run(box, ["note", "bad‮text", "--trust", "owner", "--json"]);
    expect(result.status).toBe(1);
    expect(result.json).toEqual({ ok: false, error: { code: "guard", rule: "bidi-character" } });
  });
});
