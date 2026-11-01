import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLeaks } from "../eval/candidates/leaky.js";
import { DEFAULT_SEED, generate } from "../eval/generate.js";
import { DEFAULT_OPTIONS, gate, type Report, rankMetrics, score } from "../eval/score.js";
import { Session } from "../eval/session.js";
import {
  type CorpusMemory,
  type EvalSet,
  type FindProbe,
  type WakeProbe,
  writeSet,
} from "../eval/set.js";

const ROOT = join(import.meta.dir, "..");
const FAULTY = join(import.meta.dir, "eval-faulty-candidate.ts");
const dir = mkdtempSync(join(tmpdir(), "relembra-eval-score-"));
const set = generate({ seed: DEFAULT_SEED });
writeSet(dir, set);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const candidate = (name: string, ...args: string[]) => [
  process.execPath,
  join(ROOT, "eval", "candidates", `${name}.ts`),
  ...args,
];
const faulty = (mode: string, ...args: string[]) => [process.execPath, FAULTY, mode, dir, ...args];
const run = (command: string[], options = {}) =>
  score(set, command, { ...DEFAULT_OPTIONS, ...options });

const findQuestions = set.probes.filter((p) => p.kind === "find");
const retrieval = findQuestions.filter((p) => p.gold !== "absent");

