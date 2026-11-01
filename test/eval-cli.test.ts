import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SEED, generate } from "../eval/generate.js";
import { markdown, parseCli } from "../eval/main.js";
import type { GateResult, Report, Row } from "../eval/score.js";
import {
  type SuiteEntry,
  type SuiteEnvironment,
  suiteMarkdown,
  suitePasses,
} from "../eval/suite.js";

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "relembra-eval-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const evalCli = (...args: string[]) =>
  spawnSync(process.execPath, [join(ROOT, "eval", "main.ts"), ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });

describe("parseCli", () => {
  test("scores a candidate command after --, on the default seed", () => {
    expect(parseCli(["--", "bun", "c.ts", "{set}"])).toMatchObject({
      kind: "score",
      seed: DEFAULT_SEED,
      set: undefined,
      command: ["bun", "c.ts", "{set}"],
    });
    expect(parseCli(["--set", "d", "--deadline-ms", "300", "--", "x"])).toMatchObject({
      kind: "score",
      set: "d",
      deadlineMs: 300,
    });
    // `bun run eval -- cmd` arrives without its `--`.
    expect(parseCli(["--seed", "3", "bun", "c.ts", "--flag"])).toMatchObject({
      kind: "score",
      seed: 3,
      command: ["bun", "c.ts", "--flag"],
    });
    expect(parseCli(["generate", "--seed", "7", "--out", "o"])).toEqual({
      kind: "generate",
      seed: 7,
      out: "o",
    });
  });

  test("with no candidate, runs the whole suite into docs/eval", () => {
    expect(parseCli([])).toEqual({
      kind: "all",
      seed: DEFAULT_SEED,
      out: join(ROOT, "docs", "eval"),
      deadlineMs: 5000,
      maxLineBytes: 1024 * 1024,
    });
    expect(parseCli(["--out", "o", "--seed", "5"])).toMatchObject({
      kind: "all",
      seed: 5,
      out: "o",
    });
  });

  test("refuses a missing command, unknown flags and bad numbers", () => {
    for (const argv of [
      ["--"],
      ["--set", "d"],
      ["--json", "f"],
      ["--out", "o", "--", "x"],
      ["--bogus", "1", "--", "x"],
      ["--seed", "-1", "--", "x"],
      ["--seed", "1.5", "--", "x"],
      ["--seed", "1", "--set", "d", "--", "x"],
      ["--deadline-ms", "0", "--", "x"],
      ["--seed"],
      ["generate", "--set", "d"],
    ]) {
      expect(parseCli(argv).kind).toBe("usage");
    }
  });
});

