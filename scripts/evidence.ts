/**
 * What a measurement or a gate result depends on, so a result can name it and a changed verifier
 * invalidates it: the commit, the bytes of every relevant input on disk, and the Bun and Node that
 * run them. Shared by `bench/eval-latency.ts --check` and the local gate.
 *
 *   bun scripts/evidence.ts [--root DIR] [--expect FILE]
 *
 * Prints the snapshot as JSON. Exits 0 only when Git and both runtimes were found and every
 * relevant input on disk matches HEAD; with `--expect`, also only when the snapshot equals the one
 * FILE holds (a snapshot this command printed earlier). Reasons go to stderr.
 *
 * The inputs are read from the disk and compared with HEAD's tree directly, so neither the index
 * nor a .gitignore can hide a changed or new source file. Only the fixed list below is an input:
 * generated output and planning documents are not, so evidence can be committed without
 * invalidating the code it measured.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";

/** Directories every file of which is an input, at any depth. */
const INPUT_DIRS = [
  "src",
  "eval",
  "bench",
  "build",
  "scripts",
  "test",
  "examples",
  ".github",
  ".githooks",
];
/**
 * Single inputs: package metadata and lockfile, compiler, lint, scanner and runtime configuration,
 * the installer, the files npm ships besides dist/ (README.md, LICENSE, docs/FORMAT.md) and the
 * document the CLI contract test reads. One that is absent counts as absent: if it appears, it is
 * a relevant untracked file.
 */
const INPUT_FILES = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  "tsconfig.json",
  "tsconfig.build.json",
  "biome.json",
  ".gitignore",
  ".gitleaksignore",
  ".gitleaks.toml",
  "install.sh",
  "README.md",
  "LICENSE",
  "docs/FORMAT.md",
  "docs/CLI.md",
];
/** Generated output, never an input wherever the lists above reach. */
const GENERATED = [".scratch", "docs/eval", "eval/out", "bin", "dist", "node_modules"];

/** Whether a repository-relative path is a relevant input. */
export function isInput(path: string): boolean {
  if (GENERATED.some((dir) => path === dir || path.startsWith(`${dir}/`))) return false;
  return INPUT_FILES.includes(path) || INPUT_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

export interface InputIdentity {
  /** Git and the disk could be read; when false, `errors` says why and nothing else is trusted. */
  readonly available: boolean;
  /** Every input on disk matches HEAD, and no input exists that HEAD does not hold. */
  readonly clean: boolean;
  readonly commit: string | null;
  /** sha256 over `files`, one `<mode> <blob id> <path>\n` line per input in path order. */
  readonly digest: string | null;
  /** Each input on disk as Git's tree would name it: `<mode> <blob id>`. */
  readonly files: Readonly<Record<string, string>>;
  /** Inputs that differ from HEAD's, deleted ones included. */
  readonly dirty: readonly string[];
  /** Inputs HEAD does not hold, whether or not a .gitignore names them. */
  readonly untracked: readonly string[];
  readonly errors: readonly string[];
}

export interface Runtime {
  readonly path: string;
  readonly version: string;
  /** The SQLite inside the runtime's node:sqlite. */
  readonly sqlite: string;
  /** sha256 of the executable file at `path`. */
  readonly sha256: string;
}

export interface RuntimeIdentity {
  readonly available: boolean;
  readonly bun: Runtime | null;
  readonly node: Runtime | null;
  readonly errors: readonly string[];
}

export interface Snapshot {
  readonly inputs: InputIdentity;
  readonly runtimes: RuntimeIdentity;
}

/** Git on `root`'s own repository: no GIT_* variable of the caller may point it elsewhere. */
function git(root: string, args: readonly string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
  if (result.error !== undefined) throw new Error(`git ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Git's blob id of `bytes`, in the repository's object format. */
function blobId(format: "sha1" | "sha256", bytes: Buffer): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * Every input on disk under `root`, as `<mode> <blob id>` by path. A symlink is refused: Git
 * records only its target's name, so the bytes it points to could change while it stays clean.
 */
function onDisk(root: string, format: "sha1" | "sha256"): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (path: string) => {
    if (!isInput(path) && !INPUT_DIRS.some((dir) => dir === path)) return;
    const full = join(root, path);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isFile()) {
      const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
      found.set(path, `${mode} ${blobId(format, readFileSync(full))}`);
    } else if (
      stat.isDirectory() &&
      INPUT_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`))
    ) {
      for (const entry of readdirSync(full)) visit(`${path}/${entry}`);
    } else {
      throw new Error(`${path} is not a regular file or an input directory`);
    }
  };
  for (const path of [...INPUT_DIRS, ...INPUT_FILES]) visit(path);
  return found;
}

