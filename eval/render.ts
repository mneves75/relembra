/** Rendering per the implementation plan §4.2, shared by the synthetic candidates and the scorer. */
import type { Trust } from "./set.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/**
 * Escapes `&`, `<`, `>` and `"` for evidence text and attribute values, and turns each line
 * separator (LF, CR, NEL, LS, PS) into a decimal reference such as `&#10;`, so a memory always
 * renders on one line (eval/PROTOCOL.md, "Rendering").
 */
export function escapeText(text: string): string {
  return text.replace(
    /[&<>"\n\r\u0085\u2028\u2029]/g,
    (c) => ESCAPES[c] ?? `&#${c.codePointAt(0)};`,
  );
}

export interface Rendered {
  readonly id: string;
  readonly scope: string;
  readonly rev: number;
  readonly at: number;
  readonly trust: Trust;
  readonly text: string;
}

/** One memory as one line of evidence. */
export function renderMemory(m: Rendered): string {
  const attrs = [
    `id="${escapeText(m.id)}"`,
    `scope="${escapeText(m.scope)}"`,
    `rev="${m.rev}"`,
    `at="${new Date(m.at).toISOString()}"`,
    `trust="${m.trust}"`,
  ];
  return `<memory ${attrs.join(" ")}>${escapeText(m.text)}</memory>`;
}
