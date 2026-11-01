import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./support.js";

/** `bun test` on one CLI file with no binary to find, in the given environment. */
function suiteWithoutBinary(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "CI" && key !== "RELEMBRA_REQUIRE_BINARY") env[key] = value;
  }
  return spawnSync(process.execPath, ["test", join(ROOT, "test", "cli", "commands.test.ts")], {
    cwd: ROOT,
    env: { ...env, RELEMBRA_BINARY: "/nonexistent/relembra", ...extra },
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("CI cannot pass the CLI suite without the binary", () => {
  test("with CI set, a missing binary fails the run (Sol's repro: 13 pass, 46 skip, exit 0)", () => {
    const result = suiteWithoutBinary({ CI: "1" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("there is no CLI binary to test");
  }, 120_000);

  test("positive control: locally, without CI, the same run skips loudly and passes", () => {
    const result = suiteWithoutBinary({});
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("relembra CLI suite SKIPPED");
  }, 120_000);
});
