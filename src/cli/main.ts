/**
 * The relembra CLI (docs/CLI.md). Built as a Bun AOT binary by build/cli.ts.
 *
 * Policy, the single-user trust model: the OS user running the binary is the principal and owns
 * the scope the environment names. It may read, write, pin, retract, redact and supersede there,
 * and it may also read the global scope RELEMBRA_GLOBAL_SCOPE names (docs/CLI.md, Scope).
 * Its trust ceiling is `agent`: owner trust (`--trust owner`, or changing a memory written with
 * owner trust) needs a person at the controlling terminal to type a code (confirm.ts), so a flag
 * from a prompt-injected agent cannot grant it. Any process running as the same user can still
 * open the store directly: the CLI gives scoped organization, not isolation (IMPLEMENTATION-PLAN
 * §3, invariant 2; §4.1; docs/CLI.md, Trust).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImportError, PlanChangedError } from "../errors.js";
import { guardText } from "../guard.js";
import {
  LATEST_EVENT_FORMAT,
  type Memory,
  type Principal,
  type StoredMemory,
  type Trust,
} from "../model.js";
import { importOptmem } from "../optmem.js";
import { createRelembra, type NoteProvenance, type Relembra } from "../relembra.js";
import { identityEgress, renderMemory } from "../render.js";
import { openSqliteStore, type SqliteStore } from "../sqlite/index.js";
import { exportJsonl, type ImportReport, importJsonl, MAX_IMPORT_BYTES } from "../transfer.js";
import { flagValue, hasFlag, intFlag, type Parsed, parseArgs, wantsJson } from "./args.js";
import { ENV_VARS, usageText } from "./commands.js";
import { confirmOwner } from "./confirm.js";
import { CliError, toCliError, usage } from "./errors.js";
import { serveMcp } from "./mcp.js";
import { type CliEnv, osUser, resolveScope, resolveScopes, storePath } from "./scope.js";
import { readStdinText } from "./stdin.js";
import { composeWake, type SessionScopes } from "./wake.js";

interface Output {
  readonly data: unknown;
  readonly text: string;
}

interface Context {
  readonly parsed: Parsed;
  readonly env: CliEnv;
  readonly cwd: string;
}

/** The documented SessionStart output for Claude Code and Codex hooks (docs/CLI.md, hook). */
interface HookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "SessionStart";
    readonly additionalContext: string;
  };
}

const TRUST: readonly Trust[] = ["owner", "agent", "untrusted"];
const MAX_LIMIT = 100;
const MAX_RECALL_LIMIT = 100_000;
const MAX_BUDGET = 1_000_000;
const MAX_AGE_DAYS = 36_500;
const MAX_SOURCES = 100;

/** Reads the session's scope and the global one; writes, pins and owns the session's only. */
function principalFor(scopes: SessionScopes, trustCeiling: Trust): Principal {
  const scope = scopes.session;
  return {
    id: osUser(),
    readable: scopes.global === undefined ? [scope] : [scope, scopes.global],
    writable: [scope],
    promotable: [],
    pinnable: [scope],
    owned: [scope],
    trustCeiling,
  };
}

/**
 * Export and import run at agent trust, never raised: an import grants at most agent trust
 * (docs/FORMAT.md), and no confirmation prompt covers the lines of a file. So a replayed
 * retract, supersede or redact that would change an owner memory is refused
 * (`denied:above-ceiling`), as it would be without the owner's confirmation. Export needs
 * ownership only, not trust.
 */
function transferPrincipal(scope: string): Principal {
  return principalFor({ session: scope }, "agent");
}

