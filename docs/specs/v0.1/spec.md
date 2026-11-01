# Spec: relembra v0.1, a working memory on one machine

Status: ready-for-agent. Source: `docs/ARCHITECTURE.md` (accepted 2026-10-30), `GLOSSARY.md`,
`docs/specs/ranking-algorithm.md`.

## Problem Statement

Agents that a developer runs (in different harnesses, terminals and projects) forget everything
between sessions, and the memory tools that exist either keep one flat stream with no scopes,
cannot erase anything, or require running a server. A developer wants one memory every agent on
their machine can write curated facts into and read back, kept apart by project, that can be
corrected and erased, and that starts fast enough to run on every session start.

## Solution

A TypeScript library and a single-file CLI. The library holds the memory model, scopes, the guard,
ranked search, wake and brief composition, idempotent writes, retraction, redaction, supersession
and agent-written summaries, over a store adapter (in-memory and SQLite in v0.1). The CLI exposes
the library to any agent through shell commands and session-start hooks. An eval harness measures
it against a baseline before release.

## User Stories

1. As a developer, I want to install relembra with one command that verifies the binary's checksum, so that I trust what runs on every session start.
2. As a developer, I want `relembra init` to create a store with owner-only permissions, so that other users on the machine cannot read my memories.
3. As an agent, I want to write a memory with one command, so that what I learned survives the session.
4. As an agent, I want my write refused if it contains a credential, so that secrets never enter the memory.
5. As an agent, I want my write refused if it is longer than 280 bytes or spans lines, so that memories stay curated facts.
6. As an agent, I want my write refused if it contains control, bidi or zero-width characters, so that a memory cannot hide text from a reader.
7. As a developer, I want each memory kept in a scope derived from the project I am working in, so that one project's facts do not crowd another's.
8. As a developer, I want the scope to come from the environment (the git project and my OS user), never from what the agent typed, so that an agent cannot write into or read from a scope it was not given.
9. As an agent, I want a ranked search over the memories I may read, so that I find the relevant fact fast.
10. As an agent, I want accent-insensitive and plural-insensitive search in Portuguese and English, so that `migrações` finds `migração`.
11. As an agent, I want exact matches ranked above stem-only matches, so that precise queries win.
12. As an agent, I want a wake block at session start, within a byte budget, so that I begin with the most useful memories without flooding my context.
13. As an agent, I want a brief on a topic, within a byte budget, so that I get the memories for one question.
14. As an agent, I want memories rendered as attributed evidence with id, scope and revision, so that I treat them as facts to weigh, not instructions to follow.
15. As an agent, I want a retried write with the same op id to return the first result, so that a crash and retry never duplicates a memory.
16. As an agent, I want a retried write with the same op id but a different payload refused, so that a key collision is never silently accepted.
17. As a host, I want to give each writer an authority fence (a key and an epoch) that the store enforces inside the write, so that a writer whose authority ended commits nothing.
18. As a developer, I want to retract a memory, so that agents stop seeing it while I can still review it.
19. As a developer, I want to redact a memory, so that its text is gone from every view, including summaries made from it.
20. As a developer, I want to supersede a memory with a newer one, so that agents see only the current fact.
21. As an agent, I want to see which memories are due for a summary, so that I can compress them.
22. As an agent, I want my summary refused if a source memory changed since I read it, so that summaries never describe stale facts.
23. As a developer, I want every memory to record its provenance (agent, harness, model, host, op id), so that I can judge where a fact came from.
24. As a host, I want an egress filter applied to every rendering for a principal, so that I can mask or deny content at the edge.
25. As a developer, I want a per-scope retention rule that redacts memories older than a set age when I run a sweep, so that old personal facts expire.
26. As a developer, I want to import an existing OptMem store, so that I keep what my agents already know.
27. As a developer, I want to export my memories as JSONL in a documented format, so that I can read, back up and move them without relembra.
28. As a developer, I want `relembra check` to verify the store's integrity, so that I can detect corruption before it misleads an agent.
29. As a developer, I want a session-start hook script for Claude Code and Codex, so that every agent wakes with the memory without manual steps.
30. As a library user, I want to embed relembra in a Node or Bun program with no runtime dependencies, so that it adds nothing to my supply chain.
31. As an adapter author, I want an exported conformance suite, so that my store adapter is proven to behave like the built-in ones.
32. As a maintainer, I want an eval harness that scores relembra and a baseline on the same questions (hit@5, MRR, abstention, scope denial, leaks, wake coverage), so that releases are gated on measurement.
33. As a maintainer, I want a latency benchmark over 20,000 synthetic memories, warm and cold, so that the session-start cost is known.
34. As a maintainer, I want the scorer to reject malformed candidate responses, enforce deadlines, and catch leaks in every surface, including id-only renderings and future notes in briefs, so that a candidate cannot game the score.

## Implementation Decisions

- **One package, subpath exports:** the core (`relembra`), `relembra/sqlite`, `relembra/testing`
  (conformance suite and in-memory store). Postgres, pi-durable and MCP come in later versions.
- **Core is pure:** no I/O in the core. Ports: `Store` (transactional), `Policy` (host context →
  principal, including its authority fence), `EgressFilter`, `ErasureHook` (called with carriers
  on redaction), `Clock`, `Ids`.
