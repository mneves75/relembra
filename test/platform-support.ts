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
