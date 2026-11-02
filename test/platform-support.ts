import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

/**
 * Whether a child that ends itself with `process.kill(process.pid, "SIGKILL")` died that way.
 * POSIX reports the signal. Windows has none: Node's SIGKILL is TerminateProcess with exit code 1,
 * so the parent sees status 1 and no signal, and the child wrote no stderr (an uncaught error
 * would also exit 1, with its stack on stderr).
 */
export function selfKilled(child: {
  status: number | null;
  signal: string | null;
  stderr: string;
}): boolean {
  if (process.platform !== "win32") return child.signal === "SIGKILL";
  return child.signal === null && child.status === 1 && child.stderr === "";
}

/**
 * True on Windows, where the release tooling does not run: the gate and its evidence
 * (scripts/ci.sh, scripts/evidence.ts), the benchmarks, the package smoke test, install.sh, the
 * site assembly and the eval harness's process-group kill are bash and POSIX tools that the Mac,
 * ci.yml's Linux jobs, release.yml and pages.yml run (docs/CLI.md#windows). Their tests skip
 * there; the library and CLI tests do not.
 */
export const NO_RELEASE_TOOLING = process.platform === "win32";

/**
 * Runs a Windows System32 tool and returns its stdout, throwing on failure. Independent of
 * src/sqlite/database.ts, which it checks: SystemRoot when set to a drive path, else C:\Windows.
 */
export function windowsTool(exe: string, args: string[]): string {
  const root = process.env["SystemRoot"];
  const system32 = win32.join(
    root !== undefined && /^[A-Za-z]:\\/.test(root) ? root : "C:\\Windows",
    "System32",
  );
  const run = spawnSync(win32.join(system32, exe), args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`${exe}: ${run.stderr || run.stdout}`);
  return run.stdout;
}

/** The logon account's SID, as whoami prints it on Windows; "" elsewhere. */
export function windowsSid(): string {
  if (process.platform !== "win32") return "";
  const printed = windowsTool("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  return /"(S-1-[0-9-]+)"\s*$/.exec(printed)?.[1] ?? "";
}
