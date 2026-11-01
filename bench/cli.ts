/**
 * The CLI latency benchmark (ticket 07): a deterministic store of `--size` memories, then the
 * compiled binary timed as an agent runs it, one process per call.
 *
 *   bun bench/cli.ts [--binary bin/relembra] [--size 20000] [--seed 20261031] [--runs 50]
 *
 * Measured, each after 5 unmeasured warm-up runs (the OS page cache is warm; nothing is purged,
 * so "cold" means a new process, not a cold disk):
 * - `relembra --help`: process start alone, no store.
 * - `relembra wake` and `relembra hook`: process start, store open, wake over the whole scope,
 *   the scope given by RELEMBRA_SCOPE.
 * - `wakeGit` and `hookGit`: the same, run from a git repository with no RELEMBRA_SCOPE, so the
 *   CLI derives the scope by asking git (two git processes per call), as a session hook does.
 * - `relembra find <query>`: process start, store open, ranked find, cycling over fixed queries.
 * - In-process library find, for contrast: 50 warm-up and 500 measured queries on one open store.
 * Prints a JSON record on stdout. The store lives in a temp directory removed at the end.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRng } from "../eval/prng.js";
import { createRelembra, type Principal } from "../src/index.js";
import { openSqliteStore } from "../src/sqlite/index.js";

/** The origin of the bench's repository; the dataset lives in the scope git derives from it. */
const ORIGIN = "https://example.invalid/bench/cli.git";
const SCOPE = `uid-${process.getuid?.()}/cli-${createHash("sha256")
  .update("origin:example.invalid/bench/cli")
  .digest("hex")
  .slice(0, 16)}`;
const { PATH } = process.env;

interface Options {
  readonly binary: string;
  readonly size: number;
  readonly seed: number;
  readonly runs: number;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : (argv[index + 1] ?? fallback);
  };
  const int = (name: string, fallback: number) => {
    const parsed = Number(value(name, String(fallback)));
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
    return parsed;
  };
  return {
    binary: resolve(value("--binary", join(import.meta.dir, "..", "bin", "relembra"))),
    size: int("--size", 20_000),
    seed: int("--seed", 20261031),
    runs: int("--runs", 50),
  };
}

// Invented words (consonant-vowel syllables), so the corpus holds no real data.
const ONSETS = ["b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z"];
const VOWELS = ["a", "e", "i", "o", "u"];
const COMMON = ["the", "service", "runs", "on", "port", "with", "and", "uses", "for", "deploy"];

function vocabulary(seed: number, size: number): string[] {
  const rng = createRng(seed);
  const words = new Set<string>();
  while (words.size < size) {
    let word = "";
    for (let i = 0, n = 2 + rng.int(3); i < n; i++) word += rng.pick(ONSETS) + rng.pick(VOWELS);
    words.add(word);
  }
  return [...words];
}

/** Memory i's text: 8 to 30 words, a Zipf-like mix of common and invented ones, ≤ 280 bytes. */
function corpus(seed: number, size: number, words: readonly string[]): string[] {
  const rng = createRng(seed + 1);
  const texts: string[] = [];
  for (let i = 0; i < size; i++) {
    const parts: string[] = [];
    for (let w = 0, n = 8 + rng.int(23); w < n; w++) {
      // Squaring skews choices toward the start of the vocabulary: some words are frequent.
      const skewed = Math.floor((rng.int(1_000_000) / 1_000_000) ** 2 * words.length);
      parts.push(rng.int(4) === 0 ? rng.pick(COMMON) : (words[skewed] as string));
    }
    let text = `${parts.join(" ")}.`;
    while (Buffer.byteLength(text) > 280) text = `${text.slice(0, text.lastIndexOf(" "))}.`;
    texts.push(text);
  }
  return texts;
}

async function generate(path: string, texts: readonly string[]): Promise<void> {
  const principal: Principal = {
    id: "bench",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    pinnable: [SCOPE],
    owned: [SCOPE],
  };
  const store = openSqliteStore({ path });
  let n = 0;
  const base = Date.UTC(2026, 0, 1);
  let tick = 0;
  const relembra = createRelembra<null>({
    store,
    policy: () => principal,
    // Deterministic ids and clock, so the same seed gives the same logical store.
    ids: { memoryId: () => `m-${String(++n).padStart(6, "0")}`, opId: () => `op-${n}` },
    clock: { now: () => base + tick * 60_000 },
  });
  const provenance = { agent: "bench", harness: "bench", model: "none", host: "bench" };
  for (const [i, text] of texts.entries()) {
    tick = i;
    await relembra.note(null, { scope: SCOPE, text, provenance, pinned: i % 1000 === 0 });
  }
  await store.close();
}

interface Stats {
  readonly runs: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

/** Nearest-rank percentiles, in milliseconds rounded to 0.01. */
function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
  const round = (ms: number) => Math.round(ms * 100) / 100;
  return {
    runs: sorted.length,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    min: round(sorted[0] as number),
    max: round(sorted[sorted.length - 1] as number),
    mean: round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length),
  };
}

function timeCommand(
  binary: string,
  argsFor: (run: number) => string[],
  env: Record<string, string>,
  runs: number,
  check: (stdout: string) => void,
  cwd?: string,
): Stats {
  const samples: number[] = [];
  for (let run = -5; run < runs; run++) {
    const started = performance.now();
    const result = spawnSync(binary, argsFor(run + 5), { env, encoding: "utf8", cwd });
    const elapsed = performance.now() - started;
    if (result.status !== 0) {
      throw new Error(`${argsFor(run + 5).join(" ")} exited ${result.status}: ${result.stderr}`);
    }
    check(result.stdout);
    if (run >= 0) samples.push(elapsed);
  }
  return stats(samples);
}

