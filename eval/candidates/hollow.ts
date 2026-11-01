/**
 * The hollow synthetic candidates: the perfect oracle with the answer's content taken out or
 * falsified on one surface, ids and ranking untouched. Each must fail, which proves the gate
 * reads content, not only ids.
 * Usage: bun eval/candidates/hollow.ts <set-dir> <mode>
 *   empty-brief:        every brief is "".
 *   empty-text:         every find result keeps its id and trust, with text "".
 *   wrong-text:         every find result keeps its id and trust, with its digits changed (a wrong
 *                       port, hour or count) or, without digits, a word added.
 *   wrong-scope:        every rendered memory in a brief or wake says scope="never-readable".
 *   wrong-rev:          every rendered memory says rev="0".
 *   wrong-at:           every rendered memory says at="not-a-date".
 *   duplicate-conflict: the first rendered memory of each brief and wake appears again, under the
 *                       same id, with its text falsified as in wrong-text.
 *   duplicate-exact:    the first rendered memory of each brief and wake appears twice, unchanged.
 *   indented-conflict:  the first non-poison rendered memory of each brief and wake appears again,
 *                       indented by one space, with its text falsified as in wrong-text.
 *   index-text:         every non-poison rendered memory of a wake becomes an index line that
 *                       carries its text in an attribute: <index id="…" text="…"/>.
 *   bare-text:          every non-poison rendered memory of a wake becomes its bare text.
 *   wrapped-text:       after the first non-poison rendered memory of each brief and wake, its
 *                       text again, wrapped onto two lines at its first space.
 *   encoded-duplicate:  after the first non-poison rendered memory of each brief and wake, the
 *                       same element with its tags written as &lt;…&gt; and a false body.
 * The last five leave poison memories alone, so the label checks stay quiet and only the
 * rendering rules can fail them.
 *   extra-raw:          the first find result also carries `extra`: the text of an ordinary
 *                       memory the principal cannot read.
 *   extra-wrapped:      the same, with that text wrapped onto two lines at its first space.
 *   appended-raw:       that text appended to the first find result's own text.
 *   appended-wrapped:   the same, wrapped.
 *   error-raw:          every find answers an internal error whose message is that text.
 *   error-wrapped:      the same, wrapped.
 * Each raw/wrapped pair must count the same leaks: whitespace never hides a memory.
 */
import type { FindHit, Requests, Results } from "../protocol.js";
import { escapeText } from "../render.js";
import { type EvalSet, readSet } from "../set.js";
import { createOracle } from "./oracle.js";
import { type CandidateHandler, serve } from "./serve.js";

export const HOLLOW_MODES = [
  "empty-brief",
  "empty-text",
  "wrong-text",
  "wrong-scope",
  "wrong-rev",
  "wrong-at",
  "duplicate-conflict",
  "duplicate-exact",
  "indented-conflict",
  "index-text",
  "bare-text",
  "wrapped-text",
  "encoded-duplicate",
  "extra-raw",
  "extra-wrapped",
  "appended-raw",
  "appended-wrapped",
  "error-raw",
  "error-wrapped",
] as const;
export type HollowMode = (typeof HOLLOW_MODES)[number];

function wrong(text: string): string {
  return /\d/.test(text)
    ? text.replace(/\d/g, (d) => String((Number(d) + 1) % 10))
    : `${text} Not.`;
}

const MEMORY = /^(<memory [^>]*>)(.*)(<\/memory>)$/;

/**
 * A brief or wake text with its memory lines falsified as `mode` says. `poisoned` holds the
 * escaped texts of the poison memories, which the non-poison modes leave alone.
 */
