# 07: The CLI as a Bun AOT binary, with session-start hooks and a verified installer

**What to build:** A developer installs one binary, runs `relembra init`, and agents use `note`, `find`, `recall`, `wake`, `brief`, `zoom`, `retract`, `redact`, `supersede`, `pending`, `summarize`, `sweep` and `check`; scope comes from the git project and OS user (or `RELEMBRA_SCOPE`), never from arguments; `relembra hook` prints the wake for Claude Code and Codex session starts.

**Blocked by:** 06

**Status:** done, pending review

- [x] Each command has an end-to-end test that runs the compiled binary against a temp RELEMBRA_HOME
  - `test/cli/commands.test.ts`: all 15 commands against `bin/relembra`, each with a temp `HOME`,
    `RELEMBRA_HOME` and git repository (`test/cli/support.ts`). Its last test proves every command
    in the table ran with `--json` and exit 0.
- [x] Bad input is tried: blank, 281 bytes, multi-line, bidi, a credential shape, 10 MB on stdin
  - `test/cli/input.test.ts`: blank (argument, whitespace, empty stdin, a lone newline); exactly
    280 bytes accepted and 281 refused, with `é` costing 2 bytes, as an argument and on stdin;
    multi-line (`\n`, `\r\n`, stdin); bidi (U+202E, U+2066) and zero-width (U+200B, U+FEFF);
    a credential shape refused and never echoed, with a benign mention accepted; 10 MB on stdin
    refused as `too-long` in under 10 s with empty stderr, then a normal write; invalid UTF-8 as
    `ill-formed`; provenance breaking a guard rule. Each refusal checks that nothing was stored.
- [x] No argument can change the scope (test)
  - `test/cli/scope.test.ts`: on every command, `--scope X`, `--scope=X`, `-s X`, `--project`,
    `--home` and `--RELEMBRA_SCOPE` exit 2; scope-shaped text is stored in the environment's
    scope; nothing reaches the other scope; the table has no such flag. Positive controls:
    `RELEMBRA_SCOPE` changes it, another repository gets another scope. Also: a `.env` and a
    `bunfig.toml` preload in the project are ignored; `USER` set, changed or unset does not move
    it; same-named repositories differ; ssh and https origins match; worktrees share; a moved and
    renamed folder with an origin keeps its memories.
  - Red: with a `--scope` flag patched into `note`, the test failed (`status` 0, expected 2).
- [x] `bun compile --trim` builds the binary; `install.sh` verifies a sha256 before installing (tested with a good and a tampered file)
  - `bun run build:cli` (`build/cli.ts`) runs `bun build --compile --aot --trim
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig` and writes `bin/relembra` and
    `bin/relembra.sha256`.
  - `test/cli/install.test.ts`: good file installed and runnable; tampered file refused with
    nothing installed and an earlier install kept; missing checksum file, missing line, malformed
    hash and empty file refused; the real binary with its build checksum installs and runs.
  - Red: with the hash comparison mutated to `if false`, both tamper tests failed.
- [x] The cold start of `relembra wake` on a 20,000-memory store is measured and recorded
  - `docs/bench/cli-2026-10-31.md`: wake p50 53 to 60 ms, p95 61 to 102 ms over three runs of 50
    on a shared machine (load 17 to 55 on 18 cores); find p50 106 to 178 ms; in-process find p95
    136 to 277 ms, so the 150 ms warm gate held in one run of three and ticket 19's 50 ms budget
    is far off. Repeat on an idle machine before quoting.
- [x] Every command takes `--json` and prints `{ ok, data | error: { code, rule? } }`; exit codes 0/1/2/3; `docs/CLI.md` is checked against the implementation by a test
  - `test/cli/contract.test.ts` parses `docs/CLI.md` and compares commands, per-command flags
    (and whether each takes a value), global flags, error codes with their exit codes, exit codes
    and environment variables with `src/cli/commands.ts` and `src/cli/errors.ts`, both ways.
  - Exit 1, 2 and 3 are each exercised; exit 3 by no store, a newer schema (left byte-identical),
    a 0644 store (not chmodded), a 0000 store and a corrupted store (`test/cli/store.test.ts`).
