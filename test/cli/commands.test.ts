import { afterAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/cli/commands.js";
import { OWNER_MODES } from "../../src/sqlite/database.js";
import { cliTest, exercised, exportedText, ok, ROOT, refused, run, sandbox } from "./support.js";

const box = sandbox();
afterAll(() => box.remove());

// The commands share one store and run in order: each builds on what the earlier ones wrote.
const ids = {} as Record<
  "deploy" | "migrations" | "pinned" | "cache" | "idempotent" | "summary",
  string
>;

describe("every command, end to end against the compiled binary", () => {
  cliTest(
    "init creates an owner-only store and prints both hook snippets, never writing them",
    () => {
      const data = ok(box, ["init"]);
      expect(data.scope).toBe(box.scope);
      expect(data.store).toBe(box.store);
      if (OWNER_MODES) {
        expect(statSync(box.store).mode & 0o777).toBe(0o600);
        expect(statSync(box.relembraHome).mode & 0o777).toBe(0o700);
      }
      for (const harness of [data.hooks.claudeCode, data.hooks.codex]) {
        const [group] = harness.hooks.SessionStart;
        expect(group.hooks[0].type).toBe("command");
        expect(group.hooks[0].command).toEndWith(" hook");
        // Every SessionStart source both harnesses document, fork included (Codex, Claude Code).
        expect(group.matcher.split("|").sort()).toEqual([
          "clear",
          "compact",
          "fork",
          "resume",
          "startup",
        ]);
      }
      // Text mode says the same; a second init keeps the store.
      const text = run(box, ["init"]);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain(box.scope);
      expect(text.stdout).toContain("SessionStart");
      expect(ok(box, ["init"]).created).toBe(false);
      // It prints the hook snippets and never writes them: HOME is the sandbox, so this would show.
      expect(existsSync(join(box.home, ".claude"))).toBe(false);
      expect(existsSync(join(box.home, ".codex"))).toBe(false);
    },
  );

  cliTest("note writes from an argument or stdin, with provenance from flags or env", () => {
    const first = ok(box, ["note", "The deploy runs from the release branch.", "--agent", "a1"]);
    expect(first.memory).toMatchObject({
      scope: box.scope,
      status: "live",
      revision: {
        number: 1,
        text: "The deploy runs from the release branch.",
        provenance: { agent: "a1", trust: "agent" },
      },
    });
    ids.deploy = first.memory.id;
    const second = ok(box, ["note"], {
      input: "Migrations run before the deploy.\n",
      env: { RELEMBRA_AGENT: "a2", RELEMBRA_HARNESS: "h2", RELEMBRA_MODEL: "m2" },
    });
    expect(second.memory.revision.text).toBe("Migrations run before the deploy.");
    expect(second.memory.revision.provenance).toMatchObject({
      agent: "a2",
      harness: "h2",
      model: "m2",
    });
    expect(second.memory.revision.provenance.host).not.toBe("");
    ids.migrations = second.memory.id;
    // Pinned at agent trust: owner trust needs a terminal (test/cli/trust.test.ts).
    const pinned = ok(box, ["note", "Never force-push main.", "--pin"]);
    expect(pinned.memory).toMatchObject({
      pinned: true,
      revision: { provenance: { trust: "agent" } },
    });
    ids.pinned = pinned.memory.id;
    // Text mode prints the id alone.
    const text = run(box, ["note", "The cache lives in Redis."]);
    expect(text.status).toBe(0);
    ids.cache = text.stdout.trim();
    expect(ids.cache).toMatch(/^[0-9a-f-]{36}$/);
  });

  cliTest("note with the same op id returns the first result", () => {
    const a = ok(box, ["note", "Idempotent fact.", "--op-id", "op-1"]);
    const b = ok(box, ["note", "Idempotent fact.", "--op-id", "op-1"]);
    expect(b.memory.id).toBe(a.memory.id);
    refused(box, ["note", "Another payload.", "--op-id", "op-1"], 1, "op-conflict");
    ids.idempotent = a.memory.id;
  });

  cliTest("find ranks the readable memories", () => {
    const data = ok(box, ["find", "deploy"]);
    expect(data.results.length).toBeGreaterThanOrEqual(2);
    expect(data.results.map((r: { memory: { id: string } }) => r.memory.id)).toContain(ids.deploy);
    for (const result of data.results) {
      expect(result.score).toBeGreaterThan(0);
      expect(result.memory.scope).toBe(box.scope);
    }
    expect(ok(box, ["find", "deploy", "--limit", "1"]).results).toHaveLength(1);
    expect(ok(box, ["find", "zebra"]).results).toEqual([]);
    const text = run(box, ["find", "deploy"]);
    expect(text.stdout).toContain(`<memory id="${ids.deploy}"`);
  });

  cliTest("recall lists the newest memories first", () => {
    const data = ok(box, ["recall"]);
    expect(data.memories[0].id).toBe(ids.idempotent);
    expect(data.memories).toHaveLength(5);
    expect(ok(box, ["recall", "--limit", "2"]).memories).toHaveLength(2);
  });

  cliTest("wake renders the bounded block, pinned first", () => {
    const data = ok(box, ["wake"]);
    expect(data.text.startsWith("<wake>\n")).toBe(true);
    expect(data.memoryIds[0]).toBe(ids.pinned);
    expect(run(box, ["wake"]).stdout).toBe(`${data.text}\n`);
    const small = ok(box, ["wake", "--budget", "200"]);
    expect(Buffer.byteLength(small.text)).toBeLessThanOrEqual(200);
    refused(box, ["wake", "--budget", "5"], 1, "budget");
  });

  cliTest("brief renders the block for a topic", () => {
    const data = ok(box, ["brief", "migrations", "deploy"]);
    expect(data.text.startsWith("<brief>\n")).toBe(true);
    expect(data.memoryIds).toContain(ids.migrations);
  });

  cliTest("pending lists what is due for a summary, oldest first", () => {
    const data = ok(box, ["pending"]);
    const pendingIds = data.memories.map((m: { id: string }) => m.id);
    expect(pendingIds[0]).toBe(ids.deploy);
    expect(pendingIds).not.toContain(ids.pinned);
  });

  cliTest("summarize writes a summary bound to source revisions; a stale source is refused", () => {
    const data = ok(box, [
      "summarize",
      "Deploys run from release after migrations.",
      "--of",
      `${ids.deploy}@1`,
      "--of",
      `${ids.migrations}@1`,
    ]);
    expect(data.memory.sources).toHaveLength(2);
    ids.summary = data.memory.id;
    refused(box, ["summarize", "Stale.", "--of", `${ids.deploy}@2`], 1, "source-changed");
    expect(ok(box, ["pending"]).memories.map((m: { id: string }) => m.id)).not.toContain(
      ids.deploy,
    );
  });

  cliTest("zoom shows one memory with provenance, and a summary's sources", () => {
    const data = ok(box, ["zoom", ids.summary as string]);
    expect(data.memory.id).toBe(ids.summary);
    expect(data.sources.map((s: { memoryId: string }) => s.memoryId).sort()).toEqual(
      [ids.deploy, ids.migrations].sort(),
    );
    expect(data.sources[0].memory.status).toBe("live");
    refused(box, ["zoom", "no-such-id"], 1, "not-found");
    expect(run(box, ["zoom", ids.deploy as string]).stdout).toContain("agent: a1");
  });

  cliTest("supersede replaces a live memory once", () => {
    const data = ok(box, ["supersede", ids.cache as string, "The cache lives in Valkey."]);
    expect(data.memory.revision.text).toBe("The cache lives in Valkey.");
    expect(ok(box, ["zoom", ids.cache as string]).memory).toMatchObject({
      status: "superseded",
      supersededBy: data.memory.id,
    });
    refused(box, ["supersede", ids.cache as string, "Again."], 1, "memory-state");
  });

  cliTest("superseding a summary is a refusal, not a store error", () => {
    refused(box, ["supersede", ids.summary as string, "A new summary."], 1, "summary-supersede");
    expect(ok(box, ["zoom", ids.summary as string]).memory.status).toBe("live");
  });

  cliTest("retract hides a memory from agents and keeps it in the owner view", () => {
    expect(ok(box, ["retract", ids.migrations as string])).toEqual({ memoryId: ids.migrations });
    expect(ok(box, ["find", "migrations"]).results).toEqual([]);
    const owner = ok(box, ["recall", "--retracted"]).memories;
    expect(owner.find((m: { id: string }) => m.id === ids.migrations).status).toBe("retracted");
  });

  cliTest("redact replaces the text with a tombstone, with the summaries derived from it", () => {
    const data = ok(box, ["redact", ids.deploy as string]);
    expect(data).toEqual({ redacted: [ids.deploy], derived: [ids.summary] });
    expect(ok(box, ["zoom", ids.deploy as string]).memory).toMatchObject({ status: "redacted" });
    expect(readFileSync(box.store).includes("The deploy runs from the release branch.")).toBe(
      false,
    );
  });

  cliTest("sweep redacts memories older than --max-age-days in the current scope only", () => {
    expect(ok(box, ["sweep", "--max-age-days", "30"])).toEqual({ redacted: [], derived: [] });
    refused(box, ["sweep"], 2, "usage");
    refused(box, ["sweep", "--max-age-days", "0"], 2, "usage");
  });

  cliTest("check verifies the store", () => {
    const data = ok(box, ["check"]);
    expect(data).toMatchObject({ scope: box.scope, store: box.store, integrity: "ok" });
    expect(data.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(data.events).toBeGreaterThan(0);
  });

  cliTest("hook prints the wake in the SessionStart hook format, ignoring stdin", () => {
    const result = run(box, ["hook"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toStartWith("<wake>\n");
    expect(output.hookSpecificOutput.additionalContext).toContain("Never force-push main.");
    // Claude Code caps additionalContext at 10,000 characters.
    expect(output.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);
    expect(ok(box, ["hook"])).toEqual(output);
  });

  cliTest("export prints the scope's JSONL; import replays it into another store once", () => {
    const text = run(box, ["export"]);
    expect(text.status).toBe(0);
    const lines = text.stdout
      .split("\n")
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ export: "relembra", format: 1, scopes: [box.scope] });
    expect(lines.slice(1).every((event) => event.scope === box.scope)).toBe(true);
    // The redacted memory is a tombstone in the export.
    expect(text.stdout).not.toContain("The deploy runs from the release branch.");
    expect(text.stdout).toContain("Never force-push main.");
    expect(ok(box, ["export"])).toEqual({ header: lines[0], events: lines.slice(1) });

    const file = join(box.home, "export.jsonl");
    writeFileSync(file, text.stdout, { mode: 0o600 });
    const other = { RELEMBRA_HOME: join(box.home, "other-store") };
    ok(box, ["init"], { env: other });
    const first = ok(box, ["import", file], { env: other });
    expect(first.imported + first.skipped).toBe(lines.length - 1);
    expect(first.imported).toBeGreaterThan(0);
    expect(ok(box, ["import", file], { env: other })).toMatchObject({ imported: 0 });
    const copied = ok(box, ["recall", "--retracted"], { env: other }).memories;
    const original = ok(box, ["recall", "--retracted"]).memories;
    expect(copied.map((m: { revision: { text: string } }) => m.revision.text)).toEqual(
      original.map((m: { revision: { text: string } }) => m.revision.text),
    );
    // Pinned in the source; an import never pins.
    expect(copied.some((m: { pinned: boolean }) => m.pinned)).toBe(false);
    expect(original.some((m: { pinned: boolean }) => m.pinned)).toBe(true);
  });

  cliTest("import refuses a newer format, another scope's export, and a bad command line", () => {
    const exported = exportedText(box);
    const [header, ...rest] = exported.split("\n");
    const newer = join(box.home, "newer.jsonl");
    writeFileSync(
      newer,
      // Format 2 (promote) is known; 3 is newer than this relembra.
      [JSON.stringify({ ...JSON.parse(header as string), format: 3 }), ...rest].join("\n"),
    );
    const result = refused(box, ["import", newer], 1, "import");
    expect(result.json?.ok === false && result.json.error.rule).toBe("format-too-new");
    // A lone surrogate, written as a JSON escape, is the only way one reaches the CLI.
    const lone = join(box.home, "lone.jsonl");
    writeFileSync(
      lone,
      [(header as string).replace(/"scopes":\["/, '"scopes":["\\ud800'), ...rest].join("\n"),
    );
    expect(readFileSync(lone, "utf8")).toContain("\\ud800");
    const loneResult = refused(box, ["import", lone], 1, "import");
    expect(loneResult.json?.ok === false && loneResult.json.error.rule).toBe("malformed");
    const elsewhere = { RELEMBRA_SCOPE: "some/other-scope" };
    const file = join(box.home, "export.jsonl");
    refused(box, ["import", file], 1, "scope-denied", { env: elsewhere });
    refused(box, ["import"], 2, "usage");
    refused(box, ["import", file, "--optmem", box.home], 2, "usage");
    refused(box, ["import", join(box.home, "absent.jsonl")], 2, "usage");
    refused(box, ["import", "--optmem", box.home], 2, "usage");
  });

  cliTest("import --optmem reads the synthetic OptMem store, once", () => {
    const fixture = join(ROOT, "test", "fixtures", "optmem");
    expect(ok(box, ["import", "--optmem", fixture])).toEqual({
      imported: 6,
      skipped: 0,
      refused: [],
    });
    const again = run(box, ["import", "--optmem", join(fixture, "memory")]);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe("imported: 0\nskipped: 6\n");
    const found = ok(box, ["find", "configuração"]).results;
    expect(found[0].memory.id).toMatch(/^om-[0-9a-f]{32}$/);
    expect(found[0].memory.revision.provenance.source).toMatch(/^optmem:[0-9a-f]{16}:3$/);
    expect(found[0].memory.revision.provenance.trust).toBe("agent");
  });

  cliTest("import --optmem removes the #<n> <date> prefix and keeps the date in the source", () => {
    const dir = join(box.home, "optmem-prefixed");
    mkdirSync(dir);
    const text = `Quokka synthetic fact for the prefix import. ${"x".repeat(230)}`;
    const wide = (body: string) => `${body.padEnd(319, " ")}\n`;
    writeFileSync(
      join(dir, "LOG.txt"),
      wide(`#0 2026-07-27 ${text}`) + wide("#1 2026-07-28 A second synthetic fact."),
    );
    expect(Buffer.byteLength(`#0 2026-07-27 ${text}`)).toBeGreaterThan(280);
    expect(ok(box, ["import", "--optmem", dir])).toEqual({ imported: 2, skipped: 0, refused: [] });
    const [found] = ok(box, ["find", "Quokka"]).results;
    expect(found.memory.revision.text).toBe(text);
    expect(found.memory.revision.provenance.source).toMatch(/^optmem:[0-9a-f]{16}:1:2026-07-27$/);
    // A counter out of place refuses the whole log, naming the rule and line, never the text.
    writeFileSync(join(dir, "LOG.txt"), wide("#0 2026-07-27 Kept.") + wide("#5 2026-07-27 Moved."));
    const result = refused(box, ["import", "--optmem", dir], 1, "import");
    expect(result.json?.ok === false && result.json.error.rule).toBe("not-optmem");
    expect(`${result.stdout}${result.stderr}`).not.toContain("Moved.");
  });

  cliTest("every command in the table ran with --json and exit 0", () => {
    // `mcp` prints no JSON document: its stdout carries MCP messages only, --json or not. Its
    // end-to-end suite is test/cli/mcp.test.ts and test/cli/mcp-sdk.test.ts.
    const documents = COMMANDS.map((command) => command.name).filter((name) => name !== "mcp");
    expect([...exercised].sort()).toEqual(documents.sort());
  });
});
