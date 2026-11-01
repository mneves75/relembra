/**
 * The synthetic candidates' shared core: an oracle that reads the question set's gold labels and
 * answers exactly what a correct memory would. `perfect` serves it as is; `leaky` adds one
 * planted leak on chosen surfaces, leaving retrieval untouched.
 */
import type { FindHit, NoteItem, Requests, Results } from "../protocol.js";
import { type Rendered, renderMemory } from "../render.js";
import type { EvalPrincipal, EvalSet } from "../set.js";
import type { CandidateHandler } from "./serve.js";

export type LeakSurface = "find" | "brief" | "wake";
export type LeakForm = "id" | "text";
export interface Leak {
  readonly surface: LeakSurface;
  readonly form: LeakForm;
}

interface Stored extends Rendered {
  readonly key: string | undefined;
  readonly pinned: boolean;
  readonly state: NoteItem["state"];
  superseded: boolean;
}

/** Recent memories a wake shows after the pinned ones. */
const WAKE_RECENT = 20;

export function createOracle(
  set: EvalSet,
  options: { readonly name?: string; readonly leaks?: readonly Leak[] } = {},
): CandidateHandler {
  const leaks = options.leaks ?? [];
  const keyOf = new Map(set.corpus.map((m) => [`${m.scope}\u0000${m.text}`, m.key]));
  /** Per query: the corpus keys that answer it for some principal. */
  const answers = new Map<string, string[]>();
  for (const probe of set.probes) {
    if (probe.kind !== "find") continue;
    const keys = answers.get(probe.query) ?? [];
    if (probe.gold !== "absent") keys.push(...probe.gold);
    keys.push(...(probe.control?.expect ?? []));
    answers.set(probe.query, keys);
  }

  let memories: Stored[] = [];
  let counter = 0;

  const visible = (m: Stored, principal: EvalPrincipal) =>
    m.state === "live" && !m.superseded && principal.readable.includes(m.scope);
  const forbidden = (principal: EvalPrincipal) =>
    memories.find((m) => m.state !== "live" || !principal.readable.includes(m.scope));
  const leaking = (surface: LeakSurface, form: LeakForm) =>
    leaks.some((leak) => leak.surface === surface && leak.form === form);
  const hit = (m: Stored): FindHit => ({ id: m.id, text: m.text, trust: m.trust });

  const ranked = (principal: EvalPrincipal, query: string, limit: number): Stored[] => {
    const keys = answers.get(query) ?? [];
    return keys
      .map((key) => memories.find((m) => m.key === key))
      .filter((m): m is Stored => m !== undefined && visible(m, principal))
      .slice(0, limit);
  };

  /** Lines in order, each kept only if it still fits the budget; never cut mid-line. */
  const fit = (lines: readonly string[], budget: number): string => {
    let text = "";
    for (const line of lines) {
      const next = text === "" ? line : `${text}\n${line}`;
      if (Buffer.byteLength(next) <= budget) text = next;
    }
    return text;
  };

  return {
    reset() {
      memories = [];
      return { protocol: 1, name: options.name ?? "perfect", version: "1" };
    },

    note({ memories: items }: Requests["note"]): Results["note"] {
      const ids = items.map((item) => {
        const id = `mem-${String(++counter).padStart(6, "0")}`;
        if (item.supersedes !== undefined) {
          const old = memories.find((m) => m.id === item.supersedes);
          if (old) old.superseded = true;
        }
        memories.push({
          id,
          key: keyOf.get(`${item.scope}\u0000${item.text}`),
          scope: item.scope,
          rev: 1,
          at: item.at,
          trust: item.trust,
          text: item.text,
          pinned: item.pinned,
          state: item.state,
          superseded: false,
        });
        return id;
      });
      return { ids };
    },

    find({ principal, query, limit }: Requests["find"]): Results["find"] {
      const results = ranked(principal, query, limit).map(hit);
      const planted = forbidden(principal);
      if (planted && leaking("find", "id")) results.push(hit(planted));
      const first = results[0];
      if (planted && first && leaking("find", "text")) {
        results[0] = { ...first, text: `${first.text} ${planted.text}` };
      }
      return { results: results.slice(0, limit) };
    },

    brief({ principal, topic, budgetBytes }: Requests["brief"]): Results["brief"] {
      const lines = ranked(principal, topic, 10).map(renderMemory);
      const planted = forbidden(principal);
      if (planted && leaking("brief", "text")) lines.push(renderMemory(planted));
      if (planted && leaking("brief", "id")) lines.push(`<index id="${planted.id}"/>`);
      return { text: fit(lines, budgetBytes) };
    },

    wake({ principal, scope, budgetBytes }: Requests["wake"]): Results["wake"] {
      const inScope = memories.filter((m) => m.scope === scope && visible(m, principal));
      // Untrusted memories are never pinned and come after trusted ones (plan §4.1).
      const pinned = inScope.filter((m) => m.pinned && m.trust !== "untrusted");
      const recent = inScope
        .filter((m) => !pinned.includes(m))
        .sort(
          (a, b) =>
            Number(a.trust === "untrusted") - Number(b.trust === "untrusted") || b.at - a.at,
        )
        .slice(0, WAKE_RECENT);
      const lines = [...pinned, ...recent].map(renderMemory);
      const planted = forbidden(principal);
      if (planted && leaking("wake", "text")) lines.push(renderMemory(planted));
      if (planted && leaking("wake", "id")) lines.push(`<index id="${planted.id}"/>`);
      const text = fit(lines, budgetBytes);
      return { text, pinned: pinned.filter((m) => text.includes(`id="${m.id}"`)).map((m) => m.id) };
    },
  };
}
