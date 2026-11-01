# Architecture: relembra, an open-source memory core for AI agents

Status: accepted, 2026-10-30. The name is `relembra` (Portuguese for "remind"); MIT licence.

## What it is

A curated, scoped, bounded, durable, erasable and measured memory that any agent host can plug
in. It ships as one TypeScript package with subpath exports, plus a single-file CLI. The host owns
identity, storage and runtime; the core owns the rules.

## Requirements carried over from the source projects (ideas only, no copied code)

| From | Kept | Left out |
|---|---|---|
| OptMem (no license, so nothing is copied) | Curated one-line notes; byte-budgeted wake; agent-written compression; lexical ranking with pt/en accent folding; a credential guard; one-command install | One flat stream with no scope; no erasure; a Python single file |
| pi-durable (MIT) | A durable journal; replay-safe tools keyed by stable task and call ids; the extension model, as the default integration | Coupling the core to it: it stays behind an adapter |
| ai-memory (MIT) | Cross-agent sharing; per-project knowledge; attribution and audit; an MCP surface | A mandatory server; deleted text kept in git history; SQLite plus git as two sources of truth |
| An earlier design plan | Scope from authenticated host context, never from model arguments; authorization before retrieval; erasure that reaches derived copies; idempotent writes; an authority fence; provenance; memories rendered as evidence, never as instructions; eval-gated releases | Anything specific to one deployment |

## Layers

```
host (an agent harness, an app, a CLI)
  │  provides: Principal (who may read and write which scopes, its trust ceiling and authority
  │            fence), Store, optional hooks
  ▼
integrations      pi-durable (default) · CLI (with relembra mcp, MCP over stdio) · session-start hooks
  ▼
core (pure, no I/O)
  guard → op_id idempotency → authorization → event → derived views
  find (BM25) · wake/brief composer (byte budget) · compression protocol · erasure
  ▼
ports             Store · Policy · ErasureHook · EgressFilter · Clock · Ids
  ▼
store adapters    memory (tests) · sqlite (node:sqlite, works in Node and Bun) · postgres (host SqlClient)
```

## Core model

- **Memory:** one fact of at most 280 bytes on one line. The guard rejects credentials, control and
  bidi characters, and multi-line input.
- **Scope:** an opaque key the host defines (for example `dev/my-repo` or `tenant:7/user:42`). The
  core never derives scope from model input.