function provenanceFrom(context: Context): NoteProvenance {
  const { parsed, env } = context;
  const pick = (flag: string, variable: string | undefined, fallback: string) =>
    flagValue(parsed, flag) ?? (variable === undefined || variable === "" ? fallback : variable);
  const trust = flagValue(parsed, "--trust");
  if (trust !== undefined && !TRUST.includes(trust as Trust)) {
    throw usage("bad-value", "--trust takes owner, agent or untrusted");
  }
  const source = flagValue(parsed, "--source");
  return {
    agent: pick("--agent", env.RELEMBRA_AGENT, "unknown"),
    harness: pick("--harness", env.RELEMBRA_HARNESS, "cli"),
    model: pick("--model", env.RELEMBRA_MODEL, "unknown"),
    host: hostname() || "unknown",
    ...(source === undefined ? {} : { source }),
    ...(trust === undefined ? {} : { trust: trust as Trust }),
  };
}

/** The write's text: its text argument, or stdin when there is none. */
async function textFrom(positional: string | undefined): Promise<string> {
  return positional ?? (await readStdinText());
}

/** Whether a memory's current revision was written with owner trust. */
const ownerTrust = (memory: StoredMemory): memory is Memory =>
  memory.status !== "redacted" && memory.revision.provenance.trust === "owner";

/**
 * The owner-trust memories a command would change, from the library's plan (redactionPreview):
 * for redact ("all") the memory and every summary it erases; for retract and supersede ("live")
 * the memory and the live summaries they retract.
 */
function ownersIn(plan: readonly Memory[], which: "all" | "live"): Memory[] {
  const [target, ...derived] = plan;
  if (target === undefined) return [];
  const summaries = which === "all" ? derived : derived.filter((m) => m.status === "live");
  return [target, ...summaries].filter(ownerTrust);
}

/** How many plans a gated command previews before it gives up with plan-changed. */
const PLAN_ATTEMPTS = 3;

/**
 * Runs a gated mutation until the plan it previewed is the plan it applies. Each attempt
 * previews, confirms when it must, and hands the preview to the library as `expect`, which
 * aborts with PlanChangedError when another process changed the plan in between; the next
 * attempt shows the person the new plan. `retry` is true from the second attempt on.
 */
async function untilPlanHolds<T>(attempt: (retry: boolean) => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt(n > 1);
    } catch (error) {
      if (!(error instanceof PlanChangedError) || n === PLAN_ATTEMPTS) throw error;
    }
  }
}

/** Prompt lines naming the owner memories a command would change: three, then a count. */
function changeLines(verb: string, owners: readonly Memory[]): string[] {
  const shown = owners.slice(0, 3).map((memory) => `${verb}: ${renderMemory(memory)}`);
  return owners.length > 3 ? [...shown, `and ${owners.length - 3} more with owner trust`] : shown;
}

function opIdFrom(parsed: Parsed): { opId?: string } {
  const opId = flagValue(parsed, "--op-id");
  return opId === undefined ? {} : { opId };
}

const lines = (memories: readonly Memory[]) =>
  memories
    .map((memory) =>
      memory.status === "live"
        ? renderMemory(memory)
        : `[${memory.status}] ${renderMemory(memory)}`,
    )
    .join("\n");

function zoomText(memory: StoredMemory, sources: readonly ZoomSource[]): string {
  if (memory.status === "redacted") {
    return [`id: ${memory.id}`, `scope: ${memory.scope}`, "status: redacted"].join("\n");
  }
  const { revision } = memory;
  const p = revision.provenance;
  return [
    renderMemory(memory),
    `status: ${memory.status}${memory.supersededBy === undefined ? "" : ` by ${memory.supersededBy}`}`,
    `pinned: ${memory.pinned}`,
    `noted: ${new Date(memory.notedAt).toISOString()}`,
    `trust: ${p.trust}`,
    `agent: ${p.agent}`,
    `harness: ${p.harness}`,
    `model: ${p.model}`,
    `host: ${p.host}`,
    ...(p.source === undefined ? [] : [`source: ${p.source}`]),
    `op: ${p.opId}`,
    ...(memory.origin === undefined
      ? []
      : [`origin: ${memory.origin.memoryId}@${memory.origin.revision}`]),
    ...sources.map(
      (s) =>
        `source memory: ${s.memoryId}@${s.revision} ${s.memory === null ? "not visible" : s.memory.status}`,
    ),
  ].join("\n");
}

