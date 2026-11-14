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
  readonly repeat?: boolean;
}

export type Positionals =
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
  /** What the command does, in one line for the Commands table of `relembra --help`. */
  readonly summary: string;
  readonly positionals: Positionals;
  readonly flags: readonly FlagSpec[];
  /** One line for the Usage block of `relembra --help`. */
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
  {
    name: "init",
    summary: "Create the store and print the session-start hook for your agent",
    positionals: "none",
    flags: [],
    usage: "relembra init",
  },
  {
    name: "note",
    summary: "Save one fact, a single line of at most 280 bytes",
    positionals: "text",
    flags: [...PROVENANCE, { name: "--pin", value: false }],
    usage:
      "relembra note [text] [--pin] [--trust t] [--op-id id] [--agent a] [--harness h] [--model m] [--source s]",
  },
  {
    name: "find",
    summary: "Search memories by words, best match first",
    positionals: "words",
    flags: [{ name: "--limit", value: true }],
    usage: "relembra find <query…> [--limit n]",
  },
  {
    name: "recall",
    summary: "List the newest memories",
    positionals: "none",
    flags: [
      { name: "--limit", value: true },
      { name: "--retracted", value: false },
    ],
    usage: "relembra recall [--limit n] [--retracted]",
  },
  {
    name: "wake",
    summary: "Print the block a session starts with, within a byte budget",
    positionals: "none",
    flags: [{ name: "--budget", value: true }],
    usage: "relembra wake [--budget bytes]",
  },
  {
    name: "brief",
    summary: "Print the memories about one topic, within a byte budget",
    positionals: "words",
    flags: [{ name: "--budget", value: true }],
    usage: "relembra brief <topic…> [--budget bytes]",
  },
  {
    name: "zoom",
    summary: "Show one memory with its provenance, and a summary's sources",
    positionals: "id",
    flags: [],
    usage: "relembra zoom <id>",
  },
  {
    name: "retract",
    summary: "Hide a memory from agents; its owner still sees it",
    positionals: "id",
    flags: [],
    usage: "relembra retract <id>",
  },
  {
    name: "redact",
    summary: "Erase a memory's text everywhere, summaries of it included",
    positionals: "id",
    flags: [],
    usage: "relembra redact <id>",
  },
  {
    name: "supersede",
    summary: "Replace a memory with a new line",
    positionals: "id-text",
    flags: [...PROVENANCE, { name: "--pin", value: false }],
    usage: "relembra supersede <id> [text] [--pin] [provenance flags as for note]",
  },
  {
    name: "pending",
    summary: "List unpinned memories that no summary covers yet, oldest first",
    positionals: "none",
    flags: [{ name: "--limit", value: true }],
    usage: "relembra pending [--limit n]",
  },
  {
    name: "summarize",
    summary: "Save a summary of the given memory revisions",
    positionals: "text",
    flags: [...PROVENANCE, { name: "--of", value: true, repeat: true }],
    usage: "relembra summarize [text] --of <id>@<revision>… [provenance flags as for note]",
  },
  {
    name: "sweep",
    summary: "Redact memories older than a number of days",
    positionals: "none",
    flags: [{ name: "--max-age-days", value: true }],
    usage: "relembra sweep --max-age-days n",
  },
  {
    name: "check",
    summary: "Verify the store and report what it holds",
    positionals: "none",
    flags: [],
    usage: "relembra check",
  },
  {
    name: "hook",
    summary: "Print the wake as a session-start hook response",
    positionals: "none",
    flags: [],
    usage: "relembra hook",
  },
  {
    name: "mcp",
    summary: "Serve the memory tools to an MCP client over stdio",
    positionals: "none",
    flags: [],
    usage: "relembra mcp",
  },
  {
    name: "export",
    summary: "Print the scope's events as JSON Lines",
    positionals: "none",
    flags: [],
    usage: "relembra export",
  },
  {
    name: "import",
    summary: "Load an export file, or another store's directory, into the scope",
    positionals: "path",
    flags: [{ name: "--optmem", value: true }],
    usage: "relembra import <file> | relembra import --optmem <dir>",
  },
];

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
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    "relembra: a curated, scoped memory for AI agents",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    "",
    "Usage:",
    ...COMMANDS.map((command) => `  ${command.usage}`),
    "",
    "Every command takes --json. Scope comes from the git project and the OS user, or",
    "RELEMBRA_SCOPE; reads also cover RELEMBRA_GLOBAL_SCOPE when it is set. The store lives",
    "in RELEMBRA_HOME (default ~/.relembra). See docs/CLI.md.",
  ].join("\n");
}
