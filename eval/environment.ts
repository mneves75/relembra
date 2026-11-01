/**
 * What a recorded result must name besides its numbers: the relembra commit, the machine and the
 * runtime versions. Shared by `bun run eval` and the latency benchmark.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { arch, availableParallelism, cpus, loadavg, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ROOT = join(import.meta.dirname, "..");

export interface Environment {
  readonly relembra: {
    readonly version: string;
    readonly commit: string;
    /** Whether the worktree had uncommitted changes when the run started. */
    readonly dirty: boolean;
  };
  readonly machine: {
    readonly cpu: string;
    readonly cores: number;
    readonly memoryBytes: number;
    readonly os: string;
  };
  readonly runtimes: {
    readonly bun: string;
    readonly node: string;
    /** The SQLite inside this process's node:sqlite (Bun's, under `bun`). */
    readonly sqlite: string;
    /** The SQLite inside Node's node:sqlite. */
    readonly nodeSqlite: string;
  };
}

function run(command: string, args: readonly string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: ROOT });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function cpuName(): string {
  const brand = platform() === "darwin" ? run("sysctl", ["-n", "machdep.cpu.brand_string"]) : "";
  return brand || cpus()[0]?.model || "unknown";
}

function osName(): string {
  if (platform() === "darwin") {
    const name = run("sw_vers", ["-productName"]);
    const version = run("sw_vers", ["-productVersion"]);
    if (name && version) return `${name} ${version} (${arch()})`;
  }
  return `${platform()} ${release()} (${arch()})`;
}

export function environment(): Environment {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"]);
  const sqlite = new DatabaseSync(":memory:");
  try {
    return {
      relembra: {
        version: pkg.version,
        commit: run("git", ["rev-parse", "HEAD"]) ?? "unknown",
        dirty: status === undefined || status !== "",
      },
      machine: {
        cpu: cpuName(),
        cores: availableParallelism(),
        memoryBytes: totalmem(),
        os: osName(),
      },
      runtimes: {
        bun: typeof Bun === "undefined" ? "not running" : `${Bun.version} (${Bun.revision})`,
        node: run("node", ["--version"]) ?? "unavailable",
        sqlite: (sqlite.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v,
        nodeSqlite:
          run("node", [
            "-e",
            "const { DatabaseSync } = require('node:sqlite'); console.log(new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS v').get().v)",
          ]) ?? "unavailable",
      },
    };
  } finally {
    sqlite.close();
  }
}

/** The 1-, 5- and 15-minute load averages, and `uptime`'s own line. */
export function load(): { readonly averages: readonly number[]; readonly uptime: string } {
  return {
    averages: loadavg().map((n) => Math.round(n * 100) / 100),
    uptime: run("uptime", []) ?? "",
  };
}

/**
 * SHA-256 over a set's files in name order, each as `name NUL bytes NUL` (eval/README.md, the
 * corpus digest).
 */
export function setDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).sort()) {
    hash
      .update(name)
      .update("\0")
      .update(readFileSync(join(dir, name)))
      .update("\0");
  }
  return hash.digest("hex");
}

/** Today's local date as YYYY-MM-DD, the suffix of a results file. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