interface ZoomSource {
  readonly memoryId: string;
  readonly revision: number;
  readonly memory: StoredMemory | null;
}

function shellQuote(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/** The SessionStart registration for both harnesses; the same shape in each (docs/CLI.md). */
function hookSnippet(): object {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact|fork",
          hooks: [{ type: "command", command: hookCommand() }],
        },
      ],
    },
  };
}

/**
 * The hook's command line: the binary under `/usr/bin/env -i`, handed only the variables it reads
 * apart from Bun's (an unset one arrives empty, which counts as unset). Bun acts on BUN_OPTIONS,
 * BUN_BE_BUN and its other startup variables before relembra's code runs, so only a launcher that
 * never passes them on can keep the hook from running something else (docs/CLI.md, hook).
 */
function hookCommand(): string {
  const passed = ENV_VARS.filter((name) => !name.startsWith("BUN_"));
  return [
    "/usr/bin/env -i",
    ...passed.map((name) => `${name}="$${name}"`),
    shellQuote(process.execPath),
    "hook",
  ].join(" ");
}

/**
 * Serves MCP over stdin and stdout until stdin ends (src/cli/mcp.ts). The principal is the CLI's,
 * at the agent ceiling for the whole process; provenance comes from the environment, as for note,
 * with harness `mcp` by default. Log lines go to stderr; stdout carries protocol messages only.
 */
async function serveStdio(env: CliEnv, scopes: SessionScopes, store: SqliteStore): Promise<void> {
  const principal = principalFor(scopes, "agent");
  const egress = identityEgress;
  const relembra = createRelembra<null>({ store, policy: () => principal, egress });
  const pick = (variable: string | undefined, fallback: string) =>
    variable === undefined || variable === "" ? fallback : variable;
  // A write to a closed pipe is reported through the write callback; without a listener the
  // stream's error event would end the process before the store closes.
  process.stdout.on("error", () => {});
  await serveMcp(
    process.stdin,
    {
      write: (line) =>
        new Promise((resolve, reject) => {
          process.stdout.write(line, (error) => (error ? reject(error) : resolve()));
        }),
      log: (message) => process.stderr.write(`relembra mcp: ${message}\n`),
    },
    {
      relembra,
      scope: scopes.session,
      ...(scopes.global === undefined ? {} : { globalScope: scopes.global }),
      // The protocol is stateless, so this process is the session: a fresh id per process, which
      // names it as one carrier of everything it rendered (docs/CLI.md, relembra mcp).
      carrier: { id: `mcp:${randomUUID()}`, kind: "mcp" },
      provenance: {
        agent: pick(env.RELEMBRA_AGENT, "unknown"),
        harness: pick(env.RELEMBRA_HARNESS, "mcp"),
        model: pick(env.RELEMBRA_MODEL, "unknown"),
        host: hostname() || "unknown",
      },
    },
  );
}

