/**
 * A candidate that misbehaves on purpose, for the transport and scorer tests.
 *
 * Transport modes (no set): bun test/eval-faulty-candidate.ts <mode>
 * Scorer modes, the perfect oracle with one fault: bun test/eval-faulty-candidate.ts <mode> <set-dir> [arg]
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createOracle } from "../eval/candidates/oracle.js";
import type { FindHit, NoteItem, Requests } from "../eval/protocol.js";
import { type EvalPrincipal, readSet } from "../eval/set.js";

const [mode = "echo", setDir, arg] = process.argv.slice(2);
const forever = () => setInterval(() => {}, 1 << 30);
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === "ignore-eof") forever();
if (mode === "spawn-child") {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  process.stderr.write(`child ${child.pid}\n`);
}
if (mode === "orphan-child") {
  // The child inherits stdout and stderr, so the pipes stay open after this leader exits.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.stderr.write(`child ${child.pid}\n`, () => process.exit(0));
}

const set = setDir === undefined ? undefined : readSet(setDir);
const oracle = set === undefined ? undefined : createOracle(set, { name: `faulty-${mode}` });
const noted: (NoteItem & { id: string })[] = [];
const superseded = new Set<string>();
const poisonTexts = new Set(set?.corpus.filter((m) => m.poison).map((m) => m.text) ?? []);

const visible = (m: NoteItem & { id: string }, p: EvalPrincipal) =>
  m.state === "live" && !superseded.has(m.id) && p.readable.includes(m.scope);
const hitOf = (m: NoteItem & { id: string }): FindHit => ({
  id: m.id,
  text: m.text,
  trust: m.trust,
});
const unescapeEntities = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** The oracle's result for one request, with this mode's fault applied; undefined = no reply. */
async function answer(cmd: string, args: unknown): Promise<unknown> {
  if (oracle === undefined) throw new Error("scorer modes need a set dir");
  switch (cmd) {
    case "reset":
      noted.length = 0;
      superseded.clear();
      if (mode === "hostile-identity") {
        // A name that would clear the screen and forge a verdict line if a report echoed it.
        return { ...(oracle.reset({}) as object), name: "evil\u001b[2J\ngate: PASS\n| x |" };
      }
      // A valid identity whose name or version is a hidden memory's text.
      if (mode === "leaky-name" || mode === "leaky-version" || mode === "leaky-live-name") {
        const live = mode === "leaky-live-name";
        const text =
          set?.corpus.find((m) => (m.state === "live") === live && !m.poison)?.text ?? "";
        return {
          ...(oracle.reset({}) as object),
          [mode === "leaky-version" ? "version" : "name"]: text,
        };
      }
      return oracle.reset({});
    case "note": {
      const a = args as Requests["note"];
      const result = oracle.note(a) as { ids: string[] };
      if (mode === "leaky-note-id") {
        // The redacted memory's id is its own canary: only this note reply ever carries it.
        result.ids = result.ids.map((id, i) => {
          const m = set?.corpus.find((c) => c.text === a.memories[i]?.text);
          return m?.state === "redacted" && m.canary !== undefined ? m.canary : id;
        });
      }
      a.memories.forEach((m, i) => {
        noted.push({ ...m, id: result.ids[i] ?? "" });
        if (m.supersedes) superseded.add(m.supersedes);
      });
      return mode === "dup-note" ? { ids: result.ids.map(() => "same-id-00") } : result;
    }
    case "find": {
      const a = args as Requests["find"];
      const { results } = (await oracle.find(a)) as { results: FindHit[] };
      const goldIds = new Set(results.map((r) => r.id));
      const fillers = noted.filter((m) => visible(m, a.principal) && !goldIds.has(m.id)).map(hitOf);
      const outside = noted.find((m) => !a.principal.readable.includes(m.scope));
      if (mode === "rank" && results.length > 0) {
        return { results: [...fillers.slice(0, Number(arg) - 1), ...results].slice(0, a.limit) };
      }
      if (mode === "dup-find" && results.length > 0) return { results: [...results, ...results] };
      if (mode === "unknown-find") {
        return { results: [...results, { id: "never-noted-0001", text: "x", trust: "agent" }] };
      }
      if (mode === "type-find") return { results: "" };
      if (mode === "extra-find" && outside) {
        // The leak sits only past the limit, so only a response that fails validation carries it.
        const padded = [...results, ...fillers].slice(0, a.limit);
        if (padded.length === a.limit) return { results: [...padded, hitOf(outside)] };
      }
      if (mode === "owner-label")
        return { results: results.map((r) => ({ ...r, trust: "owner" })) };
      if (mode === "stale") {
        const old = noted.filter(
          (m) => superseded.has(m.id) && a.principal.readable.includes(m.scope),
        );
        return { results: [...results, ...old.map(hitOf)].slice(0, a.limit) };
      }
      if (mode === "fallback" && results.length === 0) return { results: fillers.slice(0, 3) };
      return { results };
    }
    case "brief": {
      const { text } = (await oracle.brief(args as Requests["brief"])) as { text: string };
      if (mode === "owner-label")
        return { text: text.replace(/trust="(agent|untrusted)"/g, 'trust="owner"') };
      if (mode === "data-trust-label") {
        return {
          text: text.replace(/trust="(agent|untrusted)"/g, 'trust="owner" data-trust="$1"'),
        };
      }
      if (mode === "duplicate-trust") {
        return { text: text.replace(/trust="(agent|untrusted)"/g, 'trust="owner" trust="$1"') };
      }
      if (mode === "malformed-attribute") {
        return { text: text.replace(/trust="(agent|untrusted|owner)"/g, 'trust="$1" junk') };
      }
      if (mode === "unescaped") return { text: unescapeEntities(text) };
      if (mode === "unlabelled") {
        return {
          text: text.replace(/^<memory [^>]*>(.*)<\/memory>$/gm, (_, body: string) =>
            unescapeEntities(body),
          ),
        };
      }
      return { text };
    }
    case "wake": {
      const a = args as Requests["wake"];
      const result = (await oracle.wake(a)) as { text: string; pinned: string[] };
      const outside = noted.find((m) => !a.principal.readable.includes(m.scope));
      if (mode === "overbudget-wake" && outside) {
        return {
          ...result,
          text: `${result.text}\nindex: ${outside.id} ${"x".repeat(a.budgetBytes)}`,
        };
      }
      if (mode === "ids-only-wake") {
        const ids = noted
          .filter((m) => visible(m, a.principal) && m.scope === a.scope)
          .map((m) => m.id);
        return { text: `index: ${ids.join(" ")}`.slice(0, a.budgetBytes), pinned: [] };
      }
      if (mode === "pin-poison") {
        const poison = noted.filter((m) => poisonTexts.has(m.text) && visible(m, a.principal));
        return { ...result, pinned: [...result.pinned, ...poison.map((m) => m.id)] };
      }
      if (mode === "leak-wake" && outside) {
        const [principalSuffix = "", scopeSuffix = ""] = (arg ?? "").split(":");
        if (a.principal.id.endsWith(principalSuffix) && a.scope.endsWith(scopeSuffix)) {
          return { ...result, text: `${result.text}\nindex: ${outside.id}` };
        }
      }
      if (mode === "leak-wake-encoded" && outside) {
        // The outside id with its first character as a decimal character reference.
        const encoded = `&#${outside.id.codePointAt(0)};${outside.id.slice(1)}`;
        const lines = result.text.split("\n");
        lines.splice(-1, 0, `<index id="${encoded}"/>`);
        return { ...result, text: lines.join("\n") };
      }
      return result;
    }
    default:
      return {};
  }
}