- [x] The full acceptance suite runs against the AOT artifact; a fallback build, if any, passes the same suite (§4.6)
  - The suite runs only against the binary (`RELEMBRA_BINARY`, or `bin/relembra` built once per run
    and skipped when its inputs are unchanged). It skips with a printed message only when no binary
    exists and `RELEMBRA_REQUIRE_BINARY` is unset; CI sets it. No fallback build exists: AOT
    works on darwin-arm64 with Bun 1.4.4.
- [x] The benchmark records commands, artifact, dataset, repetitions, machine and runtime versions
  - `bench/cli.ts` and `docs/bench/cli-2026-10-31.md`.

## Comments

Decisions, each recorded in `docs/CLI.md` where it is user-visible:

- **Scope.** `RELEMBRA_SCOPE`, else `uid-<uid>/<name>-<16 hex of sha256(project key)>`. The key is
  `origin:` plus the normalized origin URL (host lowercased; scheme, `user@`, port, trailing `/`
  and `.git` removed; path case kept), else `gitdir:` plus the real path of the common git
  directory. `<name>` is the origin's last segment, else the repository's folder name. Since the
  review (below) both come from git itself, not from reading `.git` files.
  - The first build used `<OS user>/<folder name>`, as the spec's "git top-level directory name"
    said. Review found the collision (`~/dev/x/api` and `~/work/api` shared memories); fixed in
    1a99a59 per the coordinator's rule, with one deviation: the coordinator asked for the folder
    basename beside the hash, which would change the scope on a folder rename even with an
    origin, contradicting the same rule's "renaming must not orphan memories". The origin's repo
    name is used instead when there is an origin.
  - Trade-off: clones of one remote share a scope; with no origin, a move or rename orphans the
    memories until moved back or `RELEMBRA_SCOPE` names the old scope.
  - The uid, not the user name: Bun 1.4.4's `os.userInfo().username` reads `$USER` and answers
    `unknown` without it (measured; Node uses getpwuid), which would split a user's memory.
  - The first build rejected spawning git for cold start and parsed `.git/config` by hand. The
    review showed the parser wrong on quoting, comments, relative remotes, ports and separate
    git dirs; the coordinator reversed the choice (see Review fixes).
- **Policy (single-user trust model).** The OS user is the principal and owns its scope: read,
  write, pin, retract, redact, supersede; writes default to `agent`. Trust ceiling `agent` since
  the review; owner trust needs confirmation at the terminal (see Review fixes). The CLI is
  organization, not isolation (§3).
- **Provenance.** Flags, else `RELEMBRA_AGENT/_HARNESS/_MODEL`, else `unknown`, `cli`, `unknown`;
  host from `os.hostname()`. Defaults rather than required flags, so `init` and a human's `note`
  work. Provenance never grants trust.
- **`zoom`** was undefined: defined as one memory by id with provenance, status and summary
  sources, in the owner view. It needed the one library change: `Relembra.zoom` (aa0a530), which
  reads `tx.memory` through the existing `visible()` rule. Rejected: `recall` plus a filter (O(n)
  and blind to superseded memories and tombstones).
- **`check`**: open (file types and modes, schema version, SQLite verification), then
  `integrity_check`, every event's JSON and format version, and the home directory's mode.
- **`sweep`** takes `--max-age-days` for the current scope: the CLI has nowhere else to hold
  retention rules.
- **`hook`** prints `hookSpecificOutput.additionalContext`, the shape both Claude Code and Codex
  document for SessionStart (URLs in `docs/CLI.md`), never reads stdin, and fails open: exit 0
  and nothing on stdout on any failure, so a session always starts.
- **stdin** is read up to 282 bytes (280 and `\r\n`), then refused as `too-long` at once, with a
  5-second deadline; a terminal on stdin is a usage error.
- **Build flags.** Bun's `.env` and `bunfig.toml` autoload default to on in compiled binaries; both
  are off, so a project cannot set the scope or preload code (tested).