function hookOutput(text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

async function runStoreCommand(
  context: Context,
  scopes: SessionScopes,
  store: SqliteStore,
  path: string,
): Promise<Output> {
  const { parsed } = context;
  // Writes and maintenance name this scope; only reads also cover the global one.
  const scope = scopes.session;
  const name = parsed.command.name;
  const [first, second] = parsed.positionals;
  const maxAgeDays = name === "sweep" ? intFlag(parsed, "--max-age-days", MAX_AGE_DAYS) : undefined;
  if (name === "sweep" && maxAgeDays === undefined) {
    throw usage("missing-value", "sweep needs --max-age-days");
  }
  // Raised to owner only after the person at the terminal confirms (requireOwner).
  let ceiling: Trust = "agent";
  const requireOwner = (lines: readonly string[]) => {
    confirmOwner(lines);
    ceiling = "owner";
  };
  /** A write's text, guard-checked before any prompt shows it, confirmed when it claims owner. */
  const confirmedText = (text: string, provenance: NoteProvenance, lines: readonly string[]) => {
    if (provenance.trust === "owner") {
      guardText(text);
      requireOwner(lines);
    }
  };
  /** A gated mutation, at agent trust again on every attempt (untilPlanHolds). */
  const gated = <T>(attempt: (changed: readonly string[]) => Promise<T>) =>
    untilPlanHolds((retry) => {
      ceiling = "agent";
      return attempt(retry ? ["(changed since the last prompt)"] : []);
    });
  const relembra: Relembra<null> = createRelembra<null>({
    store,
    policy: () => principalFor(scopes, ceiling),
    ...(maxAgeDays === undefined ? {} : { retention: [{ scope, maxAgeDays }] }),
  });

  switch (name) {
    case "note": {
      const provenance = provenanceFrom(context);
      const text = await textFrom(first);
      confirmedText(text, provenance, [`note: ${text}`]);
      const memory = await relembra.note(null, {
        scope,
        text,
        provenance,
        pinned: hasFlag(parsed, "--pin"),
        ...opIdFrom(parsed),
      });
      return { data: { memory }, text: memory.id };
    }
    case "find": {
      const limit = intFlag(parsed, "--limit", MAX_LIMIT);
      const results = await relembra.find(null, {
        query: parsed.positionals.join(" "),
        ...(limit === undefined ? {} : { limit }),
      });
      return { data: { results }, text: lines(results.map((result) => result.memory)) };
    }
    case "recall": {
      const limit = intFlag(parsed, "--limit", MAX_RECALL_LIMIT);
      const memories = await relembra.recall(null, {
        includeRetracted: hasFlag(parsed, "--retracted"),
        ...(limit === undefined ? {} : { limit }),
      });
      return { data: { memories }, text: lines(memories) };
    }
    case "wake":
    case "brief": {
      const budgetBytes = intFlag(parsed, "--budget", MAX_BUDGET);
      const budget = budgetBytes === undefined ? {} : { budgetBytes };
      const rendering =
        name === "wake"
          ? await composeWake(relembra, scopes, budget)
          : await relembra.brief(null, { topic: parsed.positionals.join(" "), ...budget });
      return {
        data: { text: rendering.text, memoryIds: rendering.memoryIds },
        text: rendering.text,
      };
    }
    case "zoom": {
      const memory = await relembra.zoom(null, { memoryId: first as string });
      const sources: ZoomSource[] = [];
      if (memory.status !== "redacted") {
        for (const { memoryId, revision } of memory.sources ?? []) {
          const source = await relembra.zoom(null, { memoryId }).catch(() => null);
          sources.push({ memoryId, revision, memory: source });
        }
      }
      return { data: { memory, sources }, text: zoomText(memory, sources) };
    }
    case "retract": {
      const memoryId = first as string;
      await gated(async (changed) => {
        const expect = await relembra.redactionPreview(null, { memoryId });
        const owners = ownersIn(expect, "live");
        if (owners.length > 0) requireOwner([...changed, ...changeLines("retract", owners)]);
        await relembra.retract(null, { memoryId, expect });
      });
      return { data: { memoryId }, text: memoryId };
    }
    case "redact": {
      const memoryId = first as string;
      const redaction = await gated(async (changed) => {
        const expect = await relembra.redactionPreview(null, { memoryId });
        const owners = ownersIn(expect, "all");
        if (owners.length > 0) requireOwner([...changed, ...changeLines("redact", owners)]);
        return relembra.redact(null, { memoryId, expect });
      });
      return { data: redaction, text: redactionText(redaction) };
    }
    case "supersede": {
      const memoryId = first as string;
      const provenance = provenanceFrom(context);
      const text = await textFrom(second);
      const memory = await gated(async (changed) => {
        const expect = await relembra.redactionPreview(null, { memoryId });
        const owners = ownersIn(expect, "live");
        if (owners.length > 0) {
          guardText(text);
          requireOwner([...changed, ...changeLines("replace", owners), `with: ${text}`]);
        } else confirmedText(text, provenance, [...changed, `replace with: ${text}`]);
        return relembra.supersede(null, {
          memoryId,
          text,
          provenance,
          pinned: hasFlag(parsed, "--pin"),
          expect,
          ...opIdFrom(parsed),
        });
      });
      return { data: { memory }, text: memory.id };
    }
    case "pending": {
      const limit = intFlag(parsed, "--limit", MAX_RECALL_LIMIT);
      const memories = await relembra.pending(null, {
        scope,
        ...(limit === undefined ? {} : { limit }),
      });
      return { data: { memories }, text: lines(memories) };
    }
    case "summarize": {
      const sources = (parsed.flags.get("--of") ?? []).map(parseSource);
      if (sources.length === 0)
        throw usage("missing-value", "summarize needs --of <id>@<revision>");
      if (sources.length > MAX_SOURCES) {
        throw usage("bad-value", `summarize takes at most ${MAX_SOURCES} --of sources`);
      }
      const provenance = provenanceFrom(context);
      const text = await textFrom(first);
      confirmedText(text, provenance, [`summary: ${text}`]);
      const memory = await relembra.submitSummary(null, {
        scope,
        sources,
        text,
        provenance,
        ...opIdFrom(parsed),
      });
      return { data: { memory }, text: memory.id };
    }
    case "sweep": {
      const now = Date.now();
      // Expiring an owner memory changes it too: confirm first, over exactly what sweep(now)
      // redacts (superseded memories and derived summaries included).
      const redaction = await gated(async (changed) => {
        const expect = await relembra.sweepPreview(now);
        const owners = expect.filter(ownerTrust);
        if (owners.length > 0) {
          requireOwner([
            ...changed,
            `sweep: redact every memory first noted more than ${maxAgeDays} days ago`,
            ...changeLines("including", owners),
          ]);
        }
        return relembra.sweep(now, { expect });
      });
      return { data: redaction, text: redactionText(redaction) };
    }
    case "check":
      return check(scope, store, path);
    case "export": {
      const jsonl = await exportJsonl(store, transferPrincipal(scope), { scope });
      const [header, ...events] = jsonl
        .split("\n")
        .slice(0, -1)
        .map((line) => JSON.parse(line) as unknown);
      return { data: { header, events }, text: jsonl };
    }
    case "import": {
      const optmem = flagValue(parsed, "--optmem");
      if ((optmem === undefined) === (first === undefined)) {
        throw usage("missing-argument", "import takes a file, or --optmem <dir>, not both");
      }
      const report =
        optmem === undefined
          ? await importJsonl(
              store,
              transferPrincipal(scope),
              readImportFile(context, first as string),
            )
          : await importFromOptmem(context, scope, store, optmem);
      return { data: report, text: reportText(report) };
    }
    case "hook": {
      const rendering = await composeWake(relembra, scopes);
      const output = hookOutput(rendering.text);
      return { data: output, text: JSON.stringify(output) };
    }
    default:
      throw new CliError("internal", `command ${name} has no handler`);
  }
}

/** An export file's text: UTF-8, read whole. Unreadable or not UTF-8 is a usage error. */
function readImportFile(context: Context, path: string): string {
  const bytes = readRegularFile(resolve(context.cwd, path), "the import file");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw usage("bad-value", "the import file is not UTF-8");
  }
}

