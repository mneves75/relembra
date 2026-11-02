import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Attempt, RELEASE, strictOptionErrors, strictVerdict } from "../bench/acceptance.js";
import { buildStore, percentiles, storeIntegrity } from "../bench/eval-latency.js";
import { bulkCorpus, DEFAULT_SEED } from "../eval/generate.js";
import { isRuntimeOverride, type Runtime, type Snapshot } from "../scripts/evidence.js";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "relembra-bench-acceptance-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const runtime = (path: string): Runtime => ({
  path,
  version: "1.0.0",
  sqlite: "3.54.0",
  sha256: "e".repeat(64),
});
const IDENTITY: Snapshot = {
  inputs: {
    available: true,
    clean: true,
    commit: "a".repeat(40),
    digest: "b".repeat(64),
    files: { "src/a.ts": `100644 ${"c".repeat(40)}` },
    dirty: [],
    untracked: [],
    errors: [],
  },
  runtimes: { available: true, bun: runtime("/bun"), node: runtime("/node"), errors: [] },
};

const flat = (n: number, ms: number) => Array.from({ length: n }, () => ms);
/** `n` samples whose nearest-rank p95 is exactly `p95`, every one above it `tail`. */
function withP95(n: number, p95: number, tail = p95): number[] {
  const rank = Math.ceil(0.95 * n);
  return [...flat(rank - 1, 1), p95, ...flat(n - rank, tail)];
}
const runtimeSamples = (warm = 500, cold = 30) => ({
  warm: { find: flat(warm, 10), wake: flat(warm, 12), brief: flat(warm, 14) },
  cold: { find: flat(cold, 90), wake: flat(cold, 95), brief: flat(cold, 99) },
});

/** A complete pinned run, inside the budget, with a stable clean identity. */
function passing(): Attempt {
  return {
    parameters: {
      memories: 20_000,
      seed: DEFAULT_SEED,
      warm: { warmup: 50, measured: 500 },
      cold: { warmup: 3, measured: 30 },
    },
    corpus: { textSha256: RELEASE.corpusSha256 },
    store: { identicalRebuild: true, unchangedByReads: true, integrity: "ok" },
    samples: { bun: runtimeSamples(), node: runtimeSamples() },
    identity: { before: IDENTITY, after: IDENTITY },
    errors: [],
  };
}

/** `passing()` with one sample set replaced. */
function withSamples(name: "bun" | "node", mode: "warm" | "cold", op: string, value: unknown) {
  const base = passing();
  const own = runtimeSamples();
  return {
    ...base,
    samples: { ...base.samples, [name]: { ...own, [mode]: { ...own[mode], [op]: value } } },
  };
}

const failuresOf = (attempt: Attempt) => strictVerdict(attempt).failures.join("\n");