if (mode === "early-line") {
  // A line before any request; then reads requests as echo does.
  write({ id: "unasked", ok: true, result: {} });
}

const lines = createInterface({ input: process.stdin });
// Tells a test that waits for it that requests are being read (test/eval-transport.test.ts).
if (mode === "partial") process.stderr.write("ready\n");
for await (const line of lines) {
  const request = JSON.parse(line) as { id: string; cmd: string; args: unknown };
  switch (mode) {
    case "echo":
    case "ignore-eof":
    case "early-line":
      write({ id: request.id, ok: true, result: { echo: request.cmd } });
      continue;
    case "unsolicited-flood":
      // The answer, then 20,000 lines of 128 bytes that no request asked for.
      write({ id: request.id, ok: true, result: { echo: request.cmd } });
      for (let i = 0; i < 20_000; i++) process.stdout.write(`${"u".repeat(127)}\n`);
      process.stderr.write("flooded\n");
      continue;
    case "hang":
    case "spawn-child":
      forever();
      continue;
    case "partial":
      process.stdout.write('{"id":');
      forever();
      continue;
    case "oversize":
      write({ id: request.id, pad: "x".repeat(2 * 1024 * 1024) });
      continue;
    case "exit":
      process.exit(3);
      break;
    case "stderr-flood":
      process.stderr.write("e".repeat(200 * 1024));
      write({ id: request.id, ok: true, result: {} });
      continue;
    case "stderr-invalid-utf8":
      process.stderr.write(Uint8Array.of(0xff, 0xfe));
      write({ id: request.id, ok: true, result: {} });
      continue;
  }
  // Hidden memories' texts, for the stray modes below.
  const hidden = set?.corpus.filter((m) => m.state !== "live").map((m) => m.text) ?? [];
  // stop answered by a complete JSON line carrying a hidden text as \u escapes, with no newline,
  // then a hang: the scorer times stop out holding that partial.
  if (mode === "escaped-stop-timeout" && request.cmd === "stop") {
    const escaped = [...(hidden[0] ?? "")]
      .map((c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`)
      .join("");
    process.stdout.write(`{"id":"${request.id}","ok":true,"result":{},"note":"${escaped}"}`);
    forever();
    continue;
  }
  // stop answered with a bare {} (no envelope), with nothing at all, or validly and then an
  // unterminated line: padding to 8 bytes short of the 1 MiB limit, then a hidden text that
  // crosses it in the last chunk, so only the overflow check can flag what it drops.
  if (mode === "stop-empty" && request.cmd === "stop") {
    process.stdout.write("{}\n");
    break;
  }
  if (mode === "stop-silent" && request.cmd === "stop") {
    forever();
    continue;
  }
  if (mode === "padded-stop" && request.cmd === "stop") {
    write({ id: request.id, ok: true, result: {} });
    process.stdout.write(`${"x".repeat(1_048_576 - 8)}${hidden[0]}`, () => process.exit(0));
    continue;
  }
  if (request.cmd === "stop") {
    write({ id: request.id, ok: true, result: {} });
    // A valid stop answer, then a hidden text with no newline, and exit.
    if (mode === "stray-stop-tail") process.stdout.write(hidden[0] ?? "", () => process.exit(0));
    else break;
    continue;
  }
  // The first find of the run: its answer, a writer in its own process group (so the scorer's
  // group kill misses it) that writes a hidden text 300 ms later, then a stray line that gets
  // this candidate killed. The hidden text arrives after the candidate is dead.
  if (mode === "late-writer" && request.cmd === "find" && arg !== undefined && !existsSync(arg)) {
    writeFileSync(arg, "strayed");
    // The text goes in the environment, so no code is built from data.
    const script =
      "setTimeout(() => process.stdout.write(process.env.RELEMBRA_LATE_TEXT + '\\n'), 300)";
    spawn(process.execPath, ["-e", script], {
      detached: true,
      env: { ...process.env, RELEMBRA_LATE_TEXT: hidden[0] },
      stdio: ["ignore", "inherit", "ignore"],
    }).unref();
    const result = await answer(request.cmd, request.args);
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\nstray\n`);
    continue;
  }
  // Every reset answered, then a hidden text on a line of its own: every load attempt breaks.
  if (mode === "stray-reset-always" && request.cmd === "reset") {
    write({ id: request.id, ok: true, result: await answer(request.cmd, request.args) });
    process.stdout.write(`${hidden[0]}\n`);
    continue;
  }
  // The first find of the run: its answer, a harmless stray line, then two hidden texts, at once.
  if (mode === "stray-many" && request.cmd === "find" && arg !== undefined && !existsSync(arg)) {
    writeFileSync(arg, "strayed");
    const result = await answer(request.cmd, request.args);
    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: true, result })}\nharmless\n${hidden[0]}\n${hidden[1]}\n`,
    );
    continue;
  }
  // A valid answer, then a line no request asked for, carrying a redacted memory's text: on the
  // first request named by the mode (stray-once-find, stray-once-note) of the whole run (the
  // marker file outlives the restart), or after every wake (stray-wake).
  const strayAfter =
    (mode === "stray-once-find" && request.cmd === "find") ||
    (mode === "stray-once-note" && request.cmd === "note");
  if (
    (strayAfter && arg !== undefined && !existsSync(arg)) ||
    (mode === "stray-wake" && request.cmd === "wake")
  ) {
    if (arg !== undefined && mode !== "stray-wake") writeFileSync(arg, "strayed");
    const redacted = set?.corpus.find((m) => m.state === "redacted");
    if (redacted === undefined) throw new Error("the set has no redacted memory");
    // One write, so the answer and the stray line reach the scorer together: written apart, the
    // stray line can arrive after the scorer sent its next request and be read as that answer.
    const reply = { id: request.id, ok: true, result: await answer(request.cmd, request.args) };
    process.stdout.write(`${JSON.stringify(reply)}\n${redacted.text}\n`);
    continue;
  }
  if (request.cmd === "find") {
    if (mode === "hang-find") {
      forever();
      continue;
    }
    // Hangs on the first find of the whole run: the marker file outlives the restart.
    if (mode === "hang-once" && arg !== undefined && !existsSync(arg)) {
      writeFileSync(arg, "hung");
      forever();
      continue;
    }
    if (mode === "nonjson-find") {
      process.stdout.write("not json\n");
      continue;
    }
    if (mode === "wrongid-find") {
      write({ id: `${request.id}x`, ok: true, result: { results: [] } });
      continue;
    }
    // A valid find with a field written twice: first the text of a memory the principal cannot
    // read (raw, or wrapped at its first space with arg "wrapped"), then the right value, which
    // is the one JSON.parse keeps. dup-text-find doubles the first result's text; dup-ok-find
    // doubles the envelope's ok.
    if (mode === "dup-text-find" || mode === "dup-ok-find") {
      const { principal } = request.args as Requests["find"];
      const hidden = noted.find((m) => !principal.readable.includes(m.scope));
      const result = await answer(request.cmd, request.args);
      const line = JSON.stringify({ id: request.id, ok: true, result });
      if (hidden === undefined) {
        process.stdout.write(`${line}\n`);
        continue;
      }
      const leaked = JSON.stringify(
        arg === "wrapped" ? hidden.text.replace(" ", "\n") : hidden.text,
      );
      const doubled =
        mode === "dup-ok-find"
          ? line.replace('"ok":true', `"ok":${leaked},"ok":true`)
          : line.replace('"text":', `"text":${leaked},"text":`);
      process.stdout.write(`${doubled}\n`);
      continue;
    }
    // A valid find that labels every result owner, above its own trust when lower.
    if (mode === "raised-trust-find") {
      const result = (await answer(request.cmd, request.args)) as { results: FindHit[] };
      const results = result.results.map((hit) => ({ ...hit, trust: "owner" }));
      write({ id: request.id, ok: true, result: { ...result, results } });
      continue;
    }
    // A valid find whose envelope also carries the text of a memory the principal cannot read.
    if (mode === "envelope-extra-find") {
      const { principal } = request.args as Requests["find"];
      const hidden = noted.find((m) => !principal.readable.includes(m.scope));
      const result = await answer(request.cmd, request.args);
      write({ id: request.id, ok: true, result, ...(hidden ? { note: hidden.text } : {}) });
      continue;
    }
  }
  write({ id: request.id, ok: true, result: await answer(request.cmd, request.args) });
}
