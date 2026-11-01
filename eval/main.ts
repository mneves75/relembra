/**
 * bun run eval [--seed N] [--out DIR] [--deadline-ms N] [--max-line-bytes N]
 * bun run eval [--seed N | --set DIR] [--json FILE] [--deadline-ms N] [--max-line-bytes N] [--] CANDIDATE...
 * bun run eval generate [--seed N] [--out DIR]
 *
 * With no candidate, runs every candidate (eval/suite.ts) and writes `results-<date>.md` and
 * `.json` into `--out` (default docs/eval). With one, scores that command on the synthetic set and
 * applies the gate (eval/README.md). In the candidate command, `{set}` is replaced by the set
 * directory (the synthetic oracles read it).
 * Exit codes: 0 gate passed (suite: every candidate as expected), 1 failed, 2 usage error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, today } from "./environment.js";
import { DEFAULT_SEED, generate } from "./generate.js";
import { markdownLabel } from "./protocol.js";
import { DEFAULT_OPTIONS, type GateResult, gate, type Report, type Row, score } from "./score.js";
import { readSet, writeSet } from "./set.js";
import { runSuite, suiteMarkdown, suitePasses } from "./suite.js";

const OUT = join(import.meta.dirname, "out");

export type Cli =
  | { readonly kind: "generate"; readonly seed: number; readonly out: string }
  | {
      readonly kind: "all";
      readonly seed: number;
      readonly out: string;
      readonly deadlineMs: number;
      readonly maxLineBytes: number;
    }
  | {
      readonly kind: "score";
      readonly seed: number;
      readonly set: string | undefined;
      readonly json: string | undefined;
      readonly deadlineMs: number;
      readonly maxLineBytes: number;
      readonly command: readonly string[];
    }
  | { readonly kind: "usage"; readonly message: string };

const USAGE =
  "usage: bun run eval [--seed N] [--out DIR] [--deadline-ms N] [--max-line-bytes N]\n" +
  "       bun run eval [--seed N | --set DIR] [--json FILE] [--deadline-ms N] [--max-line-bytes N] [--] CANDIDATE...\n" +
  "       bun run eval generate [--seed N] [--out DIR]";

const FLAGS = ["--seed", "--set", "--json", "--out", "--deadline-ms", "--max-line-bytes"];

export function parseCli(argv: readonly string[]): Cli {
  const generating = argv[0] === "generate";
  const values = new Map<string, string>();
  // Flags first; the candidate command starts after `--` or at the first argument that is not a
  // flag (`bun run` drops a leading `--`).
  let i = generating ? 1 : 0;
  let separated = false;
  for (; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    if (flag === "--") {
      i++;
      separated = true;
      break;
    }
    if (!flag.startsWith("--")) break;
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || value === undefined) {
      return { kind: "usage", message: `unknown or incomplete flag ${flag}\n${USAGE}` };
    }
    values.set(flag, value);
  }
  const command = argv.slice(i);
  const kind = generating ? "generate" : command.length === 0 && !separated ? "all" : "score";
  const allowed: Record<typeof kind, readonly string[]> = {
    generate: ["--seed", "--out"],
    all: ["--seed", "--out", "--deadline-ms", "--max-line-bytes"],
    score: ["--seed", "--set", "--json", "--deadline-ms", "--max-line-bytes"],
  };
  const stray = [...values.keys()].find((flag) => !allowed[kind].includes(flag));
  if (stray !== undefined) {
    return { kind: "usage", message: `${stray} does not apply here\n${USAGE}` };
  }
  const integer = (flag: string, fallback: number): number | undefined => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  const seed = integer("--seed", DEFAULT_SEED);
  if (seed === undefined)
    return { kind: "usage", message: `--seed must be a positive integer\n${USAGE}` };
  if (generating) {
    if (command.length > 0) return { kind: "usage", message: USAGE };
    return { kind: "generate", seed, out: values.get("--out") ?? join(OUT, `seed-${seed}`) };
  }
  const deadlineMs = integer("--deadline-ms", DEFAULT_OPTIONS.deadlineMs);
  const maxLineBytes = integer("--max-line-bytes", DEFAULT_OPTIONS.maxLineBytes);
  if (deadlineMs === undefined || maxLineBytes === undefined) {
    return { kind: "usage", message: `limits must be positive integers\n${USAGE}` };
  }
  if (kind === "all") {
    const out = values.get("--out") ?? join(ROOT, "docs", "eval");
    return { kind: "all", seed, out, deadlineMs, maxLineBytes };
  }
  if (values.has("--seed") && values.has("--set")) {
    return { kind: "usage", message: `--seed and --set are exclusive\n${USAGE}` };
  }
  if (command.length === 0)
    return { kind: "usage", message: `a candidate command is required\n${USAGE}` };
  return {
    kind: "score",
    seed,
    set: values.get("--set"),
    json: values.get("--json"),
    deadlineMs,
    maxLineBytes,
    command,
  };
}

const COLUMNS: readonly (readonly [string, (r: Row) => number | null])[] = [
  ["questions", (r) => r.questions],
  ["failed", (r) => r.failed],
  ["hit@5", (r) => r.hitAt5],
  ["MRR", (r) => r.mrr],
  ["abstention", (r) => r.abstention],
  ["scope denial", (r) => r.scopeDenial],
  ["leaks", (r) => r.leaks],
  ["superseded served", (r) => r.stale],
  ["label violations", (r) => r.labelViolations],
  ["wake coverage", (r) => r.wakeCoverage],
];

const cell = (value: number | null) =>
  value === null ? "n/a" : Number.isInteger(value) ? String(value) : value.toFixed(3);

/** The report as Markdown: only set and category labels and numbers, never memory text. */
export function markdown(report: Report, verdict: GateResult): string {
  // The identity is the candidate's text: validated as a label (eval/protocol.ts), and encoded here.
  const candidate = report.candidate
    ? `${markdownLabel(report.candidate.name)} ${markdownLabel(report.candidate.version)}`
    : "none";
  const lines = [
    `candidate: ${candidate}; seed: ${report.seed}; restarts: ${report.restarts}`,
    "",
    `| set | category | ${COLUMNS.map(([label]) => label).join(" | ")} |`,
    `|${"---|".repeat(COLUMNS.length + 2)}`,
  ];
  const add = (set: string, category: string, row: Row) =>
    lines.push(
      `| ${set} | ${category} | ${COLUMNS.map(([, pick]) => cell(pick(row))).join(" | ")} |`,
    );
  for (const [name, rows] of Object.entries(report.sets)) {
    add(name, "all", rows.all);
    for (const [category, row] of Object.entries(rows.categories)) add(name, category, row);
  }
  add("all", "all", report.overall);
  const s = report.overall.leaksBySurface;
  lines.push("", `leaks by surface: find ${s.find}, brief ${s.brief}, wake ${s.wake}`);
  lines.push(
    "",
    verdict.pass ? "gate: PASS" : `gate: FAIL\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const cli = parseCli(argv);
  if (cli.kind === "usage") {
    process.stderr.write(`${cli.message}\n`);
    return 2;
  }
  if (cli.kind === "generate") {
    writeSet(cli.out, generate({ seed: cli.seed }));
    process.stdout.write(`${cli.out}\n`);
    return 0;
  }
  if (cli.kind === "all") {
    const setDir = join(OUT, `seed-${cli.seed}`);
    writeSet(setDir, generate({ seed: cli.seed }));
    const { environment, candidates } = await runSuite(readSet(setDir), setDir, {
      ...DEFAULT_OPTIONS,
      deadlineMs: cli.deadlineMs,
      maxLineBytes: cli.maxLineBytes,
    });
    const markdown = suiteMarkdown(environment, candidates);
    const base = join(cli.out, `results-${today()}`);
    mkdirSync(cli.out, { recursive: true });
    writeFileSync(`${base}.md`, markdown);
    writeFileSync(`${base}.json`, `${JSON.stringify({ environment, candidates }, null, 2)}\n`);
    process.stdout.write(`${markdown}\nwritten: ${base}.md, ${base}.json\n`);
    return suitePasses(candidates) ? 0 : 1;
  }
  let dir = cli.set;
  if (dir === undefined) {
    dir = join(OUT, `seed-${cli.seed}`);
    writeSet(dir, generate({ seed: cli.seed }));
  }
  const setDir = dir;
  const command = cli.command.map((part) => part.replaceAll("{set}", setDir));
  const report = await score(readSet(setDir), command, {
    ...DEFAULT_OPTIONS,
    deadlineMs: cli.deadlineMs,
    maxLineBytes: cli.maxLineBytes,
  });
  const verdict = gate(report);
  if (cli.json !== undefined) {
    writeFileSync(cli.json, `${JSON.stringify({ report, gate: verdict }, null, 2)}\n`);
  }
  process.stdout.write(markdown(report, verdict));
  return verdict.pass ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