/** HEAD's inputs, as `<mode> <blob id>` by path. */
function atHead(root: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of git(root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]).split("\0")) {
    if (line === "") continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (match === null) throw new Error(`git ls-tree printed an unexpected line: ${line}`);
    const [, mode, type, id, path] = match as unknown as [string, string, string, string, string];
    if (!isInput(path)) continue;
    if (type !== "blob" || mode === "120000") {
      throw new Error(`${path} is not a regular file in HEAD (${mode} ${type})`);
    }
    found.set(path, `${mode} ${id}`);
  }
  return found;
}

/** The relevant inputs of the repository whose top level is `root`, compared with its HEAD. */
export function inputIdentity(root: string): InputIdentity {
  try {
    const top = git(root, ["rev-parse", "--show-toplevel"]).trim();
    if (realpathSync(top) !== realpathSync(root)) {
      throw new Error(`${root} is not its repository's top level (${top})`);
    }
    const commit = git(root, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).trim();
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
      throw new Error(`git rev-parse printed ${JSON.stringify(commit)}, not a commit id`);
    }
    const format = git(root, ["rev-parse", "--show-object-format"]).trim();
    if (format !== "sha1" && format !== "sha256")
      throw new Error(`unknown object format ${format}`);
    const disk = onDisk(root, format);
    const head = atHead(root);
    const paths = [...new Set([...disk.keys(), ...head.keys()])].sort();
    const dirty = paths.filter((path) => head.has(path) && disk.get(path) !== head.get(path));
    const untracked = paths.filter((path) => !head.has(path));
    const files: Record<string, string> = {};
    const hash = createHash("sha256");
    for (const path of paths) {
      const entry = disk.get(path);
      if (entry === undefined) continue;
      files[path] = entry;
      hash.update(`${entry} ${path}\n`);
    }
    return {
      available: true,
      clean: dirty.length === 0 && untracked.length === 0,
      commit,
      digest: hash.digest("hex"),
      files,
      dirty,
      untracked,
      errors: [],
    };
  } catch (error) {
    return {
      available: false,
      clean: false,
      commit: null,
      digest: null,
      files: {},
      dirty: [],
      untracked: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1 << 20);
  const fd = openSync(path, "r");
  try {
    for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

const DESCRIBE = (version: string) =>
  `const { DatabaseSync } = require("node:sqlite"); console.log(JSON.stringify({ path: process.execPath, version: ${version}, sqlite: new DatabaseSync(":memory:").prepare("SELECT sqlite_version() AS v").get().v }))`;

/** Runs `command` and asks it what it is: the identity comes from the executable that answers. */
function discover(command: string, version: string): Runtime {
  const result = spawnSync(command, ["-e", DESCRIBE(version)], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`exited ${result.status}: ${result.stderr.trim().slice(0, 500)}`);
  }
  const { path, version: reported, sqlite } = JSON.parse(result.stdout) as Record<string, unknown>;
  if (typeof path !== "string" || typeof reported !== "string" || typeof sqlite !== "string") {
    throw new Error(`did not report its path, version and SQLite: ${result.stdout.trim()}`);
  }
  return { path, version: reported, sqlite, sha256: fileSha256(path) };
}

/**
 * Variables that change how Bun or Node run while their executables stay the same (the CLI
 * refuses BUN_OPTIONS and BUN_BYTECODE_ORDER_OUT for the same reason, docs/CLI.md).
 */
const OVERRIDES = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_OPTIONS",
  "BUN_BE_BUN",
  "BUN_BYTECODE_ORDER_OUT",
];
/** JavaScriptCore options (JIT, GC), read by Bun under either prefix. */
const OVERRIDE_PREFIXES = ["BUN_JSC_", "JSC_"];

