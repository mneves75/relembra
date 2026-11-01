import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Runs the Postgres conformance file in a child, with no Postgres configured plus `extra`. */
function withoutPostgres(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("RELEMBRA_")) env[key] = value;
  }
  return spawnSync(process.execPath, ["test", join(ROOT, "test", "postgres.test.ts")], {
    cwd: ROOT,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("the Postgres tests cannot pass without a Postgres", () => {
  test("with no RELEMBRA_POSTGRES_URL, the Postgres tests fail and say how to run them", () => {
    const result = withoutPostgres({});
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("scripts/with-postgres.sh");
  });

  test("RELEMBRA_SKIP_POSTGRES=1 skips them, and only that", () => {
    const result = withoutPostgres({ RELEMBRA_SKIP_POSTGRES: "1" });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toMatch(/[1-9]\d* skip/);
    expect(output).toMatch(/\b0 fail/);
  });
});
