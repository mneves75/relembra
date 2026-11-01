import { test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
const { RELEMBRA_BINARY, RELEMBRA_REQUIRE_BINARY, CI, PATH, TMPDIR } = process.env;

/** A missing binary fails the suite under RELEMBRA_REQUIRE_BINARY, and in CI (CI is set). */
const REQUIRE = Boolean(RELEMBRA_REQUIRE_BINARY) || Boolean(CI);

/**
 * The binary under test: RELEMBRA_BINARY when set (CI points it at the `cli` job's build),
 * otherwise bin/relembra, built once per test run by build/cli.ts (which skips a build whose
 * sources have not changed).
 */
function resolveBinary(): string | undefined {
  const given = RELEMBRA_BINARY;
  if (given !== undefined && given !== "") return existsSync(given) ? given : undefined;
  const built = spawnSync(process.execPath, [join(ROOT, "build", "cli.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  const path = join(ROOT, "bin", "relembra");
  if (built.status !== 0) {
    if (REQUIRE) throw new Error(`the CLI build failed:\n${built.stdout}\n${built.stderr}`);
    return undefined;
  }
  return existsSync(path) ? path : undefined;
}

const binary = resolveBinary();
if (binary === undefined) {
  if (REQUIRE) {
    throw new Error("RELEMBRA_REQUIRE_BINARY or CI is set, but there is no CLI binary to test");
  }
  console.warn(
    "relembra CLI suite SKIPPED: no binary (the build failed or RELEMBRA_BINARY is missing). " +
      "Set RELEMBRA_REQUIRE_BINARY=1 (CI sets CI) to make this a failure.",
  );
}

/** The compiled binary. Only call it inside `cliTest`. */
export const BINARY = binary ?? "";

/**
 * A test that runs the compiled binary: skipped, loudly, only when no binary exists. Spawning
 * dozens of processes on a busy machine outlasts bun's 5 s default, so the default is 30 s.
 */
export function cliTest(name: string, fn: () => void | Promise<void>, timeoutMs = 30_000): void {
  (binary === undefined ? test.skip : test)(name, fn, timeoutMs);
}

/** The OS user part of a scope: the uid (see src/cli/scope.ts on why not the name). */
export const USER = `uid-${process.getuid?.()}`;

/** The first 16 hex characters of the sha256 of a project key (docs/CLI.md, Scope). */
export const hash16 = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** The scope docs/CLI.md gives a repository with no origin remote: its git directory is the key. */
export const scopeFor = (repo: string) =>
  `${USER}/${basename(repo)}-${hash16(`gitdir:${realpathSync(join(repo, ".git"))}`)}`;

export interface Sandbox {
  /** A temporary directory standing in for $HOME, so nothing reaches the real one. */
  readonly home: string;
  /** RELEMBRA_HOME inside it. */
  readonly relembraHome: string;
  readonly store: string;
  /** A git repository with no origin; its scope is scopeFor(repo). */
  readonly repo: string;
  readonly scope: string;
  remove(): void;
}

/** A temp HOME, RELEMBRA_HOME and git repository, removed by `remove`. */
export function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relembra-cli-")));
  const home = join(root, "home");
  const relembraHome = join(root, "relembra-home");
  const repo = join(root, "work", `repo-${basename(root).slice(-6)}`);
  mkdirSync(home);
  gitInit(repo);
  return {
    home,
    relembraHome,
    store: join(relembraHome, "relembra.db"),
    repo,
    scope: scopeFor(repo),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function gitInit(dir: string, ...flags: string[]): void {
  mkdirSync(dir, { recursive: true });
  const result = spawnSync("git", ["init", "-q", ...flags, dir], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr}`);
}

export function git(dir: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-C", dir, ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

export interface RunOptions {
  readonly cwd?: string;
  /** Added to the sandbox's environment; `undefined` removes a variable. */
  readonly env?: Record<string, string | undefined>;
  readonly input?: string | Uint8Array;
  /** Kills the binary after this many milliseconds (default 30,000); a kill leaves status null. */
  readonly timeoutMs?: number;
}

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout parsed as JSON when it is one document, else undefined. */
  readonly json: JsonDocument | undefined;
}

export type JsonDocument =
  // biome-ignore lint/suspicious/noExplicitAny: the binary's JSON; the assertions check its shape.
  | { readonly ok: true; readonly data: any }
  | { readonly ok: false; readonly error: { readonly code: string; readonly rule?: string } };

/** Every command run with exit 0 in --json mode, so a test can prove each one was exercised. */
export const exercised = new Set<string>();

/** The sandbox's environment: no RELEMBRA_SCOPE, HOME in the sandbox, plus `extra`. */
export function sandboxEnv(
  box: Sandbox,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: PATH ?? "/usr/bin:/bin",
    HOME: box.home,
    RELEMBRA_HOME: box.relembraHome,
    TMPDIR: TMPDIR ?? "/tmp",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Every run starts the binary in a new session (setsid), so it has no controlling terminal, as
 * an agent's tool call has none, and a developer's terminal never sees a confirmation prompt.
 */
const SETSID = ["-MPOSIX", "-e", "POSIX::setsid(); exec { $ARGV[0] } @ARGV or die $!"];
/** perl by absolute path, so a test can give the binary a PATH without perl (or git) in it. */
const PERL = existsSync("/usr/bin/perl") ? "/usr/bin/perl" : "perl";

/** Runs the binary in the sandbox: its repo as cwd, a clean environment with no RELEMBRA_SCOPE. */
export function run(box: Sandbox, args: readonly string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(PERL, [...SETSID, BINARY, ...args], {
    cwd: options.cwd ?? box.repo,
    env: sandboxEnv(box, options.env),
    input: options.input ?? "",
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code !== "EPIPE") {
    throw result.error;
  }
  let json: JsonDocument | undefined;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  if (result.status === 0 && json?.ok === true && args.includes("--json") && args[0]) {
    exercised.add(args[0]);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

/**
 * Runs the binary with `input` written to stdin, which then stays open (never EOF), and resolves
 * when it exits or is killed after `killAfterMs`, with how long it took.
 */
/**
 * `relembra export` of `box`'s store: its stdout. A failed export throws with the CLI's stderr, so
 * a test never parses an empty or partial export and reports a JSON error instead of the cause.
 */
export function exportedText(box: Sandbox): string {
  const result = run(box, ["export"]);
  if (result.status !== 0) {
    throw new Error(`relembra export exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

export function runStdinOpen(
  box: Sandbox,
  args: readonly string[],
  input: string,
  killAfterMs = 20_000,
): Promise<{ status: number | null; stdout: string; elapsedMs: number; killed: boolean }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(PERL, [...SETSID, BINARY, ...args], {
      cwd: box.repo,
      env: sandboxEnv(box),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let killed = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stdin.on("error", () => {});
    child.stdin.write(input);
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, killAfterMs);
    child.on("exit", (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ status, stdout, elapsedMs: performance.now() - started, killed });
    });
  });
}

/** Runs with --json, expects exit 0 and ok, and returns the data. */
// biome-ignore lint/suspicious/noExplicitAny: the binary's JSON; the assertions check its shape.
export function ok(box: Sandbox, args: readonly string[], options: RunOptions = {}): any {
  const result = run(box, withJson(args), options);
  if (result.status !== 0 || result.json?.ok !== true) {
    throw new Error(
      `expected ok from ${args.join(" ")}: status ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.json.data;
}

/** Runs with --json and expects the given exit code and error code. Returns the result. */
export function refused(
  box: Sandbox,
  args: readonly string[],
  exit: number,
  code: string,
  options: RunOptions = {},
): RunResult {
  const result = run(box, withJson(args), options);
  if (result.status !== exit || result.json?.ok !== false || result.json.error.code !== code) {
    throw new Error(
      `expected exit ${exit} code ${code} from ${args.join(" ")}: status ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

/** `--json` right after the command, so it stays a flag even when the args hold a `--`. */
function withJson(args: readonly string[]): string[] {
  const [command, ...rest] = args;
  return command === undefined ? ["--json"] : [command, "--json", ...rest];
}
