/**
 * Finding a memory inside a candidate's response. A memory is exposed when any string in the
 * response holds its id as a bounded token, its full text (raw or escaped), or its canary token,
 * either as written or with its character references decoded. Texts compare with every run of
 * whitespace as one space, so a text wrapped across lines is still found.
 * A reworded rendering is not detected; planted memories carry canaries so a partial one is.
 */
import { escapeText } from "./render.js";

export interface Findable {
  readonly id: string;
  readonly text: string;
  readonly canary?: string;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function containsId(haystack: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRegex(id)}(?![A-Za-z0-9_-])`).test(haystack);
}

function containsToken(haystack: string, token: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(token)}(?![A-Za-z0-9])`).test(haystack);
}

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** One level of decimal, hex and the five named XML character references decoded. */
export function decodeReferences(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (match, dec, hex, name) => {
      if (name !== undefined) return NAMED[name] ?? match;
      const code = dec !== undefined ? Number(dec) : Number.parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}

/** Most decoding levels inspected: `&amp;#109;` is one level deeper than `&#109;`. */
const MAX_DECODE_LEVELS = 4;

/** `haystack` as written, and each further level of its character references decoded. */
function readings(haystack: string): string[] {
  const out = [haystack];
  for (let level = 0; level < MAX_DECODE_LEVELS; level++) {
    const next = decodeReferences(out.at(-1) as string);
    if (next === out.at(-1)) break;
    out.push(next);
  }
  return out;
}

/**
 * Whether `memory` appears in `haystack` by id, text or canary, in the raw text or after its
 * character references are decoded, so `&#109;em-1` cannot hide `mem-1`.
 */
export function exposes(haystack: string, memory: Findable): boolean {
  return readings(haystack).some(
    (reading) => containsId(reading, memory.id) || textIn(reading, memory),
  );
}

/** Whether `memory`'s text (not its id) appears in `haystack`, raw or decoded. */
export function exposesText(haystack: string, memory: Findable): boolean {
  return readings(haystack).some((reading) => textIn(reading, memory));
}

/** Every run of whitespace, line separators and NEL included, as one space. */
const spaced = (text: string) => text.replace(/[\s\u0085]+/g, " ");

/** Text compares with its whitespace normalized on both sides, so wrapping hides nothing. */
function textIn(haystack: string, memory: Findable): boolean {
  const normal = spaced(haystack);
  return (
    normal.includes(spaced(memory.text)) ||
    normal.includes(spaced(escapeText(memory.text))) ||
    (memory.canary !== undefined && containsToken(haystack, memory.canary))
  );
}
