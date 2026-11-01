/**
 * The stdio framing of MCP 2026-07-28 (basic/transports/stdio): one JSON-RPC message per line,
 * delimited by newlines, UTF-8. Split on bytes, so a chunk boundary inside a multi-byte character
 * changes nothing, with a cap on what one line may hold.
 */

/**
 * The most bytes one message line may hold before its newline, a trailing CR included: 1 MiB.
 * The largest message this server takes is a tools/call of at most a few KiB (a 280-byte note,
 * a 1,000-character query, `_meta` with client info); the cap leaves room for a client that puts
 * icons in its client info, and bounds what one line can make the server hold in memory.
 */
export const MAX_MESSAGE_BYTES = 1_048_576;

export type Frame =
  /** A complete line, decoded, without its newline or a trailing CR. */
  | { readonly kind: "line"; readonly text: string }
  /** A complete line that is not well-formed UTF-8. */
  | { readonly kind: "ill-formed" }
  /** A line longer than the cap; its bytes were discarded as they arrived. */
  | { readonly kind: "oversized" };

const NEWLINE = 0x0a;
const CR = 0x0d;

export class LineSplitter {
  readonly #maxBytes: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #parts: Uint8Array[] = [];
  #size = 0;
  /** Inside a line past the cap: drop bytes up to its newline. */
  #discarding = false;

  constructor(maxBytes: number = MAX_MESSAGE_BYTES) {
    this.#maxBytes = maxBytes;
  }

  /** The frames `chunk` completes, in order. */
  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(NEWLINE, start);
      const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (!this.#discarding) {
        this.#size += piece.length;
        if (this.#size > this.#maxBytes) {
          this.#discarding = true;
          this.#parts = [];
          this.#size = 0;
        } else if (piece.length > 0) {
          // Copied: the caller may reuse the chunk's buffer.
          this.#parts.push(piece.slice());
        }
      }
      if (end < 0) break;
      frames.push(this.#discarding ? { kind: "oversized" } : this.#line());
      this.#discarding = false;
      this.#parts = [];
      this.#size = 0;
      start = end + 1;
    }
    return frames;
  }

  /**
   * The input ended. An unterminated final line is not a message (the stdio binding delimits
   * messages by newlines), so it is dropped, never decoded or executed; its size is returned for
   * the log. A line being discarded for its size counts as nothing held.
   */
  end(): { partialBytes: number } {
    const partialBytes = this.#discarding ? 0 : this.#size;
    this.#parts = [];
    this.#size = 0;
    this.#discarding = false;
    return { partialBytes };
  }

  #line(): Frame {
    let bytes = this.#parts.length === 1 ? (this.#parts[0] as Uint8Array) : concat(this.#parts);
    if (bytes.length > 0 && bytes[bytes.length - 1] === CR) bytes = bytes.subarray(0, -1);
    try {
      return { kind: "line", text: this.#decoder.decode(bytes) };
    } catch {
      return { kind: "ill-formed" };
    }
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