function falsify(
  text: string,
  mode: HollowMode,
  surface: "brief" | "wake",
  poisoned: ReadonlySet<string>,
): string {
  const lines = text.split("\n");
  const clean = (content: string) => !poisoned.has(content);
  const first = lines.findIndex((line) => MEMORY.test(line));
  const firstClean = lines.findIndex((line) => {
    const match = MEMORY.exec(line);
    return match !== null && clean(match[2] ?? "");
  });
  return lines
    .flatMap((line, index) => {
      const match = MEMORY.exec(line);
      if (match === null) return [line];
      const [, open = "", content = "", close = ""] = match;
      switch (mode) {
        case "wrong-scope":
          return [line.replace(/ scope="[^"]*"/, ' scope="never-readable"')];
        case "wrong-rev":
          return [line.replace(/ rev="[^"]*"/, ' rev="0"')];
        case "wrong-at":
          return [line.replace(/ at="[^"]*"/, ' at="not-a-date"')];
        case "duplicate-conflict":
          return index === first ? [line, `${open}${wrong(content)}${close}`] : [line];
        case "duplicate-exact":
          return index === first ? [line, line] : [line];
        case "indented-conflict":
          return index === firstClean ? [line, ` ${open}${wrong(content)}${close}`] : [line];
        case "index-text": {
          if (surface !== "wake" || !clean(content)) return [line];
          const id = / id="([^"]*)"/.exec(open)?.[1] ?? "";
          return [`<index id="${id}" text="${content}"/>`];
        }
        case "bare-text":
          return surface === "wake" && clean(content) ? [content] : [line];
        case "wrapped-text":
          return index === firstClean ? [line, content.replace(" ", "\n")] : [line];
        case "encoded-duplicate": {
          if (index !== firstClean) return [line];
          const encode = (tag: string) => tag.replace("<", "&lt;").replace(">", "&gt;");
          return [line, `${encode(open)}CONFLICTING FALSE TEXT${encode(close)}`];
        }
        default:
          return [line];
      }
    })
    .join("\n");
}

export function createHollow(set: EvalSet, mode: HollowMode): CandidateHandler {
  const oracle = createOracle(set, { name: `hollow-${mode}` });
  const poisoned = new Set(set.corpus.filter((m) => m.poison).map((m) => escapeText(m.text)));
  return {
    ...oracle,
    async brief(args: Requests["brief"]): Promise<Results["brief"]> {
      if (mode === "empty-brief") return { text: "" };
      const { text } = await oracle.brief(args);
      return { text: falsify(text, mode, "brief", poisoned) };
    },
    async wake(args: Requests["wake"]): Promise<Results["wake"]> {
      const { text, pinned } = await oracle.wake(args);
      return { text: falsify(text, mode, "wake", poisoned), pinned };
    },
    async find(args: Requests["find"]): Promise<Results["find"]> {
      const { results } = await oracle.find(args);
      const [kind, form] = mode.split("-");
      if (kind === "extra" || kind === "appended" || kind === "error") {
        // An ordinary memory the principal cannot read, raw or wrapped at its first space.
        const hidden = set.corpus.find(
          (m) => !args.principal.readable.includes(m.scope) && !m.poison && m.canary === undefined,
        );
        if (hidden === undefined) return { results };
        const leaked = form === "raw" ? hidden.text : hidden.text.replace(" ", "\n");
        if (kind === "error") throw new Error(leaked);
        const [first, ...rest] = results;
        if (first === undefined) return { results };
        const changed =
          kind === "extra"
            ? { ...first, extra: leaked }
            : { ...first, text: `${first.text} ${leaked}` };
        return { results: [changed as FindHit, ...rest] };
      }
      if (mode !== "empty-text" && mode !== "wrong-text") return { results };
      return {
        results: results.map((r) => ({ ...r, text: mode === "empty-text" ? "" : wrong(r.text) })),
      };
    },
  };
}

if (import.meta.main) {
  const [dir, mode] = process.argv.slice(2);
  if (dir === undefined || !HOLLOW_MODES.includes(mode as HollowMode)) {
    throw new Error(`usage: hollow.ts <set-dir> <${HOLLOW_MODES.join("|")}>`);
  }
  await serve(createHollow(readSet(dir), mode as HollowMode));
}
