/**
 * The scorer's side of one candidate: starts it, loads the corpus, and turns every exchange into
 * a call outcome. A broken stream (late, oversized, unsolicited, not JSON, wrong id, exited) kills the
 * candidate; the next call restarts it and reloads the corpus, up to `maxRestarts` times.
 * Whatever the candidate wrote that no call returns is kept as a stray for the scorer: output
 * outside its answers or a broken reply (while the corpus loads, at stop) to fail and leak-check,
 * and the strings of its successful loading replies (its identity, note ids) to leak-check.
 */
import { scanJson } from "./json.js";
import {
  type Command,
  envelopeFault,
  type Fields,
  type NoteItem,
  PROTOCOL_VERSION,
  parseEnvelope,
  type Requests,
  type Results,
  validateResult,
} from "./protocol.js";
import type { CorpusMemory, EvalPrincipal, EvalSet, Trust } from "./set.js";
import { CandidateProcess } from "./transport.js";

export interface SessionOptions {
  readonly deadlineMs: number;
  readonly maxLineBytes: number;
  readonly maxRestarts: number;
  /** Memories per `note` request. */
  readonly batchSize: number;
}

/**
 * One call's outcome. `strings` holds everything the candidate wrote in answer (every string of
 * the parsed line, or the raw text when it was not JSON), for the leak check. `result` is set only
 * when the response passed every check; otherwise `failure` says why.
 */
export interface CallOutcome<C extends Command> {
  readonly strings: readonly string[];
  readonly result?: Results[C];
  readonly failure?: string;
}

/**
 * Output no scored call returned: its strings, for the leak check by text. `reason` says why it is
 * a failure; a successful loading reply has none and is only leak-checked.
 */
export interface Stray {
  readonly strings: readonly string[];
  readonly reason?: string;
}

export interface CandidateIdentity {
  readonly name: string;
  readonly version: string;
}

export class Session {
  readonly #command: readonly string[];
  readonly #set: EvalSet;
  readonly #options: SessionOptions;
  #process: CandidateProcess | undefined;
  #requests = 0;
  #starts = 0;
  #ids = new Map<string, string>();
  #keys = new Map<string, string>();
  #identity: CandidateIdentity | undefined;
  #stderrBytes = 0;
  #strays: Stray[] = [];

  constructor(command: readonly string[], set: EvalSet, options: SessionOptions) {
    this.#command = command;
    this.#set = set;
    this.#options = options;
  }

  get identity(): CandidateIdentity | undefined {
    return this.#identity;
  }

  get restarts(): number {
    return Math.max(0, this.#starts - 1);
  }

  get stderrBytes(): number {
    return this.#stderrBytes + (this.#process?.stderr.totalBytes ?? 0);
  }

  /** Hands over the strays kept since the last call, once. */
  takeStrays(): Stray[] {
    const strays = this.#strays;
    this.#strays = [];
    return strays;
  }

  /** The id the current candidate gave a corpus key. */
  idOf(key: string): string | undefined {
    return this.#ids.get(key);
  }

  /** The corpus key the current candidate's id stands for. */
  keyOf(id: string): string | undefined {
    return this.#keys.get(id);
  }

  /** Sends one request, starting (or restarting) the candidate first when needed. */
  async call<C extends Exclude<Command, "reset" | "note" | "stop">>(
    cmd: C,
    args: Requests[C],
  ): Promise<CallOutcome<C>> {
    if (!(await this.#ensure())) return { strings: [], failure: "candidate unavailable" };
    return this.#send(cmd, args);
  }

  /** Sends `stop` and stops the process, whatever it does. */
  async close(): Promise<void> {
    const process_ = this.#process;
    if (process_ === undefined) return;
    if (process_.alive) this.#keep(await this.#send("stop", {}));
    await process_.close();
    this.#retire();
  }

  async #ensure(): Promise<boolean> {
    if (this.#process?.alive) return true;
    while (this.#starts <= this.#options.maxRestarts) {
      if (await this.#start()) return true;
    }
    return false;
  }

  async #start(): Promise<boolean> {
    if (this.#process) {
      await this.#process.close(0);
      this.#retire();
    }
    this.#starts++;
    this.#ids = new Map();
    this.#keys = new Map();
    this.#process = new CandidateProcess(this.#command, {
      maxLineBytes: this.#options.maxLineBytes,
    });
    const reset = await this.#send("reset", {});
    if (reset.result === undefined) return this.#abandon(reset);
    this.#keep(reset);
    this.#identity = { name: reset.result.name, version: reset.result.version };
    for (const batch of this.#batches()) {
      const memories: NoteItem[] = batch.map((m) => {
        const supersedes = m.supersedes === undefined ? undefined : this.#ids.get(m.supersedes);
        return {
          scope: m.scope,
          text: m.text,
          at: m.at,
          trust: m.trust,
          pinned: m.pinned,
          state: m.state,
          ...(supersedes === undefined ? {} : { supersedes }),
        };
      });
      const first = batch[0];
      if (first === undefined) continue;
      const note = await this.#send("note", { principal: loader(batch, first.trust), memories });
      if (note.result === undefined) return this.#abandon(note);
      this.#keep(note);
      note.result.ids.forEach((id, i) => {
        const key = batch[i]?.key;
        if (key === undefined) return;
        this.#ids.set(key, id);
        this.#keys.set(id, key);
      });
    }
    return true;
  }

  /** Phase 1: memories that supersede nothing; phase 2: the rest. Each batch has one trust. */
  #batches(): CorpusMemory[][] {
    const batches: CorpusMemory[][] = [];
    for (const phase of [false, true]) {
      for (const trust of ["owner", "agent", "untrusted"] as const) {
        const items = this.#set.corpus.filter(
          (m) => (m.supersedes !== undefined) === phase && m.trust === trust,
        );
        for (let i = 0; i < items.length; i += this.#options.batchSize) {
          batches.push(items.slice(i, i + this.#options.batchSize));
        }
      }
    }
    return batches;
  }

  #abandon(outcome: CallOutcome<Command>): false {
    this.#keep(outcome);
    this.#process?.kill();
    return false;
  }

