import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  identityChanges,
  inputIdentity,
  isRuntimeOverride,
  runtimeIdentity,
  type Snapshot,
  snapshot,
  snapshotProblems,
} from "../scripts/evidence.js";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

const ROOT = join(import.meta.dir, "..");
const EVIDENCE = join(ROOT, "scripts", "evidence.ts");
const scratch = mkdtempSync(join(tmpdir(), "relembra-evidence-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Git with the fixture's own repository only: no GIT_* variable from the caller redirects it. */
function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
    ].concat(args),
    { cwd, encoding: "utf8", env },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

let fixtures = 0;
/** A committed repository holding `files`, one relevant input of each kind by default. */
function fixture(files: Record<string, string> = {}): string {
  const root = join(scratch, `repo-${++fixtures}`);
  const all = {
    "src/a.ts": "export const a = 1;\n",
    "test/a.test.ts": "// a test\n",
    "scripts/run.sh": "#!/bin/sh\n",
    "package.json": "{}\n",
    "docs/notes.md": "not an input\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) write(root, path, text);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

describe.skipIf(NO_RELEASE_TOOLING)("inputIdentity", () => {
  test("a committed checkout is available and clean, named by its commit and its input bytes", () => {
    const root = fixture();
    const identity = inputIdentity(root);
    expect(identity.errors).toEqual([]);
    expect(identity).toMatchObject({ available: true, clean: true, dirty: [], untracked: [] });
    expect(identity.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/);
    // Each input as Git's tree entry would name it: mode and blob id.
    expect(identity.files["src/a.ts"]).toBe(`100644 ${git(root, "rev-parse", "HEAD:src/a.ts")}`);
    expect(Object.keys(identity.files).sort()).toEqual([
      "package.json",
      "scripts/run.sh",
      "src/a.ts",
      "test/a.test.ts",
    ]);
    // The same bytes give the same identity.
    expect(inputIdentity(root)).toEqual(identity);
  });

  test("a changed, deleted, re-moded or staged input makes it dirty and changes the digest", () => {
    const root = fixture();
    const clean = inputIdentity(root);

    write(root, "src/a.ts", "export const a = 2;\n");
    const changed = inputIdentity(root);
    expect(changed).toMatchObject({ available: true, clean: false, dirty: ["src/a.ts"] });
    expect(changed.digest).not.toBe(clean.digest);

    // Staged is not committed: the identity compares the disk with HEAD, not with the index.
    git(root, "add", "src/a.ts");
    expect(inputIdentity(root)).toMatchObject({ clean: false, dirty: ["src/a.ts"] });
    git(root, "commit", "-q", "-m", "change");
    expect(inputIdentity(root)).toMatchObject({ clean: true, dirty: [] });

    chmodSync(join(root, "scripts", "run.sh"), 0o755);
    expect(inputIdentity(root)).toMatchObject({ clean: false, dirty: ["scripts/run.sh"] });
    chmodSync(join(root, "scripts", "run.sh"), 0o644);

    rmSync(join(root, "test", "a.test.ts"));
    expect(inputIdentity(root)).toMatchObject({ clean: false, dirty: ["test/a.test.ts"] });
  });

  test("a relevant untracked file makes it dirty, even one the repository's .gitignore hides", () => {
    const root = fixture({ ".gitignore": "src/hidden.ts\n" });
    expect(inputIdentity(root).clean).toBe(true);
    write(root, "src/hidden.ts", "export const hidden = 1;\n");
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(inputIdentity(root)).toMatchObject({ clean: false, untracked: ["src/hidden.ts"] });
    write(root, "bench/new.ts", "export {};\n");
    expect(inputIdentity(root).untracked).toEqual(["bench/new.ts", "src/hidden.ts"]);
  });

  test("generated output and files outside the inputs leave it clean and unchanged", () => {
    const root = fixture();
    const clean = inputIdentity(root);
    for (const path of [
      ".scratch/run/log.txt",
      "docs/eval/bench-2026-11-01-x/bench.json",
      "eval/out/bench/seed-1/relembra.db",
      "bin/relembra",
      "dist/index.js",
      "node_modules/x/index.js",
      "docs/notes.md",
      "docs/specs/release-evidence/spec.md",
      "CHANGELOG.md",
    ]) {
      write(root, path, "generated\n");
    }
    expect(inputIdentity(root)).toEqual(clean);
    // Positive control: the same write into an input directory is seen.
    write(root, "eval/new.ts", "export {};\n");
    expect(inputIdentity(root)).toMatchObject({ clean: false, untracked: ["eval/new.ts"] });
  });

  test("a sealed eval set where eval/README.md keeps it leaves it clean; other eval files do not", () => {
    const root = fixture({ "eval/.gitignore": "sealed/\n" });
    const clean = inputIdentity(root);
    write(root, "eval/sealed/real/manifest.json", "{}\n");
    write(root, "eval/sealed/real/questions.jsonl", "{}\n");
    expect(inputIdentity(root)).toEqual(clean);
    // Positive controls: an ignored file elsewhere under eval/, and a look-alike name, are seen.
    write(root, "eval/sealed-not/manifest.json", "{}\n");
    write(root, "eval/other/sealed/manifest.json", "{}\n");
    expect(inputIdentity(root)).toMatchObject({
      clean: false,
      untracked: ["eval/other/sealed/manifest.json", "eval/sealed-not/manifest.json"],
    });
  });

  test("the files the package ships and the tests read are inputs, present or not", () => {
    const root = fixture({ "README.md": "# r\n" });
    expect(inputIdentity(root).files["README.md"]).toBeDefined();
    write(root, "README.md", "# changed\n");
    expect(inputIdentity(root)).toMatchObject({ clean: false, dirty: ["README.md"] });
    // Absent from HEAD, so each one appearing is a relevant untracked file.
    for (const path of [
      "LICENSE",
      "docs/FORMAT.md",
      "docs/CLI.md",
      "install.sh",
      "bun.lock",
      "tsconfig.json",
      "biome.json",
      ".gitleaksignore",
      ".github/workflows/ci.yml",
      ".githooks/pre-push",
    ]) {
      write(root, path, "new\n");
      expect(inputIdentity(root).untracked).toContain(path);
    }
  });

  test("a symlink among the inputs is refused: its target's bytes could change unseen", () => {
    // Committed, so Git alone would call it clean while the file it points to changes.
    const root = join(scratch, "symlinks");
    write(root, "outside.ts", "export const a = 1;\n");
    write(root, "src/a.ts", "export const a = 1;\n");
    symlinkSync("../outside.ts", join(root, "src", "link.ts"));
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fixture");
    const identity = inputIdentity(root);
    expect(identity).toMatchObject({ available: false, clean: false, digest: null });
    expect(identity.errors.join("\n")).toContain("src/link.ts");
    // A symlink outside the inputs is not looked at; without the input one, the checkout is clean.
    rmSync(join(root, "src", "link.ts"));
    symlinkSync("outside.ts", join(root, "docs-link.ts"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "no input symlink");
    expect(inputIdentity(root)).toMatchObject({ available: true, clean: true });
  });

  test("a failed Git discovery is unavailable, never a guessed commit", () => {
    const plain = join(scratch, "not-a-repository");
    write(plain, "src/a.ts", "export {};\n");
    const outside = inputIdentity(plain);
    expect(outside).toMatchObject({ available: false, clean: false, commit: null, digest: null });
    expect(outside.errors.length).toBeGreaterThan(0);

    // A repository with no commit: `git rev-parse HEAD` fails.
    const empty = join(scratch, "no-commit");
    write(empty, "src/a.ts", "export {};\n");
    git(empty, "init", "-q");
    expect(inputIdentity(empty)).toMatchObject({ available: false, commit: null });

    // A directory inside a repository is not its root: paths would not match HEAD's.
    const root = fixture();
    expect(inputIdentity(join(root, "src"))).toMatchObject({ available: false, commit: null });
    // Positive control: the root itself.
    expect(inputIdentity(root).available).toBe(true);
  });
});

describe.skipIf(NO_RELEASE_TOOLING)("runtimeIdentity", () => {
  test("names the Bun and Node that actually run, with their executables' sha256", () => {
    const identity = runtimeIdentity();
    expect(identity.errors).toEqual([]);
    expect(identity.available).toBe(true);
    expect(identity.bun?.version).toContain(Bun.version);
    expect(identity.bun?.version).toContain(Bun.revision);
    const node = spawnSync("node", ["-p", "process.version + ' ' + process.execPath"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(`${identity.node?.version} ${identity.node?.path}`).toBe(node);
    for (const runtime of [identity.bun, identity.node]) {
      expect(runtime?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(runtime?.sqlite).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe.skipIf(NO_RELEASE_TOOLING)("snapshotProblems", () => {
  test("rejects any snapshot not available and clean, whatever its lists say", () => {
    const good = snapshot(fixture());
    expect(snapshotProblems(good)).toEqual([]);
    // Flags alone, with empty lists and no errors, as a hand-edited or partial record could be.
    for (const bad of [
      { ...good, inputs: { ...good.inputs, clean: false } },
      { ...good, inputs: { ...good.inputs, available: false } },
      { ...good, runtimes: { ...good.runtimes, available: false } },
    ]) {
      expect(snapshotProblems(bad).length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(NO_RELEASE_TOOLING)("identityChanges", () => {
  test("names every input and runtime difference between two snapshots, and none for equal ones", () => {
    const root = fixture();
    const before = snapshot(root);
    expect(identityChanges(before, snapshot(root))).toEqual([]);

    write(root, "src/a.ts", "export const a = 3;\n");
    write(root, "src/b.ts", "export {};\n");
    rmSync(join(root, "test", "a.test.ts"));
    const after = snapshot(root);
    expect(identityChanges(before, after)).toEqual([
      "src/a.ts changed",
      "src/b.ts appeared",
      "test/a.test.ts disappeared",
    ]);

    const node = before.runtimes.node;
    if (node === null) throw new Error("no Node to compare");
    const otherNode: Snapshot = {
      ...before,
      runtimes: { ...before.runtimes, node: { ...node, sha256: "0".repeat(64) } },
    };
    expect(identityChanges(before, otherNode)).toEqual([expect.stringContaining("node runtime")]);
  });
});

describe.skipIf(NO_RELEASE_TOOLING)("scripts/evidence.ts", () => {
  /** This process's environment without any runtime override, so the controls start clean. */
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !isRuntimeOverride(name)),
  );
  const run = (args: string[], env: Record<string, string | undefined> = cleanEnv) =>
    spawnSync(process.execPath, [EVIDENCE, ...args], {
      cwd: scratch,
      encoding: "utf8",
      env,
      timeout: 30_000,
    });

  test("prints the snapshot and exits 0 on a clean checkout; --expect fails once it changed", () => {
    const root = fixture();
    const first = run(["--root", root]);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const printed = JSON.parse(first.stdout) as Snapshot;
    expect(printed.inputs).toEqual(inputIdentity(root));
    expect(printed.runtimes.available).toBe(true);

    const saved = join(root, "..", `snapshot-${fixtures}.json`);
    writeFileSync(saved, first.stdout);
    expect(run(["--root", root, "--expect", saved]).status).toBe(0);

    write(root, "src/a.ts", "export const a = 4;\n");
    const changed = run(["--root", root, "--expect", saved]);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("src/a.ts changed");
  });

  test("exits 1 with the reason when an input is untracked or a runtime cannot be found", () => {
    const root = fixture();
    write(root, "scripts/new.ts", "export {};\n");
    const untracked = run(["--root", root]);
    expect(untracked.status).toBe(1);
    expect(untracked.stderr).toContain("scripts/new.ts");
    rmSync(join(root, "scripts", "new.ts"));

    // A PATH holding git only: Node is not there to be found.
    const bin = join(scratch, "git-only-bin");
    mkdirSync(bin, { recursive: true });
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const noNode = run(["--root", root], { ...cleanEnv, PATH: bin });
    expect(noNode.status).toBe(1);
    const printed = JSON.parse(noNode.stdout) as Snapshot;
    expect(printed.inputs.clean).toBe(true);
    expect(printed.runtimes.available).toBe(false);
    expect(printed.runtimes.node).toBeNull();
    expect(noNode.stderr).toContain("node");
  });

  test("an inherited runtime override is refused by name, its value never printed", () => {
    const root = fixture();
    // Each would change how the measured runtimes run while their executables stay the same.
    const value = "--max-old-space-size=4099";
    const overrides: [string, string][] = [
      ["NODE_OPTIONS", value],
      ["NODE_PATH", value],
      ["BUN_OPTIONS", value],
      ["BUN_BE_BUN", value],
      // Bun writes this file: keep it in the scratch directory.
      ["BUN_BYTECODE_ORDER_OUT", join(scratch, `order-${value}`)],
      // A valid JSC value: Bun refuses to start on an invalid one, and prints it itself. A number
      // this long appears in no output by chance, so the check below can catch it.
      ["BUN_JSC_thresholdForJITAfterWarmUp", "2099040990"],
      ["JSC_thresholdForJITAfterWarmUp", "2099040990"],
    ];
    for (const [name, set] of overrides) {
      const overridden = run(["--root", root], { ...cleanEnv, [name]: set });
      expect(overridden.status).toBe(1);
      expect(overridden.stderr).toContain(name);
      const printed = JSON.parse(overridden.stdout) as Snapshot;
      // Refused before either runtime is started: neither ran under the override.
      expect(printed.runtimes).toMatchObject({ available: false, bun: null, node: null });
      // The value as set, and the marker inside the path in any form a path may be printed.
      expect(`${overridden.stdout}${overridden.stderr}`).not.toContain(set);
      expect(`${overridden.stdout}${overridden.stderr}`).not.toContain(value);
    }
    // Positive control: set but empty is no override.
    const empty = run(["--root", root], { ...cleanEnv, NODE_OPTIONS: "", BUN_OPTIONS: "" });
    expect(empty.stderr).toBe("");
    expect(empty.status).toBe(0);
    // Eight runs of scripts/evidence.ts.
  }, 60_000);
});