/**
 * Imports `<dir>/LOG.txt`, or `<dir>/memory/LOG.txt` (an OptMem home), into the scope. The store
 * is named by the first 16 hex characters of the sha256 of the log directory's real path.
 */
async function importFromOptmem(
  context: Context,
  scope: string,
  store: SqliteStore,
  dir: string,
): Promise<ImportReport> {
  const base = resolve(context.cwd, dir);
  const logDir = [base, join(base, "memory")].find((candidate) =>
    existsSync(join(candidate, "LOG.txt")),
  );
  if (logDir === undefined) throw usage("bad-value", "--optmem names no directory holding LOG.txt");
  let real: string;
  try {
    real = realpathSync(logDir);
  } catch {
    throw usage("bad-value", "the OptMem log cannot be read");
  }
  const log = readRegularFile(join(real, "LOG.txt"), "the OptMem log");
  const { agent, harness, model, host } = provenanceFrom(context);
  return importOptmem(store, transferPrincipal(scope), {
    scope,
    store: createHash("sha256").update(real).digest("hex").slice(0, 16),
    log,
    provenance: { agent, harness, model, host },
  });
}

/** How much readRegularFile reads at a time. */
const READ_CHUNK = 64 * 1024;

/**
 * The bytes of the regular file at `path` (a symlink to one is followed), at most
 * MAX_IMPORT_BYTES (`too-large:file` otherwise). A FIFO, device, socket or directory is refused
 * (`bad-value`) before it is opened for reading, and the open itself does not block, so a FIFO
 * swapped in after that check cannot hang the import either: the open descriptor is checked
 * again, and is what is read. A file that grows past the cap while read is refused the same way.
 */
