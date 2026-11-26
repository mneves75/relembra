import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { findGuardViolation } from "../guard.js";
import { MAX_SCOPE_BYTES } from "../render.js";
import { windowsUserSid } from "../sqlite/database.js";
import { CliError } from "./errors.js";
import type { SessionScopes } from "./wake.js";

/** The environment the CLI reads (docs/CLI.md, Environment). Nothing here comes from arguments. */
export interface CliEnv {
  readonly RELEMBRA_HOME?: string | undefined;
  readonly RELEMBRA_SCOPE?: string | undefined;
  readonly RELEMBRA_GLOBAL_SCOPE?: string | undefined;
  readonly RELEMBRA_AGENT?: string | undefined;
  readonly RELEMBRA_HARNESS?: string | undefined;
  readonly RELEMBRA_MODEL?: string | undefined;
  readonly RELEMBRA_WAKE_BUDGET?: string | undefined;
  /** Bun startup options: refused when set (main.ts), since they could move the cwd. */
  readonly BUN_OPTIONS?: string | undefined;
  readonly BUN_BYTECODE_ORDER_OUT?: string | undefined;
  /** Passed to git, and only these: where to find it and the user's own git configuration. */
  readonly PATH?: string | undefined;
  readonly HOME?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  /** Windows only: the Windows folder, whose System32 holds whoami.exe; default `C:\Windows`. */
  readonly SystemRoot?: string | undefined;
}

/**
 * The OS user, as `uid-<uid>`. Not the user name: Bun's os.userInfo().username reads $USER and
 * answers "unknown" when it is unset (measured on Bun 1.4.4; Node asks getpwuid), so a hook run
 * without USER would land in a second scope. The uid is the same in every environment.
 */
export function osUser(env: CliEnv): string {
  if (process.platform === "win32") return windowsUser(env.SystemRoot);
  const uid = process.getuid?.();
  if (uid === undefined) throw new CliError("no-scope", "this platform has no OS user id");
  return `uid-${uid}`;
}

/**
 * Windows has no uid: the user is `sid-<SID>`, the logon account's security identifier, which,
 * like a uid, is one per account (`PC\alex` and `CORP\alex` differ) and survives a rename. It
 * comes from the process token through whoami, never from os.userInfo(): Bun reads that from
 * %USERNAME% on Windows (seen on the hosted runners), which the hook's `env -i` clears and any
 * caller can set. An account whoami cannot name is refused, never mapped to a shared scope.
 * windowsUserSid runs whoami once per process, though the policy builds a principal for every
 * operation.
 */
function windowsUser(systemRoot: string | undefined): string {
  try {
    return `sid-${windowsUserSid(systemRoot)}`;
  } catch {
    throw new CliError("no-scope", "no scope: the OS did not name the user; set RELEMBRA_SCOPE");
  }
}

/** The store file: RELEMBRA_HOME/relembra.db, RELEMBRA_HOME defaulting to ~/.relembra. */
export function storePath(env: CliEnv, cwd: string): string {
  const home = env.RELEMBRA_HOME;
  const dir = home === undefined || home === "" ? join(homedir(), ".relembra") : home;
  return join(isAbsolute(dir) ? dir : resolve(cwd, dir), "relembra.db");
}

/** The global scope RELEMBRA_GLOBAL_SCOPE names, checked like RELEMBRA_SCOPE; undefined unset. */
function resolveGlobalScope(env: CliEnv): string | undefined {
  const given = env.RELEMBRA_GLOBAL_SCOPE;
  return given === undefined || given === "" ? undefined : checkScope(given);
}

/**
 * The session's scope: RELEMBRA_SCOPE when the host sets it, otherwise
 * `<OS user>/<name>-<first 16 hex of sha256(project key)>`, the project being the git repository
 * containing `cwd`, as git itself sees it (docs/CLI.md, Scope). The name is for people reading
 * the scope; the hash keeps two projects with the same name apart. Outside a repository it is the
 * global scope (RELEMBRA_GLOBAL_SCOPE), undefined when that is unset too; a no-scope error when
 * git cannot answer, never the global scope, since the working directory may be in a project.
 * Never derived from arguments. A bad RELEMBRA_GLOBAL_SCOPE is refused even when unused.
 */
