/**
 * One candidate subprocess, spoken to one JSON line at a time. Every exchange is bounded: a
 * response must arrive within its deadline and fit in `maxLineBytes`, or the process group is
 * killed; a line that arrives while no exchange waits for one kills it too, so nothing is ever
 * queued. Stdout that no exchange returns (that line, whatever follows it, an unterminated tail at
 * exit) is kept, bounded, for the scorer to inspect. Stderr is drained into a bounded tail so a
 * chatty candidate can neither block nor flood.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface TransportOptions {
  /** The longest response line accepted, in bytes. Default 1 MiB. */
  readonly maxLineBytes?: number;
  /** How much of the candidate's stderr is kept (its tail), in UTF-16 code units. Default 16,384. */
  readonly stderrBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The outcome of one exchange. Anything but `line` leaves the process dead. `partial` is whatever
 * the candidate wrote of an unfinished line, so the scorer can still inspect it; for
 * `unsolicited`, it is the first line that arrived while no exchange waited for one.
 */
export type Exchange =
  | { readonly status: "line"; readonly line: string }
  | { readonly status: "timeout"; readonly partial: string }
  | { readonly status: "oversize"; readonly partial: string }
  | { readonly status: "unsolicited"; readonly partial: string }
  | { readonly status: "exit"; readonly partial: string; readonly detail: string };

const DEFAULT_MAX_LINE = 1024 * 1024;
const DEFAULT_STDERR = 16 * 1024;

export class CandidateProcess {
  readonly #child: ChildProcess;
  readonly #maxLine: number;
  readonly #stderrLimit: number;
  #buffer = "";
  #bufferBytes = 0;
  /** The first line that arrived with no exchange waiting; set, the candidate is killed. */
  #unsolicited: string | undefined;
  /** Whether an exchange has returned `#unsolicited` to the scorer. */
  #unsolicitedReported = false;
  /** Other stdout no exchange returned, at most `#maxLine` bytes of it. */
  #unread = "";
  #unreadBytes = 0;
  /** Whether stdout past that limit was dropped. */
  #unreadTruncated = false;
  #waiter: ((exchange: Exchange) => void) | undefined;
  #exited: string | undefined;
  #oversized = false;
  #killed = false;
  #stderr = "";
  #stderrTotal = 0;
  readonly #closed: Promise<void>;