describe("strictVerdict", () => {
  test("a complete pinned run inside the budget passes", () => {
    expect(strictVerdict(passing())).toEqual({ passed: true, failures: [] });
  });

  test("the budget is the raw nearest-rank p95 of warm find, on each runtime", () => {
    expect(strictVerdict(withSamples("bun", "warm", "find", withP95(500, 50))).passed).toBe(true);
    expect(strictVerdict(withSamples("node", "warm", "find", withP95(500, 50))).passed).toBe(true);
    // Above p95 nothing counts: a slow tail with p95 on the budget passes.
    const tail = withSamples("bun", "warm", "find", withP95(500, 50, 900));
    expect(strictVerdict(tail).passed).toBe(true);

    // 50.004 displays as 50, and still fails.
    const over = withP95(500, 50.004);
    expect(percentiles(over).p95).toBe(50);
    const bun = strictVerdict(withSamples("bun", "warm", "find", over));
    expect(bun.passed).toBe(false);
    expect(bun.failures).toEqual(["bun warm find p95 is 50.004 ms, over the 50 ms budget"]);
    const node = strictVerdict(withSamples("node", "warm", "find", withP95(500, 80)));
    expect(node.failures).toEqual(["node warm find p95 is 80 ms, over the 50 ms budget"]);
    // Only find is budgeted: a slow wake is reported in the results, not judged.
    expect(strictVerdict(withSamples("bun", "warm", "wake", flat(500, 80))).passed).toBe(true);
  });

  test("another corpus fails: size, seed, digest or none recorded", () => {
    const base = passing();
    for (const [attempt, reason] of [
      [{ ...base, parameters: { ...base.parameters, memories: 19_999 } }, "--memories 19999"],
      [{ ...base, parameters: { ...base.parameters, seed: DEFAULT_SEED + 1 } }, "--seed"],
      [{ ...base, corpus: { textSha256: "0".repeat(64) } }, "corpus sha256"],
      [{ ...base, corpus: null }, "no corpus"],
    ] as const) {
      expect(failuresOf(attempt)).toContain(reason);
    }
  });

  test("fewer samples than the release requires, or than were asked for, fail", () => {
    const base = passing();
    const thin = {
      ...base,
      parameters: {
        ...base.parameters,
        warm: { warmup: 49, measured: 499 },
        cold: { warmup: 3, measured: 29 },
      },
      samples: { bun: runtimeSamples(499, 29), node: runtimeSamples(499, 29) },
    };
    const reasons = failuresOf(thin);
    for (const flag of ["--warmup 49", "--warm 499", "--cold 29"]) expect(reasons).toContain(flag);
    // The counts asked for were met, so the only failures are the release minimums.
    expect(strictVerdict(thin).failures).toHaveLength(3);

    expect(failuresOf(withSamples("bun", "warm", "wake", flat(499, 12)))).toContain(
      "bun warm wake: 499 samples, not 500",
    );
    expect(failuresOf(withSamples("node", "cold", "brief", flat(31, 99)))).toContain(
      "node cold brief: 31 samples, not 30",
    );
    expect(failuresOf(withSamples("node", "cold", "brief", undefined))).toContain(
      "node cold brief: no samples",
    );
    const { node: _, ...bunOnly } = base.samples;
    expect(failuresOf({ ...base, samples: bunOnly })).toContain("node warm find: no samples");
  });

  test("a missing, non-finite or negative sample fails, wherever it is", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.001, null, "5", undefined]) {
      const samples = flat(500, 10) as unknown[];
      samples[123] = bad;
      expect(failuresOf(withSamples("bun", "warm", "brief", samples))).toContain(
        "bun warm brief: sample 123 is",
      );
    }
    const cold = flat(30, 90) as unknown[];
    cold[0] = Number.NaN;
    expect(failuresOf(withSamples("node", "cold", "find", cold))).toContain(
      "node cold find: sample 0 is NaN",
    );
    // Positive control: zero is a finite nonnegative time.
    expect(strictVerdict(withSamples("bun", "cold", "wake", flat(30, 0))).passed).toBe(true);
  });

  test("a store that failed SQLite's integrity check, or was never checked, fails", () => {
    const base = passing();
    const store = { identicalRebuild: true, unchangedByReads: true };
    expect(
      failuresOf({
        ...base,
        store: { ...store, integrity: "*** in database main ***\nPage 5: never used" },
      }),
    ).toContain("store integrity check: *** in database main ***");
    expect(failuresOf({ ...base, store: { ...store, integrity: null } })).toContain(
      "store integrity check: not run",
    );
    // A record without the field at all, as an older or edited one would be.
    expect(failuresOf({ ...base, store } as unknown as Attempt)).toContain(
      "store integrity check: not run",
    );
  });

  test("a store that differed between builds or changed under the reads fails", () => {
    const base = passing();
    const ok = { identicalRebuild: true, unchangedByReads: true, integrity: "ok" };
    expect(failuresOf({ ...base, store: { ...ok, identicalRebuild: false } })).toContain(
      "two builds of the corpus gave different stores",
    );
    expect(failuresOf({ ...base, store: { ...ok, unchangedByReads: false } })).toContain(
      "the reads changed the store",
    );
    expect(failuresOf({ ...base, store: null })).toContain("no store was built");
  });

  test("storeIntegrity runs SQLite's integrity check: ok on a built store, not on a damaged one", async () => {
    const path = join(scratch, "integrity", "relembra.db");
    await buildStore(path, bulkCorpus({ seed: DEFAULT_SEED, memories: 300 }).memories);
    expect(storeIntegrity(path)).toBe("ok");
    // Overwrite the second page, a b-tree page, with a byte no page type uses.
    const bytes = readFileSync(path);
    const pageSize = bytes.readUInt16BE(16);
    bytes.fill(0xee, pageSize, pageSize + 64);
    writeFileSync(path, bytes);
    expect(storeIntegrity(path)).not.toBe("ok");
  }, 30_000);

  for (const [mode, field, label, minimum] of [
    ["warm", "warmup", "--warmup", 50],
    ["warm", "measured", "--warm", 500],
    ["cold", "warmup", "cold warm-up", 3],
    ["cold", "measured", "--cold", 30],
  ] as const) {
    const notInteger = "is not an integer";
    const below = `is below ${minimum}`;
    test.each([
      ["missing", undefined, notInteger],
      ["string", String(minimum), notInteger],
      ["blank string", "", notInteger],
      ["null", null, notInteger],
      ["boolean", true, notInteger],
      ["NaN", Number.NaN, notInteger],
      ["Infinity", Number.POSITIVE_INFINITY, notInteger],
      ["-Infinity", Number.NEGATIVE_INFINITY, notInteger],
      ["fractional", minimum + 0.5, notInteger],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 1, notInteger],
      ["negative", -1, below],
      ["insufficient", minimum - 1, below],
    ] as const)(`sampling metadata ${mode}.${field}: %s fails`, (_name, value, category) => {
      const base = passing();
      const metadata: Record<string, unknown> = { ...base.parameters[mode], [field]: value };
      // An absent field, not only one set to undefined, must fail.
      if (value === undefined) delete metadata[field];
      const parameters = { ...base.parameters, [mode]: metadata };
      const verdict = strictVerdict({ ...base, parameters } as unknown as Attempt);
      expect(verdict.passed).toBe(false);
      // Exactly one failure names this field, and it gives this reason.
      const about = verdict.failures.filter((failure) => failure.startsWith(`${label} `));
      expect(about).toHaveLength(1);
      expect(about[0]).toEndWith(category);
    });
  }

  test("sampling metadata: the release minimums and larger safe integer counts pass", () => {
    const base = passing();
    expect(strictVerdict(base)).toEqual({ passed: true, failures: [] });
    expect(
      strictVerdict({
        ...base,
        parameters: {
          ...base.parameters,
          warm: { warmup: 51, measured: 501 },
          cold: { warmup: 5, measured: 31 },
        },
        samples: { bun: runtimeSamples(501, 31), node: runtimeSamples(501, 31) },
      }),
    ).toEqual({ passed: true, failures: [] });
  });

  test("a recorded error fails, even with every number present", () => {
    const failed = { ...passing(), errors: ["node worker warm exited 1: boom"] };
    expect(strictVerdict(failed).failures).toEqual(["node worker warm exited 1: boom"]);
  });

  test("identity: missing, unavailable, unclean or changed during the run fails", () => {
    const base = passing();
    const inputs = IDENTITY.inputs;
    const node = runtime("/node");
    const cases: [Attempt, string][] = [
      [{ ...base, identity: { before: null, after: IDENTITY } }, "no identity before the run"],
      [{ ...base, identity: { before: IDENTITY, after: null } }, "no identity after the run"],
      [
        {
          ...base,
          identity: {
            before: {
              ...IDENTITY,
              inputs: {
                ...inputs,
                available: false,
                clean: false,
                errors: ["git rev-parse exited 128"],
              },
            },
            after: IDENTITY,
          },
        },
        "before the run: inputs unavailable: git rev-parse exited 128",
      ],
      [
        {
          ...base,
          identity: {
            before: IDENTITY,
            after: { ...IDENTITY, inputs: { ...inputs, clean: false, untracked: ["src/b.ts"] } },
          },
        },
        "after the run: src/b.ts is not in HEAD",
      ],
      [
        {
          ...base,
          identity: {
            before: { ...IDENTITY, inputs: { ...inputs, clean: false, dirty: ["bench/x.ts"] } },
            after: IDENTITY,
          },
        },
        "before the run: bench/x.ts differs from HEAD",
      ],
      [
        {
          ...base,
          identity: {
            before: {
              ...IDENTITY,
              runtimes: {
                available: false,
                bun: runtime("/bun"),
                node: null,
                errors: ["node: spawnSync node ENOENT"],
              },
            },
            after: IDENTITY,
          },
        },
        "before the run: runtime unavailable: node: spawnSync node ENOENT",
      ],
      [
        {
          ...base,
          identity: {
            before: IDENTITY,
            after: {
              ...IDENTITY,
              inputs: {
                ...inputs,
                digest: "d".repeat(64),
                files: { "src/a.ts": `100644 ${"f".repeat(40)}` },
              },
            },
          },
        },
        "changed during the run: src/a.ts changed",
      ],
      [
        {
          ...base,
          identity: {
            before: IDENTITY,
            after: {
              ...IDENTITY,
              runtimes: { ...IDENTITY.runtimes, node: { ...node, sha256: "0".repeat(64) } },
            },
          },
        },
        "changed during the run: node runtime",
      ],
    ];
    for (const [attempt, reason] of cases) {
      const verdict = strictVerdict(attempt);
      expect(verdict.passed).toBe(false);
      expect(verdict.failures.join("\n")).toContain(reason);
    }
  });
});