- **Principal:** `{ id, readable: Scope[], writable: Scope[], promotable: Scope[], pinnable?:
  Scope[], owned?: Scope[], trustCeiling?, fence? }`. `owned` scopes are where the principal may
  retract, redact and supersede, and see retracted memories. Stores
  receive the readable set and filter in the query, before ranking.
- **Events:** append-only, except that redaction overwrites text with a tombstone. Ops: `note`,
  `retract`, `redact`, `supersede`, `summarize`. `promote` is defined in the model but enabled in
  v0.3.
- **Op id:** unique per principal per store; payload hash compared on conflict; the result is stored in the same
  transaction as the mutation.
- **Guard:** ≤ 280 UTF-8 bytes, a single line, no Cc/Cf/bidi/zero-width characters, and credential
  shapes rejected (private keys, common token prefixes, high-entropy assignments). Rejections name
  the rule and never echo the input.
- **Ranking:** exactly `docs/specs/ranking-algorithm.md`, computed in TypeScript over candidates the
  store returns. Stores return every live memory in the readable scopes; ranking statistics (N, df,
  avgdl) are computed over that whole set, so stores never prefilter by text. If find latency over
  20,000 memories misses its target, a store-maintained term index with exact statistics is the
  planned change, not an FTS prefilter.
- **Wake composition order:** pinned memories (a pin flag set at note time, by a principal whose
  `pinnable` scopes include the memory's scope; never `untrusted` ones), then the scope's recent
  memories that no live summary covers, then the summaries no summary covers (most trusted
  first), then the memories they cover, each group newest first; after the pinned memories every trusted memory comes before every `untrusted` one.
  A summary covers a memory only at its current revision and only when the summary's trust is at
  least the memory's, so a less trusted summary never displaces what it summarizes; the same rule
  decides which memories `pending()` lists as due. Then an index
  of the remaining ids (`<index id="…"/>`), within the byte budget (default 9,500 UTF-8 bytes). The
  longest prefix of that order that fits renders in full; entries are omitted whole, never cut.
  Brief: the top find results for the topic in rank order, then their summaries, under the
  budget, with no index. A budget that cannot hold the frame is refused (`BudgetError`).
- **Rendering:** `<memory id="…" scope="…" rev="…" at="…" trust="…">text</memory>`, one per line,
  inside a `<wake>` or `<brief>` frame. `&`, `<`, `>` and `"` are escaped in text and attributes;
  ids are at most 128 bytes and scopes 256. The egress filter runs on the final text, and the
  budget is measured after it: an expanding filter leaves fewer whole entries.
- **Retention:** `{ scope, maxAgeDays }` rules; `sweep(now)` redacts expired memories and returns
  what it changed.
- **SQLite store:** `node:sqlite`, WAL, one transaction per write, forward-only migrations with a
  `schema_version` table, file mode 0600 and directory mode 0700. The store file and its sidecars
  must be regular files, never symbolic links.
- **CLI:** `init, note, find, recall, wake, brief, zoom, retract, redact, supersede, pending,
  summarize, sweep, check, import, export, hook`. Scope comes from the git project (its normalized
  `origin` URL, else its common git directory, hashed) plus the OS user id, overridable only by an
  environment variable the host sets (`RELEMBRA_SCOPE`), never by an argument; `docs/CLI.md`
  holds the exact rule. The CLI's trust ceiling is `agent`: owner trust needs a person to confirm
  at the terminal, so no flag grants it. The store path comes from `RELEMBRA_HOME` (default `~/.relembra`).
- **Build:** the library compiles to ESM with `.d.ts` via `tsc`, and the CLI via `bun build
  --compile --aot --trim` for darwin-arm64 and linux-x64 (`bun run build:cli`). `install.sh`
  verifies a binary's sha256 before installing it; downloading release binaries waits for
  releases.
- **Format:** `docs/FORMAT.md` specifies the JSONL export (one event per line, versioned).
- **Eval:** in `eval/`, in TypeScript. A JSON-lines stdio protocol, the scorer, synthetic
  candidates (perfect, empty, leaky), a relembra candidate, and the latency benchmark (20,000
  memories from a fixed seed, warm: 50 warm-up and 500 measured queries; cold: a process per
  query). Personal data never enters the repository.

## Testing Decisions

- Test external behaviour through the library's public API and the CLI, never internals.
- Every negative assertion has a positive control (a denied read beside an allowed read; a caught
  leak beside a clean run; two rows without the op-id constraint).
- Store behaviour is tested once, in the conformance suite, and run against every store.
- The tests run under `bun test`, and a Node smoke test imports the built library and runs a
  note-find round trip with `node --test`.
- Ranking tests pin the properties in `docs/specs/ranking-algorithm.md` §6.
- The eval scorer's tests include the reviewer's probes: future notes through brief, id-only leaks,
  unchecked wake scopes, malformed responses (duplicate ids, wrong types, extra results), and a
  hung candidate stopped by its deadline.

## Out of Scope

- Postgres store, sharing across machines, the pi-durable integration, conversation-scoped op ids
  from a runtime (v0.2).
- MCP server, promotion, erasure carriers reported by integrations, release gates in CI (v0.3).
- Embeddings and any model call inside relembra.
- Windows builds.

## Further Notes

- The CLI's cold start is the number agents feel. Measured on a 20,000-row SQLite FTS5 query on
  2026-10-30: 18 ms as a Bun AOT binary against 57 ms on Node 26.
- OptMem has no licence. The importer reads its file format, and no code is copied.
