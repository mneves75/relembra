import {
  BudgetError,
  ExposureRedactedError,
  GuardError,
  IdentifierError,
  ImportError,
  MemoryNotFoundError,
  MemoryRedactedError,
  MemoryStateError,
  OpConflictError,
  PlanChangedError,
  ProvenanceError,
  ScopeDeniedError,
  SourceChangedError,
} from "../errors.js";
import {
  StoreBusyError,
  StoreFileModeError,
  StoreFileTypeError,
  StoreUnverifiedError,
} from "../sqlite/database.js";
import { WalScrubError } from "../sqlite/index.js";
import { SchemaTooNewError } from "../sqlite/migrations.js";

/** 1: refused. 2: usage. 3: store error. */
export type ExitCode = 1 | 2 | 3;

/** Every error code the CLI prints, with its exit code. docs/CLI.md lists exactly these. */
export const ERROR_CODES = {
  usage: 2,
  "no-scope": 2,
  "bad-scope": 2,
  "invalid-argument": 2,
  "unsafe-runtime-env": 2,
  guard: 1,
  "input-timeout": 1,
  "owner-confirmation-required": 1,
  provenance: 1,
  "scope-denied": 1,
  "not-found": 1,
  "memory-state": 1,
  "op-conflict": 1,
  budget: 1,
  "source-changed": 1,
  "plan-changed": 1,
  redacted: 1,
  import: 1,
  "no-store": 3,
  "schema-too-new": 3,
  "store-file": 3,
  "store-unverified": 3,
  "store-busy": 3,
  "wal-scrub": 3,
  integrity: 3,
  store: 3,
  internal: 3,
} as const satisfies Record<string, ExitCode>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** An error the CLI reports: a code, an optional rule, and a message that never echoes input. */
export class CliError extends Error {
  override readonly name = "CliError";
  readonly code: ErrorCode;
  readonly rule: string | undefined;

  constructor(code: ErrorCode, message: string, rule?: string) {
    super(message);
    this.code = code;
    this.rule = rule;
  }

  get exit(): ExitCode {
    return ERROR_CODES[this.code];
  }
}

export const usage = (rule: string, message: string) => new CliError("usage", message, rule);

/** System error codes that mean the store's files could not be reached. */
const FILE_ERRORS = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EROFS", "ENOSPC"]);

/** Maps anything thrown to the error the CLI reports. Library messages never echo input. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof GuardError) return new CliError("guard", error.message, error.rule);
  if (error instanceof ProvenanceError) {
    return new CliError("provenance", error.message, `${error.field}:${error.rule}`);
  }
  if (error instanceof ScopeDeniedError) {
    return new CliError("scope-denied", error.message, error.access);
  }
  if (error instanceof MemoryNotFoundError) return new CliError("not-found", error.message);
  if (error instanceof MemoryStateError) {
    return new CliError("memory-state", error.message, error.status);
  }
  if (error instanceof OpConflictError) return new CliError("op-conflict", error.message);
  if (error instanceof BudgetError) return new CliError("budget", error.message);
  if (error instanceof SourceChangedError) return new CliError("source-changed", error.message);
  if (error instanceof PlanChangedError) return new CliError("plan-changed", error.message);
  if (error instanceof MemoryRedactedError) return new CliError("redacted", error.message);
  if (error instanceof ExposureRedactedError) return new CliError("redacted", error.message);
  if (error instanceof ImportError) {
    const rule = error.detail === undefined ? error.reason : `${error.reason}:${error.detail}`;
    return new CliError("import", error.message, rule);
  }
  if (error instanceof IdentifierError) {
    const field = error.field.replace(" ", "-");
    return new CliError("invalid-argument", error.message, `${field}:${error.rule}`);
  }
  if (error instanceof SchemaTooNewError) return new CliError("schema-too-new", error.message);
  if (error instanceof StoreFileModeError) return new CliError("store-file", error.message, "mode");
  if (error instanceof StoreFileTypeError) return new CliError("store-file", error.message, "type");
  if (error instanceof StoreUnverifiedError) return new CliError("store-unverified", error.message);
  if (error instanceof StoreBusyError) return new CliError("store-busy", error.message);
  if (error instanceof WalScrubError) return new CliError("wal-scrub", error.message);
  // The library refuses out-of-range arguments (a limit, a budget) with a RangeError.
  if (error instanceof RangeError) return new CliError("invalid-argument", error.message);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (code.startsWith("ERR_SQLITE") || FILE_ERRORS.has(code))) {
    return new CliError("store", `store error: ${(error as Error).message}`);
  }
  return new CliError("internal", `internal error: ${String((error as Error)?.message ?? error)}`);
}
