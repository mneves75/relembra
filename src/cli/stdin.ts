import { isatty } from "node:tty";
import { GuardError } from "../errors.js";
import { MAX_MEMORY_BYTES } from "../guard.js";
import { CliError, usage } from "./errors.js";

/**
 * The most bytes read from stdin: a memory's 280 (MAX_MEMORY_BYTES) and a trailing `\r\n`. One
 * byte more is refused as too long at once, without waiting for the rest or for the end.
 */
export const MAX_STDIN_BYTES = MAX_MEMORY_BYTES + 2;

/** How long stdin may take to end. A writer that never closes it is refused, not waited on. */
export const STDIN_DEADLINE_MS = 5_000;

/**
 * A memory's text from stdin: UTF-8, at most MAX_STDIN_BYTES, with one trailing line break
 * removed (what `echo` adds). A byte-order mark is kept, so the guard refuses it as it refuses
 * one in an argument. A terminal on stdin is a usage error, never a wait.
 */
export function readStdinText(): Promise<string> {
  if (isatty(0)) throw usage("missing-argument", "give the text as an argument or on stdin");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const stdin = process.stdin;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      stdin.destroy();
      settle();
    };
    const onData = (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_STDIN_BYTES) finish(() => reject(new GuardError("too-long")));
      else chunks.push(chunk);
    };
    const onEnd = () =>
      finish(() => {
        try {
          resolve(decode(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
    const onError = (error: Error) => finish(() => reject(error));
    const timer = setTimeout(
      () =>
        finish(() => reject(new CliError("input-timeout", "stdin did not end within 5 seconds"))),
      STDIN_DEADLINE_MS,
    );
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
  });
}

/** The bytes as UTF-8, a BOM kept, one trailing line break removed. */
function decode(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new GuardError("ill-formed");
  }
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}