describe("the controls", () => {
  test("the perfect candidate passes with every metric at its best", async () => {
    const report = await run(candidate("perfect", dir));
    expect(gate(report)).toEqual({ pass: true, reasons: [] });
    expect(report.candidate).toEqual({ name: "perfect", version: "1" });
    expect(report.overall).toMatchObject({
      questions: findQuestions.length,
      failed: 0,
      hitAt5: 1,
      mrr: 1,
      abstention: 1,
      scopeDenial: 1,
      leaks: 0,
      stale: 0,
      labelViolations: 0,
      wakeCoverage: 1,
    });
    expect(report.restarts).toBe(0);
    expect(report.misses).toEqual([]);
    for (const name of ["en", "pt"]) {
      const categories = report.sets[name]?.categories ?? {};
      expect(Object.keys(categories).sort()).toEqual(
        ["abstention", "basic", "contradiction", "poisoning", "pt-en-fold", "scope"].sort(),
      );
      const { basic, scope } = categories;
      expect(basic?.wakeCoverage).toBe(1);
      expect(scope?.scopeDenial).toBe(1);
    }
  }, 30_000);

  test("the empty candidate fails: positive retrieval and wake coverage are required", async () => {
    const report = await run(candidate("empty"));
    const result = gate(report);
    expect(result.pass).toBe(false);
    expect(report.overall).toMatchObject({ hitAt5: 0, mrr: 0, wakeCoverage: 0, leaks: 0 });
    // Nothing returned abstains correctly and leaks nothing, so those alone cannot pass a gate.
    expect(report.overall.abstention).toBe(1);
    // The positive control (the same query from a reader of the scope) fails, so denial does too.
    expect(report.overall.scopeDenial).toBe(0);
    expect(result.reasons.join("\n")).toMatch(/hit@5/);
    expect(result.reasons.join("\n")).toMatch(/wake coverage/);
    // Every miss is listed by corpus key, with what was expected, what came back and why.
    const hits = report.misses.filter((m) => m.metric === "hit@5");
    expect(hits.map((m) => m.probe).sort()).toEqual(retrieval.map((p) => p.key).sort());
    for (const miss of hits) {
      const probe = retrieval.find((p) => p.key === miss.probe);
      expect(miss).toMatchObject({ got: [], why: "gold not in results" });
      expect(miss.expected).toEqual(probe?.gold === "absent" ? [] : [...(probe?.gold ?? [])]);
      expect(miss.query).toBe(probe?.kind === "find" ? probe.query : "");
    }
    const denials = report.misses.filter((m) => m.metric === "scope denial");
    expect(denials).toHaveLength(findQuestions.filter((p) => p.category === "scope").length);
    for (const miss of denials) expect(miss.why).toBe("positive control missed the denied memory");
    const wakes = report.misses.filter((m) => m.metric === "wake coverage");
    expect(wakes.length).toBe(set.probes.filter((p) => p.kind === "wake").length);
    for (const miss of wakes) {
      expect(miss.expected.length).toBeGreaterThan(0);
      expect(miss.got).toEqual([]);
    }
    expect(report.misses.some((m) => m.metric === "abstention")).toBe(false);
  }, 30_000);

  test("the leaky candidate fails on leaks", async () => {
    const report = await run(candidate("leaky", dir));
    const result = gate(report);
    expect(result.pass).toBe(false);
    expect(report.overall.leaks).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.startsWith("leaks"))).toBe(true);
  }, 30_000);

  for (const spec of ["find:id", "find:text", "brief:id", "brief:text", "wake:id", "wake:text"]) {
    test(`a leak through ${spec} alone is caught on that surface`, async () => {
      const [leak] = parseLeaks([spec]);
      const report = await run(candidate("leaky", dir, spec));
      // Retrieval stays perfect, except that text planted in a find result is also not that
      // memory's text, so those find responses fail as well.
      if (spec === "find:text") expect(report.overall.failed).toBeGreaterThan(0);
      else expect(report.overall.hitAt5).toBe(1);
      for (const surface of ["find", "brief", "wake"] as const) {
        const leaks = report.overall.leaksBySurface[surface];
        if (surface === leak?.surface) expect(leaks).toBeGreaterThan(0);
        else expect(leaks).toBe(0);
      }
      expect(gate(report).pass).toBe(false);
    }, 30_000);
  }

  test("an empty brief fails: a positive question needs its answer rendered in the brief", async () => {
    const report = await run(candidate("hollow", dir, "empty-brief"));
    expect(gate(report).pass).toBe(false);
    expect(report.overall.hitAt5).toBe(0);
    expect(report.overall.failed).toBe(0);
    const misses = report.misses.filter((m) => m.metric === "hit@5");
    expect(misses).toHaveLength(retrieval.length);
    for (const miss of misses) expect(miss.why).toBe("brief does not render the answer");
  }, 30_000);

  for (const mode of ["empty-text", "wrong-text"]) {
    test(`find results with the right ids but ${mode} fail their requests`, async () => {
      const report = await run(candidate("hollow", dir, mode));
      const result = gate(report);
      expect(result.pass).toBe(false);
      expect(report.overall.hitAt5).toBe(0);
      expect(report.overall.failed).toBeGreaterThan(0);
      expect(result.reasons.some((r) => r.startsWith("failed requests"))).toBe(true);
      expect(report.failures[0]?.reason).toMatch(
        /^find: result \S+ text is not the memory's text$/,
      );
    }, 30_000);
  }

  const renderingFaults: Record<string, RegExp> = {
    "wrong-scope": /wrong scope$/,
    "wrong-rev": /wrong rev$/,
    "wrong-at": /wrong at$/,
    "duplicate-conflict": /appears twice$/,
    "duplicate-exact": /appears twice$/,
  };
  for (const [mode, why] of Object.entries(renderingFaults)) {
    test(`every rendered memory is checked: ${mode} fails its brief and wake requests`, async () => {
      const report = await run(candidate("hollow", dir, mode));
      const result = gate(report);
      expect(result.pass).toBe(false);
      expect(result.reasons.some((r) => r.startsWith("failed requests"))).toBe(true);
      // Every positive question and every wake probe loses its credit.
      expect(report.overall.hitAt5).toBe(0);
      expect(report.overall.wakeCoverage).toBe(0);
      const reasons = report.failures.map((f) => f.reason);
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(reason).toMatch(/^(brief|wake): rendered memory \S+ /);
        expect(reason).toMatch(why);
      }
    }, 30_000);
  }

  // Every mode below leaves the poison memories alone, so no label check fires: only the line
  // allowlist can fail them. Briefs that render only poison memories are left as they were, so
  // the poisoning questions (4 of 28) keep their credit where briefs are touched.
  const poisoningQuestions = retrieval.filter((p) => p.category === "poisoning");
  const notProtocolLines: Record<string, { surfaces: string; hitAt5: number }> = {
    "indented-conflict": { surfaces: "brief|wake", hitAt5: poisoningQuestions.length / 28 },
    "wrapped-text": { surfaces: "brief|wake", hitAt5: poisoningQuestions.length / 28 },
    "encoded-duplicate": { surfaces: "brief|wake", hitAt5: poisoningQuestions.length / 28 },
    "index-text": { surfaces: "wake", hitAt5: 1 },
    "bare-text": { surfaces: "wake", hitAt5: 1 },
  };
  for (const [mode, { surfaces, hitAt5 }] of Object.entries(notProtocolLines)) {
    test(`a line that is not a protocol line fails the request: ${mode}`, async () => {
      expect(retrieval).toHaveLength(28);
      expect(poisoningQuestions).toHaveLength(4);
      const report = await run(candidate("hollow", dir, mode));
      const result = gate(report);
      expect(result.pass).toBe(false);
      expect(report.overall.labelViolations).toBe(0);
      expect(report.overall.leaks).toBe(0);
      expect(report.overall.hitAt5).toBe(hitAt5);
      expect(report.overall.wakeCoverage).toBe(0);
      const reasons = report.failures.map((f) => f.reason);
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(reason).toMatch(new RegExp(`^(${surfaces}): line is not a protocol line$`));
      }
    }, 30_000);
  }

  // A forbidden memory's text in a find response, raw or wrapped at its first space: in a field
  // the protocol does not define, appended to a result's own text, or as an error message. Each
  // fails the request, and the failed response is still inspected: whitespace hides nothing, so
  // the wrapped form counts exactly the leaks the raw form does.
  const leakingFields: Record<string, RegExp> = {
    extra: /^find: unexpected field in a result entry$/,
    appended: /^find: result \S+ text is not the memory's text$/,
    error: /^find: error internal$/,
  };
  for (const [kind, why] of Object.entries(leakingFields)) {
    test(`forbidden text in ${kind}: raw and wrapped fail and count the same leaks`, async () => {
      const raw = await run(candidate("hollow", dir, `${kind}-raw`));
      const wrapped = await run(candidate("hollow", dir, `${kind}-wrapped`));
      for (const report of [raw, wrapped]) {
        const result = gate(report);
        expect(result.pass).toBe(false);
        expect(result.reasons.some((r) => r.startsWith("failed requests"))).toBe(true);
        expect(report.overall.hitAt5).toBe(0);
        expect(report.failures.length).toBeGreaterThan(0);
        for (const failure of report.failures) expect(failure.reason).toMatch(why);
      }
      expect(raw.overall.leaksBySurface.find).toBeGreaterThan(0);
      expect(wrapped.overall.leaksBySurface.find).toBe(raw.overall.leaksBySurface.find);
    }, 60_000);
  }
});

