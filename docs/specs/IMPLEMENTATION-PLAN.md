# Implementation plan: relembra v0.1 to v0.3

Status: accepted 2026-10-30, revision 2. Revision 1 was reviewed adversarially by a different
model, which returned REVISE with 2 P0 and 15 P1/P2 findings. All are folded in below; §10 lists
what changed.

Sources: `docs/ARCHITECTURE.md`, `docs/specs/v0.1/spec.md`, `GLOSSARY.md`, and the research in
§2. This plan amends the v0.1 tickets and adds the v0.2 and v0.3 tickets. Where a ticket file and
this plan disagree, this plan wins until the ticket is updated.

## 1. The deeper version of the task

**What a top practitioner would do that was not asked for.** Treat memory as an attack surface
and a set of contracts, and promise only what the boundaries can enforce. One planted line in a
store that every agent reads at session start steers all of them, so:
- trust, provenance and erasure are part of the data model;
- the event format and the CLI output are versioned public contracts;
- every quality claim is a number from a reproducible eval.

Where relembra cannot enforce something, the plan says so instead of testing around it:
- authority held by another process;
- copies held by a client;
- a model ignoring malicious evidence.

**The rawest material.**
- The real questions agents ask their memory.
- The event log itself.
- Primary specifications: the SQLite transaction docs, `node:sqlite`, Postgres isolation, the MCP
  2026-07-28 schema and changelog, and pi-durable 1.4.0's README, CHANGELOG and `.d.ts` files.
- The Okapi BM25 definition.

**Methods and tools.**
- A store conformance suite with a flawed-store control for every case.
- Real contending processes against a single SQLite file.
- Golden fixtures from released versions.
- Crash-replay tests on pi-durable's own storage.
- Escaping and forged-tag tests.
- A planted-leak scorer, plus a vacuity check: an empty candidate must fail.
- gitleaks and checksummed binaries.

**What, other than us, shows it is right.**
- A third-party adapter passing the conformance suite.
- An independent MCP client completing a stdio round trip.
- A sealed question set opened once per release.
- A different model reviewing every build.
- Readers using the documented JSONL export without relembra.

**The prompt, rewritten.** "Build relembra in layers, each working end to end before the next.
Make trust, provenance, erasure, the event format, the CLI's JSON output and the store
conformance suite tested contracts. Promise only what the boundaries enforce:
- transactional local effects;
- authority defined by the host and enforced atomically in the store;
- honest trust labels;
- external erasure delivered durably and reported as pending, acknowledged or unsupported.

Measure retrieval with a deterministic eval that an empty candidate fails. Integrate pi-durable
1.4.0 exactly, through its real tool context, proven by a crash test on its own storage."

## 2. Research that changes the plan (read 2026-10-30)

