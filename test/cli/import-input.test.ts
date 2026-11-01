import { afterAll, beforeAll, describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_IMPORT_BYTES, MAX_IMPORT_EVENTS } from "../../src/transfer.js";
import { RELEMBRA_VERSION } from "../../src/version.js";
import { BINARY, cliTest, exportedText, ok, refused, run, sandbox } from "./support.js";

/**
 * What `relembra import` reads: identifiers that a rendering would show (docs/FORMAT.md, "Import
 * of an export"), and only a bounded regular file (docs/CLI.md, import).
 */
const box = sandbox();
afterAll(() => box.remove());

/** Synthetic: the shape of a GitHub token, never a real one. */
const CREDENTIAL = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const UNSEEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

function exportOf(scope: string, ids: readonly string[]): string {
  const header = { export: "relembra", format: 1, relembra: RELEMBRA_VERSION, scopes: [scope] };
  const events = ids.map((memoryId, index) => ({
    format: 1,
    kind: "note",
    seq: index + 1,
    memoryId,
    scope,
    principalId: "p",
    pinned: false,
    revision: {
      number: 1,
      text: `Imported fact number ${index + 1}.`,
      at: 1_000 + index,
      provenance: {
        agent: "a",
        harness: "h",
        model: "m",
        host: "h",
        trust: "agent",
        opId: `op-${index}`,
      },
    },
  }));
  return [header, ...events].map((line) => `${JSON.stringify(line)}\n`).join("");
}