- **Identifiers:** a scope, memory id, principal id or fence key is well-formed UTF-16, then passes
  the guard's rules within its byte cap (memory id 128 bytes; scope, principal id and fence key
  256): not blank, one line, no control character (NUL, C0, C1), no format, bidi, zero-width or
  other default-ignorable character (the guard's emoji joiners and selectors excepted), and no
  credential shape. The core refuses a bad one with `IdentifierError(field, rule)` before any
  store call, whether it comes from the caller, the host's `Policy` or its `Ids`; an import
  refuses it as `malformed`. Every store therefore sees the same names.
- **Principal:** the host's `Policy` maps its own authenticated context to a principal with
  `readable`, `writable`, `promotable`, `pinnable` and `owned` scope sets (`owned`: retract,
  redact, supersede, and see retracted memories; `promotable`: the scopes it may promote into).
  Stores receive the readable set and filter in the query itself, so nothing outside it is ever
  loaded.
  - **Trust ceiling** (`trustCeiling`, default `agent`): the most trust its writes may carry, and
    the most trusted memory it may change. `retract` and `supersede` are refused
    (`trust:above-ceiling`, nothing written) when the memory or a live summary derived from it,
    which they retract too, is above the ceiling; `redact` when the memory or any summary derived
    from it, which it erases too, is. One helper, `enforceCeiling`, makes the check, so an event
    replay applies it too. `redactionPreview` and `sweepPreview` do not check it: a host
    previews at its usual ceiling, asks a person, then acts at a raised one (the CLI's owner
    prompt). Retention `sweep` is exempt: it runs the host's policy with no principal.
- **Events,** append-only except for redaction: `note`, `retract`, `redact`, `supersede`,
  `summarize` and `promote`.
  - `summarize` records the memory ids and revisions it derives from, and is refused if a source
    has changed since.
  - `promote` copies a live, plain memory the principal may read into another scope it may
    promote into, bound to the exact revision (`origin`), with the promoter's provenance and
    trust at most the origin's. It is refused if the origin has changed since, and for a
    summary. Promote events carry event format 2; every other kind keeps format 1, so an export
    without a promotion stays readable by a format 1 reader (`FORMAT.md`). A SQLite file is
    another matter: opening it migrates it to schema 6 whether or not it holds a promotion, and
    0.2.0 and earlier (schema 4) refuse it.
- **Identity:** `seq` gives store order; `memory_id` is stable; `revision` is per memory; `op_id`
  is the idempotency key. It is unique per principal per store (another principal's use of the
  same op id is a separate operation, so op ids can neither block nor probe across principals),
  checks the payload hash, and stores its result, so a retry returns the first result.
- **Authority fence:** a host-supplied fencing key and epoch. The store keeps the highest epoch per
  key and refuses a write with a lower one in the same transaction, so a writer whose authority
  ended (a takeover, a cancelled conversation) commits nothing. The host advances the epoch.
- **Provenance** on every memory: agent, harness, model, host, source, trust and `op_id`.
- **Erasure:**
  - `redact` replaces the text with a tombstone (no hash of it) and redacts every derived summary
    and every promoted copy, in whatever scope, in the same transaction. A preview, an approval
    and the result list only the copies the principal may see; the others are erased all the
    same;
  - redaction also scrubs cached op results and content fingerprints, and records erasure work in
    a durable outbox in the same transaction;
  - every rendering lists the memory ids it carried (`memoryIds`). Given a carrier (`{ id, kind }`:
    a conversation, an MCP server process), `wake`, `brief` and `findRendering` return the
    rendering only after the store recorded an exposure of each of those ids for that carrier
    (ids only, one row per carrier and memory); a recording that fails refuses the rendering, and
    a denied or empty rendering records nothing. The store reports the ids already redacted when
    the recording commits: a memory redacted between the read and the recording makes the
    rendering render again, so a carrier never holds text a redaction could not name. On
    Postgres, recorders take a shared advisory lock and a redaction's exposures read takes it
    exclusively, never the store lock row; SQLite and the memory store get the same order from
    their single writer;
  - the redaction writes the carriers of every memory it erases (the memory, its summaries, its
    promoted copies) into its outbox rows. After commit, the host runs `deliverErasures(hook)` on
    its own schedule, as it runs `sweep`. Delivery reads only the rows with a pending carrier
    (`erasure_pending`), 100 rows a page, never the whole outbox; the hook gets each row's pending
    carriers and answers `acknowledged` (the host purged or quarantined its copy: its word, which relembra cannot
    check) or `unsupported` per carrier. Anything else, no answer or a throw leaves the carrier
    `pending`, sent again on the next delivery, so hooks must be idempotent. `erasureStatus()`
    lists every row with each carrier's status, for the host only (a carrier id says what a
    conversation saw). relembra never claims an external copy is gone;
  - exposures grow with carriers times memories (ids only, no text). Nothing prunes them, nor
    settled outcomes, in v0.3: pruning is later work, and until then a host that needs it deletes
    rows itself;
  - `retract` hides a memory from agents, and an owner view still shows it, marked. Retracting
    or superseding a memory retracts the live summaries derived from it, but not its promoted
    copies: they live in scopes with their own owners.
  - SQLite runs with `secure_delete` on and truncates the WAL after a redaction commits; a
    truncation a reader blocks is recorded durably, read by every handle on the file, and retried
    at the next commit, close or open.
  - Postgres removes the text from every row and index entry relembra keeps, in the redaction's
    transaction. It cannot reach what Postgres itself keeps: old row versions stay in the table
    and index files until VACUUM reclaims them (and VACUUM marks the space free without
    overwriting it; VACUUM FULL rewrites the files), and the WAL, replicas, archives and backups
    keep their copies. Those belong to the database operator.