describe("ranking metrics", () => {
  test("hit@5 counts ranks 1 to 5 only; reciprocal rank is 1/rank", () => {
    expect(rankMetrics(1)).toEqual({ hit: true, rr: 1 });
    expect(rankMetrics(2)).toEqual({ hit: true, rr: 0.5 });
    expect(rankMetrics(5)).toEqual({ hit: true, rr: 0.2 });
    expect(rankMetrics(6)).toEqual({ hit: false, rr: 1 / 6 });
    expect(rankMetrics(10)).toEqual({ hit: false, rr: 0.1 });
    expect(rankMetrics(11)).toEqual({ hit: false, rr: 0 });
    expect(rankMetrics(undefined)).toEqual({ hit: false, rr: 0 });
  });

  test("end to end, gold at rank 2, 5, 6 and 10 scores exactly; MRR is not constant", async () => {
    const expected: Record<string, { hitAt5: number; mrr: number }> = {
      "2": { hitAt5: 1, mrr: 0.5 },
      "5": { hitAt5: 1, mrr: 0.2 },
      "6": { hitAt5: 0, mrr: 1 / 6 },
      "10": { hitAt5: 0, mrr: 0.1 },
    };
    for (const [rank, metrics] of Object.entries(expected)) {
      const report = await run(faulty("rank", rank));
      expect({ rank, hitAt5: report.overall.hitAt5, mrr: report.overall.mrr }).toEqual({
        rank,
        hitAt5: metrics.hitAt5,
        mrr: expect.closeTo(metrics.mrr, 12),
      });
      expect(report.overall.failed).toBe(0);
      const misses = report.misses.filter((m) => m.metric === "hit@5");
      if (metrics.hitAt5 === 1) expect(misses).toEqual([]);
      else {
        expect(misses).toHaveLength(retrieval.length);
        for (const miss of misses) {
          expect(miss.why).toBe(`rank ${rank}`);
          expect(miss.got).toHaveLength(Number(rank));
          expect(miss.got.at(-1)).toBe(miss.expected[0] as string);
        }
      }
    }
  }, 60_000);
});

