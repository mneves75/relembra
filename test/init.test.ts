/**
 * scripts/init.sh --check reports the tools a contributor's machine needs for AGENTS.md's checks,
 * refusing an old or missing required tool and only noting an absent optional one. The tools are
 * fakes first on PATH here, so the result depends on nothing installed on this machine.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

const script = join(import.meta.dir, "..", "scripts", "init.sh");
// Each test spawns the script and its fake tools; a loaded runner needs more than 5 s.
setDefaultTimeout(60_000);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DEFAULT_TOOLS: Record<string, string> = {
  git: "git version 2.53.0",
  bun: "1.4.4",
  node: "v26.12.1",
  gh: "gh version 2.103.3 (2026-10-26)",
  gitleaks: "8.30.0",
  zizmor: "zizmor 1.31.1",
  docker: "Docker version 29.3.0, build abc1234",
  shellcheck: "ShellCheck - shell script analysis tool\nversion: 0.11.0",
};

/** A PATH holding only the given fakes, each printing its version line. */
function tools(overrides: Record<string, string | null> = {}): string {
  const bin = mkdtempSync(join(tmpdir(), "relembra-init-"));
  dirs.push(bin);
  for (const [name, output] of Object.entries({ ...DEFAULT_TOOLS, ...overrides })) {
    if (output === null) continue;
    // %b expands the \n of a two-line version banner (shellcheck's).
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%b\\n' '${output.replaceAll("\n", "\\n")}'\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  // The script itself needs sh and the POSIX tools; a second entry keeps those reachable.
  mkdirSync(join(bin, "sys"));
  for (const tool of ["sh", "awk", "sed", "head", "cut", "tr", "basename", "dirname", "uname"]) {
    const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(bin, "sys", tool), `#!/bin/sh\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "sys", tool), 0o755);
  }
  return `${bin}:${join(bin, "sys")}`;
}

function check(path: string) {
  return spawnSync("sh", [script, "--check"], {
    encoding: "utf8",
    env: { HOME: process.env["HOME"] ?? "/", PATH: path },
  });
}

describe.skipIf(NO_RELEASE_TOOLING)("scripts/init.sh --check", () => {
  test("every tool present and recent: reports each and exits 0 (positive control)", () => {
    const run = check(tools());
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("git: git version 2.53.0");
    expect(run.stdout).toContain("bun: 1.4.4 (>= 1.4)");
    expect(run.stdout).toContain("node: v26.12.1 (>= 24.14)");
    expect(run.stdout).toContain("gh: gh version 2.103.3");
    expect(run.stdout).toContain("gitleaks: 8.30.0");
    expect(run.stdout).toContain("zizmor: zizmor 1.31.1");
    expect(run.stdout).toContain("docker: Docker version 29.3.0");
    expect(run.stdout).toContain("shellcheck: version: 0.11.0");
    expect(run.stdout).toContain("ready: run scripts/init.sh without --check to install and build");
  });

  test("an old Node is refused by name and version", () => {
    const run = check(tools({ node: "v22.14.0" }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("node v22.14.0 is older than 24.14 (AGENTS.md)");
  });

  test("Node 24.14 itself is recent enough; 24.13 is not", () => {
    expect(check(tools({ node: "v24.14.0" })).status).toBe(0);
    const old = check(tools({ node: "v24.13.9" }));
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("node v24.13.9 is older than 24.14");
  });

  test("an old Bun is refused", () => {
    const run = check(tools({ bun: "1.3.9" }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("bun 1.3.9 is older than 1.4 (AGENTS.md)");
  });

  test("a missing required tool is refused, and every problem is listed at once", () => {
    const run = check(tools({ bun: null, gitleaks: null, node: "v20.0.0" }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("bun is not installed (https://bun.sh)");
    expect(run.stderr).toContain(
      "gitleaks is not installed (the pre-push hook and scripts/ci.sh run it)",
    );
    expect(run.stderr).toContain("node v20.0.0 is older than 24.14");
  });

  test("zizmor may be replaced by uvx, as scripts/ci.sh allows", () => {
    const without = check(tools({ zizmor: null }));
    expect(without.status).toBe(1);
    expect(without.stderr).toContain("neither zizmor nor uvx is installed");
    const uvx = check(tools({ zizmor: null, uvx: "uvx 0.9.0" }));
    expect(uvx.status).toBe(0);
    expect(uvx.stdout).toContain("zizmor: uvx 0.9.0 (uvx zizmor@1.31.1 in scripts/ci.sh)");
  });

  test("docker, gh and shellcheck are optional: their absence is noted, not refused", () => {
    const run = check(tools({ docker: null, gh: null, shellcheck: null }));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "docker: not installed; the Postgres tests need it (scripts/with-postgres.sh)",
    );
    expect(run.stdout).toContain("gh: not installed; releases need it (scripts/deploy.sh)");
    expect(run.stdout).toContain("shellcheck: not installed; lints the shell scripts");
  });

  test("usage", () => {
    const run = spawnSync("sh", [script, "--wat"], { encoding: "utf8", env: { PATH: tools() } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage: scripts/init.sh [--check]");
  });
});
