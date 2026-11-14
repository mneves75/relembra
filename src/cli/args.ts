import { COMMANDS, type CommandSpec } from "./commands.js";
import { usage } from "./errors.js";

export interface Parsed {
  readonly command: CommandSpec;
  readonly positionals: readonly string[];
  /** Each given flag's values; a boolean flag has one empty value. */
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

export type ParseResult =
  | { readonly kind: "help" }
  | { readonly kind: "command"; readonly parsed: Parsed };

/** Whether `--json` appears before any `--`, so even a usage error can answer in JSON. */
export function wantsJson(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--json") return true;
  }
  return false;
}

/**
 * Parses `argv` against the command table. Every token that starts with `-` before `--` must be
 * a flag the command declares (or a global flag): an unknown flag is a usage error, never
 * ignored, so no spelling of an undeclared option can change what a command does.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  if (argv.includes("--help") && !argv.slice(0, argv.indexOf("--help")).includes("--")) {
    return { kind: "help" };
  }
  const [name, ...rest] = argv.filter(
    (arg, index) => !(arg === "--json" && !argv.slice(0, index).includes("--")),
  );
  if (name === undefined) throw usage("missing-command", "no command given; see relembra --help");
  const command = COMMANDS.find((spec) => spec.name === name);
  if (command === undefined)
    throw usage("unknown-command", `unknown command: ${name.slice(0, 40)}`);

  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    if (arg === "--") {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const flagName = equals < 0 ? arg : arg.slice(0, equals);
    const spec = command.flags.find((flag) => flag.name === flagName);
    if (spec === undefined) {
      throw usage("unknown-flag", `${command.name} takes no flag ${flagName.slice(0, 40)}`);
    }
    let value = "";
    if (spec.value) {
      if (equals >= 0) value = arg.slice(equals + 1);
      else {
        const next = rest[index + 1];
        if (next === undefined) throw usage("missing-value", `${flagName} needs a value`);
        value = next;
        index++;
      }
    } else if (equals >= 0) {
      throw usage("unexpected-value", `${flagName} takes no value`);
    }
    const values = flags.get(flagName) ?? [];
    if (values.length > 0 && !spec.repeat) {
      throw usage("repeated-flag", `${flagName} may be given once`);
    }
    flags.set(flagName, [...values, value]);
  }
  checkPositionals(command, positionals);
  return { kind: "command", parsed: { command, positionals, flags } };
}

function checkPositionals(command: CommandSpec, positionals: readonly string[]): void {
  const count = positionals.length;
  const max = {
    none: 0,
    id: 1,
    text: 1,
    "id-text": 2,
    words: Number.POSITIVE_INFINITY,
    path: 1,
  }[command.positionals];
  const min = { none: 0, id: 1, text: 0, "id-text": 1, words: 1, path: 0 }[command.positionals];
  if (count > max) {
    throw usage(
      "extra-argument",
      command.positionals === "text" || command.positionals === "id-text"
        ? `${command.name} takes the text as one argument; quote it`
        : `${command.name} takes at most ${max} argument${max === 1 ? "" : "s"}`,
    );
  }
  if (count < min) throw usage("missing-argument", `usage: ${command.usage}`);
}

export function flagValue(parsed: Parsed, name: string): string | undefined {
  return parsed.flags.get(name)?.[0];
}

export function hasFlag(parsed: Parsed, name: string): boolean {
  return parsed.flags.has(name);
}

/** A positive integer flag value, at most `max`; undefined when the flag is absent. */
export function intFlag(parsed: Parsed, name: string, max: number): number | undefined {
  const value = flagValue(parsed, name);
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,15}$/.test(value)) {
    throw usage("bad-value", `${name} takes a whole number from 1 to ${max}`);
  }
  const number = Number(value);
  if (number < 1 || number > max) {
    throw usage("bad-value", `${name} takes a whole number from 1 to ${max}`);
  }
  return number;
}
