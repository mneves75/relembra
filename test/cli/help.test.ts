import { afterAll, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { COMMANDS } from "../../src/cli/commands.js";
import { RELEMBRA_VERSION } from "../../src/version.js";
import { cliTest, refused, run, runStdinOpen, sandbox } from "./support.js";

// No `relembra init`: help and --version must work, and create nothing, without a store.
const box = sandbox();
afterAll(() => box.remove());

const FOOTER = `See https://github.com/mneves75/relembra/blob/v${RELEMBRA_VERSION}/docs/CLI.md`;

/** Exit 0, the text on stdout, nothing on stderr. */
function printed(args: readonly string[]): string {
  const result = run(box, args);
  expect({ args, status: result.status, stderr: result.stderr }).toEqual({
    args,
    status: 0,
    stderr: "",
  });
  return result.stdout;
}

describe("help and --version", () => {
  cliTest("-h and help print exactly what --help prints", () => {
    const global = printed(["--help"]);
    // Positive control: the global help is the Commands table.
    expect(global).toContain("Commands:\n");
    expect(printed(["-h"])).toBe(global);
    expect(printed(["help"])).toBe(global);
    // As today, --help names no command when the first word is not one.
    expect(printed(["--help", "note"])).toBe(global);
    expect(printed(["nope", "--help"])).toBe(global);
  });

  cliTest("<command> --help, <command> -h and help <command> print only that command", () => {
    const global = printed(["--help"]);
    for (const command of COMMANDS) {
      const text = printed([command.name, "--help"]);
      expect(printed([command.name, "-h"])).toBe(text);
      expect(printed(["help", command.name])).toBe(text);
      expect(text).not.toBe(global);
      const lines = text.split("\n");
      expect(lines[0]).toBe(`relembra ${command.name}: ${command.summary}`);
      expect(lines).toContain(`  ${command.usage}`);
      expect(lines).not.toContain("Commands:");
      for (const other of COMMANDS.filter((spec) => spec !== command)) {
        expect({ command: command.name, other: lines.includes(`  ${other.usage}`) }).toEqual({
          command: command.name,
          other: false,
        });
      }
      for (const flag of command.flags) expect(text).toContain(flag.name);
    }
  });

  cliTest(
    "the footer names the published reference for this version, not a repository path",
    () => {
      for (const args of [["--help"], ["note", "--help"], ["help", "mcp"]]) {
        const text = printed(args);
        expect(text.trimEnd().split("\n").at(-1)).toBe(FOOTER);
        expect(text).not.toContain("See docs/CLI.md");
      }
    },
  );

  cliTest("help with --json is one document with data.usage, global or per command", () => {
    const global = run(box, ["help", "--json"]);
    expect(global.status).toBe(0);
    expect(global.json?.ok === true && global.json.data.usage).toContain("Commands:");
    for (const args of [
      ["help", "note", "--json"],
      ["--json", "note", "-h"],
      ["note", "--help", "--json"],
    ]) {
      const result = run(box, args);
      expect({ args, status: result.status }).toEqual({ args, status: 0 });
      const usage = result.json?.ok === true ? String(result.json.data.usage) : "";
      expect(usage.split("\n")[0]).toBe(
        `relembra note: ${COMMANDS.find((spec) => spec.name === "note")?.summary}`,
      );
      expect(usage).not.toContain("Commands:");
    }
  });

  cliTest("--version prints the version, alone or with --json", () => {
    expect(printed(["--version"])).toBe(`relembra ${RELEMBRA_VERSION}\n`);
    for (const args of [
      ["--version", "--json"],
      ["--json", "--version"],
    ]) {
      const result = run(box, args);
      expect({ args, status: result.status }).toEqual({ args, status: 0 });
      expect(result.json).toEqual({ ok: true, data: { version: RELEMBRA_VERSION } });
    }
  });

  cliTest("bad input: --help still wins, the rest are usage errors", () => {
    // --help anywhere before `--` wins over everything else on the line, as it always has.
    expect(printed(["note", "--help", "extra"])).toBe(printed(["note", "--help"]));
    expect(printed(["note", "extra", "-h", "--bogus"])).toBe(printed(["note", "--help"]));
    const rule = (args: string[]) => {
      const result = refused(box, args, 2, "usage");
      return result.json?.ok === false ? result.json.error.rule : undefined;
    };
    expect(rule(["help", "nope"])).toBe("unknown-command");
    expect(rule(["help", "note", "extra"])).toBe("extra-argument");
    expect(rule(["--version", "extra"])).toBe("extra-argument");
    expect(rule(["note", "x", "--version"])).toBe("unknown-flag");
    expect(rule(["nope"])).toBe("unknown-command");
    // Text mode: the message on stderr, nothing on stdout.
    const text = run(box, ["help", "nope"]);
    expect({ status: text.status, stdout: text.stdout }).toEqual({ status: 2, stdout: "" });
    expect(text.stderr).toContain("unknown command: nope");
    // Blank and very long topics: unknown-command, the name capped at 40 characters.
    expect(rule(["help", ""])).toBe("unknown-command");
    const long = run(box, ["help", "x".repeat(5000)]);
    expect(long.status).toBe(2);
    expect(long.stderr).toBe(`relembra: unknown command: ${"x".repeat(40)} (unknown-command)\n`);
    // -h where a flag value goes is still the help flag; --flag=-h passes it as the value.
    expect(printed(["note", "x", "--agent", "-h"])).toBe(printed(["note", "--help"]));
    expect(printed(["find", "x", "--limit", "-h"])).toBe(printed(["find", "--help"]));
  });

  cliTest("help is a word only in command position, and -h only before --", () => {
    // Positive controls: these reach the store, which this sandbox does not have.
    refused(box, ["find", "help"], 3, "no-store");
    refused(box, ["note", "--", "-h"], 3, "no-store");
    refused(box, ["note", "--", "--help"], 3, "no-store");
  });

  cliTest("help and --version open no store and read no stdin", async () => {
    for (const args of [["note", "--help"], ["note", "-h"], ["help", "note"], ["--version"]]) {
      const result = await runStdinOpen(box, args, "partial", 10_000);
      expect({ args, status: result.status, killed: result.killed }).toEqual({
        args,
        status: 0,
        killed: false,
      });
      expect(existsSync(box.relembraHome)).toBe(false);
    }
  });

  cliTest(
    "positive control: note without --help waits on open stdin, and init creates the store",
    async () => {
      // The sandbox has no store yet, so the store check would answer first: create one.
      const control = sandbox();
      try {
        expect(run(control, ["init"]).status).toBe(0);
        expect(existsSync(control.relembraHome)).toBe(true);
        const waiting = await runStdinOpen(control, ["note"], "partial", 1_500);
        expect(waiting.killed).toBe(true);
      } finally {
        control.remove();
      }
    },
  );
});