function readRegularFile(path: string, what: string): Uint8Array {
  const notFile = () => usage("bad-value", `${what} is not a regular file`);
  let fd: number;
  try {
    if (!statSync(path).isFile()) throw notFile();
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw usage("bad-value", `${what} cannot be read`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw notFile();
    if (stat.size > MAX_IMPORT_BYTES) throw new ImportError("too-large", 0, "file");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(READ_CHUNK);
      const read = readSync(fd, chunk, 0, READ_CHUNK, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_IMPORT_BYTES) throw new ImportError("too-large", 0, "file");
      chunks.push(chunk.subarray(0, read));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof CliError || error instanceof ImportError) throw error;
    throw usage("bad-value", `${what} cannot be read`);
  } finally {
    closeSync(fd);
  }
}

function reportText(report: ImportReport): string {
  return [
    `imported: ${report.imported}`,
    `skipped: ${report.skipped}`,
    ...report.refused.map(({ line, rule }) => `refused: line ${line} (${rule})`),
  ].join("\n");
}

function redactionText(redaction: { redacted: readonly string[]; derived: readonly string[] }) {
  return [`redacted: ${redaction.redacted.join(" ")}`, `derived: ${redaction.derived.join(" ")}`]
    .map((line) => line.trimEnd())
    .join("\n");
}

/** `<id>@<revision>`, split at the last `@` so an id may contain one. */
function parseSource(value: string): { memoryId: string; revision: number } {
  const at = value.lastIndexOf("@");
  const memoryId = value.slice(0, at);
  const revision = value.slice(at + 1);
  if (at <= 0 || !/^[1-9][0-9]{0,14}$/.test(revision)) {
    throw usage("bad-value", "--of takes <id>@<revision>, the revision a whole number from 1");
  }
  return { memoryId, revision: Number(revision) };
}

/**
 * The store's integrity: the open itself checks file types and modes, the schema version and
 * SQLite's verification; then SQLite's integrity_check, every event's JSON and format, and the
 * home directory's mode. Any failure is a store error.
 */
async function check(scope: string, store: SqliteStore, path: string): Promise<Output> {
  const homeMode = Number(lstatSync(dirname(path)).mode) & 0o777;
  if ((homeMode & 0o077) !== 0) {
    throw new CliError("store-file", "the store's directory grants group or others access", "mode");
  }
  const db = new DatabaseSync(path, { readOnly: true });
  let schemaVersion: number;
  let events = 0;
  let memories: number;
  let erasurePending: { work: number; carriers: number };
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new CliError("integrity", "SQLite's integrity check failed", "sqlite");
    }
    schemaVersion = (
      db.prepare("SELECT max(version) AS version FROM schema_version").get() as { version: number }
    ).version;
    for (const row of db.prepare("SELECT body FROM events").iterate() as Iterable<{
      body: string;
    }>) {
      let format: unknown;
      try {
        format = (JSON.parse(row.body) as { format?: unknown }).format;
      } catch {
        throw new CliError("integrity", "an event is not valid JSON", "event-json");
      }
      // Format 1 events, and format 2 promote events a library host may have written.
      if (
        !Number.isSafeInteger(format) ||
        (format as number) < 1 ||
        (format as number) > LATEST_EVENT_FORMAT
      ) {
        throw new CliError("integrity", "an event has an unknown format", "event-format");
      }
      events++;
    }
    memories = (db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n;
    // Counts only: an outbox row's memory id and carrier ids may belong to other scopes.
    erasurePending = db
      .prepare("SELECT count(DISTINCT seq) AS work, count(*) AS carriers FROM erasure_pending")
      .get() as { work: number; carriers: number };
  } finally {
    db.close();
  }
  const walScrubPending = await store.walScrubPending();
  const data = {
    scope,
    store: path,
    integrity: "ok",
    schemaVersion,
    events,
    memories,
    walScrubPending,
    erasurePending: { work: erasurePending.work, carriers: erasurePending.carriers },
  };
  const text = [
    `store: ${path}`,
    `scope: ${scope}`,
    "integrity: ok",
    `schema version: ${schemaVersion}`,
    `events: ${events}`,
    `memories: ${memories}`,
    ...(walScrubPending
      ? ["wal scrub: pending (a redaction's old pages may remain in the WAL)"]
      : []),
    ...(erasurePending.carriers > 0
      ? [
          `erasure pending: ${plural(erasurePending.work, "redaction")}, ${plural(erasurePending.carriers, "carrier")} not acknowledged by a host`,
        ]
      : []),
  ].join("\n");
  return { data, text };
}

