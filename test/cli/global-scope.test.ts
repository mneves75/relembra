/**
 * Ticket global-memory/02: RELEMBRA_GLOBAL_SCOPE names a scope the CLI principal also reads.
 * Reads (wake, hook, find, brief, recall, zoom, and the MCP server's find, brief and wake) cover
 * the session's scope and the global one; writes and maintenance stay on the session's scope.
 * End to end against the compiled binary. Every fixture is synthetic.
 */
import { afterAll, describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { call, lines, mcp, toolText } from "./mcp-support.js";
import {
  cliTest,
  HOOK_SHELL,
  hookSilence,
  ok,
  refused,
  run,
  type Sandbox,
  sandbox,
  sandboxEnv,
} from "./support.js";

const G = "team/global-rules";
const boxes: Sandbox[] = [];
afterAll(() => {
  for (const box of boxes) box.remove();
});

function ready(): Sandbox {
  const box = sandbox();
  boxes.push(box);
  ok(box, ["init"]);
  return box;
}

const IN_G = { RELEMBRA_SCOPE: G };
const WITH_G = { RELEMBRA_GLOBAL_SCOPE: G };
const DEFAULT_BUDGET = 9_500;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** The `<wake>` frames of a rendering, in order. */
const frames = (text: string) => text.match(/<wake>\n[\s\S]*?<\/wake>/g) ?? [];

/** The hook's context in the sandbox's repository, with `env` added. */
function hookContext(box: Sandbox, env: Record<string, string> = {}): string {
  const result = run(box, ["hook"], { env });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
}

/**
 * Fills a scope past the default wake budget through one MCP server: `count` memories of about
 * 200 bytes, the first five pinned, then one summary of every unpinned one, so a wake renders
 * the pins, then the summary, then the memories it covers. Returns the newest pin's text.
 */
function fill(box: Sandbox, env: Record<string, string>, label: string, count = 60): string {
  const texts = Array.from(
    { length: count },
    (_, i) =>
      `${label} rule ${i}: keep release notes short, name the owner of each step, and write the date of the change in the log before the deploy window opens on the shared calendar.`,
  );
  const result = mcp(box, lines(...texts.map((text, i) => call(i, "note", { text, pin: i < 5 }))), {
    env,
  });
  const ids = texts.map((_, i) => result.byId(i).result.structuredContent.memoryId as string);
  const of = ids.slice(5).flatMap((id) => ["--of", `${id}@1`]);
  ok(box, ["summarize", `${label} summary: release notes stay short and dated.`, ...of], { env });
  return texts[4] as string;
}

describe("RELEMBRA_GLOBAL_SCOPE: the session also reads the global scope", () => {
  cliTest("find, wake, hook, brief, recall and zoom read g only when the variable names it", () => {
    const box = ready();
    const id = ok(box, ["note", "The staging cluster restarts every Sunday at noon."], {
      env: IN_G,
    }).memory.id as string;
    ok(box, ["note", "Project fact: the harbor build listens on port 4100."]);

    // With the variable: every read in project P covers g too.
    const found = ok(box, ["find", "staging", "cluster"], { env: WITH_G }).results;
    expect(found.map((r: { memory: { scope: string } }) => r.memory.scope)).toEqual([G]);
    expect(ok(box, ["wake"], { env: WITH_G }).text).toContain("restarts every Sunday");
    expect(hookContext(box, WITH_G)).toContain("restarts every Sunday");
    expect(hookContext(box, WITH_G)).toContain("harbor build");
    expect(ok(box, ["brief", "staging"], { env: WITH_G }).text).toContain("restarts every Sunday");
    const scopes = ok(box, ["recall"], { env: WITH_G }).memories.map(
      (m: { scope: string }) => m.scope,
    );
    expect(new Set(scopes)).toEqual(new Set([box.scope, G]));
    expect(ok(box, ["zoom", id], { env: WITH_G }).memory.scope).toBe(G);

    // Without it (the negative control): P alone, as before.
    expect(ok(box, ["find", "staging", "cluster"]).results).toEqual([]);
    expect(ok(box, ["wake"]).text).not.toContain("restarts every Sunday");
    expect(hookContext(box)).not.toContain("restarts every Sunday");
    expect(hookContext(box)).toContain("harbor build");
    refused(box, ["zoom", id], 1, "not-found");
  });

  cliTest("note writes to P's scope; retract of a g memory is scope-denied from P", () => {
    const box = ready();
    const id = ok(box, ["note", "Global fact to keep."], { env: IN_G }).memory.id as string;
    const written = ok(box, ["note", "Written from the project."], { env: WITH_G }).memory;
    expect(written.scope).toBe(box.scope);
    expect(ok(box, ["recall"], { env: IN_G }).memories.map((m: { id: string }) => m.id)).toEqual([
      id,
    ]);
    refused(box, ["retract", id], 1, "scope-denied", { env: WITH_G });
    refused(box, ["redact", id], 1, "scope-denied", { env: WITH_G });
    refused(box, ["supersede", id, "Replaced from the project."], 1, "scope-denied", {
      env: WITH_G,
    });
    expect(ok(box, ["find", "global", "fact"], { env: IN_G }).results).toHaveLength(1);
    // Positive control: with RELEMBRA_SCOPE set to g, the same retract works.
    expect(ok(box, ["retract", id], { env: { ...IN_G, ...WITH_G } }).memoryId).toBe(id);
    expect(ok(box, ["find", "global", "fact"], { env: IN_G }).results).toEqual([]);
  });

  cliTest("pending, export and check stay on the session's scope", () => {
    const box = ready();
    ok(box, ["note", "A global memory due for a summary."], { env: IN_G });
    ok(box, ["note", "A project memory due for a summary."]);
    const pending = ok(box, ["pending"], { env: WITH_G }).memories;
    expect(pending.map((m: { scope: string }) => m.scope)).toEqual([box.scope]);
    // Positive control: in g, the global memory is due.
    expect(
      ok(box, ["pending"], { env: IN_G }).memories.map((m: { scope: string }) => m.scope),
    ).toEqual([G]);
    const exported = ok(box, ["export"], { env: WITH_G });
    expect(exported.header.scopes).toEqual([box.scope]);
    expect(JSON.stringify(exported.events)).not.toContain("A global memory");
    expect(JSON.stringify(exported.events)).toContain("A project memory");
    expect(ok(box, ["check"], { env: WITH_G }).scope).toBe(box.scope);
  });

  cliTest("the same scope named twice is one scope", () => {
    const box = ready();
    ok(box, ["note", "Only one copy of me renders."], { env: IN_G });
    const once = ok(box, ["wake"], { env: IN_G });
    const twice = ok(box, ["wake"], { env: { ...IN_G, ...WITH_G } });
    expect(twice).toEqual(once);
    expect(frames(twice.text)).toHaveLength(1);
    expect(twice.memoryIds).toHaveLength(1);
  });

  cliTest("outside a repository, the global scope is the session's scope", () => {
    const box = ready();
    const outside = dirname(box.repo);
    const memory = ok(box, ["note", "Noted outside any project."], {
      cwd: outside,
      env: WITH_G,
    }).memory;
    expect(memory.scope).toBe(G);
    const wake = ok(box, ["wake"], { cwd: outside, env: WITH_G }).text as string;
    expect(wake).toContain("Noted outside any project.");
    expect(frames(wake)).toHaveLength(1);
    expect(ok(box, ["init"], { cwd: outside, env: WITH_G }).scope).toBe(G);
    // Unset, behavior is unchanged: no scope.
    refused(box, ["note", "homeless"], 2, "no-scope", { cwd: outside });
    refused(box, ["wake"], 2, "no-scope", { cwd: outside });
    expect(ok(box, ["init"], { cwd: outside }).scope).toBeNull();
    const hook = run(box, ["hook"], { cwd: outside });
    expect({ status: hook.status, stdout: hook.stdout }).toEqual({ status: 0, stdout: "" });
  });

  cliTest("a bad RELEMBRA_GLOBAL_SCOPE is refused as a bad RELEMBRA_SCOPE; hook fails open", () => {
    const box = ready();
    for (const bad of ["a\nb", "x".repeat(257)]) {
      const env = { RELEMBRA_GLOBAL_SCOPE: bad };
      refused(box, ["wake"], 2, "bad-scope", { env });
      refused(box, ["note", "never written"], 2, "bad-scope", { env });
      refused(box, ["wake"], 2, "bad-scope", { env: { ...env, ...IN_G } });
      const hook = run(box, ["hook"], { env });
      expect({ status: hook.status, stdout: hook.stdout }).toEqual({ status: 0, stdout: "" });
      expect(hook.stderr).toContain("relembra hook: skipped (bad-scope)");
      const server = mcp(box, "", { env });
      expect(server.status).toBe(2);
      expect(server.stdout).toBe("");
    }
    // Positive control: an empty one counts as unset.
    expect(ok(box, ["wake"], { env: { RELEMBRA_GLOBAL_SCOPE: "" } }).text).toContain("<wake>");
    expect(ok(box, ["recall"]).memories).toEqual([]);
  });

  cliTest("init's hook command passes RELEMBRA_GLOBAL_SCOPE through env -i", () => {
    const box = ready();
    const command = ok(box, ["init"]).hooks.claudeCode.hooks.SessionStart[0].hooks[0]
      .command as string;
    expect(command).toContain('RELEMBRA_GLOBAL_SCOPE="$RELEMBRA_GLOBAL_SCOPE"');
    ok(box, ["note", "A rule every project should see."], { env: IN_G });
    const viaHarness = (extra: Record<string, string>) => {
      const result = spawnSync(HOOK_SHELL, ["-c", command], {
        cwd: box.repo,
        env: sandboxEnv(box, extra),
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(hookSilence(box, command, result.stdout, extra)).toBe("printed");
      return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    };
    expect(viaHarness(WITH_G)).toContain("A rule every project should see.");
    expect(viaHarness({})).not.toContain("A rule every project should see.");
  });
});

describe("wake and hook reserve room for each scope; unused room passes to the other", () => {
  cliTest("a full global scope (pins, a summary) leaves the project's memory in the hook", () => {
    const box = ready();
    ok(box, ["note", "Project fact: the harbor build listens on port 4100."]);
    const newestPin = fill(box, IN_G, "Global");
    // Control: g alone overflows the default budget, so its wake ends in an index.
    expect(ok(box, ["wake"], { env: IN_G }).text).toContain("<index ");
    const context = hookContext(box, WITH_G);
    expect(bytes(context)).toBeLessThanOrEqual(DEFAULT_BUDGET);
    const [project, glob] = frames(context);
    expect(project).toContain("Project fact: the harbor build listens on port 4100.");
    expect(project).not.toContain("Global rule");
    // g's pins and summary come first in its part; it used the room the project left unused.
    expect(glob).toContain(newestPin);
    expect(glob).toContain("Global summary: release notes stay short and dated.");
    expect(bytes(glob as string)).toBeGreaterThan(Math.floor((DEFAULT_BUDGET - 1) / 2));
    // The same composition for wake, with its ids in order: the project's, then g's.
    const wake = ok(box, ["wake"], { env: WITH_G });
    expect(wake.text).toBe(context);
  });

  cliTest("a full project (pins, a summary) leaves the global memory in the hook", () => {
    const box = ready();
    ok(box, ["note", "Global fact: every commit message says why."], { env: IN_G });
    const newestPin = fill(box, {}, "Project");
    expect(ok(box, ["wake"]).text).toContain("<index ");
    const context = hookContext(box, WITH_G);
    expect(bytes(context)).toBeLessThanOrEqual(DEFAULT_BUDGET);
    const [mine, glob] = frames(context);
    expect(glob).toContain("Global fact: every commit message says why.");
    expect(mine).toContain(newestPin);
    expect(mine).toContain("Project summary: release notes stay short and dated.");
    expect(bytes(mine as string)).toBeGreaterThan(Math.floor((DEFAULT_BUDGET - 1) / 2));
  });

  cliTest("both full: each part fills its reservation; --budget sets the whole", () => {
    const box = ready();
    const globalPin = fill(box, IN_G, "Global");
    const projectPin = fill(box, {}, "Project");
    // Room a part cannot use, because its next line does not fit: well under one memory line.
    const slack = 450;
    for (const budget of [DEFAULT_BUDGET, 3_000]) {
      const text = ok(box, ["wake", "--budget", String(budget)], { env: WITH_G }).text as string;
      expect(bytes(text)).toBeLessThanOrEqual(budget);
      const [mine, glob] = frames(text);
      const projectShare = Math.floor((budget - 1) / 2);
      const globalShare = budget - 1 - projectShare;
      expect(bytes(mine as string)).toBeGreaterThan(projectShare - slack);
      expect(bytes(glob as string)).toBeGreaterThan(globalShare - slack);
      expect(mine).toContain(projectPin);
      expect(glob).toContain(globalPin);
    }
  });
});

describe("relembra mcp: reads widen to the global scope, writes stay on the session's", () => {
  cliTest("find and wake show g; note writes P; retract of a g memory is refused", () => {
    const box = ready();
    const id = ok(box, ["note", "The staging cluster restarts every Sunday at noon."], {
      env: IN_G,
    }).memory.id as string;
    const result = mcp(
      box,
      lines(
        call(1, "find", { query: "staging cluster" }),
        call(2, "wake"),
        call(3, "note", { text: "Written through MCP in the project." }),
        call(4, "retract", { memoryId: id }),
      ),
      { env: WITH_G },
    );
    expect(toolText(result.byId(1))).toContain(`scope="${G}"`);
    expect(toolText(result.byId(2))).toContain("restarts every Sunday");
    expect(result.byId(3).result.isError).toBe(false);
    expect(toolText(result.byId(4))).toContain("refused: scope-denied");
    const mine = ok(box, ["recall"]).memories.map(
      (m: { scope: string; revision: { text: string } }) => [m.scope, m.revision.text],
    );
    expect(mine).toEqual([[box.scope, "Written through MCP in the project."]]);
    expect(ok(box, ["find", "staging"], { env: IN_G }).results).toHaveLength(1);
    // Negative control: without the variable the server reads P only.
    const alone = mcp(box, lines(call(5, "find", { query: "staging cluster" })));
    expect(toolText(alone.byId(5))).toBe("<find>\n</find>");
  });
});