- **`package.json`**: only the scripts `"build:cli": "bun build/cli.ts"` and
  `"bench:cli": "bun bench/cli.ts"`. No `bin` entry: `bin/` is
  git-ignored, so a `bin` field would point npm at a missing file; the binary ships through
  `install.sh`. `tsconfig.json` and `biome.json` include `build/` and `bench/`.
- **install.sh** takes local files (`<binary> <checksum-file> [<dest>]`); downloading release
  binaries waits for releases, which need the owner's go (ticket 11).

### Review fixes (Sol, verdict FIX, 12 findings)

Each finding has a test that failed first against the previous binary (red run: 18 of 81 CLI
tests failed, one or more per finding) and passes now, with a positive control. Binding decisions
from the coordinator, recorded in `docs/CLI.md`:

- **#1 Owner impersonation (P1).** Every invocation has trust ceiling `agent`. `--trust owner`,
  and `supersede`, `retract` or `redact` of a memory whose current revision has owner trust,
  run only after a confirmation on `/dev/tty`: the text shown (guard-checked first), a random
  6-character code typed back within 60 s. No controlling tty: exit 1,
  `owner-confirmation-required`, rule `no-tty` (also `mismatch`, `timeout`). Sol's repro (note
  `--trust owner --pin`, then supersede) is refused and the wake still shows the owner rule.
  Documented plainly: a same-user process is not a security boundary, and one that drives a
  pseudo-terminal can read the code.
  - My extension, flagged: `summarize --trust owner` needs the same confirmation, and so does a
    `sweep` that would expire an owner-trust memory (or a scope too large to check in one
    recall), since expiring an owner rule is a mutation of it. Its red was shown by mutating the
    check off (`sweep --max-age-days 30` then exited 0).
- **#2 BUN_OPTIONS (P1).** Set `BUN_OPTIONS` or `BUN_BYTECODE_ORDER_OUT`, or a non-empty
  `process.execArgv`: exit 2, `unsafe-runtime-env`; the hook exits 0 silently. `BUN_BE_BUN=1`
  replaces the binary with the Bun CLI before relembra's code runs, so it cannot be refused from
  inside; documented.