| Finding | Source | Change |
|---|---|---|
| A single adversarial memory write steers later behaviour. Write-time filters stop direct injections but not indirect ones arriving through stored tool output or email. Prompt-injection defences do not cover memory poisoning. | [MPBench, arXiv 2606.04329](https://arxiv.org/abs/2606.04329); [MemPoison, arXiv 2607.14651](https://arxiv.org/abs/2607.14651); [GhostWriter, arXiv 2607.06595](https://www.alphaxiv.org/abs/2607.06595.md); [MINJA defence study, arXiv 2601.05504](https://arxiv.org/abs/2601.05504) | Trust tiers, an explicit threat model (§4.1), escaping (§4.2), a trust floor through derivations, and a `poisoning` eval category that proves only labelling, authorization, quarantine and rendering |
| An LLM judge can be talked into scoring a malicious instruction as trusted. | [Promptfoo LMVD 7e5fb607](https://www.promptfoo.dev/lm-security-db/vuln/agent-persistent-memory-poisoning-7e5fb607) | No model in the trust path, and no LLM judge in any gate |
| LoCoMo's answer key is 6.4% wrong and its judge accepts up to 63% of wrong answers. LongMemEval-S is saturated by long context windows. Answer accuracy hides retrieval errors. | [LoCoMo audit](https://github.com/dial481/locomo-audit); [survey arXiv 2606.30306](https://arxiv.org/pdf/2606.30306); [Zep on Mem0](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) | Score retrieval (hit@5, MRR), abstention and leaks per question and per fact. Add `contradiction` and `poisoning` categories. Scoring is deterministic. No third-party benchmark numbers in the README. |
| `node:sqlite` is Stability 1.2 (release candidate) from Node 25.7. Defensive mode defaults to **true** from Node 25.5.0 and 24.14.0, which we verified: `PRAGMA schema_version=42` is blocked by default on Node 26.12.1 and Bun 1.4.4 (SQLite 3.54.0). | [Node sqlite docs](https://nodejs.org/api/sqlite.html#new-databasepath-options); [PR #61262](https://github.com/nodejs/node/pull/61262) | Set `defensive: true` explicitly and test it, with a `defensive:false` control. One runtime matrix everywhere (§4.6): Node ≥ 24.14 and Bun ≥ 1.4, with SQLite conformance run on every advertised runtime. |
| SQLite allows one writer at a time, and `BEGIN IMMEDIATE` can return `SQLITE_BUSY`. Postgres SERIALIZABLE transactions can abort and must be retried whole. | [SQLite transactions](https://www.sqlite.org/lang_transaction.html); [Postgres 17 isolation](https://www.postgresql.org/docs/17/transaction-iso.html) | Explicit contention contracts (§4.4) |
| MCP 2026-07-28 is stateless: no initialize handshake and no sessions. It requires `server/discover`, `resultType`, and metadata and cache fields. | [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) | Ticket 15 acceptance covers discovery, dispatch, framing and errors, plus an independent client round trip |
| pi-durable **1.4.0** (2026-10-21) made breaking changes within major version 1. The README warns the API changes without notice. "One process owns a storage at a time; there is no cross-process locking." A tool's intent is committed before `execute()`, and a crashed call reruns only if `replay: "safe"`. The context carries `taskId`, `conversationId` and `callId`. `api.now()` is live harness time (default `Date.now`), not a recorded value. | `@earendil-works/pi-durable@1.4.0`: README §tools and line 790, CHANGELOG 1.4.0, `dist/harness/types.d.ts:155-167, 574-577` | Peer dependency **exactly 1.4.0**, with `latest` as an informational probe. One owner per pi-durable storage. Takeover is supported only through a host fencing epoch enforced in the memory store (§4.3). Replay determinism comes from persisting the first commit's outcome, not from the clock (§4.3). |

## 3. First principles and the invariants every ticket tests

A memory for agents is a log of claims that a model reads as context. The model can be steered by
text, context bytes are scarce, and the store outlives every model and harness that writes to it.

1. **Attributable.** Every rendered byte names its memory, scope, revision and trust tier, and
   evidence text cannot forge that framing.
2. **Authority comes from the host.**
   - Scope, principal, pin, promote and fencing rights come from the host's authenticated
     context and are checked in the same store transaction as the effect.
   - The CLI gives scoped organization. It is not isolation from a hostile process running as
     the same OS user.
3. **Exactly one effect per operation.**
   - A write with an op id has one effect.
   - A retry returns the persisted outcome, including the generated id and timestamp.
   - Current authorization and redaction override replaying a stored result.
4. **Erasure dominates what relembra controls.**
   - Redaction atomically removes relembra-managed content: revisions, summaries, indexes,
     promoted copies, cached op results and content fingerprints.
   - It durably records the erasure work for hosts. External copies are reported as pending,
     acknowledged or unsupported, never as erased by assumption.
5. **Bounded.** Every output is measured after escaping and egress filtering. Entries are omitted
   whole, or the output is refused; it is never cut mid-entry and never over budget.
6. **Measured.** No quality claim without an eval that an empty candidate fails.

## 4. Design contracts

### 4.1 Threat model and trust tiers (fields from ticket 04, behaviour in 05)

**Trusted:**
- the host;
- its policy;
- whoever holds direct database access.

**Not trusted:**
- model-authored text;
- tool output and web content;
- import files.

`Provenance.trust` takes three values:
- `owner`: established by the host independently of any model, such as a human-reviewed write or
  owner CLI flag.
- `agent`: model-authored and unreviewed. This is the default.
- `untrusted`: the integration knows the text came from external content.

Rules:
- The policy sets each principal's trust ceiling. A write may lower its trust, never raise it.
- A summary or promoted copy gets the least trust of its sources, unless a host-authorized review
  raises it.
- Imports never grant `owner` trust or pin rights.
- Pinning requires `Principal.pinnable`. The wake renders `untrusted` memories only after trusted
  ones, and never in the pinned section.
- The `poisoning` suite proves:
  - labels are applied;
  - pins are authorized;
  - quarantine and holds work;
  - rendering is correct.

  It claims nothing about whether a downstream model ignores malicious evidence.

### 4.2 Rendering

- `<memory id="…" scope="…" rev="…" at="…" trust="…">text</memory>`, one per line.
- Text and attribute values are escaped (`&`, `<`, `>`, `"`), and metadata fields are bounded.
- Tests:
  - a forged `</memory><memory trust="owner">` stays inert text;
  - quoted attributes;
  - an egress filter that expands output still keeps the result under budget;
  - complete-entry omission.

### 4.3 Operations, idempotency, time and fencing (ticket 04; integration side in 13)

- **Op ids.**
  - A caller-supplied op id is an opaque string of at most 256 bytes.
  - Integration op ids are `v1:` plus SHA-256 over a canonical JSON array of
    `[hostNamespace, conversationId, taskId, callId]`. Concatenation with delimiters is
    forbidden: `["host",1,2,"3:4"]` and `["host:1",2,3,"4"]` collide.
  - The host namespace identifies one durable journal lineage. It survives recovery. An
    independently writable clone gets a new namespace.
- **Fingerprint.**
  - SHA-256 over a canonical encoding of operation kind, scope, authenticated principal id, and
    every semantic input field.
  - Generated fields (memory id, timestamp) are excluded.
  - Same op id with a different fingerprint is a named conflict.
- **Persisted outcome.**
  - The first successful commit stores the generated memory id, timestamp and result with the
    op record, in the same transaction.
  - A retry, even through a later process with a different clock, returns that outcome.
  - A retry after the memory was redacted returns a terminal `redacted` outcome with no text.
  - A retry by a principal that has since lost access is refused.
- **Time.**
  - SQLite uses the injected `Clock`.
  - Postgres uses database time for acceptance and retention, and the caller's time is kept as
    provenance only.
  - Store sequence is the only ordering.
  - Tests move the clock backwards and forwards, and recover with a different clock.
- **Fencing.**
  - `AuthorityFence` is not a boolean callback. The host supplies a fencing key and epoch.
  - The store keeps the highest epoch seen per key and refuses a write whose epoch is lower,
    atomically within the write transaction.
  - Advancing the epoch is a store operation the host calls on takeover.
  - The test covers a paused writer resuming after the epoch advanced (nothing committed),
    alongside the current writer succeeding.

### 4.4 Store contention and transactions (tickets 02 and 12)

- **SQLite.**
  - Operations on one connection are serialized.
  - Mutations begin with `BEGIN IMMEDIATE`.
  - Busy handling is bounded (`busyTimeoutMs`), and exhaustion raises `StoreBusyError`.
  - `synchronous=FULL` in WAL is declared. The docs separate process-crash durability (tested)
    from power-loss durability (inherited from SQLite and the filesystem, not tested).
  - External callbacks never run inside a transaction.
  - Tests: contending processes, a read during a suspended transaction on the same connection,
    rollback, writer death mid-transaction, and lock recovery.
- **Postgres** (ticket 12).
  - Mutations take a persistent store-lock row (`SELECT … FOR UPDATE`) before reading mutable
    state.
  - Every check and write in a mutation uses one transaction-bound client on one connection.
  - `StoreTransaction` gains the reads that revision, idempotency and fencing checks need.
  - Retryable SQLSTATEs (`40001`, `40P01`) are retried with a bound.
  - An ambiguous commit is resolved by looking up the op id.
  - Tests: duplicate-op races, conflicting supersedes, and a redaction racing summary creation.

### 4.5 Contracts that must not drift

- **Event format.** Every stored event carries its format: `1`, or `2` for a `promote` event
  (ticket 17; a new kind takes the next format on its own events only, so a log or export
  without one stays format 1). The export header names the newest format of its lines. `docs/FORMAT.md` begins in ticket 02
  with the schema and is completed in 08. The export header carries the format version and the
  relembra version. An import refuses an unknown newer format.
- **Migrations.**
  - Take migration ownership, reread the version, then apply schema change and version bump in
    one transaction.
  - A store whose schema is newer than the code is refused untouched.
  - Fixtures are produced by released versions only (`test/fixtures/schema-vN.db`) with expected
    logical contents.
  - Tests: concurrent open, interrupted migration, future-version refusal, and preservation of
    tombstones and op records.
- **CLI.**
  - Every command takes `--json` and prints one JSON document, `{ ok, data | error: { code,
    rule? } }`.
  - Exit codes: 0 ok, 1 refused, 2 usage, 3 store error.
  - `docs/CLI.md` is the contract, and a test checks it against the implementation.
- **pi-durable.** Its own SQLite schema v2 upgrade is irreversible (1.3.0 cannot reopen a
  migrated store), and the integration docs say so.

### 4.6 Runtime, ids and packaging

- **Runtimes.** Node ≥ 24.14 (defensive default, `node:sqlite` available) and Bun ≥ 1.4, the same
  in `AGENTS.md`, `package.json` `engines`, the README and CI. SQLite conformance runs on Node 24,
  Node 26 and Bun.
- **Ids.** Memory ids stay opaque strings from the `Ids` port (`crypto.randomUUID()` by default).
  Sequence is the order, and ids carry no chronology. There is no `Embedder` port until measured
  retrieval failures define one.
- **CLI build.**
  - `bun build --compile --aot --trim` on each native target, and the full CLI acceptance suite
    runs against the produced binary.
  - A non-AOT or Node build is a fallback only when the AOT build cannot run on a target. It must
    pass the same suite.
  - Source, type or test failures block the release; they do not trigger a fallback.
- **Speed claims.** None until ticket 07's benchmark records the commands, artifacts, dataset,
  repetitions, machine and runtime versions. The 2026-10-30 prototype numbers stay labelled as a
  prototype.
- **Supply chain.** sha256 checksums for every binary, `npm sbom`, and gitleaks and
  `npm pack --dry-run` checks in CI. npm provenance applies only when publishing, which needs the
  owner's go.

## 5. Five years out

| Regret | Action now |
|---|---|
| Promised guarantees across boundaries we did not control | §3 and §4.3 promise only store-enforced effects. External erasure is acknowledged, not assumed. |
| Trust labels that could be forged through rendering or laundered through summaries | §4.1 and §4.2 |
| A cached retry result resurrected redacted text | §4.3 persisted outcome with a `redacted` terminal state |
| Migrations broke old stores or let old binaries corrupt new ones | §4.5 |
| A delimiter collision merged two operations | Canonical tuple hash, §4.3 |
| The CLI's text output became an unwritten contract | `--json` and `docs/CLI.md` |
| Peer ranges claimed compatibility we never tested | Exact pi-durable 1.4.0, widened only after tests |
| Quality claims rested on benchmarks later shown broken, or on gates an empty system passed | Deterministic eval with vacuity checks |
| Speculative interfaces (an Embedder, sortable ids) that nobody needed | Removed until measured need |

## 6. Tickets

Each ticket is built test-first by a fresh agent and reviewed by a different model. The main
session merges it into `feat/v0.1`, reruns the checks and pushes. Negative assertions carry
positive controls.

### Progress (resume here; updated with every merge)

| Ticket | State | Where |
|---|---|---|
| 01–05 | Merged, Sol-reviewed, fixes merged | `feat/v0.1` |
| 06 | Merged; Sol PASS on round 4 at `fdc9afd` (575 Bun, 102 Node) | `feat/v0.1` |
| 10 part A | Merged at `a294d52`; Sol FIX (one P2) fixed and verified; hosted CI blocked by GitHub billing | `feat/v0.1` |
| 07 | Merged at `1173dac`; Sol PASS on round 8 at `fb42e4e` (722 Bun, 102 Node on the merge) | `feat/v0.1` |
| Site (`site/`, `examples/quickstart.ts`) | Merged at `b94170a` | `feat/v0.1` |
| SQLite concurrent-open race (found under load) | Merged at `145dfd2`; Sol confirmed the fix (728 Bun, 103 Node on the merge) | `feat/v0.1` |
| 09 (relembra candidate, gates, latency) | Merged at `7fe2ccb`; Sol PASS on round 7 at `d55b497` (782 Bun, 103 Node, eval PASS) | `feat/v0.1` |
| 08 | Merged at `86d5551`; Sol PASS on round 6, round-7 P3 fixed at `ae1abb0` (937 Bun, 106 Node, eval PASS) | `feat/v0.1` |
| 19 | Merged at `aa66f82`; Sol PASS on round 1 at `64f1322`; find p95 ≤ 50 ms in 3 of 3 runs at the merge (968 Bun, 114 Node) | `feat/v0.1` |
| 11 | Released 0.1.0: security gate PASS on candidate 3 (`fda7be8`, Sol acceptance round 3; candidates 1 and 2 rejected and fixed), squash `9507c00` (PR #1), tag `v0.1.0`, private GitHub release (1,053 Bun, 116 Node) | `main` |
| 12 | Merged into `feat/v0.2` at `5dfa702` (with 14); Sol FIX round 1, PASS round 2 at `e8b75cd` | `feat/v0.2` |
| 13 | Merged into `feat/v0.2` at `d9ed82d`; Sol rounds 1–3 (egress via `findRendering`, fail-closed wake, request-time wake, bounded argument errors); round-3 P3 docs fixed at `c7aa3fb` | `feat/v0.2` |
| 14 | Merged into `feat/v0.2` at `5dfa702`; Sol FIX round 1 (P3 malformed URL), PASS round 2 at `407fd9c`. Integration: 1,239 Bun with Postgres 17, 116 Node | `feat/v0.2` |
| 15 | Merged into `feat/v0.3` at `6e6e547`; Sol PASS on round 1 at `535825d` | `feat/v0.3` |
| 17 | Merged into `feat/v0.3` at `c4ecbd5`; Sol PASS round 2 at `99f6ac1`. Postgres promotion at `3e55c41`; integration review FIX (promote at store time, `derived` index), fixed and Sol PASS at `aef446d`, merged at `4475794` | `feat/v0.3` |
| 16 | Built on `feat/v0.3` (`c91f5e6`..`8c27614`): exposures per rendering carrier, carriers in the outbox, `deliverErasures` and `erasureStatus`, SQLite schema 6 and Postgres schema 3. Sol FIX round 1 (empty rendering recorded, delivery read all history), fixed at `f483942` | `feat/v0.3` |
| 18 | Merged into `feat/v0.3` at `28d020e`; Sol FIX rounds 1–2 (stable-Bun toolchain test, typecheck), PASS round 3 at `b032a83`. Configured only: hosted CI blocked by billing | `feat/v0.3` |

The repository was private through 0.4.0: ticket 11 made no npm publish, and the tags, commits
and pull requests named above belong to that pre-release history, which the public repository
does not carry. The first public release is 1.0.0-beta.1.
`main` has a ruleset (PR required, linear history, no force-push or deletion).

### v0.1: one machine on SQLite

| # | Ticket | Blocked by | Status, and amendments from this plan |
|---|---|---|---|
| 01 | Tracer: note and recall | none | Built. Review and security fixes in progress. |
| 02 | SQLite store and conformance suite | 01 | Built. Integration with 03 in progress. Add §4.4 SQLite tests (writer death, same-connection read), `format: 1`, §4.5 migration rules, the `docs/FORMAT.md` schema part, and a refusal for files looser than 0600. |
| 03 | Ranked find | 01 | Built and merged into integration. Stores never prefilter by text. |
| 04 | Operations: idempotency, persisted outcome, fencing epoch | 02 | Everything in §4.3, plus the `Provenance.trust` field |
| 05 | Wake, brief, egress, trust and rendering | 03, 04 | §4.1, §4.2 and invariant 5 |
| 06 | Retract, redact, supersede, summaries, retention | 04, 05 | Invariant 4 within relembra: scrub cached results and fingerprints; retry after redaction returns the terminal outcome; trust floor for summaries; an erasure outbox table (delivery comes in 16); a reimported stale export is refused where the tombstone is kept. |
| 07 | CLI and AOT binary | 06 | §4.5 CLI contract and §4.6 build rules, plus the benchmark artifact |
| 08 | Import, export, format | 07 | Export header, refusal of newer formats, namespaced source ids, preserved tombstones; imports grant no trust or pins |
| 09 | Eval harness | 07 | Pinned baseline (a named baseline implementation and version, a synthetic corpus, a fixed seed, all recorded in `eval/README.md`), metric definitions and thresholds. An empty candidate fails (positive retrieval and wake coverage required). Ids are opaque strings. `as_of` is out of v0.1 (no temporal read surface), so temporal questions wait. Fixtures come from injected deterministic `Clock` and `Ids`. |
| 10 | Node build and CI | 03, 07 | §4.6 runtime matrix, packed-tarball smoke, SBOM, gitleaks |
| 19 | Find latency: store-maintained term index | 09 | A review measured find on 20,000 memories (4.1 MB) at 96–107 ms on Bun and 120–165 ms on Node for two terms, and 0.4–2.8 s for a 250-term query, because every find loads and retokenizes the readable set. Build a per-scope term index with exact statistics (N, df, avgdl, per-memory term frequencies), kept in the same transaction as each write, retraction and redaction. Rankings stay byte-identical to the specification's (a property test compares them on random corpora). Cap distinct query terms at 32. Budget: warm find p95 ≤ 50 ms on 20,000 memories on both runtimes, measured by ticket 09's benchmark. |
| 11 | Release 0.1.0 | 08, 09, 10, 19 | Gates run locally: leaks 0, scope denial 100%, non-empty retrieval, the hit@5 floor against the pinned baseline. Version bump, CHANGELOG, README. **npm publish and GitHub release binaries need the owner's go.** |

### v0.2: shared across machines, plus pi-durable

Starts after 11's acceptance, independently of publication.

| # | Ticket | Blocked by | Done when |
|---|---|---|---|
| 12 | Postgres store over a host `SqlClient` | 11 | §4.4 Postgres contract; conformance suite passes on Postgres 17 in a throwaway container; golden migration tests |
| 13 | pi-durable integration (`relembra/pi-durable`), peer `1.4.0` exactly | 11 | Tools `memory_note`, `memory_find` and `memory_brief`, plus a wake section. Write tools are `replay: "safe"`, with op ids from §4.3. **Crash test** on pi-durable's SQLite storage: kill after the memory commit and before the journal ack, reopen, and find exactly one memory and the same id and timestamp; the negative control without op-id enforcement gives two. One owner per storage. **Takeover**: only with a host fencing epoch, tested per §4.3. The irreversible schema-v2 upgrade is documented. |
| 14 | Sharing across machines | 12 | Two minimal host programs inject one `SqlClient`, see each other's memories in a shared scope and never another scope's. The shipped CLI stays SQLite-only; a Postgres CLI configuration would be a separate ticket. |

### v0.3: MCP, erasure reach and promotion

| # | Ticket | Blocked by | Done when |
|---|---|---|---|
| 15 | MCP server, stdio, 2026-07-28 | 11 | Built and tested: `server/discover`, `tools/list`, `tools/call`, required metadata, `resultType` and cache fields, protocol errors. Fault tests: malformed and oversized messages, interleaved ids, EOF and stdout framing. Round trip passes through an independent conforming client, and the README names the client versions it qualified with. JSON-RPC ids are correlation ids; writes carry a separate op id. The principal comes from the launch environment, and a test shows no argument changes scope. |
| 16 | Erasure delivery | 06, 13, 15, 17 | Renderings record carried memory ids per integration. After commit, outbox work goes to idempotent host hooks, with retry and acknowledgement. Status per carrier: pending, acknowledged or unsupported. MCP delivery records exposure but makes no claim of client deletion. |
| 17 | Promotion | 05, 06 | Copy at an exact revision into a promotable scope, with an origin link. Refused if the revision changed. Trust floor applies. Redacting the origin reaches the copy. |
| 18 | Gates in CI | 09, 11 | Automates 11's local gates on the synthetic set. The sealed real-question set stays local, because personal data never enters the repository. |

## 7. Order and parallelism

```
01 ─┬─ 02 ─── 04 ─┐
    └─ 03 ────────┴─ 05 ─ 06 ─ 07 ─┬─ 08 ─┐
                                   ├─ 09 ─┼─ 19 ─ 11 ─┬─ 12 ─ 14
                                   └─ 10 ─┘      ├─ 13 ─┐
                                                 ├─ 15 ─┤
                                                 └─ 17 ─┴─ 16
                                                   18 (after 09, 11)
```

Parallel tickets run only in separate worktrees with disjoint file ownership. The main session
merges, reruns `bun test`, typecheck and lint on the merged tree, and pushes.

## 8. Verification for every merge

- `bun test`, `bun run typecheck` and `bun run lint` (plus `test:node` once it exists) pass on the
  merged tree, run by the main session.
- Every new behaviour has a test shown red before green, and every negative assertion has a
  positive control.
- gitleaks runs before each push; the repository is public.
- A different model reviews each ticket, and its findings are fixed or answered in writing.
- Before 0.1.0 is called done: `code-review` (standards and spec axes), the `reviewer` agent, and
  an independent verification pass.

## 9. Out of scope

- Any model call inside relembra.
- Windows builds.
- Automatic capture of transcripts or tool output.
- Isolation between processes running as the same OS user.
- A guarantee that clients delete what they received.
- Temporal (`as_of`) reads in v0.1.
- Publishing to npm or creating GitHub releases without the owner's go.

## 10. Changes from revision 1 (adversarial review, 2026-10-30)

| Finding | Severity | Resolution |
|---|---|---|
| A conversation-lease fence is unsupported: pi-durable has no cross-process locking or public lease | P0 | One owner per storage; takeover only via a host fencing epoch enforced in the store (§4.3, ticket 13) |
| The erasure hook cannot share the local transaction | P0 | Atomic local scrub plus a durable outbox, post-commit delivery, acknowledgement states (§3, tickets 06, 16) |
| `api.now()` does not make replay deterministic | P1 | Persisted first-commit outcome; database time on Postgres; clock tests (§4.3) |
| Colon-joined op ids collide | P1 | Versioned canonical tuple hash; namespace lineage rules (§4.3) |
| Cached results can resurrect redacted text | P1 | Redaction scrubs op results and fingerprints; terminal `redacted` outcome (§4.3, ticket 06) |
| The poisoning model assumed source knowledge | P1 | Explicit threat model; `agent` is the default tier; the suite claims no behavioural resistance (§4.1) |
| Trust laundering through rendering and derivations | P1 | Escaping, trust floor, imports grant no trust, budget measured after filtering (§4.1, §4.2) |
| SQLite contention undefined | P1 | §4.4 SQLite contract |
| Postgres contract undecided | P1 | Store-lock row, one connection, extended transaction reads, retry rules (§4.4) |
| Golden fixtures are not enough for migrations | P1 | §4.5 migration rules |
| Defensive-mode claim false; runtime matrix inconsistent | P1 | Corrected; one matrix, Node ≥ 24.14 (§2, §4.6) |
| MCP acceptance insufficient | P1 | Ticket 15 rewritten |
| Dependency graph errors | P1 | 05→04; 10→03,07; 11→08,09,10; 16→15,17; 17→06; ticket 14 uses host programs |
| Eval gates vacuous or contradictory | P1 | Vacuity check, opaque ids, `as_of` deferred, deterministic fixtures, pinned baseline |
| pi-durable range overstated | P1 | Exact 1.4.0, with `latest` as a probe |
| AOT equivalence and timing unverified | P2 | Full suite on the artifact; fallback rules; no speed claim without an artifact |
| UUIDv7 and Embedder were speculative | P2 | Dropped |
