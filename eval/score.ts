/**
 * Scores a candidate on an eval set through eval/PROTOCOL.md. No model is called anywhere: every
 * metric is computed from ids, text and labels (definitions in eval/README.md).
 */

import { exposes, exposesText, type Findable } from "./exposure.js";
import { WAKE_BUDGET_BYTES } from "./generate.js";
import type { FindHit, Results } from "./protocol.js";
import { escapeText } from "./render.js";
import {
  type CallOutcome,
  type CandidateIdentity,
  Session,
  type SessionOptions,
} from "./session.js";
import {
  CATEGORIES,
  type Category,
  type CorpusMemory,
  type EvalPrincipal,
  type EvalSet,
  type FindProbe,
  type Probe,
  type Trust,
  type WakeProbe,
} from "./set.js";

export const FIND_LIMIT = 10;
export const BRIEF_BUDGET_BYTES = 4000;

export const DEFAULT_OPTIONS: SessionOptions = {
  deadlineMs: 5000,
  maxLineBytes: 1024 * 1024,
  maxRestarts: 3,
  batchSize: 500,
};

export interface Thresholds {
  readonly hitAt5Floor: number;
  readonly wakeCoverageFloor: number;
}

/** Provisional floors on the synthetic set (eval/README.md, "Gate"). */
export const DEFAULT_THRESHOLDS: Thresholds = { hitAt5Floor: 0.9, wakeCoverageFloor: 0.9 };

type Surface = "find" | "brief" | "wake";
/** A call as scored, with the corpus memories its response exposes. */
type Scored<C extends Surface> = CallOutcome<C> & { readonly exposed: ReadonlySet<CorpusMemory> };
type ProbeKey = Pick<Miss, "probe" | "set" | "category" | "metric">;

/** What one probe (or one leak-check wake) contributed. */
interface Outcome {
  readonly set: string;
  readonly category: Category;
  failed: number;
  hit?: boolean;
  rr?: number;
  abstained?: boolean;
  denied?: boolean;
  leaks: Record<Surface, number>;
  stale: number;
  labelViolations: number;
  wakeExpected: number;
  wakeCovered: number;
}

export interface Row {
  readonly questions: number;
  readonly failed: number;
  readonly hitAt5: number | null;
  readonly mrr: number | null;
  readonly abstention: number | null;
  readonly scopeDenial: number | null;
  readonly leaks: number;
  readonly leaksBySurface: Readonly<Record<Surface, number>>;
  readonly stale: number;
  readonly labelViolations: number;
  readonly wakeCoverage: number | null;
}

/**
 * One question or wake probe that missed a metric, by corpus key (stable across runs, unlike
 * candidate ids). `got` is the find results in rank order for hit@5 and abstention, the denied
 * memories exposed for scope denial, and the expected memories rendered for wake coverage.
 */
export interface Miss {
  readonly probe: string;
  readonly set: string;
  readonly category: Category;
  readonly metric: "hit@5" | "abstention" | "scope denial" | "wake coverage";
  /** The probe's query; "" for a wake probe. Synthetic text from the generator. */
  readonly query: string;
  readonly expected: readonly string[];
  readonly got: readonly string[];
  readonly why: string;
}

export interface Report {
  readonly protocol: 1;
  readonly seed: number;
  readonly candidate: CandidateIdentity | null;
  readonly restarts: number;
  readonly overall: Row;
  readonly sets: Readonly<Record<string, { all: Row; categories: Record<string, Row> }>>;
  readonly failures: readonly { readonly probe: string; readonly reason: string }[];
  readonly misses: readonly Miss[];
}

/** hit@5 and reciprocal rank for a 1-based rank, or for no relevant result. */
export function rankMetrics(rank: number | undefined): { hit: boolean; rr: number } {
  if (rank === undefined || rank < 1 || rank > FIND_LIMIT) return { hit: false, rr: 0 };
  return { hit: rank <= 5, rr: 1 / rank };
}

const TRUST_RANK: Record<Trust, number> = { untrusted: 0, agent: 1, owner: 2 };

const mean = (values: readonly (boolean | number)[]): number | null =>
  values.length === 0
    ? null
    : values.reduce<number>((sum, v) => sum + Number(v), 0) / values.length;