- **Retrieval:**
  - `find` is BM25 over a pt/en tokenizer written fresh for this project, read from a term index
    the store keeps in each write's transaction (N, length sums, per-memory term counts), so a
    query reads only its own terms' rows and ranks exactly as a full scan would;
  - `wake` composes pinned rules, then the scope's recent memories that no live summary of at
    least their trust covers, then summaries, then the memories they cover, with every untrusted
    memory after every trusted one, then an index, within a byte budget;
  - `brief` is the query-conditioned version;
  - output is rendered as attributed evidence (`<memory id scope rev at trust>`), escaped so
    evidence cannot forge its framing, and bounded after the egress filter by omitting whole
    entries.
  - Embeddings are out until the eval shows lexical retrieval failing a category. If they come,
    they are derived data stamped `{provider, model, dim}` that can be rebuilt.
- **Egress:** an `EgressFilter` port runs per principal on every rendering before it leaves the
  core: masking, PII rules, or a deny. The core ships an identity filter and the credential guard.
  `find`, `recall` and `zoom` return memories as data, not renderings, so the filter does not run
  on them: a host or integration that shows their text to a model applies its filter first, or
  uses the renderings: `wake`, `brief`, and `findRendering` (find's results rendered as
  evidence, filtered and bounded like the others).
- **Audit:** the event log is a mutation journal, not a security audit log. It records who changed
  what (principal, provenance, sequence); retract and redact events carry no wall-clock time of
  their own, and reads (`find`, `wake`, `brief`, `zoom`, export) leave no trace in it. A host that
  needs access auditing records security-relevant reads and exports itself, with actor, action,
  time and origin, and without logging memory text or credentials.
- **Retention:** a per-scope policy (for example "redact after 180 days"). A `sweep()` call
  applies it, and the host schedules the call; the core runs no timer.
- **Compression:** `pending()` lists sources due for a summary (live, unpinned, not a summary, and
  not covered by a live summary of at least their trust at their current revision); a summary is
  never superseded, only retracted and replaced by a new summary; `submitSummary()` is conditional on
  the source revisions, and the summary's trust is the writer's, capped at the least of its sources'. The agent writes the summary text, as in OptMem; no model call is built in.

## Store adapters

- **sqlite:** `node:sqlite` with WAL and transactions. Find reads the term index (exact
  statistics, so no prefilter changes a score); wake and brief read every live memory in the
  readable scopes, never prefiltered by text. Measured on 2026-10-30: the same code
  runs on Node 26 and Bun 1.4.4, and compiles with `bun compile`.
- **postgres:** takes a minimal `SqlClient` (`query`, `transaction`) from the host, so it adds no
  driver dependency; the README shows the wrappers for Bun's SQL, `pg` and `postgres.js`. The
  tables live in one schema (default `relembra`). Every store transaction runs at READ COMMITTED,
  whatever the client's default, first locks the one `store_lock` row (`SELECT … FOR UPDATE`) and
  then works only through that transaction's connection, so writers on any machine run one at a
  time and each statement sees every earlier commit (under REPEATABLE READ the snapshot would
  predate the lock wait and miss a fence advanced meanwhile); `40001` and `40P01` are retried a
  bounded number of times. A COMMIT whose answer was lost after the work wrote an op record runs
  again, so the op-id check returns the persisted outcome or refuses a conflicting payload; one
  without an op record raises `StoreCommitUnknownError`. Writes, fresh imports included, are
  accepted, and retention counts, by the database clock (`StoreTransaction.now`); the caller's
  clock stays as `revision.at`, and a JSONL replay keeps each revision's age, bounded by the
  database clock. Its conformance runs on Postgres 17 in a throwaway
  container (`scripts/with-postgres.sh`), on Bun.
- **memory:** for tests and examples.
- **Shared rules:** the persistent adapters (SQLite, Postgres) run forward-only versioned
  migrations with a schema version table; the memory store keeps nothing between runs and has no
  schema. Every adapter passes the exported conformance suite (`relembra/testing`). The suite covers
  transactions, concurrent writers, `op_id` replay, scope isolation, the fence, erasure, and the
  term index (`findByTerms`), which each adapter keeps in the transaction of every write.

