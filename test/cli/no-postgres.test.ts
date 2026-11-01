import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ENV_VARS, usageText } from "../../src/cli/commands.js";
import { BINARY, cliTest, ok, ROOT, refused, type Sandbox, sandbox } from "./support.js";

/**
 * Ticket 14, box 3: the shipped CLI stays SQLite-only. No flag, environment variable or
 * configuration reaches the Postgres store; sharing through Postgres is for hosts that build
 * their own SqlClient (examples/shared-postgres). A Postgres CLI configuration would be a ticket
 * of its own.
 */

const SPECIFIER =
  /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;

/** Every source file `entry` reaches through relative imports, and every bare specifier. */
function importGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? "";
      if (!spec.startsWith(".")) {
        bare.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (!existsSync(target)) throw new Error(`${file} imports ${spec}, which does not resolve`);
      visit(target);
    }
  };
  visit(resolve(ROOT, entry));
  return { files, bare };
}

/** What in a graph would give its program a Postgres path. */
function postgresReach(entry: string): string[] {
  const { files, bare } = importGraph(entry);
  const postgresDir = join(ROOT, "src", "postgres");
  return [
    ...[...files]
      .filter((file) => file.startsWith(`${postgresDir}/`))
      .map((file) => `imports ${relative(ROOT, file)}`),
    ...[...bare]
      .filter((spec) => spec === "bun" || /postgres/i.test(spec))
      .map((s) => `imports ${s}`),
    ...[...files]
      .filter((file) => /\bBun\.SQL\b|\bnew SQL\(/.test(readFileSync(file, "utf8")))
      .map((file) => `opens SQL in ${relative(ROOT, file)}`),
  ];
}

const POSTGRES_NAME = /postgres|database_url|^PG/i;

describe("the CLI has no Postgres path", () => {
  test("nothing the CLI entry point reaches imports the Postgres store or a SQL driver", () => {
    expect(postgresReach("src/cli/main.ts")).toEqual([]);
    // Positive controls: the walk reaches the SQLite store, and flags a module that does import
    // the Postgres store and Bun's SQL.
    expect(importGraph("src/cli/main.ts").files).toContain(join(ROOT, "src", "sqlite", "index.ts"));
    expect(postgresReach("test/postgres-support.ts")).toEqual(
      expect.arrayContaining(["imports bun", "imports relembra/postgres"]),
    );
    expect(postgresReach("examples/shared-postgres/host.ts")).toEqual(
      expect.arrayContaining(["imports bun", "imports relembra/postgres"]),
    );
  });

  test("the CLI reads no Postgres environment variable and documents no Postgres option", () => {
    expect(ENV_VARS.filter((name) => POSTGRES_NAME.test(name))).toEqual([]);
    expect(usageText()).not.toMatch(/postgres/i);
    // Positive control: the pattern catches the names a Postgres path would read.
    for (const name of ["RELEMBRA_POSTGRES_URL", "DATABASE_URL", "PGHOST"]) {
      expect(name).toMatch(POSTGRES_NAME);
    }
  });

  cliTest("the binary carries the SQLite store and not the Postgres store", () => {
    const binary = readFileSync(BINARY);
    // Positive controls: literals from the CLI and from the SQLite store are in the binary.
    expect(binary.includes("no store at")).toBe(true);
    expect(binary.includes("this SQLite cannot turn on secure_delete")).toBe(true);
    // Literals only the Postgres store holds (src/postgres) are not.
    expect(binary.includes("store_lock")).toBe(false);
    expect(binary.includes("the store lost the connection during COMMIT")).toBe(false);
  });
});

describe("Postgres settings do not move the CLI off SQLite", () => {
  let box: Sandbox;
  afterEach(() => box.remove());

  // A closed port: a CLI that tried to reach Postgres through any of these would fail.
  const postgresEnv = {
    RELEMBRA_POSTGRES_URL: "postgres://relembra:relembra-test@127.0.0.1:1/relembra",
    DATABASE_URL: "postgres://relembra:relembra-test@127.0.0.1:1/relembra",
    PGHOST: "127.0.0.1",
    PGPORT: "1",
    RELEMBRA_STORE: "postgres",
  };

  cliTest("with Postgres variables set, init, note and find use the SQLite file", () => {
    box = sandbox();
    ok(box, ["init"], { env: postgresEnv });
    ok(box, ["note", "the shared fact stays in SQLite"], { env: postgresEnv });
    const found = ok(box, ["find", "shared fact"], { env: postgresEnv });
    expect(JSON.stringify(found)).toContain("the shared fact stays in SQLite");
    expect(readFileSync(box.store).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
    // Positive control: the same store, read without the variables, holds the memory.
    expect(JSON.stringify(ok(box, ["find", "shared fact"]))).toContain("stays in SQLite");
  });

  cliTest("no flag selects a Postgres store", () => {
    box = sandbox();
    ok(box, ["init"]);
    for (const flag of [
      ["--postgres", postgresEnv.DATABASE_URL],
      ["--store", "postgres"],
    ]) {
      refused(box, ["note", "x", ...flag], 2, "usage");
    }
    // Positive control: the same note without the flag is accepted.
    ok(box, ["note", "x"]);
  });
});
