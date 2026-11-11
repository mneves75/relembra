# Product

<!-- impeccable:product-schema 1 -->

Inferred from README.md and the owner's brief, 2026-11-10.

## Platform

web

## Stack

Static HTML, CSS and JavaScript in `site/`, no framework, no build step besides `bun run build:site`
(which bundles the library into `site/assets/relembra.js` for the page's demos).

## Users

Developers who run AI coding agents (Claude Code, Codex, opencode, pi) on their own machines and
want those agents to remember project facts between sessions.

## Product Purpose

A shared memory every agent on the machine reads at session start: one fact per line (at most 280
bytes), scoped per project, bounded by byte budgets, durable, truly erasable (redaction), and
measured by an eval with controls that must fail.

## Positioning

Curated lines instead of transcripts or embeddings. The guard refuses secrets. Redaction reaches
summaries and reports which carriers still hold a copy. Results are measured, not promised.

## Capabilities and Constraints

A TypeScript library with zero runtime dependencies (Node 24.14+ or Bun 1.4+), a single-binary CLI
with a session-start hook, a stdio MCP server, SQLite and Postgres stores. Public beta under the
MIT licence; the version on the page always equals `package.json`'s.

## Brand Commitments

- The name is "relembra", always lowercase.
- pt-BR first, English second, both complete.
- Plain technical voice.
- Generic examples only ("Projeto A", "Projeto B"); the page names no other projects, clients or
  people.

## Evidence on Hand

- The live demos, which run the real library in the browser (`site/assets/relembra.js`).
- The eval and latency numbers in `docs/eval` and `docs/bench`.
- The explainer video, kept on the `gh-pages` branch.
- The docs in `docs/`.

No customers, testimonials or logos exist; invent none.

## Product Principles

- Show the mechanism working rather than describe it.
- Every claim carries a number or a reproducible source.
- Say what the product does not do (it never claims an erased copy it cannot reach).