/** `count` and `noun`, plural with an s when count is not 1. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function init(env: CliEnv, cwd: string): { output: Output; store: SqliteStore } {
  const path = storePath(env, cwd);
  const created = !existsSync(path);
  let scope: string | null;
  try {
    scope = resolveScope(env, cwd) ?? null;
  } catch (error) {
    // init still creates the store when git cannot answer; the scope is shown as none.
    if (!(error instanceof CliError && error.code === "no-scope")) throw error;
    scope = null;
  }
  // Opening creates the directory (0700) and the file (0600), and migrates it.
  const store = openSqliteStore({ path });
  const output: Output = {
    data: {
      scope,
      store: path,
      created,
      hooks: { claudeCode: hookSnippet(), codex: hookSnippet() },
    },
    text: [
      `store: ${path} (${created ? "created" : "already there"})`,
      `scope: ${scope ?? "none here: run inside a git repository, or set RELEMBRA_SCOPE or RELEMBRA_GLOBAL_SCOPE"}`,
      "",
      "To wake every Claude Code session, add to .claude/settings.json (or ~/.claude/settings.json):",
      JSON.stringify(hookSnippet(), null, 2),
      "",
      "To wake every Codex session, add to .codex/hooks.json (or ~/.codex/hooks.json):",
      JSON.stringify(hookSnippet(), null, 2),
    ].join("\n"),
  };
  return { output, store };
}

/**
 * Whether Bun was handed startup options through the environment: BUN_OPTIONS can move the cwd
 * (and so the scope) or change the runtime, and BUN_BYTECODE_ORDER_OUT makes it write a file.
 * Options that reached the runtime show in execArgv, which a plain run leaves empty.
 */
function unsafeRuntime(env: CliEnv, execArgv: readonly string[]): boolean {
  const set = (value: string | undefined) => value !== undefined && value !== "";
  return set(env.BUN_OPTIONS) || set(env.BUN_BYTECODE_ORDER_OUT) || execArgv.length > 0;
}

