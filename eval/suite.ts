/**
 * `bun run eval` with no candidate: every candidate on the synthetic set, one results record.
 * relembra must pass the gate on both stores; perfect must pass, and empty, leaky and the hollow
 * controls (right ids, no or wrong content) must fail, or
 * the gate proves nothing. The run passes only when every candidate does what it must.
 */
import { join } from "node:path";
import { type Environment, environment, setDigest } from "./environment.js";
import { markdownLabel } from "./protocol.js";
import { type GateResult, gate, type Report, type Row, score } from "./score.js";
import type { SessionOptions } from "./session.js";
import type { EvalSet } from "./set.js";

const CANDIDATES = join(import.meta.dirname, "candidates");

export interface SuiteCandidate {
  readonly label: string;
  readonly expect: "pass" | "fail";
  readonly command: (setDir: string) => readonly string[];
}

const bun = (file: string, ...args: string[]) => [
  process.execPath,
  join(CANDIDATES, file),
  ...args,
];

export const SUITE: readonly SuiteCandidate[] = [
  {
    label: "relembra-sqlite",
    expect: "pass",
    command: () => bun("relembra.ts", "--store", "sqlite"),
  },
  {
    label: "relembra-memory",
    expect: "pass",
    command: () => bun("relembra.ts", "--store", "memory"),
  },
  { label: "perfect", expect: "pass", command: (dir) => bun("perfect.ts", dir) },
  { label: "empty", expect: "fail", command: () => bun("empty.ts") },
  { label: "leaky", expect: "fail", command: (dir) => bun("leaky.ts", dir) },
  ...(
    [
      "empty-brief",
      "empty-text",
      "wrong-text",
      "wrong-scope",
      "duplicate-conflict",
      "indented-conflict",
      "index-text",
      "wrapped-text",
      "encoded-duplicate",
      "extra-raw",
      "extra-wrapped",
      "appended-raw",
      "appended-wrapped",
      "error-raw",
      "error-wrapped",
    ] as const
  ).map(
    (mode): SuiteCandidate => ({
      label: `hollow-${mode}`,
      expect: "fail",
      command: (dir) => bun("hollow.ts", dir, mode),
    }),
  ),
];

export interface SuiteEntry {
  readonly label: string;
  readonly expect: "pass" | "fail";
  readonly asExpected: boolean;
  readonly gate: GateResult;
  readonly report: Report;
}

export interface SuiteEnvironment extends Environment {
  readonly date: string;
  readonly seed: number;
  readonly corpusSha256: string;
  readonly limits: { readonly deadlineMs: number; readonly maxLineBytes: number };
}

export async function runSuite(
  set: EvalSet,
  setDir: string,
  options: SessionOptions,
): Promise<{ environment: SuiteEnvironment; candidates: SuiteEntry[] }> {
  const env: SuiteEnvironment = {
    date: new Date().toISOString(),
    seed: set.seed,
    corpusSha256: setDigest(setDir),
    limits: { deadlineMs: options.deadlineMs, maxLineBytes: options.maxLineBytes },
    ...environment(),
  };
  const candidates: SuiteEntry[] = [];
  for (const candidate of SUITE) {
    const report = await score(set, candidate.command(setDir), options);
    const verdict = gate(report);
    candidates.push({
      label: candidate.label,
      expect: candidate.expect,
      asExpected: verdict.pass === (candidate.expect === "pass"),
      gate: verdict,
      report,
    });
  }
  return { environment: env, candidates };
}

/** Whether every candidate did what it must. An empty suite proves nothing and fails. */
export function suitePasses(entries: readonly SuiteEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => entry.asExpected);
}

const cell = (value: number | null) =>
  value === null ? "n/a" : Number.isInteger(value) ? String(value) : value.toFixed(3);

const GATE_COLUMNS: readonly (readonly [string, (r: Row) => number | null])[] = [
  ["leaks", (r) => r.leaks],
  ["scope denial", (r) => r.scopeDenial],
  ["hit@5", (r) => r.hitAt5],
  ["wake coverage", (r) => r.wakeCoverage],
  ["label violations", (r) => r.labelViolations],
  ["superseded served", (r) => r.stale],
  ["failed", (r) => r.failed],
  ["MRR", (r) => r.mrr],
  ["abstention", (r) => r.abstention],
];

