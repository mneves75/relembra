import { randomInt } from "node:crypto";
import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";
import { CliError } from "./errors.js";

const CONFIRM_TIMEOUT_MS = 60_000;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
/** Waited on between reads of a terminal that has nothing yet, instead of spinning. */
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

const refuse = (rule: string, message: string) =>
  new CliError("owner-confirmation-required", message, rule);

/**
 * Asks the person at the controlling terminal to confirm an owner-trust action: shows `lines`
 * (already guard-checked, so they render plainly), prints a random code and requires it typed
 * back within CONFIRM_TIMEOUT_MS. Reads and writes /dev/tty only, never stdin or stdout, so an
 * agent whose tool call has no terminal cannot answer, and one sharing the user's terminal never
 * sees the code. Throws owner-confirmation-required: `no-tty`, `mismatch` or `timeout`.
 *
 * Not a security boundary: a process running as the same OS user can open the store directly,
 * and one that can drive a pseudo-terminal can read the code off it (docs/CLI.md, Trust).
 */
export function confirmOwner(lines: readonly string[]): void {
  let fd: number;
  try {
    fd = openSync("/dev/tty", constants.O_RDWR | constants.O_NONBLOCK);
  } catch {
    throw refuse(
      "no-tty",
      "owner trust needs confirmation at a terminal, and this process has none",
    );
  }
  try {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const prompt = [
      "relembra: this needs owner trust:",
      ...lines.map((line) => `  ${line}`),
      `Type ${code} to confirm (${CONFIRM_TIMEOUT_MS / 1000} s): `,
    ].join("\n");
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    writeAll(fd, prompt, deadline);
    const answer = readLine(fd, deadline);
    if (answer === undefined) {
      tryWriteAll(fd, "\nrelembra: not confirmed (timed out)\n", Date.now() + 1_000);
      throw refuse("timeout", "owner trust was not confirmed in time");
    }
    if (answer.trim().toUpperCase() !== code) {
      tryWriteAll(fd, "relembra: not confirmed (wrong code)\n", Date.now() + 1_000);
      throw refuse("mismatch", "owner trust was not confirmed: the code did not match");
    }
  } finally {
    closeSync(fd);
  }
}

/** Writes all UTF-8 bytes of `text` to a non-blocking terminal fd, retrying EAGAIN and short writes. */
function writeAll(fd: number, text: string, deadline: number): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    if (Date.now() >= deadline) {
      throw refuse("timeout", "owner trust was not confirmed in time");
    }
    try {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        throw refuse("no-tty", "owner trust could not be confirmed: the terminal closed");
      }
      offset += written;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        Atomics.wait(PAUSE, 0, 0, 20);
        continue;
      }
      throw refuse("no-tty", "owner trust could not be confirmed: the terminal closed");
    }
  }
}

/** Best-effort feedback write before refusing: a hung-up terminal must still yield owner-confirmation-required. */
function tryWriteAll(fd: number, text: string, deadline: number): void {
  try {
    writeAll(fd, text, deadline);
  } catch {
    // Feedback is advisory; the refusal error takes precedence.
  }
}

/** One line from the terminal, or undefined at the deadline. At most 64 bytes are kept. */
function readLine(fd: number, deadline: number): string | undefined {
  const buffer = new Uint8Array(64);
  let length = 0;
  while (Date.now() < deadline) {
    let read: number;
    try {
      read = readSync(fd, buffer, length, buffer.length - length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        Atomics.wait(PAUSE, 0, 0, 20);
        continue;
      }
      return "";
    }
    if (read === 0) return "";
    length += read;
    const text = new TextDecoder().decode(buffer.subarray(0, length));
    const end = text.search(/[\r\n]/);
    if (end >= 0) return text.slice(0, end);
    if (length === buffer.length) return text;
  }
  return undefined;
}