describe("bun run eval", () => {
  test("generate writes the set; the same seed twice gives the same bytes", () => {
    const a = join(scratch, "a");
    const b = join(scratch, "b");
    expect(evalCli("generate", "--out", a).status).toBe(0);
    expect(evalCli("generate", "--out", b).status).toBe(0);
    for (const file of ["manifest.json", "corpus.jsonl", "questions.jsonl"]) {
      expect(readFileSync(join(b, file))).toEqual(readFileSync(join(a, file)));
    }
  });

  test("the perfect candidate passes (exit 0); the empty one fails (exit 1)", () => {
    const set = join(scratch, "set");
    expect(evalCli("generate", "--out", set).status).toBe(0);
    const json = join(scratch, "report.json");
    const perfect = evalCli(
      "--set",
      set,
      "--json",
      json,
      "--",
      process.execPath,
      join(ROOT, "eval", "candidates", "perfect.ts"),
      "{set}",
    );
    expect(perfect.stdout).toContain("gate: PASS");
    expect(perfect.status).toBe(0);
    const written = JSON.parse(readFileSync(json, "utf8")) as { gate: { pass: boolean } };
    expect(written.gate.pass).toBe(true);
    const empty = evalCli(
      "--set",
      set,
      "--",
      process.execPath,
      join(ROOT, "eval", "candidates", "empty.ts"),
    );
    expect(empty.stdout).toContain("gate: FAIL");
    expect(empty.stdout).toContain("hit@5");
    expect(empty.status).toBe(1);
  });

  test("the suite runs every candidate, writes its results and exits 0 only as expected", () => {
    const out = join(scratch, "results");
    const suite = evalCli("--out", out);
    expect(suite.status).toBe(0);
    // The file is dated by the eval process; bun test runs in UTC, so its own today() can differ.
    const files = readdirSync(out).sort();
    const date = /^results-(\d{4}-\d{2}-\d{2})\.json$/.exec(files[0] ?? "")?.[1];
    expect(files).toEqual([`results-${date}.json`, `results-${date}.md`]);
    const base = join(out, `results-${date}`);
    const md = readFileSync(`${base}.md`, "utf8");
    const json = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
      environment: { seed: number; corpusSha256: string; relembra: { commit: string } };
      candidates: { label: string; expect: string; asExpected: boolean; gate: { pass: boolean } }[];
    };
    expect(json.environment.seed).toBe(DEFAULT_SEED);
    expect(json.environment.corpusSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(json.environment.relembra.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(json.candidates.map((c) => [c.label, c.expect, c.gate.pass, c.asExpected])).toEqual([
      ["relembra-sqlite", "pass", true, true],
      ["relembra-memory", "pass", true, true],
      ["perfect", "pass", true, true],
      ["empty", "fail", false, true],
      ["leaky", "fail", false, true],
      ["hollow-empty-brief", "fail", false, true],
      ["hollow-empty-text", "fail", false, true],
      ["hollow-wrong-text", "fail", false, true],
      ["hollow-wrong-scope", "fail", false, true],
      ["hollow-duplicate-conflict", "fail", false, true],
      ["hollow-indented-conflict", "fail", false, true],
      ["hollow-index-text", "fail", false, true],
      ["hollow-wrapped-text", "fail", false, true],
      ["hollow-encoded-duplicate", "fail", false, true],
      ["hollow-extra-raw", "fail", false, true],
      ["hollow-extra-wrapped", "fail", false, true],
      ["hollow-appended-raw", "fail", false, true],
      ["hollow-appended-wrapped", "fail", false, true],
      ["hollow-error-raw", "fail", false, true],
      ["hollow-error-wrapped", "fail", false, true],
    ]);
    expect(md).toContain(json.environment.corpusSha256);
    expect(md).toMatch(/\| relembra-sqlite \| [^|]+ \| pass \| PASS \| yes \|/);
    expect(md).toMatch(/\| empty \| [^|]+ \| fail \| FAIL \| yes \|/);
    // Labels, keys and numbers only: no memory text reaches the results.
    for (const memory of generate({ seed: DEFAULT_SEED }).corpus) {
      expect(md).not.toContain(memory.text);
      expect(JSON.stringify(json)).not.toContain(JSON.stringify(memory.text).slice(1, -1));
    }
  }, 120_000);

  test("the suite fails when relembra fails or a control does not behave", () => {
    const entry = (label: string, expect: "pass" | "fail", pass: boolean) =>
      ({ label, expect, asExpected: (expect === "pass") === pass }) as SuiteEntry;
    const good = [entry("relembra-sqlite", "pass", true), entry("empty", "fail", false)];
    expect(suitePasses(good)).toBe(true);
    expect(suitePasses([entry("relembra-sqlite", "pass", false), good[1] as SuiteEntry])).toBe(
      false,
    );
    expect(suitePasses([good[0] as SuiteEntry, entry("empty", "fail", true)])).toBe(false);
    expect(suitePasses([])).toBe(false);
  });

  test("a usage error exits 2", () => {
    expect(evalCli("--bogus").status).toBe(2);
  });
});

describe("a candidate's identity in the reports", () => {
  const HOSTILE = "evil\u001b[2J\ngate: PASS\n| x | y |";
  const row: Row = {
    questions: 1,
    failed: 1,
    hitAt5: 0,
    mrr: 0,
    abstention: null,
    scopeDenial: null,
    leaks: 0,
    leaksBySurface: { find: 0, brief: 0, wake: 0 },
    stale: 0,
    labelViolations: 0,
    wakeCoverage: null,
  };
  const report = (name: string, version: string): Report => ({
    protocol: 1,
    seed: DEFAULT_SEED,
    candidate: { name, version },
    restarts: 0,
    overall: row,
    sets: { en: { all: row, categories: {} } },
    failures: [],
    misses: [],
  });
  const verdict: GateResult = { pass: false, reasons: ["hit@5 0, required >= 0.9"] };
  const env: SuiteEnvironment = {
    date: "2026-10-31T00:00:00.000Z",
    seed: DEFAULT_SEED,
    corpusSha256: "0".repeat(64),
    limits: { deadlineMs: 5000, maxLineBytes: 1024 },
    relembra: { version: "0.1.0", commit: "0".repeat(40), dirty: false },
    machine: { cpu: "cpu", cores: 1, memoryBytes: 1, os: "os" },
    runtimes: { bun: "1", node: "1", sqlite: "1", nodeSqlite: "1" },
  };
  const suiteOf = (version: string) =>
    suiteMarkdown(env, [
      { label: "x", expect: "fail", asExpected: true, gate: verdict, report: report("x", version) },
    ]);
  const gateRow = (md: string) => md.split("\n").find((line) => line.startsWith("| x |")) ?? "";
  const cells = (line: string) => line.split(/(?<!\\)\|/).length;

  test("the score report encodes a hostile name and version: one line, no escape, no forged verdict", () => {
    const md = markdown(report(HOSTILE, HOSTILE), verdict);
    expect(md).not.toContain("\u001b");
    expect(md.split("\n").filter((line) => line.startsWith("gate: "))).toEqual(["gate: FAIL"]);
    expect(md.split("\n")[0]).toStartWith("candidate: evil");
    expect(md.split("\n")[0]).toContain("\\| x \\| y \\|");
    // Positive control: an ordinary identity is written unchanged.
    expect(markdown(report("relembra", "0.1.0+sqlite"), verdict).split("\n")[0]).toBe(
      `candidate: relembra 0.1.0+sqlite; seed: ${DEFAULT_SEED}; restarts: 0`,
    );
  });

  test("the suite record encodes a hostile version: the table keeps its columns", () => {
    const hostile = suiteOf(HOSTILE);
    const plain = suiteOf("0.1.0+sqlite");
    expect(hostile).not.toContain("\u001b");
    expect(hostile).not.toContain("\ngate: PASS");
    expect(cells(gateRow(hostile))).toBe(cells(gateRow(plain)));
    // Positive control: an ordinary version is written unchanged.
    expect(gateRow(plain)).toStartWith("| x | 0.1.0+sqlite | fail | FAIL | yes |");
  });

  test("a candidate whose reset carries a hostile identity fails, and the output names no candidate", () => {
    const set = join(scratch, "set-identity");
    expect(evalCli("generate", "--out", set).status).toBe(0);
    const run = evalCli(
      "--set",
      set,
      "--",
      process.execPath,
      join(ROOT, "test", "eval-faulty-candidate.ts"),
      "hostile-identity",
      "{set}",
    );
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("\u001b");
    expect(run.stdout.split("\n").filter((line) => line.startsWith("gate: "))).toEqual([
      "gate: FAIL",
    ]);
    expect(run.stdout.split("\n")[0]).toStartWith("candidate: none;");
    // Positive control: the same candidate with an ordinary identity is named in the report.
    const plain = evalCli(
      "--set",
      set,
      "--",
      process.execPath,
      join(ROOT, "test", "eval-faulty-candidate.ts"),
      "rank",
      "{set}",
      "1",
    );
    expect(plain.stdout.split("\n")[0]).toStartWith("candidate: faulty-rank 1;");
  });
});