describe("leak coverage", () => {
  test("an id-only rendering is caught (a valid index line in wake and in brief)", async () => {
    for (const spec of ["wake:id", "brief:id"]) {
      const report = await run(candidate("leaky", dir, spec));
      expect(report.overall.leaks).toBeGreaterThan(0);
    }
  }, 30_000);

  test("the wake of a principal no wake probe names is leak-checked", async () => {
    // The gamma auditor appears only as a scope question's control.
    const report = await run(faulty("leak-wake", "auditor-gamma:gamma"));
    expect(report.overall.leaksBySurface.wake).toBeGreaterThan(0);
  }, 30_000);

  test("every readable scope of every tested principal is leak-checked", async () => {
    // The alpha-beta reader has no wake probe; its beta wake is its second readable scope.
    const report = await run(faulty("leak-wake", "reader-alpha-beta:beta"));
    expect(report.overall.leaksBySurface.wake).toBeGreaterThan(0);
  }, 30_000);

  test("an id hidden behind a character reference is caught as a wake leak", async () => {
    // The perfect candidate, which the controls show leaks nothing, with one encoded index line.
    const report = await run(faulty("leak-wake-encoded"));
    expect(report.overall.leaksBySurface.wake).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  // JSON.parse keeps a duplicated field's last value; the first carries forbidden text.
  for (const mode of ["dup-text-find", "dup-ok-find"]) {
    for (const form of ["raw", "wrapped"]) {
      test(`a field written twice fails the request and its hidden value is leak-checked: ${mode} ${form}`, async () => {
        const report = await run(faulty(mode, form));
        expect(report.overall.failed).toBeGreaterThan(0);
        expect(report.overall.leaksBySurface.find).toBeGreaterThan(0);
        expect(report.restarts).toBe(0);
        for (const failure of report.failures) expect(failure.reason).toBe("find: duplicate field");
        expect(gate(report).pass).toBe(false);
      }, 30_000);
    }
  }

  test("an unexpected envelope field fails the request and is still leak-checked", async () => {
    const report = await run(faulty("envelope-extra-find"));
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(report.overall.leaksBySurface.find).toBeGreaterThan(0);
    expect(report.restarts).toBe(0);
    for (const failure of report.failures) {
      expect(failure.reason).toBe("find: unexpected field in the envelope");
    }
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("a leak in the 11th find result is still inspected, and the response fails", async () => {
    const report = await run(faulty("extra-find"));
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(report.overall.leaksBySurface.find).toBeGreaterThan(0);
  }, 30_000);

  test("a wake that only lists ids covers nothing and fails the gate", async () => {
    const report = await run(faulty("ids-only-wake"));
    expect(report.overall.wakeCoverage).toBe(0);
    expect(report.overall.hitAt5).toBe(1);
    expect(gate(report).reasons.some((r) => r.startsWith("wake coverage"))).toBe(true);
  }, 30_000);

  test("an over-budget wake fails, loses its coverage and is still leak-checked", async () => {
    const report = await run(faulty("overbudget-wake"));
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(report.overall.wakeCoverage).toBe(0);
    expect(report.overall.leaksBySurface.wake).toBeGreaterThan(0);
  }, 30_000);
});

describe("malformed responses fail their question, never the run", () => {
  for (const mode of ["dup-find", "unknown-find", "type-find"]) {
    test(`${mode}`, async () => {
      const report = await run(faulty(mode));
      expect(report.overall.failed).toBeGreaterThan(0);
      expect(report.overall.hitAt5 ?? 1).toBeLessThan(1);
      expect(report.restarts).toBe(0);
      expect(gate(report).pass).toBe(false);
    }, 30_000);
  }

  test("a find result labelled above its memory's trust fails its request", async () => {
    // Every memory below owner in this corpus is poisoned, so the label check counts them too;
    // the request check holds for any memory, poisoned or not.
    const report = await run(faulty("raised-trust-find"));
    expect(report.overall.labelViolations).toBeGreaterThan(0);
    expect(report.failures.some((f) => / trust owner is above the memory's /.test(f.reason))).toBe(
      true,
    );
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  for (const mode of ["nonjson-find", "wrongid-find"]) {
    test(`${mode} breaks the stream: restarts are capped and the run completes`, async () => {
      const report = await run(faulty(mode));
      expect(report.overall.failed).toBeGreaterThan(0);
      expect(report.overall.hitAt5).toBe(0);
      expect(report.restarts).toBe(DEFAULT_OPTIONS.maxRestarts);
    }, 30_000);
  }

  test("colliding note ids fail every question", async () => {
    const report = await run(faulty("dup-note"));
    expect(report.candidate).toEqual({ name: "faulty-dup-note", version: "1" });
    expect(report.overall).toMatchObject({ hitAt5: 0, wakeCoverage: 0, leaks: 0 });
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("a hung candidate is killed at its deadline and scored as failed", async () => {
    const began = performance.now();
    const report = await run(faulty("hang-find"), { deadlineMs: 300 });
    expect(performance.now() - began).toBeLessThan(20_000);
    expect(report.overall.hitAt5).toBe(0);
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(report.restarts).toBe(DEFAULT_OPTIONS.maxRestarts);
    expect(report.failures[0]?.reason).toBe("find: timeout");
  }, 30_000);

  test("after one hang the restarted candidate is reloaded and scored on fresh ids", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "relembra-eval-hang-")), "marker");
    try {
      // The default deadline: one hang costs it once, and every other request, the restarted
      // candidate's reset and reload included, keeps its full margin on a loaded machine.
      const report = await run(faulty("hang-once", marker));
      expect(report.restarts).toBe(1);
      expect(report.overall.failed).toBe(1);
      expect(report.overall.hitAt5).toBeCloseTo((retrieval.length - 1) / retrieval.length, 12);
      expect(report.overall.leaks).toBe(0);
    } finally {
      rmSync(join(marker, ".."), { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a line after a valid answer is a failure and is leak-checked", () => {
  const marked = async (mode: string) => {
    const marker = join(mkdtempSync(join(tmpdir(), "relembra-eval-stray-")), "marker");
    try {
      return await run(faulty(mode, marker));
    } finally {
      rmSync(join(marker, ".."), { recursive: true, force: true });
    }
  };

  test("after a find: the restart does not swallow it", async () => {
    const report = await marked("stray-once-find");
    expect(report.restarts).toBe(1);
    expect(report.overall.leaksBySurface.find).toBeGreaterThan(0);
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(report.failures.some((f) => f.reason === "find: unsolicited")).toBe(true);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("after a note while the corpus loads", async () => {
    const report = await marked("stray-once-note");
    expect(report.restarts).toBe(1);
    expect(report.overall.leaks).toBeGreaterThan(0);
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("after every wake: each one counts, restarts capped", async () => {
    const report = await run(faulty("stray-wake"));
    expect(report.overall.leaksBySurface.wake).toBeGreaterThan(0);
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 60_000);

  test("after stop, unterminated, then exit: the scorer still fails and leak-checks it", async () => {
    const report = await run(faulty("stray-stop-tail"));
    expect(report.overall.leaks).toBeGreaterThan(0);
    expect(report.overall.failed).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("several stray lines at once: each later line is leak-checked too", async () => {
    const report = await marked("stray-many");
    expect(report.overall.leaksBySurface.find).toBeGreaterThanOrEqual(2);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("a leak on every load attempt counts though no load ever completes", async () => {
    const report = await run(faulty("stray-reset-always"));
    expect(report.restarts).toBe(DEFAULT_OPTIONS.maxRestarts);
    expect(report.overall.leaks).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 60_000);

  test("a hidden text written after the candidate was killed is leak-checked", async () => {
    const report = await marked("late-writer");
    expect(report.overall.leaksBySurface.find).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("a timed-out stop holding escaped hidden text is decoded and leak-checked", async () => {
    const report = await run(faulty("escaped-stop-timeout"), { deadlineMs: 2000 });
    expect(report.overall.leaks).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  for (const mode of ["leaky-name", "leaky-version"]) {
    test(`${mode}: a valid identity carrying hidden text is a leak`, async () => {
      const report = await run(faulty(mode));
      expect(report.overall.failed).toBe(0);
      expect(report.overall.leaks).toBeGreaterThan(0);
      expect(gate(report).pass).toBe(false);
    }, 30_000);
  }

  test("a valid identity carrying a live memory's text is a leak too", async () => {
    const report = await run(faulty("leaky-live-name"));
    expect(report.overall.failed).toBe(0);
    expect(report.overall.leaks).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("a note id carrying a hidden memory's canary is a leak", async () => {
    const report = await run(faulty("leaky-note-id"));
    expect(report.overall.failed).toBe(0);
    expect(report.overall.leaks).toBeGreaterThan(0);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  for (const mode of ["stop-empty", "stop-silent"]) {
    test(`${mode}: a broken stop with nothing to inspect still fails the run`, async () => {
      const report = await run(faulty(mode), { deadlineMs: 2000 });
      expect(report.overall.failed).toBeGreaterThan(0);
      expect(gate(report).pass).toBe(false);
    }, 30_000);
  }

  test("output past the line limit fails and says the rest is not leak-checked", async () => {
    const report = await run(faulty("padded-stop"));
    expect(report.failures.some((f) => f.reason.includes("past the line limit"))).toBe(true);
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("after the last request: closing the session keeps it", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "relembra-eval-stray-")), "marker");
    const session = new Session(faulty("stray-once-find", marker), set, DEFAULT_OPTIONS);
    try {
      const probe = findQuestions[0] as FindProbe;
      const find = await session.call("find", {
        principal: probe.principal,
        query: probe.query,
        limit: 10,
      });
      expect(find.failure).toBeUndefined();
      await session.close();
      const redacted = set.corpus.find((m) => m.state === "redacted") as CorpusMemory;
      // Successful loading replies are kept too (leak-checked only, no reason); skip them.
      const strays = session.takeStrays().filter((s) => s.reason !== undefined);
      // Seen before closing, it was unsolicited; arriving during close, it is stop's broken answer.
      expect(strays).toHaveLength(1);
      expect(strays[0]?.strings).toContain(redacted.text);
      expect(session.takeStrays()).toEqual([]);
    } finally {
      rmSync(join(marker, ".."), { recursive: true, force: true });
    }
  }, 30_000);
});

describe("memories that share a text are told apart by id", () => {
  // The generator refuses such a corpus; the scorer must still not blame a correct candidate.
  const byKey = (key: string) => set.corpus.find((m) => m.key === key) as CorpusMemory;
  const scoreVariant = async (variant: EvalSet) => {
    const variantDir = mkdtempSync(join(tmpdir(), "relembra-eval-collide-"));
    try {
      writeSet(variantDir, variant);
      return await score(variant, candidate("perfect", variantDir), DEFAULT_OPTIONS);
    } finally {
      rmSync(variantDir, { recursive: true, force: true });
    }
  };

  test("rendering a readable memory does not leak an unreadable one with the same text", async () => {
    const [first] = retrieval as [FindProbe];
    const readable = byKey((first.gold as readonly string[])[0] as string);
    const twin: CorpusMemory = {
      ...readable,
      key: "x-unreadable-twin",
      scope: "collision-unreadable",
      pinned: false,
      state: "live",
    };
    const report = await scoreVariant({ ...set, corpus: [...set.corpus, twin] });
    expect(report.overall.leaks).toBe(0);
    expect(gate(report)).toEqual({ pass: true, reasons: [] });
  }, 30_000);

  test("an ordinary memory with a poison memory's text is no label violation", async () => {
    const poison = set.corpus.find((m) => m.poison) as CorpusMemory;
    const wake = set.probes.find(
      (p): p is WakeProbe => p.kind === "wake" && p.scope !== poison.scope,
    ) as WakeProbe;
    const ordinary = byKey(wake.expect.find((key) => !byKey(key).poison) as string);
    const corpus = set.corpus.map((m) =>
      m.key === ordinary.key ? { ...m, text: poison.text } : m,
    );
    const report = await scoreVariant({ ...set, corpus });
    expect(report.overall.labelViolations).toBe(0);
    expect(report.overall.leaks).toBe(0);
    expect(gate(report)).toEqual({ pass: true, reasons: [] });
  }, 30_000);
});

describe("categories", () => {
  const category = (report: Report, name: string) =>
    ["en", "pt"].map((s) => report.sets[s]?.categories[name]);

  test("poisoning: honest labels pass; pinning, owner labels, unescaped and unlabelled text fail", async () => {
    const perfect = await run(candidate("perfect", dir));
    expect(perfect.overall.labelViolations).toBe(0);
    for (const row of category(perfect, "poisoning")) expect(row?.hitAt5).toBe(1);
    for (const mode of ["pin-poison", "owner-label", "unescaped", "unlabelled"]) {
      const report = await run(faulty(mode));
      expect({ mode, violations: report.overall.labelViolations > 0 }).toEqual({
        mode,
        violations: true,
      });
      expect(gate(report).pass).toBe(false);
    }
  }, 60_000);

  // The control is the perfect candidate above: its correct elements give 0 violations.
  for (const mode of ["data-trust-label", "duplicate-trust", "malformed-attribute"]) {
    test(`raised trust hidden in attributes fails: ${mode}`, async () => {
      const report = await run(faulty(mode));
      expect(report.overall.labelViolations).toBeGreaterThan(0);
      expect(gate(report).pass).toBe(false);
    }, 30_000);
  }

  test("contradiction: serving the superseded fact fails the question", async () => {
    const report = await run(faulty("stale"));
    expect(report.overall.stale).toBeGreaterThan(0);
    for (const row of category(report, "contradiction")) expect(row?.hitAt5).toBe(0);
    for (const row of category(report, "basic")) expect(row?.hitAt5).toBe(1);
    const misses = report.misses.filter((m) => m.metric === "hit@5");
    expect(misses.map((m) => m.category)).toEqual([
      "contradiction",
      "contradiction",
      "contradiction",
      "contradiction",
    ]);
    for (const miss of misses) expect(miss.why).toBe("superseded memory served");
    expect(gate(report).pass).toBe(false);
  }, 30_000);

  test("abstention: a fallback that returns something when nothing matches fails", async () => {
    const report = await run(faulty("fallback"));
    expect(report.overall.abstention ?? 1).toBeLessThan(1);
    expect(report.overall.hitAt5).toBe(1);
    const misses = report.misses.filter((m) => m.metric === "abstention");
    expect(misses.length).toBeGreaterThan(0);
    for (const miss of misses) {
      expect(miss.expected).toEqual(["any"]);
      expect(miss.why).toBe("results returned where nothing is stored");
      expect(miss.got.length).toBeGreaterThan(0);
    }
  }, 30_000);
});

test("no model call anywhere in the harness: no network module or fetch in eval/", () => {
  const files = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
    );
  for (const file of files(join(ROOT, "eval")).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(file, "utf8");
    expect({
      file,
      network: /\bfetch\(|node:(https?|net|tls|dgram)|WebSocket/.test(source),
    }).toEqual({
      file,
      network: false,
    });
  }
});
