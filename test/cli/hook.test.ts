import { afterEach, describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, openSync, statSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  BINARY,
  cliTest,
  HOOK_SHELL,
  hookSilence,
  ok,
  type RunOptions,
  run,
  type Sandbox,
  sandbox,
  sandboxEnv,
} from "./support.js";

let box: Sandbox;
afterEach(() => {
  try {
    chmodSync(box.store, 0o600);
  } catch {}
  box.remove();
});

/** The hook in text and JSON mode: exit 0, nothing in the session's context. */
function expectSilent(options: RunOptions = {}, args: string[] = []) {
  const text = run(box, ["hook", ...args], options);
  expect({ status: text.status, stdout: text.stdout }).toEqual({ status: 0, stdout: "" });
  const json = run(box, ["hook", "--json", ...args], options);
  expect({ status: json.status, json: json.json }).toEqual({
    status: 0,
    json: { ok: true, data: null },
  });
}

describe("the session-start hook fails open: whatever goes wrong, exit 0 and no context", () => {
  cliTest("an invalid RELEMBRA_SCOPE (Sol's repro: it exited 2)", () => {
    box = sandbox();
    ok(box, ["init"]);
    expectSilent({ env: { RELEMBRA_SCOPE: "a\nb" } });
  });

  cliTest("a corrupt store (Sol's repro: it exited 3 with diagnostics)", () => {
    box = sandbox();
    ok(box, ["init"]);
    ok(box, ["note", "a fact"]);
    const size = statSync(box.store).size;
    const fd = openSync(box.store, "r+");
    writeSync(fd, Buffer.alloc(size, 0xa5), 0, size, 0);
    closeSync(fd);
    expectSilent();
  });

  cliTest("a newer schema, a loose store, an unknown flag", () => {
    box = sandbox();
    ok(box, ["init"]);
    const raw = new DatabaseSync(box.store);
    raw.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(999, 0);
    raw.close();
    expectSilent();
    chmodSync(box.store, 0o644);
    expectSilent();
    chmodSync(box.store, 0o600);
    expectSilent({}, ["--bogus"]);
  });

  cliTest(
    "the hook command init prints clears Bun's startup variables before the binary runs",
    () => {
      box = sandbox();
      const command = ok(box, ["init"]).hooks.claudeCode.hooks.SessionStart[0].hooks[0].command;
      ok(box, ["note", "Deploys go through staging."]);
      const viaHarness = (extra: Record<string, string>) =>
        spawnSync(HOOK_SHELL, ["-c", command], {
          cwd: box.repo,
          env: sandboxEnv(box, extra),
          encoding: "utf8",
          timeout: 30_000,
        });
      // Sol's repro: Bun acts on these before relembra's code, so no in-binary check can refuse them.
      const direct = spawnSync(BINARY, ["hook"], {
        cwd: box.repo,
        env: sandboxEnv(box, { BUN_OPTIONS: "--version" }),
        encoding: "utf8",
      });
      expect(direct.stdout).not.toContain("SessionStart");
      for (const extra of [
        { BUN_OPTIONS: "--version" },
        { BUN_BE_BUN: "1" },
        { BUN_OPTIONS: "--help" },
      ]) {
        const result = viaHarness(extra);
        expect({ extra, status: result.status }).toEqual({ extra, status: 0 });
        expect(hookSilence(box, command, result.stdout, extra)).toBe("printed");
        expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(
          "Deploys go through staging.",
        );
      }
      // The host's RELEMBRA_* variables still reach the binary through it.
      const elsewhere = viaHarness({ RELEMBRA_SCOPE: "someone-else/other" });
      expect(elsewhere.status).toBe(0);
      expect(JSON.parse(elsewhere.stdout).hookSpecificOutput.additionalContext).not.toContain(
        "Deploys go through staging.",
      );
    },
  );

  cliTest("positive control: a healthy store's hook carries the wake", () => {
    box = sandbox();
    ok(box, ["init"]);
    ok(box, ["note", "Deploys go through staging."]);
    const result = run(box, ["hook"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(
      "Deploys go through staging.",
    );
  });
});