  /** Keeps an outcome no scored call returns: a failure to fail and leak-check, else to leak-check. */
  #keep(outcome: CallOutcome<Command>): void {
    // A failure counts with nothing to inspect too (a bare {} for stop, a silent timeout).
    if (outcome.failure === undefined && outcome.strings.length === 0) return;
    this.#strays.push(
      outcome.failure === undefined
        ? { strings: outcome.strings }
        : { strings: outcome.strings, reason: outcome.failure },
    );
  }

  #retire(): void {
    const text = this.#process?.unreported;
    if (text !== undefined) {
      // The whole text (a leak wrapped across lines), and each line's strings (JSON decoded).
      const strings = [text, ...text.split("\n").flatMap((line) => stringsOf(line))];
      const reason = this.#process?.unreadTruncated
        ? "unsolicited, past the line limit (the rest is not leak-checked)"
        : "unsolicited";
      this.#strays.push({ strings, reason });
    }
    this.#stderrBytes += this.#process?.stderr.totalBytes ?? 0;
    this.#process = undefined;
  }

  async #send<C extends Command>(cmd: C, args: Requests[C]): Promise<CallOutcome<C>> {
    const process_ = this.#process;
    if (process_ === undefined) return { strings: [], failure: "candidate unavailable" };
    const id = `r${++this.#requests}`;
    const deadline =
      this.#options.deadlineMs + (cmd === "note" ? (args as Requests["note"]).memories.length : 0);
    const exchange = await process_.exchange(
      JSON.stringify({ v: PROTOCOL_VERSION, id, cmd, args }),
      deadline,
    );
    if (exchange.status !== "line") {
      process_.kill();
      // The raw partial, and its strings decoded when it happens to be complete JSON.
      const strings =
        exchange.partial === "" ? [] : [exchange.partial, ...decoded(exchange.partial)];
      const detail = exchange.status === "exit" ? exchange.detail : exchange.status;
      return { strings, failure: `${cmd}: ${detail}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(exchange.line);
    } catch {
      process_.kill();
      return { strings: [exchange.line], failure: `${cmd}: response is not JSON` };
    }
    // Every key and string value, a duplicated key's hidden values included, is leak-checked.
    const { strings, duplicate } = scanJson(exchange.line);
    const envelope = parseEnvelope(parsed, id);
    if (!envelope.ok) {
      process_.kill();
      return { strings, failure: `${cmd}: ${envelope.reason}` };
    }
    if (duplicate) return { strings, failure: `${cmd}: duplicate field` };
    const extra = envelopeFault(parsed as Fields);
    if (extra !== undefined) return { strings, failure: `${cmd}: ${extra}` };
    if (envelope.value.kind === "error") {
      return { strings, failure: `${cmd}: error ${envelope.value.code}` };
    }
    const checked = validateResult(cmd, envelope.value.result, {
      args,
      knownIds: new Set(this.#keys.keys()),
    });
    if (!checked.ok) return { strings, failure: checked.reason };
    return { strings, result: checked.value };
  }
}

/** Every string of a JSON line, duplicated keys' hidden values included, or the raw text. */
function stringsOf(line: string): readonly string[] {
  const strings = decoded(line);
  return strings.length > 0 ? strings : [line];
}

/** Every string of `text` when it is one JSON value, duplicated keys' hidden values included. */
function decoded(text: string): readonly string[] {
  try {
    JSON.parse(text);
  } catch {
    return [];
  }
  return scanJson(text).strings;
}

/** The writer of one batch: every scope in it, its trust as the ceiling, pinnable if it pins. */
function loader(batch: readonly CorpusMemory[], trust: Trust): EvalPrincipal {
  return {
    id: `loader-${trust}`,
    readable: [],
    writable: [...new Set(batch.map((m) => m.scope))].sort(),
    promotable: [],
    trustCeiling: trust,
    pinnable: batch.some((m) => m.pinned),
  };
}