export function resolveScope(env: CliEnv, cwd: string): string | undefined {
  const global = resolveGlobalScope(env);
  const given = env.RELEMBRA_SCOPE;
  if (given !== undefined && given !== "") return checkScope(given);
  const found = gitProject(env, cwd);
  if (found === undefined) return global;
  const hash = createHash("sha256").update(found.key).digest("hex").slice(0, 16);
  return checkScope(`${osUser(env)}/${found.name}-${hash}`);
}

/**
 * The scopes the session reads (src/cli/wake.ts): its own (resolveScope) and the global scope
 * when that is another one; the same scope named twice is one. Undefined with no session scope.
 */
export function resolveScopes(env: CliEnv, cwd: string): SessionScopes | undefined {
  const session = resolveScope(env, cwd);
  if (session === undefined) return undefined;
  const global = resolveGlobalScope(env);
  return global === undefined || global === session ? { session } : { session, global };
}

const WINDOWS = process.platform === "win32";

/** Git's file name: Windows runs only files named .exe. */
const GIT = WINDOWS ? "git.exe" : "git";

/** Git gets this long to answer each question before the scope is refused. */
const GIT_TIMEOUT_MS = 2_000;

/** Characters a path or URL from git may not hold: control characters, a newline among them. */
const UNSUPPORTED = /\p{Cc}/u;

const noGit = () =>
  new CliError(
    "no-scope",
    "no scope: git did not answer (is it installed on an absolute PATH entry?); or set RELEMBRA_SCOPE",
    "git-unavailable",
  );

/**
 * The git to run: the first executable `git` on PATH, taking only absolute entries outside the
 * working directory and every enclosing repository (including a linked worktree's or submodule's
 * main checkout). An empty or relative entry (`.`, `bin`) names a folder the current directory
 * chooses, and an entry inside any enclosing repository holds whatever is checked out there:
 * either would let a checked-out `git` run on every session start. The executable is judged, and
 * run, by its real path, so a `git` link on an outside entry that points into a fenced checkout is
 * passed over too. The same filtered list is git's own PATH.
 */
function hostGit(env: CliEnv, cwd: string): { git: string; path: string } {
  // Every enclosing repository, not only the nearest: a linked worktree or a nested repository
  // may sit inside another checkout, or belong to a main checkout elsewhere, whose files a PATH
  // entry can name. If $HOME is itself a repository, every git below it is fenced too.
  const fences = [safeRealpath(cwd)];
  for (let dir = fences[0] as string; ; dir = dirname(dir)) {
    const hasDotGit = lstatSync(join(dir, ".git"), { throwIfNoEntry: false }) !== undefined;
    if (hasDotGit || markerAt(dir) !== undefined) {
      fences.push(dir);
      const main = mainCheckout(dir);
      if (main !== undefined) fences.push(main);
    }
    if (dirname(dir) === dir) break;
  }
  // Windows paths ignore case, so a fence compared by bytes would let C:\REPO\bin past C:\repo.
  const fold = (path: string) => (WINDOWS ? path.toLowerCase() : path);
  const inside = (dir: string) => {
    const folded = fold(dir);
    return fences.some((f) => {
      const target = fold(f);
      const prefix = target.endsWith(sep) ? target : `${target}${sep}`;
      return folded === target || folded.startsWith(prefix);
    });
  };
  const entries = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => isAbsolute(entry) && !inside(safeRealpath(entry)));
  for (const entry of entries) {
    try {
      const candidate = realpath(join(entry, GIT));
      if (inside(candidate)) continue;
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return { git: candidate, path: entries.join(delimiter) };
      }
    } catch {
      // Not there, or not executable: keep looking.
    }
  }
  throw noGit();
}

/**
 * Runs git with no shell, a timeout and an environment built from scratch: the filtered PATH,
 * HOME and XDG_CONFIG_HOME only, so GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_* and the rest cannot
 * point it at another repository or inject configuration. The system configuration still applies
 * (no GIT_CONFIG_NOSYSTEM): only an administrator can write it, and the scope must follow the same
 * configuration (an insteadOf rewrite, say) as the user's own git commands. The answer is git's
 * whole output less its final newline; one holding another newline or a control character is
 * refused, never cut, since a cut path could name another repository.
 */
