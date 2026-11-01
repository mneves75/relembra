import { afterAll, beforeAll, describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRelembra,
  exportJsonl,
  importJsonl,
  type Memory,
  type Principal,
  type Trust,
} from "../../src/index.js";
import { openSqliteStore } from "../../src/sqlite/index.js";
import { createMemoryStore } from "../../src/testing/memory-store.js";
import { BINARY, cliTest, exportedText, ok, refused, sandbox } from "./support.js";

const box = sandbox();
let ownerRule: Memory;
let agentNote: Memory;
let agentNotes: Record<"retract" | "redact", Memory>;

const host = (scope: string): Principal => ({
  id: "host",
  readable: [scope],
  writable: [scope],
  promotable: [],
  pinnable: [scope],
  owned: [scope],
  trustCeiling: "owner",
});

/** A memory written by the host itself (the library with an owner principal). */
async function seed(text: string, trust: Trust, pinned: boolean): Promise<Memory> {
  const store = openSqliteStore({ path: box.store });
  try {
    const relembra = createRelembra<null>({ store, policy: () => host(box.scope) });
    const provenance = { agent: "human", harness: "test", model: "none", host: "test", trust };
    return await relembra.note(null, { scope: box.scope, text, provenance, pinned });
  } finally {
    await store.close();
  }
}

/**
 * An export of the box's scope that goes on to supersede `target`: the box's own export,
 * replayed into a scratch store where the host supersedes it, then exported again.
 */
async function supersedingExport(target: Memory, text: string): Promise<string> {
  const scratch = createMemoryStore();
  await importJsonl(scratch, host(box.scope), exportedText(box));
  const relembra = createRelembra<null>({ store: scratch, policy: () => host(box.scope) });
  const provenance = { agent: "a", harness: "test", model: "none", host: "test" };
  await relembra.supersede(null, {
    memoryId: target.id,
    text,
    provenance: { ...provenance, trust: "agent" as const },
  });
  const file = join(box.home, `supersede-${target.id}.jsonl`);
  writeFileSync(file, await exportJsonl(scratch, host(box.scope), { scope: box.scope }), {
    mode: 0o600,
  });
  return file;
}

/** The same, for a retract or a redact of `target` by the host. */
async function changingExport(target: Memory, change: "retract" | "redact"): Promise<string> {
  const scratch = createMemoryStore();
  await importJsonl(scratch, host(box.scope), exportedText(box));
  const relembra = createRelembra<null>({ store: scratch, policy: () => host(box.scope) });
  await relembra[change](null, { memoryId: target.id });
  const file = join(box.home, `${change}-${target.id}.jsonl`);
  writeFileSync(file, await exportJsonl(scratch, host(box.scope), { scope: box.scope }), {
    mode: 0o600,
  });
  return file;
}

const statusOf = (memory: Memory) => ok(box, ["zoom", memory.id]).memory.status;

beforeAll(async () => {
  if (BINARY === "") return;
  ok(box, ["init"]);
  ownerRule = await seed("Never publish secrets", "owner", false);
  agentNote = await seed("The build uses Bun", "agent", false);
  agentNotes = {
    retract: await seed("Tests run in CI", "agent", false),
    redact: await seed("Logs rotate daily", "agent", false),
  };
});
afterAll(() => box.remove());

describe("relembra import runs at agent trust, with no confirmation prompt", () => {
  cliTest("a replayed supersede of an owner memory is denied; the rule stands", async () => {
    const file = await supersedingExport(ownerRule, "Publish everything");
    const result = refused(box, ["import", file], 1, "import");
    expect(result.json?.ok === false && result.json.error.rule).toBe("denied:above-ceiling");
    const live = ok(box, ["recall"]).memories.map((m: Memory) => m.revision.text);
    expect(live).toContain("Never publish secrets");
    expect(live).not.toContain("Publish everything");
  });

  cliTest("positive control: a replayed supersede of an agent memory imports", async () => {
    const file = await supersedingExport(agentNote, "The build uses Bun 1.4");
    expect(ok(box, ["import", file])).toMatchObject({ imported: 2, refused: [] });
    const live = ok(box, ["recall"]).memories.map((m: Memory) => m.revision.text);
    expect(live).toContain("The build uses Bun 1.4");
    expect(live).not.toContain("The build uses Bun");
    expect(live).toContain("Never publish secrets");
  });

  for (const change of ["retract", "redact"] as const) {
    cliTest(`a replayed ${change} of an owner memory is denied; the rule stands`, async () => {
      const file = await changingExport(ownerRule, change);
      const result = refused(box, ["import", file], 1, "import");
      expect(result.json?.ok === false && result.json.error.rule).toBe("denied:above-ceiling");
      expect(statusOf(ownerRule)).toBe("live");
    });

    cliTest(`positive control: a replayed ${change} of an agent memory imports`, async () => {
      const file = await changingExport(agentNotes[change], change);
      expect(ok(box, ["import", file])).toMatchObject({ refused: [] });
      expect(statusOf(agentNotes[change])).toBe(change === "retract" ? "retracted" : "redacted");
      expect(statusOf(ownerRule)).toBe("live");
    });
  }
});