/** Whether an environment variable, when set and nonempty, makes the runtimes unidentifiable. */
export function isRuntimeOverride(name: string): boolean {
  return OVERRIDES.includes(name) || OVERRIDE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The Bun and Node a run uses: this process's executable when it is Bun (the benchmark spawns
 * its Bun workers with it), else `bun` from PATH; `node` from PATH (the Node workers' command).
 * Unavailable when either cannot be run or a nonempty override is inherited; an override is named,
 * never its value.
 */
export function runtimeIdentity(): RuntimeIdentity {
  const errors = Object.entries(process.env)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([name]) => name)
    .filter(isRuntimeOverride)
    .sort()
    .map((name) => `${name} is set, which changes how the runtimes run`);
  // Neither runtime is started under an override: it would act on it before answering.
  if (errors.length > 0) return { available: false, bun: null, node: null, errors };
  const attempt = (name: string, command: string, version: string) => {
    try {
      return discover(command, version);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const bun = attempt(
    "bun",
    process.versions.bun === undefined ? "bun" : process.execPath,
    'Bun.version + " (" + Bun.revision + ")"',
  );
  const node = attempt("node", "node", "process.version");
  return { available: errors.length === 0, bun, node, errors };
}

export function snapshot(root: string): Snapshot {
  return { inputs: inputIdentity(root), runtimes: runtimeIdentity() };
}

/**
 * Why a snapshot is not usable evidence: unavailable discovery or inputs that differ from HEAD.
 * Each flag and each list counts on its own, so a partial or edited record cannot pass.
 */
export function snapshotProblems(s: Snapshot): string[] {
  const { inputs, runtimes } = s;
  const problems = [
    ...inputs.errors.map((error) => `inputs unavailable: ${error}`),
    ...inputs.dirty.map((path) => `${path} differs from HEAD`),
    ...inputs.untracked.map((path) => `${path} is not in HEAD`),
    ...runtimes.errors.map((error) => `runtime unavailable: ${error}`),
  ];
  if (!inputs.available && inputs.errors.length === 0) problems.push("inputs unavailable");
  if (inputs.available && !inputs.clean && inputs.dirty.length + inputs.untracked.length === 0) {
    problems.push("inputs differ from HEAD");
  }
  if (inputs.available && (inputs.commit === null || inputs.digest === null)) {
    problems.push("inputs name no commit or digest");
  }
  if (!runtimes.available && runtimes.errors.length === 0) problems.push("runtimes unavailable");
  if (runtimes.available && (runtimes.bun === null || runtimes.node === null)) {
    problems.push("a runtime is missing");
  }
  return problems;
}

/** Every difference between two snapshots; none when they name the same inputs and runtimes. */
export function identityChanges(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  const a = before.inputs;
  const b = after.inputs;
  if (a.available !== b.available) {
    changes.push(`inputs became ${b.available ? "available" : "unavailable"}`);
  }
  if (a.commit !== b.commit) changes.push(`commit ${a.commit} became ${b.commit}`);
  for (const path of [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort()) {
    const was = a.files[path];
    const is = b.files[path];
    if (was === is) continue;
    changes.push(
      `${path} ${was === undefined ? "appeared" : is === undefined ? "disappeared" : "changed"}`,
    );
  }
  for (const name of ["bun", "node"] as const) {
    const was = JSON.stringify(before.runtimes[name]);
    const is = JSON.stringify(after.runtimes[name]);
    if (was !== is) changes.push(`${name} runtime ${was} became ${is}`);
  }
  return changes;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const root = value("--root") ?? join(import.meta.dirname, "..");
  const expected = value("--expect");
  const now = snapshot(root);
  process.stdout.write(`${JSON.stringify(now, null, 2)}\n`);
  const problems = snapshotProblems(now);
  if (expected !== undefined) {
    const changes = identityChanges(JSON.parse(readFileSync(expected, "utf8")) as Snapshot, now);
    problems.push(...changes.map((change) => `since ${expected}: ${change}`));
  }
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