export function aggregate(outcomes: readonly Outcome[], questions: number): Row {
  const defined = <T>(pick: (o: Outcome) => T | undefined) =>
    outcomes.map(pick).filter((v): v is T => v !== undefined);
  const sum = (pick: (o: Outcome) => number) => outcomes.reduce((total, o) => total + pick(o), 0);
  const expected = sum((o) => o.wakeExpected);
  const leaksBySurface = {
    find: sum((o) => o.leaks.find),
    brief: sum((o) => o.leaks.brief),
    wake: sum((o) => o.leaks.wake),
  };
  return {
    questions,
    failed: sum((o) => o.failed),
    hitAt5: mean(defined((o) => o.hit)),
    mrr: mean(defined((o) => o.rr)),
    abstention: mean(defined((o) => o.abstained)),
    scopeDenial: mean(defined((o) => o.denied)),
    leaks: leaksBySurface.find + leaksBySurface.brief + leaksBySurface.wake,
    leaksBySurface,
    stale: sum((o) => o.stale),
    labelViolations: sum((o) => o.labelViolations),
    wakeCoverage: expected === 0 ? null : sum((o) => o.wakeCovered) / expected,
  };
}

/** A memory element as a whole line; its escaped body holds no raw `<` or `>`. */
const MEMORY_LINE = /^<memory((?: [^>]*)?)>([^<>]*)<\/memory>$/;
/** An id-only index line. */
const INDEX_LINE = /^<index id="([^"<>]*)"\/>$/;
/** The frame lines a brief or wake may open and close with (eval/PROTOCOL.md, "Rendering"). */
const FRAME_LINES: Readonly<Record<"brief" | "wake", readonly string[]>> = {
  brief: ["<brief>", "</brief>"],
  wake: ["<wake>", "</wake>"],
};
/** One whole attribute: a space, a full name, and a quoted value without quotes or brackets. */
const ATTRIBUTE = / ([A-Za-z][A-Za-z0-9_:.-]*)="([^"<>]*)"/y;
/** The attributes a memory element has (IMPLEMENTATION-PLAN §4.2), each exactly once. */
const MEMORY_ATTRIBUTES = new Set(["id", "scope", "rev", "at", "trust"]);

/**
 * The element's attributes by whole name, or undefined when the list is malformed (anything that
 * is not a sequence of ` name="value"`), names an attribute twice, or names one the format lacks.
 */
function memoryAttributes(list: string): Map<string, string> | undefined {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  while (ATTRIBUTE.lastIndex < list.length) {
    const match = ATTRIBUTE.exec(list);
    if (match === null) return undefined;
    const [, name = "", value = ""] = match;
    if (!MEMORY_ATTRIBUTES.has(name) || attributes.has(name)) return undefined;
    attributes.set(name, value);
  }
  return attributes.size === MEMORY_ATTRIBUTES.size ? attributes : undefined;
}

/** Whether a rendered line is a well-formed, correctly labelled, escaped element for `memory`. */
function labelledLine(line: string, memory: CorpusMemory, id: string): boolean {
  const match = MEMORY_LINE.exec(line);
  if (!match) return false;
  const attributes = memoryAttributes(match[1] ?? "");
  if (attributes === undefined) return false;
  const trust = attributes.get("trust") as Trust | undefined;
  return (
    attributes.get("id") === id &&
    trust !== undefined &&
    Object.hasOwn(TRUST_RANK, trust) &&
    TRUST_RANK[trust] <= TRUST_RANK[memory.trust] &&
    !/[<>]/.test(match[2] ?? "")
  );
}

/**
 * Whether a line renders `memory` in full: a well-formed, correctly labelled element for its id
 * whose content is exactly the memory's text, escaped as documented.
 */
function rendersLine(line: string, memory: CorpusMemory, id: string): boolean {
  return labelledLine(line, memory, id) && MEMORY_LINE.exec(line)?.[2] === escapeText(memory.text);
}

