import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, ENV_VARS, GLOBAL_FLAGS } from "../../src/cli/commands.js";
import { ERROR_CODES } from "../../src/cli/errors.js";

const doc = readFileSync(join(import.meta.dir, "..", "..", "docs", "CLI.md"), "utf8");

/** The text of a `## title` section, up to the next `## ` heading. */
function section(title: string): string {
  const start = doc.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`docs/CLI.md has no "## ${title}" section`);
  const rest = doc.slice(start + title.length + 5);
  const end = rest.indexOf("\n## ");
  return end < 0 ? rest : rest.slice(0, end);
}

/** The first cell of each table row in `text`, header and separator rows excluded. */
function firstCells(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !/^\|\s*-/.test(line))
    .map((line) => line.split("|")[1]?.trim() ?? "")
    .filter((cell) => cell.startsWith("`"));
}

/** `--flag <value>` → { name: "--flag", value: true }. */
function parseFlag(cell: string): { name: string; value: boolean } {
  const match = /^`(--[a-z-]+)( <[^>]+>)?`$/.exec(cell);
  if (match === null) throw new Error(`docs/CLI.md has a malformed flag cell: ${cell}`);
  return { name: match[1] as string, value: match[2] !== undefined };
}

/** Each `### name` heading in Commands with the flags in its table. */
function documentedCommands(): Map<string, { name: string; value: boolean }[]> {
  const commands = new Map<string, { name: string; value: boolean }[]>();
  const parts = section("Commands").split("\n### ").slice(1);
  for (const part of parts) {
    const name = /^`relembra ([a-z]+)`/.exec(part)?.[1];
    if (name === undefined) throw new Error(`docs/CLI.md has a malformed command heading: ${part}`);
    commands.set(name, firstCells(part).map(parseFlag));
  }
  return commands;
}

describe("docs/CLI.md is the contract, checked against the command table both ways", () => {
  test("the same commands", () => {
    expect([...documentedCommands().keys()].sort()).toEqual(
      COMMANDS.map((command) => command.name).sort(),
    );
  });

  test("the same flags per command, with the same value-taking", () => {
    const documented = documentedCommands();
    for (const command of COMMANDS) {
      const flags = command.flags.map(({ name, value }) => ({ name, value }));
      expect({ command: command.name, flags: documented.get(command.name) ?? [] }).toEqual({
        command: command.name,
        flags: [...flags],
      });
    }
  });

  test("the same global flags", () => {
    expect(firstCells(section("Global flags")).map((cell) => parseFlag(cell).name)).toEqual([
      ...GLOBAL_FLAGS,
    ]);
  });

  test("the same error codes, each with its exit code", () => {
    const rows = section("Error codes")
      .split("\n")
      .filter((line) => /^\| `[a-z-]+` \|/.test(line))
      .map((line) => {
        const [, code = "", exit = ""] = line.split("|").map((cell) => cell.trim());
        return [code.replaceAll("`", ""), Number(exit)] as const;
      });
    expect(Object.fromEntries(rows)).toEqual({ ...ERROR_CODES });
  });

  test("exit codes 0 to 3, as the plan fixes them", () => {
    const rows = section("Exit codes")
      .split("\n")
      .filter((line) => /^\| [0-9] \|/.test(line))
      .map((line) => Number(line.split("|")[1]));
    expect(rows).toEqual([0, 1, 2, 3]);
    expect(new Set(Object.values(ERROR_CODES))).toEqual(new Set([1, 2, 3]));
  });

  test("the same environment variables", () => {
    expect(firstCells(section("Environment")).map((cell) => cell.replaceAll("`", ""))).toEqual([
      ...ENV_VARS,
    ]);
  });

  test("the binary reads exactly those variables, in one place", () => {
    const dir = join(import.meta.dir, "..", "..", "src", "cli");
    const reads = readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        readFileSync(join(dir, file), "utf8")
          .split("\n")
          .filter((line) => line.includes("process.env"))
          .map((line) => ({ file, line: line.trim() })),
      );
    expect(reads).toEqual([{ file: "main.ts", line: "} = process.env;" }]);
    const main = readFileSync(join(dir, "main.ts"), "utf8");
    const names = /const \{([^}]*)\} = process\.env;/.exec(main)?.[1] ?? "";
    expect(
      names
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ).toEqual([...ENV_VARS]);
  });

  test("positive control: the parser sees a flag that is missing from the table", () => {
    const tampered = `${section("Commands")}\n### \`relembra ghost\`\n\n| \`--boo\` | x |\n`;
    expect(tampered.split("\n### ").length - 1).toBe(documentedCommands().size + 1);
  });
});