/** Runs one invocation and returns its exit code. */
export async function main(
  argv: readonly string[],
  env: CliEnv,
  cwd: string,
  execArgv: readonly string[] = [],
): Promise<number> {
  const json = wantsJson(argv);
  // The session-start hook must never break a session: whatever goes wrong, it exits 0 with
  // nothing for the session's context, and at most one line on stderr.
  const hook = argv.find((arg) => arg !== "--json") === "hook";
  // The MCP server's stdout carries protocol messages only, so it reports a failure to start on
  // stderr, with the CLI's exit code, whatever --json says (docs/CLI.md, mcp).
  const server = argv.find((arg) => arg !== "--json") === "mcp";
  const write = (stream: NodeJS.WriteStream, text: string) => {
    if (text !== "") stream.write(text.endsWith("\n") ? text : `${text}\n`);
  };
  const succeed = (output: Output) => {
    write(process.stdout, json ? JSON.stringify({ ok: true, data: output.data }) : output.text);
    return 0;
  };
  let store: SqliteStore | undefined;
  try {
    if (unsafeRuntime(env, execArgv)) {
      throw new CliError(
        "unsafe-runtime-env",
        "refusing to run with BUN_OPTIONS or BUN_BYTECODE_ORDER_OUT set: unset them",
      );
    }
    const result = parseArgs(argv);
    if (result.kind === "help") return succeed({ data: { usage: usageText() }, text: usageText() });
    const { parsed } = result;
    const context: Context = { parsed, env, cwd };
    const name = parsed.command.name;
    if (name === "init") {
      const opened = init(env, cwd);
      store = opened.store;
      return succeed(opened.output);
    }
    const scopes = resolveScopes(env, cwd);
    const path = storePath(env, cwd);
    // No scope or no store yet is the hook's ordinary quiet case, not an error.
    if (hook && (scopes === undefined || !existsSync(path))) {
      if (json) write(process.stdout, JSON.stringify({ ok: true, data: null }));
      return 0;
    }
    if (scopes === undefined) {
      throw new CliError(
        "no-scope",
        "no scope: run inside a git repository, or set RELEMBRA_SCOPE or RELEMBRA_GLOBAL_SCOPE",
      );
    }
    if (!existsSync(path)) throw new CliError("no-store", `no store at ${path}: run relembra init`);
    store = openSqliteStore({ path });
    if (server) {
      await serveStdio(env, scopes, store);
      return 0;
    }
    return succeed(await runStoreCommand(context, scopes, store, path));
  } catch (error) {
    const failure = toCliError(error);
    if (hook) {
      write(process.stderr, `relembra hook: skipped (${failure.code})`);
      if (json) write(process.stdout, JSON.stringify({ ok: true, data: null }));
      return 0;
    }
    if (server) {
      write(
        process.stderr,
        `relembra mcp: ${failure.message}${failure.rule === undefined ? "" : ` (${failure.rule})`}`,
      );
      return failure.exit;
    }
    return fail(failure, json, write);
  } finally {
    if (store !== undefined) {
      try {
        await store.close();
      } catch (error) {
        // A close that fails after the command succeeded still reports, on stderr only.
        write(process.stderr, `relembra: ${toCliError(error).message}`);
      }
    }
  }
}

function fail(
  error: CliError,
  json: boolean,
  write: (stream: NodeJS.WriteStream, text: string) => void,
): number {
  if (json) {
    const body =
      error.rule === undefined ? { code: error.code } : { code: error.code, rule: error.rule };
    write(process.stdout, JSON.stringify({ ok: false, error: body }));
  } else {
    write(
      process.stderr,
      `relembra: ${error.message}${error.rule === undefined ? "" : ` (${error.rule})`}`,
    );
  }
  return error.exit;
}

if (import.meta.main) {
  // Only the variables docs/CLI.md lists are read.
  const {
    RELEMBRA_HOME,
    RELEMBRA_SCOPE,
    RELEMBRA_GLOBAL_SCOPE,
    RELEMBRA_AGENT,
    RELEMBRA_HARNESS,
    RELEMBRA_MODEL,
    BUN_OPTIONS,
    BUN_BYTECODE_ORDER_OUT,
    PATH,
    HOME,
    XDG_CONFIG_HOME,
  } = process.env;
  const env: CliEnv = {
    RELEMBRA_HOME,
    RELEMBRA_SCOPE,
    RELEMBRA_GLOBAL_SCOPE,
    RELEMBRA_AGENT,
    RELEMBRA_HARNESS,
    RELEMBRA_MODEL,
    BUN_OPTIONS,
    BUN_BYTECODE_ORDER_OUT,
    PATH,
    HOME,
    XDG_CONFIG_HOME,
  };
  const code = await main(process.argv.slice(2), env, process.cwd(), process.execArgv);
  process.exitCode = code;
}