let files = 0;
function file(content: string | Uint8Array): string {
  const path = join(box.home, `import-${++files}.jsonl`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

beforeAll(() => {
  if (BINARY !== "") ok(box, ["init"]);
});

describe("relembra import refuses identifiers a rendering would show raw", () => {
  const hostile: readonly [string, string, string][] = [
    ["ESC", "m-\u001b[31mred", "control-character"],
    ["bidi", "m-\u202eevil", "bidi-character"],
    ["zero-width", "m-\u200bhidden", "zero-width-character"],
    ["credential", CREDENTIAL, "credential"],
  ];
  for (const [name, id, rule] of hostile) {
    cliTest(
      `a memory id with ${name} exits 1 (import, malformed:memoryId:${rule}), writing nothing`,
      () => {
        const result = refused(box, ["import", file(exportOf(box.scope, [id]))], 1, "import");
        expect(result.json?.ok === false && result.json.error.rule).toBe(
          `malformed:memoryId:${rule}`,
        );
        expect(result.stdout).not.toContain(id);
        expect(ok(box, ["export"]).events).toEqual([]);
        const wake = run(box, ["wake"]);
        expect(wake.status).toBe(0);
        expect(UNSEEN.test(wake.stdout.replaceAll("\n", ""))).toBe(false);
      },
    );
  }

  for (const variable of ["RELEMBRA_AGENT", "RELEMBRA_HARNESS", "RELEMBRA_MODEL"]) {
    cliTest(`${variable} with ESC is refused before any write (provenance)`, () => {
      const field = variable.slice("RELEMBRA_".length).toLowerCase();
      const result = refused(box, ["note", "An env-provenance fact."], 1, "provenance", {
        env: { [variable]: "agent\u001b[31m" },
      });
      expect(result.json?.ok === false && result.json.error.rule).toBe(
        `${field}:control-character`,
      );
    });
  }

  cliTest(
    "positive control: safe ids import, and the wake renders them as the source store does",
    () => {
      const ids = ["m-safe-1", "550e8400-e29b-41d4-a716-446655440000", "nota-é"];
      expect(ok(box, ["import", file(exportOf(box.scope, ids))])).toEqual({
        imported: 3,
        skipped: 0,
        refused: [],
      });
      const wake = run(box, ["wake"]);
      for (const id of ids) expect(wake.stdout).toContain(`id="${id}"`);
      const other = { RELEMBRA_HOME: join(box.home, "copy-store") };
      ok(box, ["init"], { env: other });
      const exported = exportedText(box);
      expect(ok(box, ["import", file(exported)], { env: other })).toMatchObject({ imported: 3 });
      expect(run(box, ["wake"], { env: other }).stdout).toBe(wake.stdout);
      // The env provenance of a plain note is accepted (positive control for the refusals above).
      ok(box, ["note", "A plain env fact."], { env: { RELEMBRA_AGENT: "plain-agent" } });
    },
  );
});

describe("relembra import reads only a bounded regular file", () => {
  /** A refusal that must come at once: a FIFO or a device must never be waited on. */
  function refusedFast(args: string[], exit: number, code: string, rule: string) {
    const began = performance.now();
    const result = run(box, [args[0] as string, "--json", ...args.slice(1)], { timeoutMs: 10_000 });
    expect(performance.now() - began).toBeLessThan(5_000);
    expect({
      status: result.status,
      error: result.json?.ok === false && result.json.error,
    }).toEqual({
      status: exit,
      error: { code, rule },
    });
  }

  cliTest("a FIFO is refused before it is opened for reading (bad-value), never waited on", () => {
    const fifo = join(box.home, "import.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    refusedFast(["import", fifo], 2, "usage", "bad-value");
  });

  cliTest("a device and a directory are refused (bad-value)", () => {
    refusedFast(["import", "/dev/null"], 2, "usage", "bad-value");
    const dir = join(box.home, "a-directory");
    mkdirSync(dir);
    refusedFast(["import", dir], 2, "usage", "bad-value");
  });

  cliTest("a file over 64 MiB is refused before it is read (import, too-large:file)", () => {
    const path = file("");
    // Sparse: the size is what is refused, so no 64 MiB is written.
    truncateSync(path, MAX_IMPORT_BYTES + 1);
    refusedFast(["import", path], 1, "import", "too-large:file");
  });

  cliTest("the reviewer's 4,194,388-byte header line is refused (import, too-large:line)", () => {
    const header = JSON.stringify({
      export: "relembra",
      format: 1,
      relembra: RELEMBRA_VERSION,
      scopes: [box.scope],
      ignored: "",
    });
    const padded = header.replace(
      '"ignored":""',
      `"ignored":"${"x".repeat(4_194_388 - header.length)}"`,
    );
    expect(padded.length).toBe(4_194_388);
    refusedFast(["import", file(`${padded}\n`)], 1, "import", "too-large:line");
  });

  cliTest("more than 100,000 events is refused (import, too-large:events)", () => {
    const head = exportOf(box.scope, []);
    refusedFast(
      ["import", file(head + "{}\n".repeat(MAX_IMPORT_EVENTS + 1))],
      1,
      "import",
      "too-large:events",
    );
  });

  cliTest("an OptMem LOG.txt that is a FIFO, or over 64 MiB, is refused the same way", () => {
    const fifoDir = join(box.home, "optmem-fifo");
    mkdirSync(fifoDir);
    expect(spawnSync("mkfifo", [join(fifoDir, "LOG.txt")]).status).toBe(0);
    refusedFast(["import", "--optmem", fifoDir], 2, "usage", "bad-value");
    const bigDir = join(box.home, "optmem-big");
    mkdirSync(bigDir);
    writeFileSync(join(bigDir, "LOG.txt"), "");
    truncateSync(join(bigDir, "LOG.txt"), MAX_IMPORT_BYTES + 1);
    refusedFast(["import", "--optmem", bigDir], 1, "import", "too-large:file");
  });

  cliTest(
    "positive control: a normal export round-trips through a file, and a symlink to it",
    () => {
      const other = { RELEMBRA_HOME: join(box.home, "round-trip-store") };
      ok(box, ["init"], { env: other });
      ok(box, ["note", "A round-trip fact."]);
      const exported = exportedText(box);
      const path = file(exported);
      const link = join(box.home, "export-link.jsonl");
      symlinkSync(path, link);
      const first = ok(box, ["import", link], { env: other });
      expect(first.imported).toBeGreaterThan(0);
      expect(ok(box, ["import", path], { env: other })).toMatchObject({ imported: 0 });
      expect(run(box, ["export"], { env: other }).stdout.split("\n").length).toBe(
        exported.split("\n").length,
      );
    },
  );
});

describe("a memory id on the command line passes the identifier rule", () => {
  const hostileIds: readonly [string, string][] = [
    ["m-\u001b[31mred", "control-character"],
    ["m-‮evil", "bidi-character"],
    ["m-​hidden", "zero-width-character"],
  ];
  for (const [id, rule] of hostileIds) {
    cliTest(
      `zoom, retract, redact and summarize --of refuse a ${rule} id (invalid-argument)`,
      () => {
        for (const args of [
          ["zoom", id],
          ["retract", id],
          ["redact", id],
          ["summarize", "--of", `${id}@1`, "A summary."],
        ]) {
          const result = refused(box, args, 2, "invalid-argument");
          expect(result.json?.ok === false && result.json.error.rule).toBe(`memory-id:${rule}`);
          expect(result.stdout).not.toContain(id);
        }
      },
    );
  }

  cliTest(
    "positive control: an ordinary id is looked up (not-found when absent, found when noted)",
    () => {
      refused(box, ["zoom", "memória-ausente"], 1, "not-found");
      const noted = ok(box, ["note", "A fact to zoom into."]);
      expect(ok(box, ["zoom", noted.memory.id]).memory.id).toBe(noted.memory.id);
    },
  );
});