- **#3, #4, #5 Scope from git (P1, P2).** The hand-written parser is gone. `git -C <cwd>
  rev-parse --path-format=absolute --git-common-dir` (real-pathed) names the repository, bare
  ones included; `git remote get-url origin` gives the effective URL. Deviation: the coordinator
  named `ls-remote --get-url origin`, which prints `origin` with exit 0 when there is no origin
  (indistinguishable from a relative remote named `origin`); `remote get-url` applies the same
  insteadOf rewriting and exits 2 instead. Local and relative remotes resolve to a real path
  (`file:` key); non-default ports are kept; the name comes from the common dir's repository or
  the origin, never the worktree folder. Git runs with no shell, a 2 s timeout, and only `PATH`,
  `HOME` and `XDG_CONFIG_HOME` in its environment. `GIT_CONFIG_NOSYSTEM` is not set: the system
  config is administrator-owned and the scope should follow the user's own git. Git missing or
  timing out: `no-scope` (`git-unavailable`). Needs git 2.31+.
- **#6 stdin.** Refused at once past 282 bytes even with stdin open; a 5 s deadline
  (`input-timeout`, exit 1).
- **#7 BOM.** `ignoreBOM: true`, so a leading BOM on stdin reaches the guard
  (`zero-width-character`), as in an argument.
- **#8** `--help --json` (any order, after a command too) prints `{ ok: true, data: { usage } }`.
- **#9 Hook.** Fails open unconditionally: exit 0, nothing on stdout (`{ ok: true, data: null }`
  with `--json`), one `relembra hook: skipped (<code>)` line on stderr.
- **#10** The matcher includes `fork`: `startup|resume|clear|compact|fork`.
- **#11 install.sh** refuses a directory or a symlink (to a file or a directory) at
  `<dest>/relembra`, and nothing lands.
- **#12** `CI` set makes a missing binary fail the suite (`REQUIRE` in `test/cli/support.ts`).
  The fix landed with the tests; its red was shown by mutating `REQUIRE` back to
  `RELEMBRA_REQUIRE_BINARY` only (the CI case then failed: the run passed with skips).
- **Bench.** Re-measured with two new rows, `wakeGit` and `hookGit`, where git derives the scope
  (the earlier rows set `RELEMBRA_SCOPE` and never ran git); see
  `docs/bench/cli-2026-10-31-review.md`.

### Re-review fixes (Sol at 01ac3fa, FIX, 6 findings; security review, 2)

Every item had a test that failed first against the 01ac3fa binary: 11 tests in all, the 4
library preview tests among them. Each one passes now, with a positive control.

- **Library change, the only one (additive; no existing behaviour changes):**
  `Relembra.sweepPreview(now)` and `Relembra.redactionPreview(context, { memoryId })`, in
  `src/relembra.ts`. They return the memories `sweep(now)` and `redact` would erase, and change
  nothing. `sweep` and `redact` now build their own work from the same two helpers
  (`sweepPlan`, `redactionPlan`), so a preview is exactly the operation: the same `tx.expiring`
  query and exclusive boundary, the same derived closure, the same visibility and ownership
  checks. `test/preview.test.ts` asserts each preview equals what the operation then redacts.
  - Rejected: enforcing the trust ceiling inside the library's redact and sweep. The default
    ceiling is `agent`, so that would forbid every existing library host from erasing an owner
    memory it owns. Erasure by the scope owner should stay possible (it is how a leaked secret
    is removed). Sweep has no principal at all. The CLI gates on the previews instead, and
    raises its ceiling only after the person at the terminal confirms.
- **#1 (P1) / security #7, sweep.** The gate checks `sweepPreview(now)`, using the same `now`
  the sweep then uses. That covers superseded and retracted memories and derived summaries,
  where recall did not. Sol's repro (an owner rule from 400 days ago, superseded today, then
  `sweep --max-age-days 30` with no tty) is refused `no-tty`, and the rule stays superseded,
  not redacted.
- **Security #8, cascades.** `redact` checks every memory `redactionPreview` returns. `retract`
  and `supersede` check the target and the live summaries in it, which they retract. The
  library already never lets a summary outrank its sources, so the test reaches the case by
  lowering a source's stored trust (data from an import or a foreign writer).
- **#2 PATH.** Git is the first executable `git` on PATH among absolute entries outside the cwd
  and the repository around it. That filtered list is also git's PATH. Tested with `.`, an empty
  entry, `bin` and an absolute in-repository `bin`; the fake git's marker never appears, and
  invoking the fake directly writes it.
- **#3 newlines.** Git's output is used whole, less its final newline. A control character in
  a path or URL is refused (`no-scope`, `unsupported-path`), never cut. A trailing space is kept
  (positive control).
- **#4 relative origin base.** Resolved against `rev-parse --show-toplevel`, as git resolves
  it, or the git directory when bare. This third git call happens only for a local origin. The
  name still comes from the common dir. Sol's separate-git-dir repro no longer collides.
- **#5 file URLs.** Decoded with `fileURLToPath`; a file URL naming another host is
  `unsupported-origin`. The path and the `%20` URL give one scope.
- **#6 hook launcher.** `init` prints `/usr/bin/env -i <the variables relembra reads, Bun's
  excepted, as NAME="$NAME"> <binary> hook`. Through `sh -c`, `BUN_OPTIONS=--version`,
  `BUN_OPTIONS=--help` and `BUN_BE_BUN=1` all still produce the wake, and `RELEMBRA_SCOPE` still
  passes through. Without the launcher, the bare binary does not produce the hook (positive
  control). The in-binary refusal stays for direct use. That Claude Code runs `command` through
  `sh -c` is documented. That Codex does is inferred from its examples, not tested.

### Round-3 fixes (Sol at 7b089cd, FIX, 3 findings and a flake)

Each finding had a test that failed first against the 7b089cd code; each passes now, with a
positive control.

- **Library change (additive; without the new argument nothing behaves differently):** a new
  `Approval { expect?: readonly Memory[] }`, which `RedactInput`, `RetractInput` and
  `SupersedeInput` extend and `sweep(now, approval?)` takes, and a new `PlanChangedError`, both
  exported from `src/index.ts`. With `expect`, each of the four mutations plans again inside its
  own write transaction and compares the set (whole records since round 4, below); a
  difference throws `PlanChangedError` and writes nothing. Retract and supersede compare against
  `redactionPreview` (the memory and its derived closure), redact against its plan, sweep against
  `sweepPreview(now)`. `redactionPreview` now takes `ZoomInput` (`{ memoryId }`), since an
  approval means nothing to a preview. Files: `src/relembra.ts`, `src/errors.ts`, `src/index.ts`;
  tests in `test/plan.test.ts` (all five failed first: the mutations resolved).
  - Rejected: a digest of the plan instead of the memories. It saves the host nothing (it has
    the preview in hand) and hides which memory changed from anyone debugging a refusal.
- **#1 (P1), confirmation bound to the plan.** retract, redact, supersede and sweep hand the
  preview they confirmed to the library as `expect`. On `PlanChangedError` the CLI drops back to
  agent trust, previews again, and prompts again when owner memories are in the new plan, marked
  `(changed since the last prompt)`. After three changed plans it fails with `plan-changed`
  (exit 1), having written nothing. `test/cli/race.test.ts` runs Sol's repro at a real pty for
  each command, a second process (`concurrent-write.ts`) summarizing the source while the first
  prompt waits: against the old binary the unseen summary was erased or retracted in all four.
  Now the second prompt shows it and a wrong code leaves everything intact; the positive control
  (the same race, confirmed twice) goes through. `pty-confirm.py` now answers a list of prompts
  and can run a command between a prompt and its answer.
- **#2 (P2), a git link into the repository.** `hostGit` realpaths the executable, passes over
  one whose target is inside the working directory or its repository, and runs the canonical
  path. The test links an outside PATH entry's `git` to a fake in the repository: its marker
  never appears, and invoking the link writes it.
- **#3 (P2), significant spaces.** `normalizeRemote` no longer trims; `runGit` already strips only
  git's final newline. Origins `/x/upstream` and `/x/upstream ` now give two scopes, and a second
  clone of the same origin still shares one.
- **Flake.** Every plain `test()` in `test/cli/install.test.ts` passes a 60 s deadline. No
  assertion changed (`git diff -w` shows deadlines only).

### Round-4 fixes (Sol at 3622d19, FIX, 2 findings)

Each had a test that failed first; each passes now, with a positive control.

- **Library change (behaviour of the round-3 `expect` only):** the approval comparison in
  `src/relembra.ts` (`planEntry`) now serializes the whole `Memory` record, object keys sorted at
  every depth, instead of id, seq, revision number, status and trust. Text, scope, provenance and
  any field added later count. Nothing else in the library changed.
- **#1 (P2), in-place rewrites.** `test/plan.test.ts` rewrites the source's text, scope or
  provenance through `tx.putMemory` after the preview, for each of redact, sweep, retract and
  supersede: 11 of 12 failed first (sweep with a changed scope already refused, since the memory
  leaves the sweep's scope). At a PTY, `concurrent-write.ts edit` rewrites the text while the
  redact prompt waits: with the library change stashed the memory was redacted; now the second
  prompt shows the new text and a wrong code keeps it live.
- **#2 (P2), file URLs with end spaces.** `filePath` in `src/cli/scope.ts` decodes git's raw
  string itself (empty or `localhost` host, then `decodeURIComponent` on the path) instead of
  `fileURLToPath`, whose URL parsing trimmed a trailing space. `file:///…/upstream` and
  `file:///…/upstream ` give two scopes; a file URL equals its path and its `%20` form. Another
  host, an encoded `/` and a malformed escape stay `unsupported-origin`; a decoded control character
  is now `unsupported-path`, as in git's own output. A `?` or `#` is now part of the path, where URL
  parsing cut it off as a query or fragment.