## Integrations

- **pi-durable (default, `relembra/pi-durable`, peer `1.4.0` exactly):** an extension with the
  tools `memory_note`, `memory_find` and `memory_brief`, all `replay: "safe"`, and a
  `relembra_memory` system prompt section carrying `wake`. Every rendering (the wake, `memory_find`,
  `memory_brief`) is recorded for the carrier `<hostNamespace>/<conversationId>`, kind
  `pi-durable`, before the model gets it. `memory_note`'s op id is the §4.3
  tuple hash over host namespace, conversationId, taskId and callId: pi-durable commits a call's
  intent before `execute()` and reruns a safe call after a crash with the same ids, so the rerun gets the
  persisted first outcome. `memory_find` returns `findRendering`, so every rendering an agent
  receives passes the egress filter and the byte budget. The wake fails closed: a wake that
  cannot be rendered becomes a fixed notice (pi-durable keeps a throwing section's earlier text),
  and a `beforeRequest` hook on `pi.generation`, which pi-durable runs before every request
  attempt including recovery, renders the wake again and puts it in the request once, replacing
  every stored value of relembra's section and no other. A request resumed after a crash
  therefore carries the wake the host allows now. Compaction requests leave out the conversation's system messages, the wake included, and carry
  only pi-durable's own summarization system prompt (`dist/harness/compaction.js`: the prompt at
  line 112, `serializeConversation` near line 319). Each tool's `prepareArguments` refuses invalid arguments with a fixed message
  before pi-durable's own validation, whose error quotes them. The module imports pi-durable's
  types only.
  - One process owns a pi-durable storage at a time (pi-durable has no cross-process locking,
    README "Storage"). Each storage is one journal lineage with its own host namespace.
  - Takeover only through a host fencing epoch: the new owner calls `advanceFence`, and a paused
    writer at the old epoch commits nothing.
  - pi-durable 1.4.0 migrates its SQLite storage to schema version 2 on open, irreversibly: 1.3.0
    and earlier cannot open it (pi-durable CHANGELOG 1.4.0; `dist/storage/sqlite/migrations.js`).
  - Tested: a process killed after the memory commit and before pi-durable's journal ack leaves
    one memory with the same id and timestamp after reopen (two without the op id), and the
    takeover with and without an epoch.
- **MCP server over stdio:** the plug for agents whose MCP client speaks revision 2026-07-28.
  It is the CLI's `relembra mcp` subcommand (`docs/CLI.md`), not a library export. Its renderings are recorded for
  the carrier `mcp:<random UUID>`, one per server process; the CLI has no hook, so they stay
  pending until a library host delivers them, and nothing claims a client deleted anything.
- **Session-start hook scripts** and the **CLI** (`init, note, find, recall, wake, brief, zoom,
  retract, redact, pending, summarize, check, import, export`).
- **Import:** OptMem's `LOG.txt`, read from its public documentation only (reading a data format
  copies no code), and relembra's own JSONL export; both idempotent, neither grants `owner`
  trust or pins (`FORMAT.md`).
- **Export:** plain JSONL, specified in `FORMAT.md`.

## Runtime and packaging

- One npm package with zero runtime dependencies. Subpath exports: `.` (core), `/sqlite`,
  `/postgres`, `/pi-durable` and `/testing`. pi-durable is an optional peer dependency. The MCP
  server ships in the CLI binary only, as `relembra mcp`.
- The library is built for Node (ESM with `.d.ts`). The CLI is a Bun AOT binary (`bun build
  --compile --aot --trim`) for macOS and Linux. A 2026-10-30 prototype measured 18 ms against
  57 ms on Node 26 on the hook path; the first measured numbers for the built binary are in
  `docs/bench/`.
- Install: `install.sh` installs a binary already downloaded from a GitHub release only if its
  sha256 matches the release's `SHA256SUMS`. The library is on npm as `relembra`; a prerelease
  publishes under the `beta` dist-tag, never `latest`.
