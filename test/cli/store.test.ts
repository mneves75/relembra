import { afterEach, describe, expect } from "bun:test";
import { chmodSync, closeSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRelembra, type Principal } from "relembra";
import { openSqliteStore } from "relembra/sqlite";
import { cliTest, ok, refused, run, type Sandbox, sandbox } from "./support.js";

let box: Sandbox;
afterEach(() => {
  try {
    chmodSync(box.store, 0o600);
  } catch {}
  box.remove();
});

/** A sandbox whose store exists and holds one memory. */
function withStore(): Sandbox {
  box = sandbox();
  ok(box, ["init"]);
  ok(box, ["note", "a fact to keep"]);
  return box;
}

describe("store errors exit 3 with a JSON error document", () => {
  cliTest("no store yet: every command but init and hook says so", () => {
    box = sandbox();
    refused(box, ["wake"], 3, "no-store");
    refused(box, ["note", "x"], 3, "no-store");
    refused(box, ["check"], 3, "no-store");
    const hook = run(box, ["hook"]);
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe("");
    // Positive control: after init the same commands work.
    ok(box, ["init"]);
    expect(ok(box, ["wake"]).text).toContain("<wake>");
  });

  cliTest("a store written by a newer relembra is refused, untouched", () => {
    withStore();
    const raw = new DatabaseSync(box.store);
    raw.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(999, 0);
    raw.close();
    const before = readFileSync(box.store);
    // The hook fails open instead (test/cli/hook.test.ts).
    for (const args of [["wake"], ["note", "x"], ["check"]]) {
      refused(box, args, 3, "schema-too-new");
    }
    expect(readFileSync(box.store).equals(before)).toBe(true);
  });

  cliTest("a store readable by others is refused, never chmodded", () => {
    withStore();
    chmodSync(box.store, 0o644);
    const result = refused(box, ["wake"], 3, "store-file");
    expect(result.json?.ok === false && result.json.error.rule).toBe("mode");
    expect(statSync(box.store).mode & 0o777).toBe(0o644);
  });

  cliTest("an unreadable store is a store error", () => {
    withStore();
    chmodSync(box.store, 0o000);
    const result = run(box, ["wake", "--json"]);
    expect(result.status).toBe(3);
    expect(result.json?.ok).toBe(false);
  });

  cliTest("a corrupted store fails check with exit 3", () => {
    withStore();
    // Positive control first: the intact store passes.
    expect(ok(box, ["check"]).integrity).toBe("ok");
    const size = statSync(box.store).size;
    const fd = openSync(box.store, "r+");
    // Overwrite everything after the header page with garbage.
    writeSync(fd, Buffer.alloc(size - 4096, 0xa5), 0, size - 4096, 4096);
    closeSync(fd);
    const result = run(box, ["check", "--json"]);
    expect(result.status).toBe(3);
    expect(result.json?.ok).toBe(false);
  });

  cliTest(
    "check accepts a store holding a promotion, and zoom shows the copy's origin",
    async () => {
      withStore();
      // A library host promotes a memory of another scope into the CLI's scope.
      const other = "team/elsewhere";
      const host: Principal = {
        id: "host",
        readable: [other, box.scope],
        writable: [other],
        promotable: [box.scope],
      };
      const store = openSqliteStore({ path: box.store });
      const relembra = createRelembra<null>({ store, policy: () => host });
      const provenance = { agent: "a", harness: "h", model: "m", host: "h" };
      const origin = await relembra.note(null, { scope: other, text: "Shared rule.", provenance });
      const copy = await relembra.promote(null, {
        memoryId: origin.id,
        revision: 1,
        scope: box.scope,
        provenance,
      });
      await store.close();

      expect(ok(box, ["check"]).integrity).toBe("ok");
      expect(ok(box, ["zoom", copy.id]).memory.origin).toEqual({
        memoryId: origin.id,
        revision: 1,
      });
      expect(run(box, ["zoom", copy.id]).stdout).toContain(`origin: ${origin.id}@1`);

      // Negative control: an event in a format this relembra does not know fails check.
      const raw = new DatabaseSync(box.store);
      raw
        .prepare("INSERT INTO events (kind, memory_id, scope, body) VALUES (?, ?, ?, ?)")
        .run("note", "m-x", box.scope, JSON.stringify({ format: 3, kind: "note" }));
      raw.close();
      const result = refused(box, ["check"], 3, "integrity");
      expect(result.json?.ok === false && result.json.error.rule).toBe("event-format");
    },
  );

  cliTest("a store error in text mode goes to stderr only", () => {
    withStore();
    chmodSync(box.store, 0o644);
    const result = run(box, ["wake"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("relembra:");
  });
});