### Round-5 fix (Sol at fcbc5f5, FIX, 1 finding)

- **Library change (the round-3 `expect` comparison only):** `matchPlan` in `src/relembra.ts`
  matches the plan by id and compares each record with `isDeepStrictEqual` from `node:util`,
  replacing the round-4 JSON signature. A cycle and a BigInt no longer throw `RangeError` or
  `TypeError`; `[undefined]` and `[null]`, NaN and Infinity, and a missing and an undefined field
  no longer collide. Any failure to compare is a `PlanChangedError`. `test/plan.test.ts` drives
  each case through `redact({ expect })`: all five failed first, each collision with a
  fresh-preview positive control.
- The scope-moved sweep assertion Sol flagged was in Sol's own repro script, not in this suite:
  the library test here expects `PlanChangedError` for a stale approval (one memory approved, none
  planned), which is right; the CLI then previews an empty sweep and exits 0, as Sol observed.

### Round-6 fix (Sol at 7ac469c, FIX, 1 finding)

- **Library change (the round-3 `expect` comparison only):** `matchPlan` in `src/relembra.ts`
  now reads the approval slot by slot (`approves`), since `map`, `every` and a `Set` skip a hole
  or count it as `undefined`, so `new Array(1)` approved a one-memory plan and
  `[source, <hole>]` approved an unseen derived summary. Every slot must be an own entry holding
  an object with a string id the plan has, each id once, deep-equal to the planned record; a
  non-array approval fails too. All of it stays inside the `try`, so the outcome is
  `PlanChangedError` or a match. `test/plan.test.ts` drives `new Array(1)` and
  `[approved source, <hole>]` through redact and sweep: all four failed first (the mutations
  committed); each has a valid-approval control. Retract and supersede use the same function.