function runGit(
  git: { git: string; path: string },
  env: CliEnv,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const gitEnv: Record<string, string> = { PATH: git.path, LC_ALL: "C", LANGUAGE: "C" };
  for (const name of ["HOME", "XDG_CONFIG_HOME"] as const) {
    const value = env[name];
    if (value !== undefined && value !== "") gitEnv[name] = value;
  }
  // Git 2.38 and later then refuse a bare repository found by walking up, as repoMarker does.
  const result = spawnSync(git.git, ["-c", "safe.bareRepository=explicit", ...args], {
    env: gitEnv,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    maxBuffer: 64 * 1024,
  });
  if (result.error !== undefined || result.status === null) throw noGit();
  const stdout = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (result.status === 0 && UNSUPPORTED.test(stdout)) {
    throw new CliError(
      "no-scope",
      "no scope: git named a path or URL with a line break or control character; set RELEMBRA_SCOPE",
      "unsupported-path",
    );
  }
  return { status: result.status, stdout, stderr: result.stderr ?? "" };
}

/**
 * The project key and the name shown beside its hash, from questions to git:
 * `rev-parse --git-common-dir` for the repository (every worktree, and a bare repository, has
 * one) and `remote get-url origin` for its effective origin URL. With an origin the key is
 * `origin:` and the normalized URL, named by its last segment, so every clone shares a scope
 * however its folder is moved or renamed. Otherwise it is `gitdir:` and the real path of the
 * common git directory, named by that repository's folder. A local origin costs a third
 * question, `rev-parse --show-toplevel`, for the folder git resolves it against.
 *
 * `remote get-url` rather than `ls-remote --get-url`: both apply insteadOf, but with no origin
 * `ls-remote --get-url origin` prints "origin" and exits 0, which reads like a relative remote;
 * `remote get-url` exits 2 (git 2.30 and later).
 */
/**
 * What git would find walking up from `startDir`: a folder holding `.git` (`"dotgit"`), or first a
 * folder laid out as a git directory itself (`"bare"`). A git directory inside a `.git` folder
 * (the folder itself, its worktrees and modules) counts as `"dotgit"`. A bare layout is anything
 * a checkout can carry, so the CLI never takes a project from one, on every git version; git 2.38
 * and later refuse it too (`safe.bareRepository=explicit`, see runGit).
 */
function repoMarker(startDir: string): "dotgit" | "bare" | undefined {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    const marker = markerAt(dir);
    if (marker !== undefined || dirname(dir) === dir) return marker;
  }
}

