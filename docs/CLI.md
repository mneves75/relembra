# relembra CLI

The contract for the `relembra` command. `test/cli/contract.test.ts` checks this file against the
implementation's command table (`src/cli/commands.ts`) and error table (`src/cli/errors.ts`) in
both directions: every command, flag, error code and environment variable here exists there, and
nothing exists there that is missing here.

The CLI is a Bun AOT binary (`bun run build:cli`, see [Build](#build)) over the SQLite store. It
is the library's host: it decides the scope and the principal, never the agent calling it.

## Scope, principal and store

- **Scope.** `RELEMBRA_SCOPE` when the host sets it. Otherwise
  `uid-<uid>/<name>-<hash>`, from the git repository containing the working directory:
  - `<uid>` is the OS user id. Not the user name: Bun's `os.userInfo().username` reads `$USER`
    and answers `unknown` without it, which would split one user's memory in two. Windows has
    no uid: there the part is `sid-<SID>` ([Windows](#windows)).
  - `<name>` is for people reading the scope only: the last segment of the normalized `origin`
    URL when there is one (so renaming the folder does not change the scope), else the
    repository's folder name: the folder holding `.git`, or the git directory itself, without a
    trailing `.git`, for a bare repository or a separate git dir. Never a linked worktree's own
    folder.
  - `<hash>` is the first 16 hex characters of the sha256 of the **project key**:
    `origin:<normalized URL>` when the repository has an `origin` remote, else
    `gitdir:<real path of the common git directory>`. The remote URL is normalized: the scheme,
    any `user@`, the scheme's default port (22 for ssh, 443 for https, 80 for http, 9418 for
    git), trailing slashes and a trailing `.git` removed, the host lowercased, a non-default port
    and the path's case kept (`host[:port]/owner/repo`). So `git@github.com:owner/repo.git` and
    `https://github.com/owner/repo` are one project, `:8001` and `:8002` are two, and two
    repositories with the same folder name are two. A local or relative origin (`../up.git`,
    `/srv/up.git`, `file://…`) is keyed `file:<real path>`: a `file://` URL's path is
    percent-decoded from git's raw string, spaces at its ends kept (so `file:///srv/my%20up.git`
    and `/srv/my up.git` are one project, and `file:///srv/up ` is not `file:///srv/up`). A file
    URL naming a host other than `localhost`, holding an encoded `/` or a malformed escape is
    refused (`unsupported-origin`), one decoding to a control character too (`unsupported-path`).
    A relative path is resolved as git
    resolves it, against the working tree's top (`git rev-parse --show-toplevel`, a third git
    call made only for a relative origin), or the git directory in a bare repository. So two
    `../upstream.git` beside different checkouts are two projects, a separate git dir included,
    and two linked worktrees in different places with a relative origin can name different
    upstreams, as they do to git.
  - **Trade-off.** With an origin, every clone of a repository shares one scope, and moving or
    renaming its folder keeps it; the cost is that two separate clones of one remote on the
    machine share memories. Without an origin, moving or renaming the repository changes the key
    and orphans its memories until it is moved back or `RELEMBRA_SCOPE` names the old scope.
    Adding or changing `origin` later moves the project to a new scope the same way.
  - **Git answers, not a parser.** The CLI asks git itself, so quoting, comments, includes and
    `url.<base>.insteadOf` rewrites mean what they mean to every other git command:
    `git -C <cwd> rev-parse --path-format=absolute --git-common-dir` (real-pathed) names the
    repository, which every linked worktree, a separate git dir's worktrees and a bare repository
    all have; `git -C <cwd> remote get-url origin` gives the effective origin URL. Not
    `ls-remote --get-url origin`: with no origin it prints `origin` and exits 0, which reads like
    a relative remote, where `remote get-url` exits 2. Needs git 2.31 or later
    (`--path-format`). A submodule is its own project.
  - **Which git.** The first executable `git` on `PATH`, taking only absolute entries outside the
    working directory and the repository around it (the nearest folder above it holding `.git`).
    An empty or relative entry (`.`, `bin`) names a folder the current directory chooses, and an
    entry inside the repository holds whatever is checked out there; either would run a
    repository's own `git` on every session start. The executable is judged by its real path
    and run by it, so a `git` link on an outside entry that points into the repository is passed
    over like an entry inside it. The filtered list is also git's `PATH`.
  - Git's output is used whole, less its final newline: spaces, a trailing one included, are part
    of the path or URL, so origins `/x/upstream` and `/x/upstream ` are two projects. A path or
    URL holding another newline or any control character is refused (`no-scope`, rule
    `unsupported-path`), never cut short: a cut path could name another repository.
  - Git runs with no shell, a 2-second timeout per question, and an environment built from
    scratch: the filtered `PATH`, `HOME` and `XDG_CONFIG_HOME` only, so `GIT_DIR`, `GIT_WORK_TREE`,
    `GIT_CONFIG_*` and every other `GIT_*` variable are ignored. `GIT_CONFIG_NOSYSTEM` is not
    set: the system configuration is writable only by an administrator, and the scope must follow
    the same configuration as the user's own git. The user's `~/.gitconfig` applies for the same
    reason; a process running as the user can edit it, or the repository's `.git/config`, and so
    move the scope, which is the same-user limit stated under Principal.
  - Outside a repository, with no `RELEMBRA_SCOPE`, the scope is the global scope when
    `RELEMBRA_GLOBAL_SCOPE` is set, and there is none otherwise (`no-scope`). When git is
    missing, times out or cannot read the origin, there is none either (`no-scope`, rule
    `git-unavailable` or `git-failed`), never a scope guessed without it, and never the global
    scope: the working directory may be inside a project. Each command that needs
    a scope runs git twice, three times for a relative origin (measured in docs/bench).
  - **No argument changes the scope.** No flag names a scope, a home or a user, an undeclared
    flag is a usage error, and text that looks like a scope is stored as text.
- **Global scope.** `RELEMBRA_GLOBAL_SCOPE`, when the host sets it, names a scope the session also
  reads, wherever it runs: rules and lessons that every project should see. It passes the same
  identifier rule as `RELEMBRA_SCOPE`, checked on every command even when unused (`bad-scope`
  otherwise; the hook stays silent). When it names the session's own scope, as outside a
  repository, it is one scope, not two.
  - Reads cover both scopes: `wake`, `hook`, `find`, `brief`, `recall` and `zoom`, and the MCP
    server's `find`, `brief` and `wake`.
  - Writes and maintenance stay on the session's scope: `note`, `summarize`, `retract`, `redact`,
    `supersede`, `pending`, `sweep`, `export`, `import` and `check`, and the MCP server's `note`
    and `retract`. Changing a global memory from a project is refused (`scope-denied`). To write,
    retract, redact or supersede in the global scope, set `RELEMBRA_SCOPE` to it.
  - No flag or tool argument names it; it comes from the environment only, like the scope.
- **Principal.** The single-user trust model: the OS user running the binary is the principal and
  owns the scope. It may read, write, pin, retract, redact and supersede there, and it may also
  read the global scope (above), nothing more. Its trust ceiling
  is `agent`: writes carry `agent` trust unless `--trust untrusted` lowers it, and owner trust
  needs a person at the terminal (Trust, below).
  - **No `relembra promote`.** Promotion copies a memory from a scope the principal reads into
    another it may promote into, so it needs rights on two scopes. The CLI's principal owns one
    scope and has no promote rights, and no flag may name another scope, so the CLI has no promote
    command. A host whose policy grants rights on several scopes promotes through the library
    (`Relembra.promote`); the CLI shows what it wrote (`zoom`'s `origin` line) and `check` accepts
    its events.
- **Trust.** `--trust owner` on `note`, `supersede` or `summarize`, and any command that would
  change a memory whose current revision has owner trust, succeed only after an interactive confirmation on the controlling terminal (`/dev/tty`,
  never stdin or stdout): the CLI shows the memory text, prints a random 6-character code and
  waits up to 60 seconds for it to be typed back. Only then does that one invocation run with
  ceiling `owner`. The text is guard-checked before it is shown, so a refused text never
  prompts. With no controlling terminal (an agent's tool call, a pipeline under `setsid`) the
  command is refused with `owner-confirmation-required`, rule `no-tty`; a wrong code is
  `mismatch`, no answer `timeout`. Nothing is written in any of these cases.
  - "Would change" is the library's own plan, not a guess: `redact` checks every memory
    `Relembra.redactionPreview` returns (the memory and every summary derived from it, which
    redact erases with it, and the copies promoted from it that the principal may see: a copy's
    trust is never above its origin's); `retract` and `supersede` check the memory and the live summaries in
    it, which they retract; `sweep` checks every memory `Relembra.sweepPreview(now)` returns
    (superseded and retracted memories, and derived summaries, included), with the same `now`
    the sweep then uses. Each preview shares its code with the operation it previews. The library
    never lets a summary outrank its sources, so a derived owner summary under a non-owner memory
    comes only from data written elsewhere; it is gated all the same.
  - The confirmation approves that plan and no other. The CLI hands the preview to the mutation
    (`expect`, an `Approval` in the library), which plans again inside its own write transaction
    and writes nothing when the memories it would change differ from the preview in any field
    (the whole record is compared: text, scope, provenance, status, revision), as when another
    process summarizes or rewrites the memory while the prompt waits. The CLI then previews
    again and, when owner memories are in the new plan, prompts again, marked `(changed since the
    last prompt)`. After three changed plans it gives up with `plan-changed` (exit 1), having
    written nothing. Commands that need no confirmation are bound the same way.
  - What this stops: a prompt-injected agent escalating to owner trust, or replacing, retracting
    or redacting an owner rule, by adding a flag. An agent whose tool shares the user's terminal
    never sees the code, which goes to the terminal, not to its output.
  - What it does not stop: **a process running as the same OS user is not a security
    boundary.** It can open the store file directly, and one that drives a pseudo-terminal of
    its own can read the code off it. The CLI gives scoped organization, not isolation
    (IMPLEMENTATION-PLAN §3, invariant 2; §4.1).
- **Runtime environment.** The binary refuses to run (`unsafe-runtime-env`, exit 2) when
  `BUN_OPTIONS` or `BUN_BYTECODE_ORDER_OUT` is set, or when any runtime option reached it
  (`process.execArgv` is not empty): `BUN_OPTIONS="--cwd <dir>"` would move the working
  directory, and so the scope, before relembra's code runs. `BUN_OPTIONS=--preload` is already
  refused by the AOT binary itself, and `NODE_OPTIONS` is ignored by it.
  - The refusal covers what reaches relembra's code, and only that. Bun acts on some startup
    variables first: `BUN_OPTIONS=--version` prints Bun's version, `BUN_OPTIONS=--help` exits 1,
    and `BUN_BE_BUN=1` turns the binary into the Bun CLI, all before the check can run. For direct
    use that is the caller's own environment (an agent able to set it could run Bun anyway). For
    the session-start hook, where a session's environment must not decide what runs, the
    command `init` prints launches the binary under `/usr/bin/env -i` with only the variables it
    reads (see [`hook`](#relembra-hook)), so no Bun startup variable reaches it.
- **Provenance.** `agent`, `harness` and `model` come from `--agent`, `--harness` and `--model`,
  else from `RELEMBRA_AGENT`, `RELEMBRA_HARNESS` and `RELEMBRA_MODEL`, else `unknown`, `cli` and
  `unknown`. `host` is the machine's host name. Provenance never grants trust.
- **Store.** `RELEMBRA_HOME/relembra.db`, `RELEMBRA_HOME` defaulting to `~/.relembra`; a relative
  `RELEMBRA_HOME` is resolved against the working directory. `init` creates the directory with mode
  0700 and the file with 0600. Every other command needs the store to exist (`no-store`).
- **No configuration from the working directory.** The binary is built without Bun's `.env` and
  `bunfig.toml` autoloading, so a project cannot set `RELEMBRA_SCOPE` or `RELEMBRA_HOME`, or
  preload code, through files.

## Output

- Without `--json`, a command prints text on stdout and errors on stderr as
  `relembra: <message> (<rule>)`.
- With `--json`, a command prints one JSON document on stdout, success or failure:
  `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "code": …, "rule"?: … } }`.
- A memory in `data` is the library's `Memory` (`src/model.ts`): `id`, `scope`, `seq`, `pinned`,
  `notedAt`, `revision` (`number`, `text`, `at`, `provenance`), `status`, and `supersededBy` or
  `sources` when present. A tombstone is `{ id, scope, seq, status: "redacted" }`.
- Text output renders memories as attributed evidence, one per line:
  `<memory id="…" scope="…" rev="…" at="…" trust="…">text</memory>`, escaped, prefixed by
  `[retracted]` in the owner view. Escaped means `&`, `<`, `>` and `"` as entities, and every
  line break, control, bidi, zero-width or other invisible character the guard refuses as a
  decimal reference such as `&#27;`, in attributes and text alike, so no rendering carries one
  raw whatever the store holds.
- Messages never echo the text of a refused write.
- `mcp` is the exception: its stdout carries MCP messages only, so it prints no JSON document and
  reports a failure to start on stderr, with `--json` or without (see [`mcp`](#relembra-mcp)).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | refused: the input or the operation was refused (guard, provenance, state, op id, budget) |
| 2 | usage: unknown command or flag, a bad value, a missing argument, no scope or a bad scope |
| 3 | store error: no store, a newer schema, loose file modes, corruption, a locked or unreadable store |

## Error codes

| Code | Exit | When | Rule |
|---|---|---|---|
| `usage` | 2 | The command line does not parse | `missing-command`, `unknown-command`, `unknown-flag`, `missing-value`, `unexpected-value`, `repeated-flag`, `bad-value`, `extra-argument`, `missing-argument` |
| `no-scope` | 2 | Outside a git repository with no `RELEMBRA_SCOPE`, or git could not answer | `git-unavailable`, `git-failed` when git did not answer; `unsupported-path` for a path or URL with a control character; `unsupported-origin` for a file URL naming another host, an encoded `/` or a malformed escape |
| `bad-scope` | 2 | `RELEMBRA_SCOPE` or the derived scope is blank, over 256 bytes, or holds invisible or control characters | the guard rule |
| `invalid-argument` | 2 | The library refused an out-of-range argument, or a memory id that breaks the identifier rule (`docs/FORMAT.md`, "Identifiers") | `memory-id:<rule>`, such as `memory-id:control-character`, for an id; none otherwise |
| `unsafe-runtime-env` | 2 | `BUN_OPTIONS` or `BUN_BYTECODE_ORDER_OUT` is set, or a runtime option reached the binary | |
| `guard` | 1 | The memory's text broke a guard rule; stdin past 282 bytes (280 and a `\r\n`) is `too-long` at once | `blank`, `too-long`, `ill-formed`, `multi-line`, `bidi-character`, `zero-width-character`, `control-character`, `format-character`, `invisible-character`, `credential` |
| `input-timeout` | 1 | Stdin did not end within 5 seconds | |
| `owner-confirmation-required` | 1 | Owner trust was not confirmed at the terminal (see Trust) | `no-tty`, `mismatch`, `timeout` |
| `provenance` | 1 | A provenance field was refused | `<field>:<rule>`, such as `agent:multi-line` or `trust:above-sources` |
| `scope-denied` | 1 | The principal lacks an access right | `read`, `write`, `pin`, `own` |
| `not-found` | 1 | No memory this principal may see has the id, including one in another scope | |
| `memory-state` | 1 | The memory's status refuses the operation | `retracted`, `superseded`, `redacted` |
| `summary-supersede` | 1 | `supersede` named a summary: retract it and submit a new one | |
| `op-conflict` | 1 | The op id was used for a different payload | |
| `budget` | 1 | `--budget` cannot hold the rendering's frame | |
| `source-changed` | 1 | A summary source is no longer at the given revision | |
| `plan-changed` | 1 | What `retract`, `redact`, `supersede` or `sweep` would change kept changing while it previewed and confirmed: three plans in a row (see Trust) | |
| `redacted` | 1 | A retried write's memory was redacted since | |
| `import` | 1 | `import` refused the file and wrote nothing ([`import`](#relembra-import)) | `format-too-new`, `malformed`, `malformed:summary-supersede`, `malformed:<field>:<rule>` for an identifier, such as `malformed:memoryId:control-character`, `guard:<rule>`, `provenance:<field>:<rule>`, `future-time`, `redacted-in-target`, `conflict`, `denied:above-ceiling`, `denied:pin`, `truncated`, `modified`, `not-optmem`, `too-large:file`, `too-large:line`, `too-large:events`, `too-large:records` |
| `no-store` | 3 | The store file does not exist; run `relembra init` | |
| `schema-too-new` | 3 | A newer relembra wrote the store; it is left untouched | |
| `store-file` | 3 | The store, a sidecar or its directory is not owner-only, or is not a regular file | `mode`, `type` |
| `store-unverified` | 3 | SQLite could not verify the store's schema | |
| `store-busy` | 3 | Another writer held the lock past the busy timeout | |
| `wal-scrub` | 3 | A redaction's old pages could not yet be truncated from the WAL | |
| `integrity` | 3 | `check` found corruption | `sqlite`, `event-json`, `event-format` |
| `store` | 3 | Any other SQLite or file-system error on the store | |
| `internal` | 3 | A bug: an error the CLI does not recognise | |

## Global flags

| Flag | Meaning |
|---|---|
| `--json` | Print one JSON document (see [Output](#output)) |
| `--help` | Print a Commands table (each command with a one-line summary), the usage lines and exit 0; with `--json`, `{ "ok": true, "data": { "usage": … } }` |

A token starting with `-` before `--` is a flag. Put text that starts with `-` after `--`:
`relembra note -- "-5 °C is the freezer's setting"`. A value flag takes `--flag value` or
`--flag=value`.

## Environment

| Variable | Meaning |
|---|---|
| `RELEMBRA_HOME` | The store's directory; default `~/.relembra` |
| `RELEMBRA_SCOPE` | The scope, set by the host; overrides the git project |
| `RELEMBRA_GLOBAL_SCOPE` | A scope the session also reads, set by the host; the scope outside a repository |
| `RELEMBRA_AGENT` | Provenance `agent` when `--agent` is absent |
| `RELEMBRA_HARNESS` | Provenance `harness` when `--harness` is absent |
| `RELEMBRA_MODEL` | Provenance `model` when `--model` is absent |
| `BUN_OPTIONS` | Read only to refuse: set, the binary exits 2 (`unsafe-runtime-env`) |
| `BUN_BYTECODE_ORDER_OUT` | Read only to refuse, as `BUN_OPTIONS` |
| `PATH` | Passed to git, to find it |
| `HOME` | Passed to git, for the user's `~/.gitconfig`; also the default store's home |
| `XDG_CONFIG_HOME` | Passed to git, for the user's git configuration there |
| `SystemRoot` | Windows only: the Windows folder, whose `System32\whoami.exe` names the user; `C:\Windows` unless a drive path |

An empty variable counts as unset. Nothing else in the environment is read, and git gets nothing
else from it.

## Commands

### `relembra init`

Creates the store if it is missing (directory 0700, file 0600) and prints the scope and the
session-start hook snippets for Claude Code and Codex. It never writes the user's `~/.claude` or
`~/.codex`. Works outside a repository (scope `null`, or the global scope when it is set).

`data`: `{ scope: string | null, store: string, created: boolean, hooks: { claudeCode, codex } }`,
each hook value being the `hooks.SessionStart` registration shown under [`hook`](#relembra-hook).

### `relembra note`

`relembra note [text]`. Writes one memory. The text is the one argument, or stdin when there is
none: UTF-8, at most 282 bytes (the 280 of a memory and a `\r\n`; one byte more is refused as
`too-long` at once, even if stdin stays open), one trailing line break removed, a leading
byte-order mark kept (so the guard refuses it as `zero-width-character`). Stdin must end within
5 seconds (`input-timeout`). A terminal on stdin is a usage error, never a wait.

| Flag | Meaning |
|---|---|
| `--agent <name>` | Provenance agent |
| `--harness <name>` | Provenance harness |
| `--model <name>` | Provenance model |
| `--source <text>` | Provenance source, such as a URL or a file the fact came from |
| `--trust <tier>` | `agent` (default), `untrusted`, or `owner` after confirmation at the terminal (see Trust) |
| `--op-id <id>` | Idempotency key: a retry with the same op id and payload returns the first result |
| `--pin` | Pin the memory, so wake renders it first; ignored for `untrusted`: stored, but wake never renders it pinned |

`data`: `{ memory }`. Text: the memory id.

### `relembra find`

`relembra find <query…>`. Ranked search (BM25, docs/specs/ranking-algorithm.md) over the
live memories of the scope and the global scope, ranked together. The words are joined by single spaces.

| Flag | Meaning |
|---|---|
| `--limit <n>` | At most n results, 1 to 100; default 10 |

`data`: `{ results: [{ memory, score }] }`, best first. Text: one memory line per result.

### `relembra recall`

The newest memories of the scope and the global scope first.

| Flag | Meaning |
|---|---|
| `--limit <n>` | At most n memories, 1 to 100,000; default 50 |
| `--retracted` | The owner view: retracted memories too, marked |

`data`: `{ memories }`.

### `relembra wake`

The bounded block a session starts with: pinned memories, recent ones, summaries, then an index.

| Flag | Meaning |
|---|---|
| `--budget <bytes>` | The most UTF-8 bytes, frame included, 1 to 1,000,000; default 9,500 |

`data`: `{ text, memoryIds }`. Text: the rendering.

With a global scope beside the session's, the wake is two `<wake>` frames on consecutive lines:
the session's scope, then the global scope, together within the budget. The library ranks
several scopes' memories together, newest first, so a full global scope would push every project
memory into the index; instead each part has a reservation (`src/cli/wake.ts`):

- Of the budget less the one newline between the frames, the session's part is reserved
  `floor((budget - 1) / 2)` bytes and the global part the rest: 4,749 and 4,750 of the default
  9,500.
- Room one part leaves unused goes to the other. The session's part is composed within its
  reservation first (a rendering that records nothing); the global part gets every byte that
  left; then the session's part is composed again in every byte the global part left. So each
  part holds at least what fits in its reservation, a small part costs the other nothing, and the
  two never exceed the budget.
- Within each part, the usual order: pinned memories, recent ones, summaries, then an index.
- A budget too small for two empty frames (under 29 bytes) is refused (`budget`).
- `memoryIds` lists the session's part, then the global part.

### `relembra brief`

`relembra brief <topic…>`. The bounded block for one topic: its find results, then their
summaries, over the scope and the global scope.

| Flag | Meaning |
|---|---|
| `--budget <bytes>` | The most UTF-8 bytes, frame included, 1 to 1,000,000; default 9,500 |

`data`: `{ text, memoryIds }`.

### `relembra zoom`

`relembra zoom <id>`. One memory with its full provenance and status, in the owner view (any
status, a tombstone included), and for a summary each source at the revision it was written
from, with the source as it is now (`null` when it cannot be seen).

`data`: `{ memory, sources: [{ memoryId, revision, memory }] }`. Text: the memory line, then
`key: value` lines; a promoted copy (written by a library host: the CLI has no `promote`, see
"Scope, principal and store") adds `origin: <id>@<revision>`.

### `relembra retract`

`relembra retract <id>`. Hides the memory from agents; the owner view keeps it. Summaries derived
from it are retracted too. When the memory or one of those summaries has owner trust, it needs
confirmation (see Trust).

`data`: `{ memoryId }`.

### `relembra redact`

`relembra redact <id>`. Replaces the memory's text with a tombstone everywhere, with every summary
derived from it. When the memory or one of those summaries has owner trust, it needs
confirmation (see Trust).

`data`: `{ redacted: [id], derived: [id…] }`.

### `relembra supersede`

`relembra supersede <id> [text]`. Writes a memory that replaces a live one, which stops being
served. The text is the second argument, or stdin. It also retracts the live summaries derived
from the replaced memory. When the replaced memory or one of those summaries has owner trust, or
with `--trust owner`, it needs confirmation (see Trust).

| Flag | Meaning |
|---|---|
| `--agent <name>` | As for note |
| `--harness <name>` | As for note |
| `--model <name>` | As for note |
| `--source <text>` | As for note |
| `--trust <tier>` | As for note |
| `--op-id <id>` | As for note |
| `--pin` | As for note |

`data`: `{ memory }`, the replacement.

### `relembra pending`

The session scope's memories due for a summary, oldest first: live, unpinned, not summaries, not
covered by a live summary at their current revision. Never the global scope's: a summary's
sources must be in the summary's scope.

| Flag | Meaning |
|---|---|
| `--limit <n>` | At most n memories, 1 to 100,000; default 50 |

`data`: `{ memories }`.

### `relembra summarize`

`relembra summarize [text]`. Writes a summary of the given sources, each at the revision it was
read at; refused (`source-changed`) if any source changed since. Its trust is the writer's,
capped at the least of its sources' (an explicit higher trust is refused). The text is the argument, or stdin.

| Flag | Meaning |
|---|---|
| `--agent <name>` | As for note |
| `--harness <name>` | As for note |
| `--model <name>` | As for note |
| `--source <text>` | As for note (provenance, not a summary source) |
| `--trust <tier>` | As for note; above the sources' trust is refused |
| `--op-id <id>` | As for note |
| `--of <id@revision>` | A source memory at a revision, such as `--of 3f…@1`; 1 to 100, repeatable |

`data`: `{ memory }`, the summary.

### `relembra sweep`

Redacts the scope's memories first noted more than n days ago, with their derived summaries. The
host schedules it (cron, launchd); relembra runs no timer. When anything it would redact has owner
trust (a superseded or retracted memory, or a derived summary, included), it needs confirmation
(see Trust), so a scheduled sweep never expires an owner rule unattended.

| Flag | Meaning |
|---|---|
| `--max-age-days <n>` | Required: the retention rule for the current scope, 1 to 36,500 |

`data`: `{ redacted: [id…], derived: [id…] }`.

### `relembra check`

Verifies the store: opening it checks that the file and its sidecars are owner-only regular
files, that the schema is not newer than this binary, and SQLite's schema verification; then
`check` runs SQLite's `integrity_check`, parses every event and checks its format version (1, or
2 for the promote events a library host may write; a newer one fails), and checks that the
store's directory is owner-only. Any failure exits 3.

`data`: `{ scope, store, integrity: "ok", schemaVersion, events, memories, walScrubPending,
erasurePending: { work, carriers } }`. `walScrubPending: true` is a warning, not a failure.
`erasurePending` counts, over the whole store, the redactions whose erasure work still has a
carrier no host answered for (`work`) and those carriers (`carriers`): counts only, never a memory
id or carrier id, which may belong to other scopes. The text adds `erasure pending: <n>
redactions, <m> carriers not acknowledged by a host` when `carriers` is not 0. The CLI has no
erasure hook, so what `relembra mcp` recorded stays pending until a library host opens the same
store and runs `Relembra.deliverErasures`; a carrier is `unsupported` only when such a hook says
so. Plain `wake`, `brief` and `find` record no carrier: the CLI prints them, and what a person or
script does with the output is outside erasure delivery.

### `relembra hook`

Prints the wake for a session-start hook, in the output format both harnesses document:

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "<wake>…</wake>" } }
```

- With a global scope, `additionalContext` holds the two `<wake>` frames described under
  [`wake`](#relembra-wake), within the same 9,500 bytes.
- Claude Code adds `hookSpecificOutput.additionalContext` to the context at the start of the
  conversation and caps it at 10,000 characters; the default wake budget, 9,500 bytes, fits
  (<https://code.claude.com/docs/en/hooks#sessionstart>, read 2026-10-31).
- Codex adds it as developer context; hooks are on by default
  (<https://developers.openai.com/codex/hooks>, which redirects to
  <https://learn.chatgpt.com/docs/hooks>, read 2026-10-31).
- The harness's JSON on stdin is never read.
- It fails open, unconditionally: with no scope or no store yet, and on any error (a usage error,
  a bad `RELEMBRA_SCOPE` or `RELEMBRA_GLOBAL_SCOPE`, `unsafe-runtime-env`, git missing, a
  corrupt, locked, loose or newer store), it prints nothing on stdout and exits 0, so a session
  always starts and no diagnostic reaches its context. An error leaves one line on stderr, `relembra hook: skipped (<code>)`.
- With `--json`, `data` is the same document, or `null` whenever it printed nothing.

Register it in `.claude/settings.json` or `~/.claude/settings.json` for Claude Code, and in
`.codex/hooks.json` or `~/.codex/hooks.json` for Codex (`init` prints this with the binary's path):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact|fork",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/env -i RELEMBRA_HOME=\"$RELEMBRA_HOME\" RELEMBRA_SCOPE=\"$RELEMBRA_SCOPE\" RELEMBRA_GLOBAL_SCOPE=\"$RELEMBRA_GLOBAL_SCOPE\" RELEMBRA_AGENT=\"$RELEMBRA_AGENT\" RELEMBRA_HARNESS=\"$RELEMBRA_HARNESS\" RELEMBRA_MODEL=\"$RELEMBRA_MODEL\" PATH=\"$PATH\" HOME=\"$HOME\" XDG_CONFIG_HOME=\"$XDG_CONFIG_HOME\" SystemRoot=\"$SystemRoot\" /path/to/relembra hook"
          }
        ]
      }
    ]
  }
}
```

The command starts the binary under `/usr/bin/env -i`, passing on only the variables it reads
apart from Bun's (an unset one arrives empty, which counts as unset). Bun acts on `BUN_OPTIONS`,
`BUN_BE_BUN` and its other startup variables before relembra's code runs, so a session's
environment could otherwise make the hook print Bun's version or run the Bun CLI. The command is
a shell line that relies on the shell expanding its `$` variables. Claude Code documents this:
without `args`, `command` "is passed to a shell: `sh -c` on macOS and Linux"
(<https://code.claude.com/docs/en/hooks>, "Exec form and shell form", read 2026-10-31). The
Codex hooks page does not say so outright, but its own examples rely on shell parsing
(`$(git rev-parse --show-toplevel)`, `~`) (<https://learn.chatgpt.com/docs/hooks>, read
2026-10-31). A launch under Codex itself has not been tested. Do not register the bare
`relembra hook`.

### `relembra mcp`

An MCP server over stdio supporting 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26 and
2024-11-05: an MCP client launches `relembra mcp` as a
subprocess and talks to it through stdin and stdout (the README lists the specification pages and
the client it was qualified with).

- **Scope, principal and store, as for every command.** They are resolved once, when the server
  starts, from the launch environment and working directory: `RELEMBRA_SCOPE` or the git project,
  the OS user at trust ceiling `agent`, `RELEMBRA_HOME`, and the global scope
  `RELEMBRA_GLOBAL_SCOPE`: `find`, `brief` and `wake` read it beside the session's scope, `note`
  and `retract` stay on the session's scope (retracting a global memory is `refused:
  scope-denied`). No initialize param, tool argument or `_meta` field
  changes them: every tool's input schema refuses an argument it does not declare, none declares a
  scope, principal, home or ceiling, and `trust` takes `agent` or `untrusted` only. Owner trust is
  never available: it needs a person at the controlling terminal, and the server has none.
  Provenance comes from `RELEMBRA_AGENT`, `RELEMBRA_HARNESS` and `RELEMBRA_MODEL`, else `unknown`,
  `mcp` and `unknown`; the client's self-reported `clientInfo` is not used.
- **Starting.** With no scope, no store, a bad `RELEMBRA_SCOPE` or `RELEMBRA_GLOBAL_SCOPE`,
  `BUN_OPTIONS` set or any other
  startup error, it writes `relembra mcp: <message> (<rule>)` on stderr and exits with the error's
  code (Exit codes), writing nothing on stdout. Otherwise it serves until stdin ends, answers the
  requests it has read, and exits 0.
- **Modern methods.** `server/discover`, `tools/list` and `tools/call`; every other method is `-32601`.
  A modern request must carry `io.modelcontextprotocol/protocolVersion` and
  `io.modelcontextprotocol/clientCapabilities` in `_meta` (`-32602` otherwise), and the version
  must be `2026-07-28` (`-32022`, with all five versions in `data.supported` and the requested
  version in `data.requested`, otherwise). Every modern result carries `resultType: "complete"` and
  `_meta["io.modelcontextprotocol/serverInfo"]`; `server/discover` and `tools/list` carry
  `ttlMs: 3600000` and `cacheScope: "public"` (neither names a user or scope). `tools/list` returns
  every tool in one page, so any `cursor` is `-32602`.
- **Legacy sessions.** `initialize` requires a string `protocolVersion` (`-32602` otherwise),
  returns that version if it is one of the four legacy revisions, else falls back to 2025-11-25.
  The result holds `protocolVersion`, `capabilities: { tools: {} }`, `serverInfo` and instructions.
  A second initialize is `-32600` and leaves the first negotiation unchanged. Requests without
  a modern protocol-version `_meta` key then use that revision: `ping` returns `{}`, `tools/list`
  and `tools/call` work, and every other method is `-32601`. Notifications are ignored except
  cancellation. Modern `_meta` always selects stateless modern handling, even within a legacy
  session. Legacy results omit `resultType`, `_meta`, `ttlMs` and `cacheScope`. Tool definitions
  in 2024-11-05 contain only `name`, `description` and `inputSchema`; 2025-03-26 adds annotations
  with `annotations.title`. From 2025-06-18 they have top-level titles, output schemas where
  defined and annotations, tool results may carry `structuredContent`, and `serverInfo` has
  `title: "relembra"`.
- **Tools,** in this order:
  - `note`: `text` (required), `pin`, `trust`, `source`, `idempotencyKey` (1 to 256 characters).
    Returns `{ memoryId }` as JSON text, and as structured content from 2025-06-18.
    `pin` with `trust: "untrusted"`
    is stored, but wake never renders an untrusted memory pinned, as with `relembra note`.
  - `find`: `query` (required), `limit` (1 to 100, default 10), `budget`. The ranked memories,
    rendered as `<memory>` lines in a `<find>` frame.
  - `brief`: `topic` (required), `budget`. The `<brief>` rendering.
  - `wake`: `budget`. The `<wake>` rendering; with a global scope, the two frames and the rule
    under [`wake`](#relembra-wake).
  - `retract`: `memoryId` (required). Returns `{ memoryId }`.

  `budget` is the most UTF-8 bytes of a rendering, frame included: 1 to 1,000,000, default 9,500.
  A rendering is escaped, run through the egress filter and measured after it, omitting whole
  entries; no tool returns memory text any other way.
- **Exposure.** The server process is the carrier for both eras: at start it
  picks the carrier id `mcp:` + a random UUID, kind `mcp`, and every `find`, `brief` and `wake`
  rendering that carries a memory is recorded for it (Store.recordExposure) before the response
  is written. A recording that fails is `-32603` (`data: { code: "store" }` or `internal`), so no
  unrecorded text leaves; a memory redacted while it was rendered, three times running, is
  `refused: redacted`. A later redaction lists the process as a pending carrier (`relembra check`,
  `erasurePending`). Nothing the server says claims the client deleted, forgot or dropped
  anything: an MCP server cannot reach a client's context.
- **Op ids.** The JSON-RPC id only correlates a response with its request: a client must use a new
  one on every retry, so it cannot be an op id. A `note` with an `idempotencyKey` carries op id
  `v1:` + SHA-256 of `["relembra-mcp", <scope>, "note", <key>]` as canonical JSON (the library's
  `integrationOpId`), so a retry with the same key and payload returns the first write, the same
  key with another payload is `op-conflict`, the same key in another scope is another write, and
  an MCP key cannot reuse a CLI `--op-id` of the same raw value by accident (a CLI caller that
  passes the derived value on purpose shares the write). Without a key every call writes once more, a retry after a
  lost response included. `retract` takes no op id: retracting a retracted memory changes nothing.
- **Errors.** A request that is not valid JSON or not UTF-8 is `-32700`; one that is not a single
  JSON-RPC 2.0 request object (an array outside a 2025-03-26 session, an id that is null or not an integer or string, no
  `method`) is `-32600`; both without an `id` when it could not be read. An unknown tool, or
  arguments the tool's input schema refuses, is `-32602`, and the message names neither the tool
  nor a value. In 2025-11-25 only, input-schema failures instead return a tool result with
  `isError: true` and `refused: invalid-arguments (<problem>)`; unknown tools stay `-32602`.
  A refusal by relembra is a tool result with `isError: true` and the text
  `refused: <code>` or `refused: <code> (<rule>)`, with the codes of the error table (exit 1 and
  2), plus `egress-denied` when the host's egress filter refuses a rendering; it never echoes the
  input or a memory. A store error or a bug (the exit-3 codes) is `-32603`, `data: { code }`.
- **Framing.** One message per line, as the stdio binding prescribes. A line holds at most 1 MiB
  (1,048,576 bytes) before its newline, a trailing CR included and dropped: the largest request a
  tool takes is a few KiB, and the cap bounds what one line can make the server hold. A longer line
  is discarded as it streams and answered with `-32600`, `data: { maxBytes: 1048576 }`, and the
  server reads on. Blank lines are skipped. A final line with no newline when stdin ends is not a
  message and is never executed; the server logs it on stderr. Requests run one at a time in
  arrival order while reading continues, so `notifications/cancelled` for a request still queued or
  running means it gets no response; other notifications are ignored. Logs go to stderr only.
- **Batches.** Only a negotiated 2025-03-26 session accepts arrays, decided in request order so
  a batch may be pipelined after initialize. Responses form one array line in batch order;
  notifications and cancelled requests have no response. A notification-only batch writes
  nothing; an empty array gets one `-32600` error object. An initialize inside a batch gets
  `-32600` for that element. In a batch that can be accepted (the session, or the initialize queued
  ahead of it, negotiates 2025-03-26), each request element counts toward the pending cap; excess
  elements get `-31000` inside the response array.
- **Pending requests.** At most 64 requests are queued or running at once. A request past that is
  answered at once with `-31000` (`Server overloaded`), `data: { maxPending: 64 }`, is never
  queued, and may be sent again once responses arrive. The 2026-07-28 revision defines no
  overload code and reserves `-32020` to `-32099` for the codes it defines, so this code sits
  outside `-32768` to `-32000`, as its Error Codes section asks of new codes. Errors answered
  without running a request (this one, and the framing and parse errors) are capped the same way:
  together with queued or unflushed batch lines, at 64 the server stops reading stdin. It reads on as
  long as the client reads its responses, and a client that never reads cannot make it hold more.

### `relembra export`

Prints the scope's JSONL export on stdout: a header line, then every event of the scope in seq
order, in the owner view, with redacted memories only in their tombstone form. The format, field
by field, is `docs/FORMAT.md`, "JSONL export". Only the current scope is exported: no argument
widens it. The export holds the scope's memory text, so redirect it into a file only you can
read (`umask 077`).

`data`: `{ header, events }`, the same lines parsed. Text: the JSONL itself.

### `relembra import`

`relembra import <file>` replays a relembra export into the scope; `relembra import --optmem
<dir>` imports an OptMem store, `<dir>` being the directory holding `LOG.txt` or the one holding
`memory/LOG.txt`. Exactly one of the two. Both run in one transaction and import nothing when
refused; importing the same file again adds nothing. Imported memories carry at most `agent`
trust and are never pinned. The import itself runs at `agent` trust and prompts for nothing, so a
line that retracts, supersedes or redacts an `owner` memory, or a summary of `owner` trust derived
from the memory it changes, is refused (`denied:above-ceiling`). Rules: `docs/FORMAT.md`, "Import of an export" and "OptMem import".

- An export must name only the current scope (`scope-denied` otherwise): it imports into the
  scope it was exported from. Set `RELEMBRA_SCOPE` to that scope to import it elsewhere.
- An unreadable file, a file that is not UTF-8, or a directory without `LOG.txt` is a usage error
  (`bad-value`). So is an import path, or an OptMem `LOG.txt`, that is not a regular file (a FIFO,
  device, socket or directory; a symlink to a regular file is followed): it is refused before it
  is opened for reading, and the open never waits, so a FIFO cannot hang the import.
- A file over 64 MiB is refused before it is read (`too-large:file`); an export line over
  256 KiB (`too-large:line`), more than 100,000 events (`too-large:events`) or OptMem records
  (`too-large:records`) are refused before any line is parsed. The numbers and why:
  `docs/FORMAT.md`, "Import limits".
- An OptMem store is named by its directory's real path, so moving it imports its records again.
  Imported into two scopes, it gives each scope its own memories and checkpoint.
  Provenance `agent`, `harness` and `model` come from the environment as for note.

| Flag | Meaning |
|---|---|
| `--optmem <dir>` | Import the OptMem store in `<dir>` instead of an export file |

`data`: `{ imported, skipped, refused: [{ line, rule }] }`; `refused` lists OptMem lines the guard
refused, by line and rule, never their text. Text: one `key: value` line each.

## Build

`bun run build:cli` runs `build/cli.ts`: `bun build --compile --aot --trim
--no-compile-autoload-dotenv --no-compile-autoload-bunfig` for the native target, writing
`bin/relembra` (`bin/relembra.exe` on Windows) and `bin/relembra.sha256` (`sha256sum` format). It
skips the build when the sources, the script and the Bun version are unchanged; `--force`
rebuilds. No fallback build exists (IMPLEMENTATION-PLAN §4.6).

`--aot` builds only for the platform it runs on, so every release binary is built on its own
platform: macOS arm64 locally, Linux x64 and arm64 and Windows x64 and arm64 in the hosted CI's
`cli` job. All of them use one Bun canary, pinned in `build/bun-toolchain.txt` by its immutable npm
package and that package's sha512; `scripts/bun-toolchain.sh <platform> <dir>` downloads, checks
and unpacks it.

## Install

`sh install.sh <binary> <checksum-file> [<dest-dir>]` copies the binary, verifies the copy's
sha256 against the checksum file's line for the binary's name, and only then moves it to
`<dest-dir>/relembra` (default `~/.local/bin`). A tampered file, a missing checksum file, a
missing line or a malformed hash is refused with exit 1, and nothing is installed or replaced.
So is a directory or a symlink at `<dest-dir>/relembra` (`mv` would put the file inside the
directory, or leave a link's target in place); only a regular file there is replaced. The check
and the move are not atomic: a process running as the same user could swap the path between
them, the same-user limit stated under Trust. `install.sh` serves macOS and Linux; Windows is
installed by hand (below).

## Windows

The release binaries `relembra-windows-x64.exe` and `relembra-windows-arm64.exe` run on Windows
10 and 11. What differs from macOS and Linux:

- **Scope.** Windows has no uid, so the OS user part is `sid-<SID>`, the logon account's
  security identifier as `%SystemRoot%\System32\whoami.exe /user` prints it, for example
  `sid-S-1-5-21-1004336348-1177238915-682003330-1001`. Like a uid it is one per account, so
  `PC\alex` and `CORP\alex` are two users, and renaming an account keeps its scope. It is never
  read from `%USERNAME%`, which a caller can set and the hook's `env -i` clears. If `whoami`
  cannot name the account, the scope is refused (`no-scope`) rather than shared. Folders are
  compared by their canonical real path, case-folded, so `C:\Repo` and `c:\repo` are one project.
- **Store protection.** A new Windows store requires a new leaf directory. The folder receives
  a protected descriptor at creation: full control for the current user's SID, SYSTEM and
  Administrators only, inherited by files and subfolders. The database and SQLite's sidecars
  inherit it. A preexisting directory without the database is refused without taking ownership
  or changing any ACL: existing handles cannot be revoked by tightening permissions. Choose
  another, absent directory; existing data is never moved or deleted. Two processes creating
  the same store at once are serialised by a named mutex (`Global\relembra-<hash>` of your SID
  and the folder, private to you, SYSTEM and Administrators); the second finds the first's
  database and opens it. A mutex of that name held by another account only prevents creation.
- **Where the store is safe.** Before any directory is created, relembra reads every existing
  ancestor's owner SID and DACL through the system Windows PowerShell 5.1 and .NET Framework.
  It refuses foreign owners and permissions allowing another account to rename, delete,
  re-permission, change attributes or replace a directory, or create the store folder first.
  Reparse points and inherited grants beyond read and execute are also refused. Trusted
  accounts are you, SYSTEM, Administrators and TrustedInstaller.
  Missing components are created with their private descriptor from the first instant and
  verified afterwards. No access-list file or compiler uses TEMP or TMP. A blocked or missing
  PowerShell, timeout, unreadable descriptor or malformed result prevents creation.
  Existing ancestors must have been protected throughout their relevant lifetime: current
  permissions cannot reveal handles opened before those permissions were restricted. These
  checks do not certify such history or provide an unconditional guarantee against it.
  Checks run only for a new database. Existing stores keep their existing behavior and are
  not recertified or repaired; an older store or a folder whose ACL was widened needs its
  own security assessment. See [the security specification](specs/w-nv1/spec.md).
- **Hook.** `relembra init` prints the same session hook as elsewhere, a `sh` command line under
  `/usr/bin/env -i`. Claude Code runs hook commands in Git Bash on Windows
  (<https://code.claude.com/docs/en/hooks>, read 2026-11-02), which has `/usr/bin/env`; without
  Git Bash, Claude Code falls back to PowerShell, where this command does not run. Install Git for
  Windows.
- **Owner trust.** The confirmation code is read from `/dev/tty`, which Windows does not have, so
  every action that needs owner trust is refused as `owner-confirmation-required` (`no-tty`):
  `--trust owner`, and a `retract`, `redact`, `supersede` or `sweep` that would change an owner
  memory. Agent-trust work runs as elsewhere; this release has no owner trust on Windows.
- **Line breaks in arguments.** A Windows launcher can split an argument at a line break
  before relembra reads it (Git for Windows' MSYS runtime does), and such a note is then refused
  as a usage error (`extra-argument`, exit 2) rather than by the guard. Either way nothing is
  written; on stdin the guard refuses it as `multi-line`.
- **Release tooling.** The library and the CLI are tested on Windows. The release gate
  (`scripts/ci.sh`, `scripts/check-release.sh`), the benchmarks, the evaluation harness,
  `install.sh`, the package smoke test and the site assembly are POSIX tools that run on macOS and
  Linux only.
- **Install.** Check the binary against `SHA256SUMS`, then put it on `PATH` as `relembra.exe`:

  ```powershell
  (Get-FileHash relembra-windows-x64.exe -Algorithm SHA256).Hash.ToLower()
  Select-String relembra-windows-x64.exe SHA256SUMS   # the two hashes must be equal
  New-Item -ItemType Directory -Force "$HOME\.local\bin" | Out-Null
  Copy-Item relembra-windows-x64.exe "$HOME\.local\bin\relembra.exe"
  ```
