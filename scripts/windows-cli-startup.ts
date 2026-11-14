/**
 * A bounded startup probe of the candidate binary. When it fails, the released v1.0.0-beta.3 binary
 * runs as a control, to tell an AOT regression apart from the Windows runner or host.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") throw new Error("this diagnostic requires Windows");

function probe(label: string, executable: string, args: string[]): boolean {
  const began = performance.now();
  const child = spawnSync(executable, args, { encoding: "utf8", timeout: 10_000 });
  console.log(
    JSON.stringify({
      label,
      elapsedMs: Math.round(performance.now() - began),
      status: child.status,
      signal: child.signal,
      error: child.error?.message,
      stdout: child.stdout?.slice(0, 300),
      stderr: child.stderr?.slice(0, 300),
    }),
  );
  return child.status === 0 && child.error === undefined;
}

console.log(
  JSON.stringify({ runtime: process.version, platform: process.platform, arch: process.arch }),
);
const candidate = probe("candidate-help", join(process.cwd(), "bin", "relembra.exe"), ["--help"]);
if (!candidate) {
  const work = mkdtempSync(join(tmpdir(), "relembra-startup-control-"));
  try {
    const name =
      process.arch === "arm64" ? "relembra-windows-arm64.exe" : "relembra-windows-x64.exe";
    const base = "https://github.com/mneves75/relembra/releases/download/v1.0.0-beta.3/";
    const sumsResponse = await fetch(`${base}SHA256SUMS`, { signal: AbortSignal.timeout(30_000) });
    if (!sumsResponse.ok) throw new Error(`baseline checksum HTTP ${sumsResponse.status}`);
    const sums = await sumsResponse.text();
    const expected = sums
      .split(/\r?\n/)
      .find((line) => line.endsWith(`  ${name}`))
      ?.split(/\s+/)[0];
    const response = await fetch(`${base}${name}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`baseline binary HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (expected !== digest) throw new Error("baseline release checksum mismatch");
    const executable = join(work, name);
    writeFileSync(executable, bytes);
    console.log(JSON.stringify({ baseline: "v1.0.0-beta.3", name, sha256: digest }));
    probe("released-control-help", executable, ["--help"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.exitCode = 1;
}
