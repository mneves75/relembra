import { afterAll, beforeAll, describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMANDS } from "../../src/cli/commands.js";
import {
  BINARY,
  cliTest,
  git,
  gitInit,
  hash16,
  ok,
  posixCliTest,
  refused,
  run,
  sandbox,
  scopeFor,
  USER,
} from "./support.js";

const box = sandbox();
beforeAll(() => {
  if (BINARY !== "") ok(box, ["init"]);
});
afterAll(() => box.remove());

const WINDOWS = process.platform === "win32";
/** A path as relembra writes it in a local origin's key: forward slashes on Windows too. */
const keyPath = (path: string) => (WINDOWS ? path.replaceAll("\\", "/") : path);
/** A raw, unencoded file URL for `path` (on Windows file:///C:/x), naming `host` if given. */
const rawFileUrl = (path: string, host = "") =>
  `file://${host}${WINDOWS ? `/${keyPath(path)}` : path}`;
const OTHER = "someone-else/other-repo";
const scopesIn = (env: Record<string, string> = {}, cwd = box.repo) =>
  new Set(
    ok(box, ["recall", "--limit", "1000"], { env, cwd }).memories.map(
      (m: { scope: string }) => m.scope,
    ),
  );

describe("scope comes from the git project and the OS user, or RELEMBRA_SCOPE, never from arguments", () => {
  cliTest(
    "no flag, positional or flag spelling changes the scope of any command",
    () => {
      // What an agent might try, on every command.
      const attempts = [
        ["--scope", OTHER],
        [`--scope=${OTHER}`],
        ["-s", OTHER],
        ["--project", OTHER],
        ["--home", "/tmp"],
        ["--RELEMBRA_SCOPE", OTHER],
      ];
      for (const { name } of COMMANDS) {
        for (const attempt of attempts) {
          const result = run(box, [name, ...attempt, "--json"], { input: "text" });
          // The session-start hook fails open: exit 0, and no wake from any scope.
          const expected = name === "hook" ? 0 : 2;
          expect({ name, attempt, status: result.status }).toEqual({
            name,
            attempt,
            status: expected,
          });
          if (name === "hook") expect(result.json).toEqual({ ok: true, data: null });
        }
      }
      // Text that looks like a scope is just text, stored in the environment's scope.
      for (const text of [`RELEMBRA_SCOPE=${OTHER}`, `--scope=${OTHER}`, OTHER]) {
        const memory = ok(box, ["note", "--", text]).memory;
        expect(memory.scope).toBe(box.scope);
      }
      expect(scopesIn()).toEqual(new Set([box.scope]));
      // Nothing reached the other scope.
      expect(scopesIn({ RELEMBRA_SCOPE: OTHER }).size).toBe(0);
      // The command table offers no such flag.
      for (const { flags } of COMMANDS) {
        for (const { name } of flags) expect(name).not.toMatch(/scope|home|project|user/);
      }
    },
    60_000,
  );

  cliTest("positive control: RELEMBRA_SCOPE, which the host sets, does change it", () => {
    const memory = ok(box, ["note", "set by the host"], { env: { RELEMBRA_SCOPE: OTHER } }).memory;
    expect(memory.scope).toBe(OTHER);
    expect(scopesIn({ RELEMBRA_SCOPE: OTHER })).toEqual(new Set([OTHER]));
    expect(ok(box, ["check"], { env: { RELEMBRA_SCOPE: OTHER } }).scope).toBe(OTHER);
  });

  cliTest("a subdirectory and a linked worktree share the project's scope", () => {
    const sub = join(box.repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(ok(box, ["check"], { cwd: sub }).scope).toBe(box.scope);
    git(box.repo, "commit", "-q", "--allow-empty", "-m", "first");
    const worktree = join(dirname(box.repo), "linked-worktree");
    git(box.repo, "worktree", "add", "-q", worktree);
    expect(ok(box, ["check"], { cwd: worktree }).scope).toBe(box.scope);
  });

  cliTest("positive control: another repository gets another scope", () => {
    const other = join(dirname(box.repo), "another-repo");
    gitInit(other);
    expect(ok(box, ["check"], { cwd: other }).scope).toBe(scopeFor(other));
    expect(ok(box, ["note", "elsewhere"], { cwd: other }).memory.scope).not.toBe(box.scope);
  });

  cliTest("two repositories with the same folder name get different scopes", () => {
    const a = join(dirname(box.repo), "a", "api");
    const b = join(dirname(box.repo), "b", "api");
    gitInit(a);
    gitInit(b);
    const scopeA = ok(box, ["check"], { cwd: a }).scope;
    const scopeB = ok(box, ["check"], { cwd: b }).scope;
    expect(scopeA).not.toBe(scopeB);
    // The folder name stays in the scope, for people reading it.
    expect(scopeA).toMatch(new RegExp(`^${USER}/api-[0-9a-f]{16}$`));
    expect(scopeB).toMatch(new RegExp(`^${USER}/api-[0-9a-f]{16}$`));
    // What one writes the other cannot read.
    ok(box, ["note", "only in a"], { cwd: a });
    expect(ok(box, ["recall"], { cwd: b }).memories).toEqual([]);
  });

  cliTest(
    "the origin remote is the project key: ssh and https forms of one repository match",
    () => {
      const forms = [
        "git@GitHub.com:owner/repo.git",
        "https://github.com/owner/repo",
        "https://someone@github.com/owner/repo.git/",
        "ssh://git@github.com:22/owner/repo.git",
      ];
      const scopes = forms.map((url, i) => {
        const repo = join(dirname(box.repo), `origin-${i}`, "repo");
        gitInit(repo);
        git(repo, "remote", "add", "origin", url);
        return ok(box, ["check"], { cwd: repo }).scope;
      });
      expect(new Set(scopes).size).toBe(1);
      expect(scopes[0]).toBe(`${USER}/repo-${hash16("origin:github.com/owner/repo")}`);
      // Positive control: another owner, or a path that differs in case, is another project.
      for (const url of ["git@github.com:other/repo.git", "https://github.com/Owner/repo"]) {
        const repo = join(
          dirname(box.repo),
          `control-${url.length}-${url.includes("other")}`,
          "repo",
        );
        gitInit(repo);
        git(repo, "remote", "add", "origin", url);
        expect(ok(box, ["check"], { cwd: repo }).scope).not.toBe(scopes[0]);
      }
    },
  );

  cliTest("with an origin, moving or renaming the folder keeps the scope's key", () => {
    const repo = join(dirname(box.repo), "movable", "proj");
    gitInit(repo);
    git(repo, "remote", "add", "origin", "https://example.invalid/team/proj.git");
    const before = ok(box, ["check"], { cwd: repo }).scope;
    const id = ok(box, ["note", "survives a move"], { cwd: repo }).memory.id;
    const moved = join(dirname(box.repo), "moved", "proj");
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(repo, moved);
    expect(ok(box, ["check"], { cwd: moved }).scope).toBe(before);
    // Renamed too: the readable part is the origin's repository name, not the folder's.
    const renamed = join(dirname(box.repo), "moved", "a-new-folder-name");
    renameSync(moved, renamed);
    expect(ok(box, ["check"], { cwd: renamed }).scope).toBe(before);
    expect(before).toMatch(new RegExp(`^${USER}/proj-[0-9a-f]{16}$`));
    expect(ok(box, ["zoom", id], { cwd: renamed }).memory.id).toBe(id);
    // Without an origin the key is the git directory's path, so a move changes it (documented).
    const plain = join(dirname(box.repo), "plain", "proj");
    gitInit(plain);
    const plainBefore = ok(box, ["check"], { cwd: plain }).scope;
    const plainMoved = join(dirname(box.repo), "plain-moved", "proj");
    mkdirSync(dirname(plainMoved), { recursive: true });
    renameSync(plain, plainMoved);
    expect(ok(box, ["check"], { cwd: plainMoved }).scope).not.toBe(plainBefore);
  });

  cliTest("outside a git repository with no RELEMBRA_SCOPE there is no scope", () => {
    const outside = dirname(box.repo);
    refused(box, ["note", "homeless"], 2, "no-scope", { cwd: outside });
    refused(box, ["wake"], 2, "no-scope", { cwd: outside });
    // A session-start hook must not break a session: it prints nothing and exits 0.
    const hook = run(box, ["hook"], { cwd: outside });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe("");
    // Positive control: the host's variable gives it one.
    expect(ok(box, ["wake"], { cwd: outside, env: { RELEMBRA_SCOPE: OTHER } }).text).toContain(
      "<wake>",
    );
  });

  cliTest(
    "the OS user part is the uid: USER, set, changed or unset, does not move the scope",
    () => {
      // USERNAME is Windows' variable; there the user part is the SID, never read from it.
      for (const env of [
        { USER: "alice" },
        { USER: "" },
        { USER: undefined, LOGNAME: "bob" },
        { USERNAME: "carol" },
      ]) {
        expect(ok(box, ["check"], { env }).scope).toBe(box.scope);
      }
      expect(box.scope.startsWith(`${USER}/`)).toBe(true);
    },
  );

  cliTest(
    "Bun runtime options from the environment are refused: BUN_OPTIONS could move the cwd",
    () => {
      const target = join(dirname(box.repo), "bun-options-target");
      gitInit(target);
      // Bun's option parser reads a backslash as an escape, so a Windows path goes with slashes.
      const other = keyPath(target);
      // Sol's repro: --cwd through BUN_OPTIONS answered with the other repository's scope.
      refused(box, ["check"], 2, "unsafe-runtime-env", { env: { BUN_OPTIONS: `--cwd ${other}` } });
      refused(box, ["note", "x"], 2, "unsafe-runtime-env", { env: { BUN_OPTIONS: "--smol" } });
      refused(box, ["check"], 2, "unsafe-runtime-env", {
        env: { BUN_BYTECODE_ORDER_OUT: join(box.home, "order") },
      });
      // The hook fails open, with no wake from either scope.
      const hook = run(box, ["hook"], { env: { BUN_OPTIONS: `--cwd ${other}` } });
      expect(hook.status).toBe(0);
      expect(hook.stdout).toBe("");
      // Positive control: an empty BUN_OPTIONS counts as unset.
      expect(ok(box, ["check"], { env: { BUN_OPTIONS: "" } }).scope).toBe(box.scope);
    },
  );

  cliTest(
    "GIT_DIR, GIT_WORK_TREE and GIT_CONFIG_* in the environment do not move the scope",
    () => {
      const other = join(dirname(box.repo), "git-env-target");
      gitInit(other);
      const env = {
        GIT_DIR: join(other, ".git"),
        GIT_WORK_TREE: other,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.url",
        GIT_CONFIG_VALUE_0: "https://example.invalid/x/y.git",
      };
      expect(ok(box, ["check"], { env }).scope).toBe(box.scope);
      // Positive control: run from the other repository, its scope is another.
      expect(ok(box, ["check"], { cwd: other }).scope).not.toBe(box.scope);
    },
  );

  cliTest("git's own parsing of the origin: quoting, comments and insteadOf", () => {
    const base = join(dirname(box.repo), "quoting");
    const scopeWith = (dir: string, line: string) => {
      gitInit(dir);
      const config = join(dir, ".git", "config");
      writeFileSync(config, `${readFileSync(config, "utf8")}[remote "origin"]\n\t${line}\n`);
      return ok(box, ["check"], { cwd: dir }).scope as string;
    };
    // Sol's repro: these are two URLs to git, and they collided.
    const one = scopeWith(join(base, "q1", "team"), 'url = "https://example.invalid/team/"one.git');
    const two = scopeWith(join(base, "q2", "team"), 'url = "https://example.invalid/team/"two.git');
    expect(one).not.toBe(two);
    expect(one).toBe(`${USER}/one-${hash16("origin:example.invalid/team/one")}`);
    // An unquoted comment is not part of the URL.
    const commented = scopeWith(
      join(base, "c1", "plain"),
      "url = https://example.invalid/team/plain.git # a comment",
    );
    const bare = scopeWith(
      join(base, "c2", "plain"),
      "url = https://example.invalid/team/plain.git",
    );
    expect(commented).toBe(bare);
    // The user's insteadOf rewrite applies, as it does to every git command.
    writeFileSync(
      join(box.home, ".gitconfig"),
      '[url "https://mirror.invalid/"]\n\tinsteadOf = corp:\n',
    );
    try {
      const rewritten = scopeWith(join(base, "i1", "tool"), "url = corp:team/tool.git");
      expect(rewritten).toBe(`${USER}/tool-${hash16("origin:mirror.invalid/team/tool")}`);
    } finally {
      rmSync(join(box.home, ".gitconfig"));
    }
  });

  cliTest(
    "a relative or local origin resolves to a real path: two ../upstream.git are two projects",
    () => {
      const base = join(dirname(box.repo), "relative");
      const scopes = ["x", "y"].map((side) => {
        gitInit(join(base, side, "upstream.git"), "--bare");
        const repo = join(base, side, "repo");
        gitInit(repo);
        git(repo, "remote", "add", "origin", "../upstream.git");
        return ok(box, ["check"], { cwd: repo }).scope as string;
      });
      expect(scopes[0]).not.toBe(scopes[1]);
      // The same upstream by its absolute path is the same project.
      const absolute = join(base, "z", "repo");
      gitInit(absolute);
      git(absolute, "remote", "add", "origin", realpathSync(join(base, "x", "upstream.git")));
      expect(ok(box, ["check"], { cwd: absolute }).scope).toBe(scopes[0]);
    },
  );

  cliTest("non-default ports are kept; a scheme's default port is dropped", () => {
    const base = join(dirname(box.repo), "ports");
    const scopeOf = (name: string, url: string) => {
      const repo = join(base, name, "svc");
      gitInit(repo);
      git(repo, "remote", "add", "origin", url);
      return ok(box, ["check"], { cwd: repo }).scope as string;
    };
    const a = scopeOf("a", "https://example.invalid:8001/team/svc.git");
    const b = scopeOf("b", "https://example.invalid:8002/team/svc.git");
    expect(a).not.toBe(b);
    expect(a).toBe(`${USER}/svc-${hash16("origin:example.invalid:8001/team/svc")}`);
    expect(scopeOf("c", "https://example.invalid:443/team/svc.git")).toBe(
      scopeOf("d", "https://example.invalid/team/svc"),
    );
  });

  cliTest("a separate git dir and its worktrees share one scope; a bare repository has one", () => {
    const base = join(dirname(box.repo), "separate");
    const shared = join(base, "sharedgit");
    const main = join(base, "separate-main");
    gitInit(main, "--separate-git-dir", shared);
    git(main, "commit", "-q", "--allow-empty", "-m", "first");
    const linked = join(base, "separate-linked");
    git(main, "worktree", "add", "-q", linked);
    const expected = `${USER}/sharedgit-${hash16(`gitdir:${realpathSync(shared)}`)}`;
    expect(ok(box, ["check"], { cwd: main }).scope).toBe(expected);
    expect(ok(box, ["check"], { cwd: linked }).scope).toBe(expected);
    const bareRepo = join(base, "proj.git");
    gitInit(bareRepo, "--bare");
    expect(ok(box, ["check"], { cwd: bareRepo }).scope).toBe(
      `${USER}/proj-${hash16(`gitdir:${realpathSync(bareRepo)}`)}`,
    );
  });

  cliTest("without git on PATH there is no scope, and the hook stays quiet", () => {
    refused(box, ["wake"], 2, "no-scope", { env: { PATH: "/nonexistent" } });
    const hook = run(box, ["hook"], { env: { PATH: "/nonexistent" } });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe("");
    // Positive control: RELEMBRA_SCOPE needs no git.
    expect(
      ok(box, ["wake"], { env: { PATH: "/nonexistent", RELEMBRA_SCOPE: OTHER } }).text,
    ).toContain("<wake>");
  });

  posixCliTest(
    "a relative, empty or in-repository PATH entry never runs a repository's own git",
    () => {
      const repo = join(dirname(box.repo), "path-repo");
      gitInit(repo);
      const realGit = Bun.which("git") as string;
      const marker = join(box.home, "fake-git-ran");
      const fake = `#!/bin/sh\necho ran >> '${marker}'\nexec '${realGit}' "$@"\n`;
      for (const dir of [repo, join(repo, "bin")]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "git"), fake);
        chmodSync(join(dir, "git"), 0o755);
      }
      const hostPath = `${dirname(realGit)}:/usr/bin:/bin`;
      // Sol's repro: PATH=.:… ran ./git from the repository, twice per call.
      for (const path of [
        `.:${hostPath}`,
        `:${hostPath}`,
        `bin:${hostPath}`,
        `${join(repo, "bin")}:${hostPath}`,
      ]) {
        expect({
          path,
          scope: ok(box, ["check"], { cwd: repo, env: { PATH: path } }).scope,
        }).toEqual({
          path,
          scope: scopeFor(repo),
        });
        run(box, ["hook"], { cwd: repo, env: { PATH: path } });
      }
      expect(existsSync(marker)).toBe(false);
      // Positive control: the fake git does run, and leaves its mark, when invoked.
      spawnSync(join(repo, "git"), ["--version"]);
      expect(readFileSync(marker, "utf8")).toBe("ran\n");
    },
  );

  posixCliTest("a git on an outside PATH entry that links into the repository never runs", () => {
    const repo = join(dirname(box.repo), "symlink-repo");
    gitInit(repo);
    const realGit = Bun.which("git") as string;
    const marker = join(box.home, "linked-git-ran");
    mkdirSync(join(repo, "bin"), { recursive: true });
    writeFileSync(
      join(repo, "bin", "git"),
      `#!/bin/sh\necho ran >> '${marker}'\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(join(repo, "bin", "git"), 0o755);
    const outside = join(box.home, "linkbin");
    mkdirSync(outside, { recursive: true });
    symlinkSync(join(repo, "bin", "git"), join(outside, "git"));
    const path = `${outside}:${dirname(realGit)}:/usr/bin:/bin`;
    // Sol's repro: the entry is outside the repository, the executable it names is not.
    expect(ok(box, ["check"], { cwd: repo, env: { PATH: path } }).scope).toBe(scopeFor(repo));
    run(box, ["hook"], { cwd: repo, env: { PATH: path } });
    expect(existsSync(marker)).toBe(false);
    // Positive control: the link does run the repository's git when invoked.
    spawnSync(join(outside, "git"), ["--version"]);
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
  });

  posixCliTest(
    "an origin is git's output less its newline: a trailing space is significant",
    () => {
      const base = join(dirname(box.repo), "spaced-origin");
      const plain = join(base, "upstream");
      const spaced = join(base, "upstream ");
      gitInit(plain, "--bare");
      gitInit(spaced, "--bare");
      const clone = (name: string, origin: string) => {
        const dir = join(base, name);
        gitInit(dir);
        git(dir, "remote", "add", "origin", origin);
        return ok(box, ["check"], { cwd: dir }).scope;
      };
      // Sol's repro: trimming made both origins `file:<base>/upstream`, one scope.
      const toPlain = clone("to-plain", plain);
      expect(clone("to-spaced", spaced)).not.toBe(toPlain);
      // Positive control: another clone of the same origin shares the scope.
      expect(clone("to-plain-again", plain)).toBe(toPlain);
      // Sol's round-4 repro: the same two as raw file URLs; URL parsing dropped the trailing space.
      const byUrl = clone("url-to-plain", `file://${plain}`);
      expect(clone("url-to-spaced", `file://${spaced}`)).not.toBe(byUrl);
      // Positive controls: a file URL is its path, and so is its percent-encoded form.
      expect(byUrl).toBe(toPlain);
      expect(clone("encoded-to-spaced", pathToFileURL(spaced).href)).toBe(
        clone("to-spaced-2", spaced),
      );
    },
  );

  posixCliTest("a path git prints with a newline is refused, never cut at the newline", () => {
    const base = join(dirname(box.repo), "newlines");
    const one = join(base, "newline\none");
    const two = join(base, "newline\ntwo");
    gitInit(one);
    gitInit(two);
    // Sol's repro: both scopes were cut at the newline and collided.
    for (const repo of [one, two]) {
      const result = refused(box, ["note", "x"], 2, "no-scope", { cwd: repo });
      expect(result.json?.ok === false && result.json.error.rule).toBe("unsupported-path");
    }
    // Positive control: a space, and a trailing one, are kept whole.
    const spaced = join(base, "with space ");
    gitInit(spaced);
    expect(ok(box, ["check"], { cwd: spaced }).scope).toBe(scopeFor(spaced));
  });

  cliTest("a relative origin resolves against the working tree, as git resolves it", () => {
    const base = join(dirname(box.repo), "separate-relative");
    const checkout = join(base, "checkouts", "separate");
    mkdirSync(join(base, "metadata"), { recursive: true });
    gitInit(checkout, "--separate-git-dir", join(base, "metadata", "sharedgit"));
    git(checkout, "remote", "add", "origin", "../up.git");
    const ordinary = join(base, "metadata", "ordinary");
    gitInit(ordinary);
    git(ordinary, "remote", "add", "origin", "../up.git");
    // Sol's repro: the separate checkout resolved ../up.git from its git directory and collided.
    const separate = ok(box, ["check"], { cwd: checkout }).scope;
    expect(separate).not.toBe(ok(box, ["check"], { cwd: ordinary }).scope);
    expect(separate).toBe(
      `${USER}/up-${hash16(`origin:file:${keyPath(join(base, "checkouts", "up.git"))}`)}`,
    );
  });

  cliTest(
    "a file:// origin is decoded: the same upstream by path or by encoded URL is one project",
    () => {
      const base = join(dirname(box.repo), "encoded");
      const upstream = join(base, "encoded upstream.git");
      gitInit(upstream, "--bare");
      const byPath = join(base, "by-path");
      gitInit(byPath);
      git(byPath, "remote", "add", "origin", upstream);
      const byUrl = join(base, "by-url");
      gitInit(byUrl);
      git(byUrl, "remote", "add", "origin", pathToFileURL(upstream).href);
      expect(pathToFileURL(upstream).href).toContain("%20");
      expect(ok(box, ["check"], { cwd: byUrl }).scope).toBe(
        ok(box, ["check"], { cwd: byPath }).scope,
      );
    },
  );

  cliTest("a file URL naming no local path, or a control character, gives no scope", () => {
    const base = join(dirname(box.repo), "file-url-refusals");
    const upstream = join(base, "up.git");
    gitInit(upstream, "--bare");
    const scopeOf = (name: string, origin: string) => {
      const dir = join(base, name);
      gitInit(dir);
      git(dir, "remote", "add", "origin", origin);
      return run(box, ["check", "--json"], { cwd: dir }).json;
    };
    const rule = (doc: ReturnType<typeof scopeOf>) =>
      doc?.ok === false ? `${doc.error.code}/${doc.error.rule}` : "ok";
    expect(rule(scopeOf("other-host", rawFileUrl(upstream, "elsewhere")))).toBe(
      "no-scope/unsupported-origin",
    );
    expect(rule(scopeOf("encoded-slash", `${rawFileUrl(base)}%2Fup.git`))).toBe(
      "no-scope/unsupported-origin",
    );
    expect(rule(scopeOf("bad-escape", `${rawFileUrl(base)}/up%ZZ.git`))).toBe(
      "no-scope/unsupported-origin",
    );
    expect(rule(scopeOf("control", `${rawFileUrl(base)}/up%0A.git`))).toBe(
      "no-scope/unsupported-path",
    );
    // Positive control: a localhost host is this machine, the same project as the bare path.
    const local = scopeOf("localhost", rawFileUrl(upstream, "localhost"));
    const byPath = scopeOf("by-path", upstream);
    expect(rule(local)).toBe("ok");
    expect(local?.ok === true && local.data.scope).toBe(byPath?.ok === true && byPath.data.scope);
  });

  cliTest("an invalid RELEMBRA_SCOPE is a usage error", () => {
    refused(box, ["wake"], 2, "bad-scope", { env: { RELEMBRA_SCOPE: "x".repeat(257) } });
    refused(box, ["wake"], 2, "bad-scope", { env: { RELEMBRA_SCOPE: "a\nb" } });
  });

  cliTest("RELEMBRA_SCOPE holds at most 256 UTF-8 bytes, counted in bytes, not characters", () => {
    for (const fits of ["x".repeat(256), "é".repeat(128)]) {
      expect(ok(box, ["check"], { env: { RELEMBRA_SCOPE: fits } }).scope).toBe(fits);
    }
    // 129 two-byte characters: under the limit in UTF-16 code units, over it in UTF-8 bytes.
    for (const over of ["x".repeat(257), "é".repeat(129)]) {
      const result = refused(box, ["check"], 2, "bad-scope", { env: { RELEMBRA_SCOPE: over } });
      expect(result.json?.ok === false && result.json.error.rule).toBe("too-long");
    }
  });

  cliTest("a .env or bunfig.toml in the project cannot set the scope, the home or run code", () => {
    const marker = join(box.home, "preloaded");
    writeFileSync(
      join(box.repo, ".env"),
      `RELEMBRA_SCOPE=${OTHER}\nRELEMBRA_HOME=${join(box.home, "elsewhere")}\n`,
    );
    writeFileSync(
      join(box.repo, "evil.ts"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    writeFileSync(join(box.repo, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
    const data = ok(box, ["check"]);
    expect(data.scope).toBe(box.scope);
    expect(data.store).toBe(box.store);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(box.home, "elsewhere"))).toBe(false);
  });
});