function sh(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  // Other work on the machine skews tails; the record carries the 1-minute load around the runs.
  const loadBefore = loadavg()[0];
  const dir = mkdtempSync(join(tmpdir(), "relembra-bench-"));
  try {
    const path = join(dir, "relembra.db");
    const words = vocabulary(options.seed, 4000);
    const texts = corpus(options.seed, options.size, words);
    const generationStarted = performance.now();
    await generate(path, texts);
    const generationMs = Math.round(performance.now() - generationStarted);
    const datasetHash = createHash("sha256").update(texts.join("\n")).digest("hex");

    // Two-term queries: one frequent and one mid-frequency word, then a frequent word alone.
    const queries = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? `${words[i]} ${words[200 + i * 37]}` : (words[i] as string),
    );
    const env = {
      PATH: PATH ?? "/usr/bin:/bin",
      RELEMBRA_HOME: dir,
      RELEMBRA_SCOPE: SCOPE,
    };
    const { binary, runs } = options;
    const any = () => {};
    // A repository whose origin gives SCOPE; HOME in the temp dir, so no user git config applies.
    const repo = join(dir, "repo");
    for (const args of [
      ["init", "-q", repo],
      ["-C", repo, "remote", "add", "origin", ORIGIN],
    ]) {
      if (spawnSync("git", args).status !== 0) throw new Error(`git ${args.join(" ")} failed`);
    }
    const gitEnv = { PATH: env.PATH, HOME: dir, RELEMBRA_HOME: dir };
    const envWake = spawnSync(binary, ["wake"], { env, encoding: "utf8" }).stdout;
    const sameWake = (out: string) => {
      if (out !== envWake || !out.startsWith("<wake>")) {
        throw new Error("the git-derived scope's wake differs from RELEMBRA_SCOPE's");
      }
    };
    const results = {
      help: timeCommand(binary, () => ["--help"], env, runs, any),
      wake: timeCommand(
        binary,
        () => ["wake"],
        env,
        runs,
        (out) => {
          if (!out.startsWith("<wake>")) throw new Error("wake printed no wake");
        },
      ),
      hook: timeCommand(
        binary,
        () => ["hook"],
        env,
        runs,
        (out) => {
          if (!out.includes('"SessionStart"')) throw new Error("hook printed no hook output");
        },
      ),
      wakeGit: timeCommand(binary, () => ["wake"], gitEnv, runs, sameWake, repo),
      hookGit: timeCommand(
        binary,
        () => ["hook"],
        gitEnv,
        runs,
        (out) => {
          const context = JSON.parse(out).hookSpecificOutput.additionalContext;
          sameWake(`${context}\n`);
        },
        repo,
      ),
      find: timeCommand(
        binary,
        (run) => ["find", ...(queries[run % queries.length] as string).split(" ")],
        env,
        runs,
        (out) => {
          if (!out.startsWith("<memory")) throw new Error("find found nothing");
        },
      ),
      libraryFind: await libraryFind(path, queries),
    };

    const record = {
      date: new Date().toISOString(),
      commands: {
        help: "relembra --help",
        wake: "relembra wake",
        hook: "relembra hook",
        wakeGit: "relembra wake, scope derived by git (no RELEMBRA_SCOPE)",
        hookGit: "relembra hook, scope derived by git (no RELEMBRA_SCOPE)",
        find: "relembra find <query> (10 fixed queries, cycled)",
        libraryFind: "Relembra.find in one process, 50 warm-up, 500 measured",
      },
      artifact: {
        path: binary,
        sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
        bytes: statSync(binary).size,
      },
      dataset: {
        generator: "bench/cli.ts",
        seed: options.seed,
        memories: options.size,
        textSha256: datasetHash,
        storeBytes: statSync(path).size,
        generationMs,
        queries,
      },
      repetitions: { warmup: 5, measured: runs },
      load1m: { before: loadBefore, after: loadavg()[0], cores: availableParallelism() },
      machine: {
        cpu: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
        memoryBytes: Number(sh("sysctl", ["-n", "hw.memsize"])),
        os: `${sh("sw_vers", ["-productName"])} ${sh("sw_vers", ["-productVersion"])} (${sh("uname", ["-m"])})`,
      },
      runtimes: {
        bun: Bun.version,
        bunRevision: Bun.revision,
        node: sh("node", ["--version"]),
        // The SQLite inside Bun's node:sqlite, which the binary embeds from the same Bun build.
        sqlite: (
          new DatabaseSync(":memory:").prepare("SELECT sqlite_version() AS v").get() as {
            v: string;
          }
        ).v,
      },
      resultsMs: results,
    };
    console.log(JSON.stringify(record, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function libraryFind(path: string, queries: readonly string[]): Promise<Stats> {
  const store = openSqliteStore({ path });
  const principal: Principal = { id: "bench", readable: [SCOPE], writable: [], promotable: [] };
  const relembra = createRelembra<null>({ store, policy: () => principal });
  try {
    const samples: number[] = [];
    for (let i = -50; i < 500; i++) {
      const started = performance.now();
      await relembra.find(null, { query: queries[(i + 50) % queries.length] as string });
      if (i >= 0) samples.push(performance.now() - started);
    }
    return stats(samples);
  } finally {
    await store.close();
  }
}

await main();
