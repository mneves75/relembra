# Changelog

All notable changes to relembra. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0-beta.1] - 2026-11-01

The first public release, a beta: on npm under the `beta` dist-tag (`npm install relembra@beta`),
with a macOS arm64 CLI binary on the GitHub release. The API, the store schemas and the export
format may still change before 1.0.0; any such change will be listed here with its migration.
Stores and exports written by the private 0.x pre-releases open unchanged (SQLite schema 6,
Postgres schema 3, export format 2).

### Added

- Library core (`relembra`): `note`, `find`, `wake`, `brief`, `zoom`, `retract`, `redact`,
  `supersede`, `promote`, `pending`/`submitSummary` and retention `sweep`, behind a host policy
  that maps the host's authenticated context to a principal with readable, writable, pinnable,
  promotable and owned scopes. Every write is idempotent under an op id, with its outcome
  persisted; an authority fence (key and epoch) orders hosts with more than one writer.
- Guard: refuses blank, over-long, multi-line or ill-formed text, bidirectional, zero-width,
  control, format and invisible characters, and credentials, in memory text and in every
  identifier (scope, memory id, principal id, fence key, carrier). Errors name the rule and never
  echo the text. Renderings write any character the guard refuses as a numeric reference.
- Trust tiers (`owner`, `agent`, `untrusted`) with a per-principal ceiling, a trust floor for
  summaries, and escaped rendering of every memory line.
- Ranked find: BM25 as specified in `docs/specs/ranking-algorithm.md`, over a term index the store
  keeps in the same transaction as each write. `wake`, `brief` and `findRendering` render through
  the egress filter and a byte budget (9,500 bytes by default for the wake).
- Promotion across scopes: a principal with promote rights copies a live memory it may read into
  another scope at the exact revision it read; the copy keeps its origin and never exceeds the
  origin's trust.
- Erasure: a redaction turns the text into a tombstone everywhere, with the summaries and promoted
  copies derived from it, in one transaction, then scrubs the SQLite WAL. `sweepPreview` and
  `redactionPreview` show what will change; an approved plan aborts with `PlanChangedError` if the
  affected set changes before commit. Renderings given a carrier record which carriers received
  which memories, and `deliverErasures(hook)` hands each redaction's carriers to the host until it
  answers `acknowledged` or `unsupported` per carrier; nothing reports an external copy as erased.
- Stores: SQLite (`relembra/sqlite`, on `node:sqlite`: WAL, `synchronous=FULL`, `secure_delete`,
  defensive mode, files created 0600, versioned migrations that refuse a newer schema); Postgres
  (`relembra/postgres`, over a SQL client the host passes, so relembra installs no driver; writers
  on every machine serialized behind a lock row, lost commits resolved from the persisted op
  record, the database clock for time); and `relembra/testing`, an in-memory store with the
  conformance suite every adapter must pass. `examples/shared-postgres` shares one memory between
  two hosts with their own policies.
- pi-durable integration (`relembra/pi-durable`, optional peer `@earendil-works/pi-durable`
  exactly 1.4.0): the `memory_note`, `memory_find` and `memory_brief` tools and a wake section in
  the system prompt, crash-safe through op ids.
- JSONL export and import (format 2, header, preserved tombstones, checked replay) and an OptMem
  import (records as OptMem 1.3.5 writes them, the date moved to provenance). Imports grant no
  trust or pins and are bounded (`docs/FORMAT.md`).
- CLI (`relembra`), a Bun AOT binary: scope from the git repository, principal from the OS user,
  owner trust only after a code typed at the terminal, a `--json` envelope with stable error
  codes, `init` to print the session hook, `RELEMBRA_GLOBAL_SCOPE` for a scope every session also
  reads, and `relembra mcp`, an MCP server over stdio (protocol revision 2026-07-28) with the tools
  `note`, `find`, `brief`, `wake` and `retract`. `install.sh` verifies the checksum before it
  installs (`docs/CLI.md`).
- Evaluation harness (`bun run eval`): a JSON-lines candidate protocol, a seeded synthetic corpus,
  gates for leaks, scope denial, hit@5, wake coverage, label violations and superseded memories
  served, and control candidates that must fail. Results in `docs/eval/`.
- Release checks: `scripts/ci.sh`, the whole gate on one committed candidate, with a manifest
  binding the candidate to the tested binary and package hashes; `scripts/check-release.sh`, the
  gate followed by the strict latency benchmark (raw warm find p95 at most 50 ms on Bun and Node
  over 20,000 memories); a pre-push hook; hosted CI on every push to `main` and pull request.
- A bilingual landing page (`site/`, pt-BR and English, light and dark, with a Motion switch
  that defaults to the system's reduced-motion setting) whose demos run the real library in the
  browser. `?lang=en` or `?lang=pt-BR` in the URL chooses the language.
- Releases reach npm through trusted publishing: publishing a GitHub release stages its retained
  archive on npm, after checking it against the release's `SHA256SUMS`, and the owner approves
  the staged version with their two-factor key. No npm token is stored anywhere.
- The site deploys to GitHub Pages from a manually run workflow with OIDC
  (`actions/deploy-pages`), so no stored token can change it. `scripts/site/assemble.sh` builds
  what ships from a commit's `site/` and the checked video.

### Security

Every ticket and release was reviewed by a second model before merge; the rounds are recorded in the progress
table of `docs/specs/IMPLEMENTATION-PLAN.md`. Known residuals are documented in `docs/FORMAT.md`
(import id existence) and `docs/CLI.md` (same-user trust model). Report vulnerabilities as
[SECURITY.md](SECURITY.md) describes.

[1.0.0-beta.1]: https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.1
