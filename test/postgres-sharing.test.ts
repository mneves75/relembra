import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  describePostgres,
  dropSchema,
  freshSchema,
  pool,
  postgresUrl,
} from "./postgres-support.js";

/**
 * Ticket 14: two hosts share one memory through Postgres. Each host program
 * (examples/shared-postgres) runs as its own OS process with its own Policy, principal and
 * connection pool, as two machines would; nothing passes between them but the database.
 */

const ROOT = join(import.meta.dir, "..");
const { PATH, TMPDIR } = process.env;
const HOSTS = { a: "host-a.ts", b: "host-b.ts" } as const;
type Host = keyof typeof HOSTS;

const SHARED = "shared";
const PRIVATE_A = "private-a";
const PRIVATE_B = "private-b";

// Every text holds "kestrel", so one find matches all four, and what comes back is exactly what
// the principal may read. "cache" and "logs" appear only in one private memory each.
const TEXT = {
  aShared: "kestrel builds publish to the staging bucket at noon",
  aPrivate: "kestrel on host A keeps its cache under /var/cache/a",
  bShared: "kestrel releases need two approvals before tagging",
  bPrivate: "kestrel on host B rotates its logs every hour",
} as const;

interface Found {
  readonly id: string;
  readonly scope: string;
  readonly text: string;
  readonly host: string;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  // biome-ignore lint/suspicious/noExplicitAny: the host's JSON; the assertions check its shape.
  readonly doc: any;
}

const schemas: string[] = [];
afterAll(async () => {
  if (schemas.length === 0) return;
  const admin = pool(1);
  try {
    for (const schema of schemas) await dropSchema(admin, schema);
  } finally {
    await admin.close();
  }
});

function newSchema(): string {
  const schema = freshSchema("relembra_share");
  schemas.push(schema);
  return schema;
}

/** Runs one host command in a child process whose only link to the other host is the database. */
function host(name: Host, schema: string, ...args: string[]): Run {
  return spawnHost(name, { DATABASE_URL: postgresUrl(), DATABASE_SCHEMA: schema }, args);
}

function spawnHost(name: Host, database: Record<string, string>, args: readonly string[]): Run {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "examples", "shared-postgres", HOSTS[name]), ...args],
    {
      cwd: ROOT,
      env: { PATH: PATH ?? "/usr/bin:/bin", TMPDIR: TMPDIR ?? "/tmp", ...database },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  let doc: unknown;
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    doc = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, doc };
}

/** Runs a host command that must succeed; returns its data. */
// biome-ignore lint/suspicious/noExplicitAny: the host's JSON; the assertions check its shape.
function ok(name: Host, schema: string, ...args: string[]): any {
  const run = host(name, schema, ...args);
  if (run.status !== 0 || run.doc?.ok !== true) {
    throw new Error(
      `host ${name} ${args.join(" ")}: status ${run.status}\n${run.stdout}\n${run.stderr}`,
    );
  }
  return run.doc.data;
}

/** Runs a host command that must be refused with the named error; returns the run. */
function refused(name: Host, schema: string, error: string, ...args: string[]): Run {
  const run = host(name, schema, ...args);
  if (run.status !== 1 || run.doc?.ok !== false || run.doc.error !== error) {
    throw new Error(
      `expected ${error} from host ${name} ${args.join(" ")}: status ${run.status}\n${run.stdout}\n${run.stderr}`,
    );
  }
  return run;
}

const ids = (found: readonly Found[]) => found.map((memory) => memory.id).sort();

/** Notes the four memories, each host its own, and returns their ids. */
function noteAll(schema: string) {
  return {
    aShared: ok("a", schema, "note", SHARED, TEXT.aShared).id as string,
    aPrivate: ok("a", schema, "note", PRIVATE_A, TEXT.aPrivate).id as string,
    bShared: ok("b", schema, "note", SHARED, TEXT.bShared).id as string,
    bPrivate: ok("b", schema, "note", PRIVATE_B, TEXT.bPrivate).id as string,
  };
}