- Clean room: the tokenizer and ranking are written from a written algorithm spec (fold rules,
  stopwords, stemming, BM25 parameters), never from another project's source.
- Development uses Bun (`bun test`); a Node smoke test runs against the built library. Biome lints
  and TypeScript runs in strict mode.
- CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request. Its jobs
  include lint and typecheck; the AOT CLI built on Linux and macOS with Bun canary (no stable
  Bun has `--aot` yet; this binary is not the release binary);
  every Bun test on stable Bun 1.4.4 against that binary, with a Postgres 17 service on Linux
  (macOS skips the Postgres tests, having no service containers); the Node tests and packed
  tarball; the eval's release gates on the synthetic set (ticket 18); SBOM, gitleaks, zizmor,
  and an informational probe of the latest pi-durable.
- The local merge gate, `scripts/ci.sh`, records every required step's exit and the committed
  source/runtime identity before and after. It force-builds the native CLI, tests with Postgres
  and the binary, and installs one retained package archive into Node and Bun consumers. The
  manifest verifies the binary and archive hashes after testing; dirty inputs, overrides,
  changed artifacts and failed or missing required steps refuse a pass. Each attempt has its
  own path and logs. This is evidence for the actual local platform/runtimes only.
- `scripts/check-release.sh` runs that gate then the strict benchmark serially on the same
  candidate, adding provenance and latency acceptance to the shared workflow checks. Release
  assets must match the retained tested bytes. Procedure: [RELEASE.md](RELEASE.md).

## Measured, not assumed

The repository includes the eval harness, in TypeScript, with the reviewer's findings fixed:
- id-only leaks are caught;
- responses are validated by type;
- requests have deadlines.

Temporal (`as_of`) questions are not part of the eval: relembra has no temporal read
(`eval/README.md`).

Release gates (`eval/score.ts`; `bun run eval` exits 1 when one fails):

| Gate | Threshold |
|---|---|
| Scope denial | 100% |
| Leaks | 0 |
| Superseded memories served, label violations, failed requests | 0 |
| hit@5 | ≥ 0.9 (provisional floor on the synthetic set) |
| Wake coverage | ≥ 0.9 |

Latency has a separate release gate: `bun bench/eval-latency.ts --check` requires warm find's
raw nearest-rank p95 <=50 ms on both Bun and Node on the pinned 20,000-memory corpus. It also
requires complete sampling, deterministic store rebuild, unchanged reads, SQLite integrity and
available clean source/runtime identity unchanged across the run. Every attempt retains raw
samples and diagnostics; without `--check`, timings are informational and an over-budget result
alone does not fail the run. Cold latency has no budget. Contended baseline runs are diagnostic,
not evidence of an optimization or final release performance. A release's acceptance is in its
evidence record, `docs/eval/release-<version>.md`.
The stale writer (commits nothing) is a conformance case and crash replay (exactly one memory)
has its own crash tests; neither is an eval gate.

Personal eval data never enters the repository.

## Grown in layers (each one works end to end before the next)

1. **v0.1:**
   - core, the memory and sqlite stores, the CLI and the guard;
   - import and export, and the eval harness with synthetic data;
   - usable as a personal memory beside the current tool.
2. **v0.2:** the pi-durable integration, the postgres store, the conformance suite on both stores,
   and the crash-replay and stale-writer tests.
3. **v0.3:** the MCP server, erasure carriers delivered to `ErasureHook`, promotion, and the
   release gates in CI.
4. **Sharing across machines:** v0.1 serves one machine on SQLite; v0.2 shares one memory across
   machines through the Postgres store. File sync between SQLite copies was rejected (conflicts).
5. **Later:** embeddings, and host integrations in other repositories through the same ports.

## Five years out

- A versioned `FORMAT.md` and JSONL export outlive any runtime.
- Every host coupling sits behind a port.
- Scope, idempotency and erasure exist from the first event, never retrofitted.
- The eval set grows with every real miss.
