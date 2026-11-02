/**
 * The CLI's command table: every command, its arguments and its flags. docs/CLI.md documents
 * exactly this table, and test/cli/contract.test.ts checks the two against each other.
 * No flag names a scope, a home or a user: those come from the environment only.
 */

export interface FlagSpec {
  /** `--name`. */
  readonly name: string;
  /** Whether the flag takes a value (`--limit 5`, `--limit=5`). */
  readonly value: boolean;
  /** Whether the flag may be given more than once. */
  readonly repeat?: boolean;
}

/** What a command takes as positional arguments. */
export type Positionals =
  /** None. */
  | "none"
  /** Exactly one memory id. */
  | "id"
  /** At most one text argument; stdin when absent. */
  | "text"
  /** A memory id, then at most one text argument; stdin when absent. */
  | "id-text"
  /** One or more words, joined by single spaces. */
  | "words"
  /** At most one file path. */
  | "path";

export interface CommandSpec {
  readonly name: string;
  readonly positionals: Positionals;
  readonly flags: readonly FlagSpec[];
  /** One line for `relembra --help`. */
  readonly usage: string;
}

const PROVENANCE: readonly FlagSpec[] = [
  { name: "--agent", value: true },
  { name: "--harness", value: true },
  { name: "--model", value: true },
  { name: "--source", value: true },
  { name: "--trust", value: true },
  { name: "--op-id", value: true },
];

export const COMMANDS: readonly CommandSpec[] = [
  { name: "init", positionals: "none", flags: [], usage: "relembra init" },
  {
    name: "note",
    positionals: "text",
    flags: [...PROVENANCE, { name: "--pin", value: false }],
    usage:
      "relembra note [text] [--pin] [--trust t] [--op-id id] [--agent a] [--harness h] [--model m] [--source s]",
  },
  {
    name: "find",
    positionals: "words",
    flags: [{ name: "--limit", value: true }],
    usage: "relembra find <query…> [--limit n]",
  },
  {
    name: "recall",
    positionals: "none",
    flags: [
      { name: "--limit", value: true },
      { name: "--retracted", value: false },
    ],
    usage: "relembra recall [--limit n] [--retracted]",
  },
  {
    name: "wake",
    positionals: "none",
    flags: [{ name: "--budget", value: true }],
    usage: "relembra wake [--budget bytes]",
  },
  {
    name: "brief",
    positionals: "words",
    flags: [{ name: "--budget", value: true }],
    usage: "relembra brief <topic…> [--budget bytes]",
  },
  { name: "zoom", positionals: "id", flags: [], usage: "relembra zoom <id>" },
  { name: "retract", positionals: "id", flags: [], usage: "relembra retract <id>" },
  { name: "redact", positionals: "id", flags: [], usage: "relembra redact <id>" },
  {
    name: "supersede",
    positionals: "id-text",
    flags: [...PROVENANCE, { name: "--pin", value: false }],
    usage: "relembra supersede <id> [text] [--pin] [provenance flags as for note]",
  },
  {
    name: "pending",
    positionals: "none",
    flags: [{ name: "--limit", value: true }],
    usage: "relembra pending [--limit n]",
  },
  {
    name: "summarize",
    positionals: "text",
    flags: [...PROVENANCE, { name: "--of", value: true, repeat: true }],
    usage: "relembra summarize [text] --of <id>@<revision>… [provenance flags as for note]",
  },
  {
    name: "sweep",
    positionals: "none",
    flags: [{ name: "--max-age-days", value: true }],
    usage: "relembra sweep --max-age-days n",
  },
  { name: "check", positionals: "none", flags: [], usage: "relembra check" },
  { name: "hook", positionals: "none", flags: [], usage: "relembra hook" },
  { name: "mcp", positionals: "none", flags: [], usage: "relembra mcp" },
  { name: "export", positionals: "none", flags: [], usage: "relembra export" },
  {
    name: "import",
    positionals: "path",
    flags: [{ name: "--optmem", value: true }],
    usage: "relembra import <file> | relembra import --optmem <dir>",
  },
];

/** Flags every command takes. */
export const GLOBAL_FLAGS = ["--json", "--help"] as const;

/** The environment the CLI reads, in the order docs/CLI.md lists it. */
export const ENV_VARS = [
  "RELEMBRA_HOME",
  "RELEMBRA_SCOPE",
  "RELEMBRA_GLOBAL_SCOPE",
  "RELEMBRA_AGENT",
  "RELEMBRA_HARNESS",
  "RELEMBRA_MODEL",
  "BUN_OPTIONS",
  "BUN_BYTECODE_ORDER_OUT",
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "SystemRoot",
] as const;

export function usageText(): string {
  return [
    "relembra: a curated, scoped memory for AI agents",
    "",
    ...COMMANDS.map((command) => `  ${command.usage}`),
    "",
    "Every command takes --json. Scope comes from the git project and the OS user, or",
    "RELEMBRA_SCOPE; reads also cover RELEMBRA_GLOBAL_SCOPE when it is set. The store lives",
    "in RELEMBRA_HOME (default ~/.relembra). See docs/CLI.md.",
  ].join("\n");
}