export async function score(
  set: EvalSet,
  command: readonly string[],
  options: SessionOptions = DEFAULT_OPTIONS,
): Promise<Report> {
  const session = new Session(command, set, options);
  const byKey = new Map(set.corpus.map((m) => [m.key, m]));
  const supersededBy = new Map(
    set.corpus.flatMap((m) => (m.supersedes === undefined ? [] : [[m.supersedes, m.key] as const])),
  );
  const outcomes: Outcome[] = [];
  const failures: { probe: string; reason: string }[] = [];
  const misses: Miss[] = [];
  const miss = (probe: Probe, metric: Miss["metric"], fields: Omit<Miss, keyof ProbeKey>) =>
    misses.push({
      probe: probe.key,
      set: probe.set,
      category: probe.category,
      metric,
      ...fields,
    });
  /** The corpus keys of candidate ids, in order; an id the session never noted shows as "?". */
  const keysOf = (ids: readonly string[]) => ids.map((id) => session.keyOf(id) ?? "?");
  const keysIn = (memories: readonly CorpusMemory[]) => memories.map((m) => m.key);
  const wakes = new Map<string, Scored<"wake">>();

  const findable = (m: CorpusMemory): Findable | undefined => {
    const id = session.idOf(m.key);
    if (id === undefined) return undefined;
    return { id, text: m.text, ...(m.canary === undefined ? {} : { canary: m.canary }) };
  };
  const memoryOf = (id: string) => byKey.get(session.keyOf(id) ?? "");
  /** Whether a find result carries exactly its own memory's text, raw or escaped. */
  const ownText = (hit: FindHit) => {
    const m = memoryOf(hit.id);
    return m !== undefined && (hit.text === m.text || hit.text === escapeText(m.text));
  };
  /**
   * The memory a brief or wake line names by id alone: an index line for a noted id, or a
   * well-formed memory element whose body is exactly its own memory's escaped text.
   */
  const carriedBy = (line: string): { memory: CorpusMemory; element: boolean } | undefined => {
    const index = INDEX_LINE.exec(line);
    if (index !== null) {
      const memory = memoryOf(index[1] ?? "");
      return memory === undefined ? undefined : { memory, element: false };
    }
    const match = MEMORY_LINE.exec(line);
    const attributes = match === null ? undefined : memoryAttributes(match[1] ?? "");
    if (match === null || attributes === undefined) return undefined;
    const memory = memoryOf(attributes.get("id") ?? "");
    return memory !== undefined && match[2] === escapeText(memory.text)
      ? { memory, element: true }
      : undefined;
  };
  /**
   * The corpus memories a response exposes. What carries an id is attributed by that id alone: a
   * find result with its own text, a brief or wake line `carriedBy` names, a pinned id. Every
   * other string, and every string of a response with no valid result, is searched for every
   * memory's id, text and canary, so two memories that share a text are never confused.
   */
  const exposure = (surface: Surface, call: CallOutcome<Surface>): Set<CorpusMemory> => {
    const out = new Set<CorpusMemory>();
    const scan = (s: string) => {
      for (const m of set.corpus) {
        const f = findable(m);
        if (f !== undefined && exposes(s, f)) out.add(m);
      }
    };
    // Strings attributed by id, by count, so they are not searched again below.
    const accounted = new Map<string, number>();
    const account = (s: string) => accounted.set(s, (accounted.get(s) ?? 0) + 1);
    const byId = (id: string) => {
      const m = memoryOf(id);
      if (m === undefined) return;
      out.add(m);
      account(id);
    };
    if (call.result !== undefined && surface === "find") {
      for (const hit of (call.result as Results["find"]).results as FindHit[]) {
        byId(hit.id);
        if (ownText(hit)) account(hit.text);
      }
    } else if (call.result !== undefined) {
      const { text } = call.result as Results["brief" | "wake"];
      account(text);
      for (const line of text.split("\n")) {
        const carried = carriedBy(line);
        if (carried === undefined) scan(line);
        else out.add(carried.memory);
      }
      if (surface === "wake") for (const id of (call.result as Results["wake"]).pinned) byId(id);
    }
    for (const s of call.strings) {
      const left = accounted.get(s) ?? 0;
      if (left > 0) accounted.set(s, left - 1);
      else scan(s);
    }
    return out;
  };
  /** The corpus memories, among those `filter` selects, that any of `calls` exposes. */
  const exposedIn = (calls: readonly Scored<Surface>[], filter: (m: CorpusMemory) => boolean) =>
    set.corpus.filter((m) => filter(m) && calls.some((c) => c.exposed.has(m)));
  const forbiddenFor = (principal: EvalPrincipal) => (m: CorpusMemory) =>
    m.state !== "live" || !principal.readable.includes(m.scope);
  const deniedFor = (principal: EvalPrincipal) => (m: CorpusMemory) =>
    !principal.readable.includes(m.scope);

  const blank = (probe: Probe): Outcome => ({
    set: probe.set,
    category: probe.category,
    failed: 0,
    leaks: { find: 0, brief: 0, wake: 0 },
    stale: 0,
    labelViolations: 0,
    wakeExpected: 0,
    wakeCovered: 0,
  });

  /**
   * Leak, staleness and label checks every find, brief and wake response gets, then the content
   * check: a find's texts, a brief's or wake's lines. Returns the call as scored (failed when its
   * content is), with the memories its response exposes.
   */
  /** The call inspected last: a stray belongs to it, since it arrived after that call's answer. */
  let last:
    | { outcome: Outcome; probe: Probe; surface: Surface; principal: EvalPrincipal }
    | undefined;
  /**
   * Fails each stray the session kept and leak-checks it against the principal of the call it
   * followed (`to` when no call came before: output while the corpus first loaded).
   */
  const settleStrays = (to = last) => {
    for (const stray of session.takeStrays()) {
      if (to === undefined) continue;
      // By text alone: a stray may come from a process whose ids were never noted or are stale.
      // A successful loading reply (identity, note ids, stop) is public metadata: any memory's
      // text there is a leak, live or not. Other strays are judged against the principal of the
      // call they followed.
      const forbidden = stray.reason === undefined ? () => true : forbiddenFor(to.principal);
      const exposed = new Set(
        set.corpus.filter((m) =>
          stray.strings.some((s) =>
            exposesText(s, {
              id: "",
              text: m.text,
              ...(m.canary === undefined ? {} : { canary: m.canary }),
            }),
          ),
        ),
      );
      to.outcome.leaks[to.surface] += [...exposed].filter(forbidden).length;
      if (stray.reason === undefined) continue;
      to.outcome.stale += [...exposed].filter((m) => supersededBy.has(m.key)).length;
      to.outcome.failed++;
      failures.push({ probe: to.probe.key, reason: `${to.surface}: ${stray.reason}` });
    }
  };

  const inspect = <C extends Surface>(
    outcome: Outcome,
    probe: Probe,
    surface: C,
    principal: EvalPrincipal,
    call: CallOutcome<C>,
  ): Scored<C> => {
    settleStrays(last ?? { outcome, probe, surface, principal });
    last = { outcome, probe, surface, principal };
    const exposed = exposure(surface, call);
    outcome.leaks[surface] += [...exposed].filter(forbiddenFor(principal)).length;
    outcome.stale += [...exposed].filter((m) => supersededBy.has(m.key)).length;
    outcome.labelViolations += labelViolations(surface, call);
    let scored: CallOutcome<C> = call;
    if (surface === "find") {
      scored = checkTexts(call as CallOutcome<"find">) as CallOutcome<C>;
    } else if (call.result !== undefined) {
      const fault = renderingFault(surface, (call.result as Results["brief" | "wake"]).text);
      if (fault !== undefined) scored = { strings: call.strings, failure: `${surface}: ${fault}` };
    }
    if (scored.failure !== undefined) {
      outcome.failed++;
      failures.push({ probe: probe.key, reason: scored.failure });
    }
    return { ...scored, exposed };
  };

  /**
   * Why a brief or wake text breaks the rendering rules, or undefined. An allowlist: every
   * non-empty line must be one of the protocol's line forms (eval/PROTOCOL.md, "Rendering").
   * - The surface's own frame lines, `<brief>`/`</brief>` or `<wake>`/`</wake>`.
   * - An index line, `<index id="…"/>`, naming an id this session noted.
   * - A memory element for a memory this session noted, at most once per rendering, with that
   *   memory's scope, rev (every loaded memory is at revision 1), at, a trust at or below its
   *   own, and exactly its escaped text.
   * Anything else (indented, wrapped, encoded, decorated) is not a protocol line.
   */
  const renderingFault = (surface: "brief" | "wake", text: string): string | undefined => {
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      if (line === "" || FRAME_LINES[surface].includes(line)) continue;
      const index = INDEX_LINE.exec(line);
      if (index !== null) {
        if (session.keyOf(index[1] ?? "") === undefined) {
          return "index line names an id this session never noted";
        }
        continue;
      }
      if (!line.startsWith("<memory ")) return "line is not a protocol line";
      const match = MEMORY_LINE.exec(line);
      const attributes = match === null ? undefined : memoryAttributes(match[1] ?? "");
      if (match === null || attributes === undefined) return "rendered memory ? is malformed";
      const id = attributes.get("id") ?? "";
      const m = byKey.get(session.keyOf(id) ?? "");
      if (m === undefined) return "rendered memory ? has an id this session never noted";
      const fault = (what: string) => `rendered memory ${m.key} ${what}`;
      if (seen.has(id)) return fault("appears twice");
      seen.add(id);
      if (attributes.get("scope") !== escapeText(m.scope)) return fault("has the wrong scope");
      if (attributes.get("rev") !== "1") return fault("has the wrong rev");
      if (attributes.get("at") !== new Date(m.at).toISOString()) return fault("has the wrong at");
      const trust = attributes.get("trust") ?? "";
      if (!Object.hasOwn(TRUST_RANK, trust) || TRUST_RANK[trust as Trust] > TRUST_RANK[m.trust]) {
        return fault("has a trust above its own");
      }
      if (match[2] !== escapeText(m.text)) return fault("has the wrong text");
    }
    return undefined;
  };

  /** Whether a brief or wake text renders `memory` in full on one of its lines. */
  const renders = (text: string, memory: CorpusMemory): boolean => {
    const id = session.idOf(memory.key);
    return id !== undefined && text.split("\n").some((line) => rendersLine(line, memory, id));
  };

  /**
   * A find whose results do not each carry their memory's text (raw, or escaped as documented)
   * fails: the right id with no or wrong text gives the model nothing true to read.
   */
  const checkTexts = (call: CallOutcome<"find">): CallOutcome<"find"> => {
    for (const hit of (call.result?.results ?? []) as FindHit[]) {
      const m = byKey.get(session.keyOf(hit.id) ?? "");
      if (m === undefined) continue;
      if (TRUST_RANK[hit.trust] > TRUST_RANK[m.trust]) {
        return {
          strings: call.strings,
          failure: `find: result ${m.key} trust ${hit.trust} is above the memory's ${m.trust}`,
        };
      }
      if (hit.text === m.text || hit.text === escapeText(m.text)) continue;
      return {
        strings: call.strings,
        failure: `find: result ${m.key} text is not the memory's text`,
      };
    }
    return call;
  };

  /**
   * Poison memories served with a raised trust, or their text served without their label. A
   * find result with its own text, or a brief or wake line `carriedBy` names, is judged by its
   * id alone; any other text is searched for the poison memory's text.
   */
  const labelViolations = (surface: Surface, call: CallOutcome<Surface>): number => {
    if (call.result === undefined) return 0;
    let violations = 0;
    for (const memory of set.corpus.filter((m) => m.poison)) {
      const f = findable(memory);
      if (f === undefined) continue;
      if (surface === "find") {
        for (const hit of (call.result as Results["find"]).results as FindHit[]) {
          const mine = hit.id === f.id;
          if (mine && TRUST_RANK[hit.trust] > TRUST_RANK[memory.trust]) violations++;
          if (!mine && !ownText(hit) && exposesText(hit.text, f)) violations++;
        }
        continue;
      }
      const { text } = call.result as Results["brief" | "wake"];
      for (const line of text.split("\n")) {
        const carried = carriedBy(line);
        if (carried === undefined) {
          if (exposesText(line, f) && !labelledLine(line, memory, f.id)) violations++;
        } else if (carried.element && carried.memory === memory) {
          if (!labelledLine(line, memory, f.id)) violations++;
        }
      }
      if (surface === "wake" && (call.result as Results["wake"]).pinned.includes(f.id))
        violations++;
    }
    return violations;
  };

  /**
   * The wake for `principal` in `scope` at `budgetBytes`, requested once per run. Its leaks and
   * labels count in the row of the probe that first asked for it.
   */
  const wakeFor = async (
    outcome: Outcome,
    probe: Probe,
    principal: EvalPrincipal,
    scope: string,
    budgetBytes = WAKE_BUDGET_BYTES,
  ) => {
    const cacheKey = JSON.stringify([principal, scope, budgetBytes]);
    const cached = wakes.get(cacheKey);
    if (cached) return cached;
    const call = inspect(
      outcome,
      probe,
      "wake",
      principal,
      await session.call("wake", { principal, scope, budgetBytes }),
    );
    wakes.set(cacheKey, call);
    return call;
  };

  const scoreFind = async (probe: FindProbe): Promise<Outcome> => {
    const outcome = blank(probe);
    const { principal, query } = probe;
    const find = inspect(
      outcome,
      probe,
      "find",
      principal,
      await session.call("find", { principal, query, limit: FIND_LIMIT }),
    );
    const brief = inspect(
      outcome,
      probe,
      "brief",
      principal,
      await session.call("brief", { principal, topic: query, budgetBytes: BRIEF_BUDGET_BYTES }),
    );
    const answered = find.result !== undefined && brief.result !== undefined;
    const ids = find.result?.results.map((r) => r.id) ?? [];

    if (probe.gold !== "absent") {
      const gold = new Set(probe.gold.flatMap((key) => session.idOf(key) ?? []));
      const index = ids.findIndex((id) => gold.has(id));
      // A superseded fact served beside its replacement fails the question.
      const replaced = probe.gold.flatMap((key) => {
        const old = set.corpus.find((m) => supersededBy.get(m.key) === key);
        return old ? [old] : [];
      });
      const stale = replaced.some((m) => find.exposed.has(m) || brief.exposed.has(m));
      // The brief must carry the answer too: an id in find alone gives the model nothing to read.
      const briefed = probe.gold.some((key) => {
        const m = byKey.get(key);
        return m !== undefined && brief.result !== undefined && renders(brief.result.text, m);
      });
      const ranked = answered && !stale && briefed && index >= 0;
      const { hit, rr } = rankMetrics(ranked ? index + 1 : undefined);
      outcome.hit = hit;
      outcome.rr = rr;
      if (!hit) {
        const why = !answered
          ? "request failed"
          : stale
            ? "superseded memory served"
            : index < 0
              ? "gold not in results"
              : !briefed
                ? "brief does not render the answer"
                : `rank ${index + 1}`;
        miss(probe, "hit@5", { query, expected: [...probe.gold], got: keysOf(ids), why });
      }
    }

    if (probe.category === "abstention") {
      const relevant =
        probe.relevant === "any"
          ? () => true
          : (m: CorpusMemory) => (probe.relevant ?? []).includes(m.key);
      const served = exposedIn([find, brief], relevant);
      const fallback = probe.relevant === "any" && ids.length > 0;
      outcome.abstained = answered && !fallback && served.length === 0;
      if (!outcome.abstained) {
        const why = !answered
          ? "request failed"
          : fallback
            ? "results returned where nothing is stored"
            : "a hidden memory was served";
        miss(probe, "abstention", {
          query,
          expected: probe.relevant === "any" ? ["any"] : [...(probe.relevant ?? [])],
          got: fallback ? keysOf(ids) : keysIn(served),
          why,
        });
      }
    }

    if (probe.control) {
      const control = inspect(
        outcome,
        probe,
        "find",
        probe.control.principal,
        await session.call("find", {
          principal: probe.control.principal,
          query,
          limit: FIND_LIMIT,
        }),
      );
      const controlIds = control.result?.results.map((r) => r.id) ?? [];
      const positive =
        control.result !== undefined &&
        probe.control.expect.every((key) => controlIds.includes(session.idOf(key) ?? "\u0000"));
      const surfaces: Scored<Surface>[] = [find, brief];
      for (const scope of principal.readable)
        surfaces.push(await wakeFor(outcome, probe, principal, scope));
      const valid = surfaces.every((s) => s.failure === undefined);
      const leaked = keysIn(exposedIn(surfaces, deniedFor(principal)));
      outcome.denied = positive && valid && leaked.length === 0;
      if (!outcome.denied) {
        const why = !positive
          ? "positive control missed the denied memory"
          : !valid
            ? "a surface failed"
            : "a denied memory was exposed";
        miss(probe, "scope denial", {
          query,
          expected: [...probe.control.expect],
          got: leaked,
          why,
        });
      }
    }
    return outcome;
  };

  const scoreWake = async (probe: WakeProbe): Promise<Outcome> => {
    const outcome = blank(probe);
    const call = await wakeFor(outcome, probe, probe.principal, probe.scope, probe.budgetBytes);
    outcome.wakeExpected = probe.expect.length;
    let covered: string[] = [];
    if (call.result !== undefined) {
      const text = call.result.text;
      // Validated memory elements only: an index line shows the memory exists, not what it says,
      // and text anywhere else is not a labelled rendering.
      covered = probe.expect.filter((key) => {
        const m = byKey.get(key);
        return m !== undefined && renders(text, m);
      });
      outcome.wakeCovered = covered.length;
    }
    if (covered.length < probe.expect.length) {
      miss(probe, "wake coverage", {
        query: "",
        expected: [...probe.expect],
        got: covered,
        why: call.result === undefined ? "request failed" : "not rendered in full",
      });
    }
    return outcome;
  };

  try {
    for (const probe of set.probes) {
      outcomes.push(probe.kind === "find" ? await scoreFind(probe) : await scoreWake(probe));
    }
    // Every principal any probe used, in every scope it can read, gets a wake leak check.
    for (const probe of set.probes) {
      const principals = [probe.principal];
      if (probe.kind === "find" && probe.control) principals.push(probe.control.principal);
      const outcome = blank(probe);
      for (const principal of principals) {
        for (const scope of principal.readable) await wakeFor(outcome, probe, principal, scope);
      }
      outcomes.push(outcome);
    }
  } finally {
    await session.close();
    settleStrays();
  }

  const questions = (filter: (p: Probe) => boolean) =>
    set.probes.filter((p) => p.kind === "find" && filter(p)).length;
  const sets: Record<string, { all: Row; categories: Record<string, Row> }> = {};
  for (const name of [...new Set(set.probes.map((p) => p.set))].sort()) {
    const inSet = outcomes.filter((o) => o.set === name);
    const categories: Record<string, Row> = {};
    for (const category of CATEGORIES) {
      const inCategory = inSet.filter((o) => o.category === category);
      if (inCategory.length > 0) {
        categories[category] = aggregate(
          inCategory,
          questions((p) => p.set === name && p.category === category),
        );
      }
    }
    sets[name] = {
      all: aggregate(
        inSet,
        questions((p) => p.set === name),
      ),
      categories,
    };
  }
  return {
    protocol: 1,
    seed: set.seed,
    candidate: session.identity ?? null,
    restarts: session.restarts,
    overall: aggregate(
      outcomes,
      questions(() => true),
    ),
    sets,
    failures: failures.slice(0, 50),
    misses,
  };
}

export interface GateResult {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

/** The release gate (eval/README.md): every condition must hold. */
export function gate(report: Report, thresholds: Thresholds = DEFAULT_THRESHOLDS): GateResult {
  const o = report.overall;
  const reasons: string[] = [];
  if (o.leaks !== 0) reasons.push(`leaks ${o.leaks}, required 0`);
  if (o.scopeDenial !== 1) reasons.push(`scope denial ${o.scopeDenial}, required 1`);
  if (o.hitAt5 === null || o.hitAt5 < thresholds.hitAt5Floor) {
    reasons.push(`hit@5 ${o.hitAt5}, required >= ${thresholds.hitAt5Floor}`);
  }
  if (o.wakeCoverage === null || o.wakeCoverage < thresholds.wakeCoverageFloor) {
    reasons.push(`wake coverage ${o.wakeCoverage}, required >= ${thresholds.wakeCoverageFloor}`);
  }
  if (o.labelViolations !== 0) reasons.push(`label violations ${o.labelViolations}, required 0`);
  if (o.stale !== 0) reasons.push(`superseded memories served ${o.stale}, required 0`);
  if (o.failed !== 0) reasons.push(`failed requests ${o.failed}, required 0`);
  return { pass: reasons.length === 0, reasons };
}