test("strict options: the release's own defaults pass, anything less is refused by name", () => {
  const release = { memories: 20_000, seed: DEFAULT_SEED, warmup: 50, warm: 500, cold: 30 };
  expect(strictOptionErrors(release)).toEqual([]);
  expect(strictOptionErrors({ ...release, warm: 5000, cold: 300, warmup: 500 })).toEqual([]);
  for (const [change, flag] of [
    [{ memories: 200 }, "--memories 200"],
    [{ memories: 20_001 }, "--memories 20001"],
    [{ seed: 1 }, "--seed 1"],
    [{ warmup: 49 }, "--warmup 49"],
    [{ warm: 499 }, "--warm 499"],
    [{ cold: 29 }, "--cold 29"],
  ] as const) {
    expect(strictOptionErrors({ ...release, ...change })).toEqual([expect.stringContaining(flag)]);
  }
});

test("the pinned corpus digest is the one the pinned seed generates", () => {
  const { memories } = bulkCorpus({ seed: RELEASE.seed, memories: RELEASE.memories });
  const text = memories.map((m) => m.text).join("\n");
  expect(createHash("sha256").update(text).digest("hex")).toBe(RELEASE.corpusSha256);
});

describe.skipIf(NO_RELEASE_TOOLING)("bench/eval-latency.ts --check", () => {
  /** This process's environment without runtime overrides, which would fail every run here. */
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !isRuntimeOverride(name)),
  );
  const bench = (root: string, args: string[], env = cleanEnv) =>
    spawnSync(process.execPath, [join(root, "bench", "eval-latency.ts"), ...args], {
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
  type Record = {
    check: { passed: boolean; failures: string[] } | null;
    identity: { before: Snapshot; after: Snapshot | null };
    errors: string[];
  };
  const attempts = (out: string) =>
    readdirSync(out)
      .filter((name) => name.startsWith("bench-"))
      .sort()
      .map((name) => join(out, name));
  const recordIn = (attempt: string) =>
    JSON.parse(readFileSync(join(attempt, "bench.json"), "utf8")) as Record;

  /** A committed copy of what the benchmark runs, so a control never touches the real checkout. */
  function copy(name: string, commit = true): string {
    const root = join(scratch, name);
    for (const dir of ["src", "eval", "bench", "scripts"]) {
      cpSync(join(ROOT, dir), join(root, dir), {
        recursive: true,
        filter: (path) => !/\/eval\/(out|sealed)(\/|$)/.test(path),
      });
    }
    cpSync(join(ROOT, "package.json"), join(root, "package.json"));
    if (!commit) return root;
    const git = (...args: string[]) => {
      const env = Object.fromEntries(
        Object.entries(cleanEnv).filter(([k]) => !k.startsWith("GIT_")),
      );
      const run = spawnSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: root, encoding: "utf8", env },
      );
      if (run.status !== 0) throw new Error(run.stderr);
    };
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    return root;
  }

  test("an invalid strict option is refused before anything is generated or written", () => {
    for (const args of [
      ["--memories", "200"],
      ["--seed", "1"],
      ["--warmup", "49"],
      ["--warm", "499"],
      ["--cold", "29"],
    ]) {
      const out = join(scratch, "refused-out");
      const work = join(scratch, "refused-work");
      const run = bench(ROOT, ["--check", ...args, "--out", out, "--work", work]);
      expect(run.signal).toBeNull();
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(`--check needs`);
      expect(run.stderr).toContain(args.join(" "));
      expect(existsSync(out)).toBe(false);
      expect(existsSync(work)).toBe(false);
    }
  }, 60_000);

  test("an untracked input fails before the store is built, and each attempt keeps its record", () => {
    const root = copy("untracked");
    writeFileSync(join(root, "src", "extra.ts"), "export {};\n");
    const out = join(scratch, "untracked-out");
    const work = join(scratch, "untracked-work");
    const first = bench(root, ["--check", "--out", out, "--work", work]);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain("src/extra.ts is not in HEAD");
    expect(existsSync(work)).toBe(false);
    const [only] = attempts(out);
    expect(only).toBeDefined();
    const kept = readFileSync(join(only as string, "bench.json"), "utf8");
    const record = JSON.parse(kept) as Record;
    expect(record.check?.passed).toBe(false);
    expect(record.check?.failures).toContain("before the run: src/extra.ts is not in HEAD");
    expect(record.identity.before.inputs.untracked).toEqual(["src/extra.ts"]);
    expect(record.identity.after?.inputs.untracked).toEqual(["src/extra.ts"]);
    expect(readFileSync(join(only as string, "bench.md"), "utf8")).toContain("failed");

    const second = bench(root, ["--check", "--out", out, "--work", work]);
    expect(second.status).toBe(1);
    const both = attempts(out);
    expect(both).toHaveLength(2);
    expect(readFileSync(join(only as string, "bench.json"), "utf8")).toBe(kept);
    for (const attempt of both) expect(recordIn(attempt).check?.passed).toBe(false);
  }, 60_000);

  test("a runtime that cannot be found fails a clean checkout, and only for that", () => {
    const root = copy("no-node");
    const bin = join(scratch, "git-only-bin");
    mkdirSync(bin, { recursive: true });
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const out = join(scratch, "no-node-out");
    const work = join(scratch, "no-node-work");
    const run = bench(root, ["--check", "--out", out, "--work", work], { ...cleanEnv, PATH: bin });
    expect(run.status).toBe(1);
    expect(existsSync(work)).toBe(false);
    const record = recordIn(attempts(out)[0] as string);
    // Positive control for the input identity: the copy is clean, and no input is blamed.
    expect(record.identity.before.inputs).toMatchObject({ available: true, clean: true });
    const failures = record.check?.failures.join("\n") ?? "";
    expect(failures).toContain("before the run: runtime unavailable: node");
    expect(failures).not.toMatch(/not in HEAD|differs from HEAD|inputs unavailable/);
  }, 60_000);

  test("a checkout Git cannot read fails as unavailable, never as a guessed commit", () => {
    const root = copy("no-git", false);
    const out = join(scratch, "no-git-out");
    const run = bench(root, ["--check", "--out", out, "--work", join(scratch, "no-git-work")]);
    expect(run.status).toBe(1);
    const record = recordIn(attempts(out)[0] as string);
    expect(record.identity.before.inputs).toMatchObject({ available: false, commit: null });
    expect(record.check?.failures.join("\n")).toContain("before the run: inputs unavailable");
  }, 60_000);

  test("an exploratory run whose Node worker cannot start exits 1 and keeps what it measured", () => {
    const bin = join(scratch, "git-only-bin-2");
    mkdirSync(bin, { recursive: true });
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const out = join(scratch, "worker-out");
    const work = join(scratch, "worker-work");
    const args = ["--memories", "200", "--warmup", "0", "--warm", "30", "--cold", "30"];
    const run = bench(ROOT, [...args, "--out", out, "--work", work], { ...cleanEnv, PATH: bin });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("node worker");
    const attempt = attempts(out)[0] as string;
    const record = JSON.parse(readFileSync(join(attempt, "bench.json"), "utf8")) as Record & {
      samples: { bun?: { warm: { find: number[] } }; node?: unknown };
    };
    // Exploratory: no release verdict, but the failure and Bun's raw samples are kept.
    expect(record.check).toBeNull();
    expect(record.errors.join("\n")).toContain("node worker");
    expect(record.samples.bun?.warm.find).toHaveLength(30);
    expect(record.samples.node).toBeUndefined();
    // The store is still removed: only the run's record remains.
    expect(readdirSync(work)).toEqual([]);
  }, 120_000);
});