  constructor(command: readonly string[], options: TransportOptions = {}) {
    const [file, ...args] = command;
    if (file === undefined) throw new Error("empty candidate command");
    this.#maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE;
    this.#stderrLimit = options.stderrBytes ?? DEFAULT_STDERR;
    this.#child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a kill reaches anything the candidate started.
      detached: true,
      env: { ...process.env, ...options.env },
    });
    this.#closed = new Promise((resolve) => {
      this.#child.once("close", () => resolve());
    });
    this.#child.once("error", (error) => this.#exit(`could not run: ${error.message}`));
    // "close", not "exit": a line written just before exiting is delivered first.
    this.#child.once("close", (code, signal) =>
      this.#exit(`exited (code ${code}, signal ${signal})`),
    );
    this.#child.stdin?.on("error", () => {});
    this.#child.stdout?.setEncoding("utf8");
    this.#child.stdout?.on("data", (chunk: string) => this.#onStdout(chunk));
    // Raw bytes are counted before decoding, so invalid UTF-8 counts as written.
    const stderrText = new StringDecoder("utf8");
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderrTotal += chunk.length;
      this.#stderr = (this.#stderr + stderrText.write(chunk)).slice(-this.#stderrLimit);
    });
  }

  get alive(): boolean {
    return (
      this.#exited === undefined &&
      !this.#oversized &&
      !this.#killed &&
      this.#unsolicited === undefined
    );
  }

  /**
   * Everything on stdout that no exchange returned: the unsolicited line (unless an exchange
   * reported it), then whatever else arrived unasked, an unterminated tail included. Undefined
   * when there is none. The scorer must still inspect it.
   */
  get unreported(): string | undefined {
    const parts: string[] = [];
    if (this.#unsolicited !== undefined && !this.#unsolicitedReported)
      parts.push(this.#unsolicited);
    if (this.#unread !== "") parts.push(this.#unread);
    return parts.length === 0 ? undefined : parts.join("\n");
  }

  /** Whether unreported stdout went past the line limit, so its rest was dropped unread. */
  get unreadTruncated(): boolean {
    return this.#unreadTruncated;
  }

  /** The tail of stderr, and how many bytes the candidate wrote there in all. */
  get stderr(): { readonly tail: string; readonly totalBytes: number } {
    return { tail: this.#stderr, totalBytes: this.#stderrTotal };
  }

  /** Sends one line and waits for the next response line, at most `deadlineMs`. */
  exchange(line: string, deadlineMs: number): Promise<Exchange> {
    if (this.#waiter) throw new Error("one exchange at a time");
    if (this.#unsolicited !== undefined) {
      this.#unsolicitedReported = true;
      return Promise.resolve({ status: "unsolicited", partial: this.#unsolicited });
    }
    if (!this.alive) {
      return Promise.resolve({ status: "exit", partial: "", detail: this.#exited ?? "dead" });
    }
    this.#child.stdin?.write(`${line}\n`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        const partial = this.#buffer;
        this.#buffer = "";
        this.#bufferBytes = 0;
        this.kill();
        resolve({ status: "timeout", partial });
      }, deadlineMs);
      this.#waiter = (exchange) => {
        clearTimeout(timer);
        this.#waiter = undefined;
        resolve(exchange);
      };
    });
  }

  /**
   * Kills the candidate's process group at once, even after its leader exited: a child it started
   * may still hold the pipes, and close would wait on them forever.
   */
  kill(): void {
    this.#killed = true;
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // No group left; the leader alone, if it still runs.
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill("SIGKILL");
      }
    }
  }

  /** Closes stdin, gives the candidate `graceMs` to exit, then kills it; resolves once it is gone. */
  async close(graceMs = 1000): Promise<void> {
    this.#child.stdin?.end();
    const timer = setTimeout(() => this.kill(), graceMs);
    await this.#closed;
    clearTimeout(timer);
    // The group may outlive its leader; make sure nothing the candidate started survives.
    this.kill();
  }

  #onStdout(chunk: string): void {
    // Dead already (killed at a deadline, oversized, unsolicited): whatever still arrives is no
    // answer, but it is kept for the scorer to inspect.
    if (!this.alive) {
      this.#keepUnread(chunk);
      return;
    }
    let rest = chunk;
    for (let newline = rest.indexOf("\n"); newline !== -1; newline = rest.indexOf("\n")) {
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (!this.#append(piece)) {
        this.#keepUnread(rest);
        return;
      }
      const line = this.#buffer;
      this.#buffer = "";
      this.#bufferBytes = 0;
      this.#deliver({ status: "line", line });
      if (!this.alive) {
        this.#keepUnread(rest);
        return;
      }
    }
    this.#append(rest);
  }

  /** Keeps stdout no exchange returns, up to `#maxLine` bytes in all; past that it is dropped. */
  #keepUnread(text: string): void {
    if (text === "") return;
    const room = this.#maxLine - this.#unreadBytes;
    const bytes = Buffer.from(text);
    if (bytes.length > room) this.#unreadTruncated = true;
    if (room <= 0) return;
    const kept = bytes.length <= room ? text : bytes.subarray(0, room).toString();
    this.#unread += kept;
    this.#unreadBytes += Math.min(bytes.length, room);
  }

  /** Adds to the unfinished line; false (and the process killed) once it is over the limit. */
  #append(piece: string): boolean {
    this.#bufferBytes += Buffer.byteLength(piece);
    this.#buffer += piece;
    if (this.#bufferBytes <= this.#maxLine) return true;
    this.#oversized = true;
    // With no exchange waiting, the partial is kept unread and the overflow is dropped unread.
    if (this.#waiter === undefined) this.#unreadTruncated = true;
    const partial = this.#buffer.slice(0, this.#maxLine);
    this.#buffer = "";
    this.#bufferBytes = 0;
    this.kill();
    this.#deliver({ status: "oversize", partial });
    return false;
  }

  /**
   * Hands `exchange` to the waiting exchange. A line with none waiting (before the first request,
   * or a second line for one request) breaks one response per request: it is kept for the next
   * exchange to report, and the candidate is killed, so no line is ever queued. Any other output
   * with none waiting (an oversized or unterminated line) is kept unread.
   */
  #deliver(exchange: Exchange): void {
    if (this.#waiter) {
      this.#waiter(exchange);
    } else if (exchange.status === "line" && this.#unsolicited === undefined) {
      this.#unsolicited = exchange.line;
      this.kill();
    } else {
      this.#keepUnread(exchange.status === "line" ? `${exchange.line}\n` : exchange.partial);
    }
  }

  #exit(detail: string): void {
    if (this.#exited !== undefined) return;
    this.#exited = detail;
    const partial = this.#buffer;
    this.#buffer = "";
    this.#bufferBytes = 0;
    this.#deliver({ status: "exit", partial, detail });
  }
}