describePostgres("sharing across machines: two host processes on one Postgres", () => {
  test("each host finds the other's memories in the shared scope", () => {
    const schema = newSchema();
    const id = noteAll(schema);

    const fromB: Found[] = ok("b", schema, "find", "kestrel");
    const aShared = fromB.find((memory) => memory.id === id.aShared);
    expect(aShared).toEqual({ id: id.aShared, scope: SHARED, text: TEXT.aShared, host: "host-a" });

    const fromA: Found[] = ok("a", schema, "find", "kestrel");
    const bShared = fromA.find((memory) => memory.id === id.bShared);
    expect(bShared).toEqual({ id: id.bShared, scope: SHARED, text: TEXT.bShared, host: "host-b" });

    // Recall and zoom reach the same memories.
    expect(ids(ok("b", schema, "recall", SHARED))).toEqual([id.aShared, id.bShared].sort());
    expect(ok("a", schema, "zoom", id.bShared).text).toBe(TEXT.bShared);
    expect(ok("b", schema, "zoom", id.aShared).text).toBe(TEXT.aShared);
  }, 120_000);

  test("neither host ever sees a memory of the other's private scope; the shared scope is the control", () => {
    const schema = newSchema();
    const id = noteAll(schema);
    const views: Record<Host, { own: string; other: string; otherText: string; term: string }> = {
      a: { own: id.aPrivate, other: id.bPrivate, otherText: TEXT.bPrivate, term: "logs" },
      b: { own: id.bPrivate, other: id.aPrivate, otherText: TEXT.aPrivate, term: "cache" },
    };
    for (const name of ["a", "b"] as const) {
      const view = views[name];
      const otherScope = name === "a" ? PRIVATE_B : PRIVATE_A;
      const outputs: string[] = [];
      const keep = (run: Run) => {
        outputs.push(run.stdout, run.stderr);
        return run;
      };

      // One query matching all four memories returns the shared two and this host's own, only.
      const all = keep(host(name, schema, "find", "kestrel"));
      expect(ids(all.doc.data)).toEqual([id.aShared, id.bShared, view.own].sort());
      const listed = keep(host(name, schema, "recall"));
      expect(ids(listed.doc.data)).toEqual([id.aShared, id.bShared, view.own].sort());

      // A term only the other's private memory holds finds nothing; the owner finds it.
      expect(keep(host(name, schema, "find", view.term)).doc.data).toEqual([]);
      const owner = name === "a" ? "b" : "a";
      expect(ids(ok(owner, schema, "find", view.term))).toEqual([view.other]);

      // Asking for the scope by name is refused; asking for the memory by id is as for no memory.
      keep(refused(name, schema, "ScopeDeniedError", "recall", otherScope));
      keep(refused(name, schema, "ScopeDeniedError", "find", "kestrel", otherScope));
      keep(refused(name, schema, "MemoryNotFoundError", "zoom", view.other));
      keep(refused(name, schema, "MemoryNotFoundError", "zoom", "no-such-memory"));
      // Positive control: the same calls on the shared scope work.
      expect(ids(keep(host(name, schema, "recall", SHARED)).doc.data)).toEqual(
        [id.aShared, id.bShared].sort(),
      );
      expect(keep(host(name, schema, "zoom", id.aShared)).doc.data.text).toBe(TEXT.aShared);

      const seen = outputs.join("\n");
      expect(seen).not.toContain(view.otherText);
      expect(seen).not.toContain(view.other);
      // Positive control for that scan: the shared text from the other host is in it.
      expect(seen).toContain(name === "a" ? TEXT.bShared : TEXT.aShared);
    }
  }, 120_000);

  test("after host A redacts its shared memory, host B's view drops the text", () => {
    const schema = newSchema();
    const id = noteAll(schema);
    // Before: B sees it, and may not redact it (A owns the shared scope, B only reads and writes).
    expect(ok("b", schema, "zoom", id.aShared).text).toBe(TEXT.aShared);
    refused("b", schema, "ScopeDeniedError", "redact", id.aShared);

    expect(ok("a", schema, "redact", id.aShared)).toEqual({ redacted: [id.aShared], derived: [] });

    const outputs = [
      host("b", schema, "find", "kestrel"),
      host("b", schema, "find", "staging bucket noon"),
      host("b", schema, "recall"),
      host("b", schema, "recall", SHARED),
      refused("b", schema, "MemoryNotFoundError", "zoom", id.aShared),
    ];
    expect(ids(outputs[0]?.doc.data)).toEqual([id.bShared, id.bPrivate].sort());
    expect(outputs[1]?.doc.data).toEqual([]);
    expect(ids(outputs[3]?.doc.data)).toEqual([id.bShared]);
    const seen = outputs.map((run) => `${run.stdout}\n${run.stderr}`).join("\n");
    for (const piece of ["staging bucket", "publish to the", "at noon"]) {
      expect(seen).not.toContain(piece);
    }
    // Positive control for that scan: B's own shared memory is still there.
    expect(seen).toContain(TEXT.bShared);
    // The owner sees the tombstone, without the text.
    expect(ok("a", schema, "zoom", id.aShared)).toEqual({
      id: id.aShared,
      scope: SHARED,
      status: "redacted",
    });
  }, 120_000);
});

// Needs no database: a host must answer a bad connection setting with its one JSON document.
test("a malformed DATABASE_URL gets the JSON error document, without the password", () => {
  const run = spawnHost("a", { DATABASE_URL: "postgres://u:s3cret-pw@[bad/db" }, ["find", "x"]);
  expect(run.status).toBe(1);
  expect(run.doc).toMatchObject({ ok: false, error: "TypeError" });
  expect(run.stdout + run.stderr).not.toContain("s3cret-pw");
});

test("a missing DATABASE_URL is a usage error", () => {
  const run = spawnHost("b", {}, ["find", "x"]);
  expect(run.status).toBe(2);
  expect(run.doc).toMatchObject({ ok: false, error: "UsageError" });
});