### Round-7 fix (Sol at d1cd76f, FIX, 1 finding)

- **Library change (the round-3 `expect` comparison only):** `approves` in `src/relembra.ts`
  copies the approval into a plain array in one pass (`Array.prototype.slice.call`, inside the
  `try`), reads its length once, validates the copy, and succeeds only when every planned record
  was approved exactly once (`seen.size === planned.length`). A Proxy whose `length` changes
  between reads, or a getter that truncates the approval, can no longer skip records. The
  `Approval` doc comment now states the threat model: concurrent writers, not a hostile caller,
  which could leave `expect` out. `test/plan.test.ts` drives Sol's length-changing Proxy
  through redact: it failed first (the redaction committed) and passes now, with a valid-plan
  control.

### Trust ceiling on retract and redact (coordinator, security review of 08's merge)

- **Library change (behaviour):** `retract` and `redact` now refuse with
  `ProvenanceError("trust", "above-ceiling")`, writing nothing, when a memory they would change
  is above `trustCeiling(principal)`: for redact the target and every summary derived from it
  (what `redactionPreview` lists), for retract the target and the live summaries it retracts.
  One exported helper in `src/relembra.ts`, `enforceCeiling(principal, memories)`, makes the
  check; supersede's target check now calls it too (same behaviour), and an event replay can.
  `redactionPreview` and `sweepPreview` do not check it, and retention `sweep` stays exempt (no
  principal; said in a comment and in its API doc). docs/ARCHITECTURE.md states the rule under
  Principal, and the API doc comments say it. This supersedes the round-2 note above that
  rejected enforcing the ceiling in the library: the CLI's prompt protects only the CLI.
- **Tests:** `test/ceiling.test.ts`. An agent-ceiling principal retracting or redacting an owner
  memory, and one retracting or redacting an agent memory whose cascade reaches an owner
  summary, are refused: all four failed first. Positive controls: an owner-ceiling principal
  does each; an agent-ceiling principal still changes agent memories; previews at agent ceiling
  list owner memories. The PTY suites (race, trust, cascade) stay green: preview at agent,
  prompt, commit at owner.
- **Follow-up (security review of 7be26cb):** supersede checked only its target, then retracted
  the target's live derived summaries, so an agent-ceiling supersede could retract an owner
  summary of an agent memory. A shared `liveDerived(tx, memoryId)` now gives what retract and
  supersede retract; both check the ceiling against `[target, ...liveDerived]` and then retract
  exactly that list (`retractAll`, replacing `retractDerived`), so the check and the write cannot
  drift. Red test in `test/ceiling.test.ts`: an agent-ceiling supersede of an agent memory with
  an owner-trust live summary is refused and writes nothing (failed first); control: with an
  agent summary it goes through and retracts the summary.