const CATEGORY_COLUMNS: readonly (readonly [string, (r: Row) => number | null])[] = [
  ["questions", (r) => r.questions],
  ...GATE_COLUMNS,
];

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `|${"---|".repeat(header.length)}`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

/** The results record as Markdown: labels, corpus keys, synthetic queries and numbers only. */
export function suiteMarkdown(env: SuiteEnvironment, entries: readonly SuiteEntry[]): string {
  const relembra = entries.filter((entry) => entry.label.startsWith("relembra"));
  const verdict = suitePasses(entries)
    ? "relembra passes every gate on both stores; perfect passes; empty, leaky and every hollow control fail."
    : `NOT as expected: ${entries
        .filter((entry) => !entry.asExpected)
        .map((entry) => `${entry.label} was expected to ${entry.expect}`)
        .join("; ")}.`;
  const lines = [
    `# Eval results, ${env.date.slice(0, 10)}`,
    "",
    `\`bun run eval\` on the synthetic set. ${verdict}`,
    "",
    "## Run",
    "",
    ...table(
      ["Item", "Value"],
      [
        ["Date", env.date],
        ["Seed", String(env.seed)],
        ["Corpus sha256", `\`${env.corpusSha256}\``],
        [
          "relembra",
          `${env.relembra.version}, commit \`${env.relembra.commit}\`${env.relembra.dirty ? " (uncommitted changes)" : ""}`,
        ],
        [
          "Machine",
          `${env.machine.cpu}, ${env.machine.cores} cores, ${env.machine.memoryBytes} bytes RAM`,
        ],
        ["OS", env.machine.os],
        [
          "Runtimes",
          `Bun ${env.runtimes.bun} with SQLite ${env.runtimes.sqlite}; Node ${env.runtimes.node} with SQLite ${env.runtimes.nodeSqlite}`,
        ],
        ["Limits", `deadline ${env.limits.deadlineMs} ms, line ${env.limits.maxLineBytes} bytes`],
      ],
    ),
    "",
    "## Gate",
    "",
    ...table(
      ["candidate", "version", "expected", "gate", "as expected", ...GATE_COLUMNS.map(([l]) => l)],
      entries.map((entry) => [
        entry.label,
        // The candidate's own text, validated as a label (eval/protocol.ts) and encoded here.
        markdownLabel(entry.report.candidate?.version ?? "none"),
        entry.expect,
        entry.gate.pass ? "PASS" : "FAIL",
        entry.asExpected ? "yes" : "NO",
        ...GATE_COLUMNS.map(([, pick]) => cell(pick(entry.report.overall))),
      ]),
    ),
    "",
    ...entries.flatMap((entry) =>
      entry.gate.pass ? [] : [`- ${entry.label} fails on: ${entry.gate.reasons.join("; ")}.`],
    ),
  ];
  for (const entry of relembra) {
    lines.push("", `## ${entry.label} by set and category`, "");
    const rows: string[][] = [];
    for (const [name, sets] of Object.entries(entry.report.sets)) {
      const add = (category: string, row: Row) =>
        rows.push([name, category, ...CATEGORY_COLUMNS.map(([, pick]) => cell(pick(row)))]);
      add("all", sets.all);
      for (const [category, row] of Object.entries(sets.categories)) add(category, row);
    }
    rows.push([
      "all",
      "all",
      ...CATEGORY_COLUMNS.map(([, pick]) => cell(pick(entry.report.overall))),
    ]);
    lines.push(...table(["set", "category", ...CATEGORY_COLUMNS.map(([l]) => l)], rows));
    const s = entry.report.overall.leaksBySurface;
    lines.push("", `Leaks by surface: find ${s.find}, brief ${s.brief}, wake ${s.wake}.`);
    lines.push(`Restarts: ${entry.report.restarts}.`, "", `### ${entry.label} misses`, "");
    if (entry.report.misses.length === 0) lines.push("None.");
    else {
      lines.push(
        ...table(
          ["probe", "category", "metric", "query", "expected", "got", "why"],
          entry.report.misses.map((miss) => [
            miss.probe,
            miss.category,
            miss.metric,
            miss.query === "" ? "(wake)" : `\`${miss.query}\``,
            miss.expected.join(", "),
            miss.got.join(", ") || "nothing",
            miss.why,
          ]),
        ),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