/** Whether `dir` has the layout git recognizes as a git directory (`objects` may be a symlink). */
function isGitDir(dir: string): boolean {
  const at = (name: string) => lstatSync(join(dir, name), { throwIfNoEntry: false });
  if (at("HEAD") === undefined) return false;
  if (at("commondir") !== undefined || at("config") !== undefined) return true;
  try {
    return statSync(join(dir, "objects")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether `dir/.git` is an entry git stops at: a directory laid out as a git directory, or a
 * regular file carrying a `gitdir:` line. An empty decoy `.git` folder is ignored so `repoMarker`
 * walks past it just as git does.
 */
function isValidDotGit(dir: string): boolean {
  const dotgit = join(dir, ".git");
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(dotgit);
  } catch {
    return false;
  }
  if (stats.isDirectory()) return isGitDir(dotgit);
  if (!stats.isFile()) return false;
  try {
    const line = stripCrlf(readFileSync(dotgit, "utf8").split(/\r?\n/, 1)[0] ?? "");
    return line.startsWith("gitdir: ") && line.length > "gitdir: ".length;
  } catch {
    return false;
  }
}

/** Strips only trailing CR and LF, matching git's gitfile and commondir parsers (keeping spaces). */
function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

/** repoMarker's test for one folder. */
function markerAt(dir: string): "dotgit" | "bare" | undefined {
  if (isValidDotGit(dir)) return "dotgit";
  if (!isGitDir(dir)) return undefined;
  return dir.split(sep).includes(".git") ? "dotgit" : "bare";
}

/**
 * For a folder whose `.git` is a file (a linked worktree, a submodule), the checkout that owns
 * its git directory: `gitdir:` then `commondir` followed as git follows them, cut before the first
 * `.git` component (the git directory itself when it has none). Undefined otherwise.
 */
function mainCheckout(dir: string): string | undefined {
  try {
    const gitfile = stripCrlf(readFileSync(join(dir, ".git"), "utf8").split(/\r?\n/, 1)[0] ?? "");
    if (!gitfile.startsWith("gitdir: ")) return undefined;
    const gitdir = resolve(dir, gitfile.slice("gitdir: ".length));
    const commondir = join(gitdir, "commondir");
    const common = existsSync(commondir)
      ? resolve(gitdir, stripCrlf(readFileSync(commondir, "utf8").split(/\r?\n/, 1)[0] ?? ""))
      : gitdir;
    const parts = safeRealpath(common).split(sep);
    const dotgit = parts.indexOf(".git");
    return dotgit < 0 ? parts.join(sep) : parts.slice(0, dotgit).join(sep) || sep;
  } catch {
    // A .git folder (EISDIR), or an unreadable file: nothing further to fence.
    return undefined;
  }
}

function gitProject(env: CliEnv, cwd: string): { key: string; name: string } | undefined {
  const marker = repoMarker(safeRealpath(cwd));
  if (marker === "bare") {
    throw new CliError(
      "no-scope",
      "no scope: a git directory without a .git folder (a bare repository) is not a project; set RELEMBRA_SCOPE",
      "bare-repository",
    );
  }
  const git = hostGit(env, cwd);
  const common = runGit(git, env, [
    "-C",
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (common.status !== 0) {
    if (/not a git repository \(or any /i.test(common.stderr) && marker === undefined) {
      return undefined;
    }
    throw new CliError(
      "no-scope",
      "no scope: git failed to inspect the repository; set RELEMBRA_SCOPE",
      "git-failed",
    );
  }
  if (common.stdout === "") {
    throw new CliError(
      "no-scope",
      "no scope: git returned an empty repository path; set RELEMBRA_SCOPE",
      "git-failed",
    );
  }
  const commonDir = safeRealpath(common.stdout);
  // The repository's folder, for its name: the one holding .git, or the git directory itself
  // (bare, or a separate git dir).
  const repoDir = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  const repoName = basename(repoDir).replace(/\.git$/, "") || basename(repoDir);
  const origin = runGit(git, env, ["-C", cwd, "remote", "get-url", "origin"]);
  if (origin.status === 2) return { key: `gitdir:${commonDir}`, name: repoName };
  if (origin.status !== 0 || origin.stdout === "") {
    throw new CliError("no-scope", "no scope: git could not read the origin remote", "git-failed");
  }
  // Git resolves a relative remote from the working tree's top (the git directory when bare).
  const base = () => {
    const top = runGit(git, env, ["-C", cwd, "rev-parse", "--show-toplevel"]);
    return top.status === 0 && top.stdout !== "" ? safeRealpath(top.stdout) : commonDir;
  };
  const normalized = normalizeRemote(origin.stdout, base);
  const last = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.git$/, "");
  return { key: `origin:${normalized}`, name: last || repoName };
}

/** Ports git uses when a URL names none: a URL naming its scheme's default is the same URL. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  ssh: "22",
  "git+ssh": "22",
  "ssh+git": "22",
  https: "443",
  http: "80",
  git: "9418",
};

/**
 * A remote URL as `host[:port]/owner/repo`: the scheme, any `user@`, a default port, a trailing
 * `.git` and slashes removed and the host lowercased, so the ssh, scp-like and https forms of one
 * repository match; a non-default port is kept. The path keeps its case. A local path, or a
 * `file://` URL decoded to its path, becomes `file:` and its real path, a relative one resolved
 * against `base()` (asked only then). `url` is git's answer as runGit returns it; a space in it,
 * leading or trailing, is part of the URL and kept.
 */
function normalizeRemote(url: string, base: () => string): string {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  let host: string;
  let port = "";
  let path: string;
  if (scheme !== null) {
    const name = (scheme[1] as string).toLowerCase();
    if (name === "file") return localKey(filePath(url.slice(scheme[0].length)), base);
    const after = url.slice(scheme[0].length);
    const slash = after.indexOf("/");
    const authority = slash < 0 ? after : after.slice(0, slash);
    path = slash < 0 ? "" : after.slice(slash + 1);
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    const split = /^(\[[^\]]*\]|[^:]*)(?::([0-9]*))?$/.exec(hostPort);
    host = split?.[1] ?? hostPort;
    port = split?.[2] ?? "";
    if (port === DEFAULT_PORTS[name]) port = "";
  } else if (WINDOWS && /^[A-Za-z]:[\\/]/.test(url)) {
    // A drive path, which git on Windows reads as local, never as an scp-like host "C".
    return localKey(url, base);
  } else {
    // scp-like `[user@]host:path`, as git reads it: a colon before any slash.
    const scp = /^(?:[^@/]+@)?(\[[^\]]*\]|[^/:]+):(.*)$/.exec(url);
    if (scp === null) return localKey(url, base);
    host = scp[1] as string;
    path = scp[2] as string;
  }
  path = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  return `${host.toLowerCase()}${port === "" ? "" : `:${port}`}/${path}`;
}

/**
 * The local path a `file://` URL names, from git's raw string, the scheme already cut: an empty or
 * `localhost` host, then the path percent-decoded byte for byte. Not fileURLToPath: URL parsing
 * trims spaces at the ends, so `file:///x/upstream ` would name `/x/upstream`, another repository.
 * Another host, an encoded `/` or a malformed escape names no local path; a decoded control
 * character is refused like one in git's output.
 */
function filePath(afterScheme: string): string {
  const slash = afterScheme.indexOf("/");
  const host = slash < 0 ? afterScheme : afterScheme.slice(0, slash);
  const encoded = slash < 0 ? "" : afterScheme.slice(slash);
  let path: string | undefined;
  if (encoded !== "" && (host === "" || host.toLowerCase() === "localhost")) {
    if (!/%2f/i.test(encoded)) {
      try {
        path = decodeURIComponent(encoded);
      } catch {
        // A malformed escape or bytes that are not UTF-8: no path.
      }
    }
  }
  if (path === undefined) {
    throw new CliError(
      "no-scope",
      "no scope: the origin is a file URL that names no local path; set RELEMBRA_SCOPE",
      "unsupported-origin",
    );
  }
  if (UNSUPPORTED.test(path)) {
    throw new CliError(
      "no-scope",
      "no scope: the origin's file URL decodes to a control character; set RELEMBRA_SCOPE",
      "unsupported-path",
    );
  }
  // On Windows a drive path is written /C:/x in the URL; the path is C:/x.
  return WINDOWS && /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/**
 * The key of a local origin: `file:` and its real path, with forward slashes on Windows too, so
 * the project name beside the hash is the last folder, never the whole path.
 */
function localKey(path: string, base: () => string): string {
  const absolute = isAbsolute(path) ? path : resolve(base(), path);
  const real = safeRealpath(absolute);
  return `file:${(WINDOWS ? real.replaceAll("\\", "/") : real).replace(/(?<=.)\/+$/, "")}`;
}

/**
 * The real path. On Windows the native call, which also gives the canonical case and long names,
 * so one folder reached as C:\Repo and c:\repo is one project and one fence.
 */
function realpath(path: string): string {
  return WINDOWS ? realpathSync.native(path) : realpathSync(path);
}

function safeRealpath(path: string): string {
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}

function checkScope(scope: string): string {
  // The guard's character rules, so a scope renders as plainly as the text it holds.
  const rule = findGuardViolation(scope, MAX_SCOPE_BYTES);
  if (rule !== undefined) {
    throw new CliError(
      "bad-scope",
      `the scope must be 1 to ${MAX_SCOPE_BYTES} UTF-8 bytes on one line of visible characters`,
      rule,
    );
  }
  return scope;
}
