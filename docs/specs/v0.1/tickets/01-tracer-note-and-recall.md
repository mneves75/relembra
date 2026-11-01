# 01: Tracer bullet: write and read back a scoped memory through the library

**What to build:** A program imports relembra, opens an in-memory store with a host policy, writes a memory as a principal, and reads it back from the same scope; another principal without that scope cannot see it. The package scaffold (Bun, strict TypeScript, Biome, `bun test`) exists, and the core model (Memory, Revision, Event, Scope, Principal, Provenance), the ports and the guard are in place.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Package scaffold: package.json (name relembra, type module, zero dependencies), strict tsconfig, Biome, `bun test` passing
- [x] A memory written by a principal with write access to scope S is returned by recall for a principal that can read S
- [x] A principal without read access to S never sees it (with a positive control in the same test)
- [x] The guard rejects: > 280 bytes, multi-line, control/bidi/zero-width characters, and credential shapes; each rejection names the rule and never echoes the input
- [x] Every memory carries provenance (agent, harness, model, host, op id)
- [x] `bun run typecheck` and `bun run lint` pass

## Comments

Evidence, 2026-10-30 (branch `feat/v0.1`):

- Scaffold: `package.json` (relembra, ESM, no `dependencies`), `tsconfig.json` (strict), `biome.json`; `bun test` 44 pass, 0 fail.
- Write then recall: `test/tracer.test.ts` "a memory noted in a scope is recalled by a principal that can read the scope".
- Denied read with positive control: `test/tracer.test.ts` "a principal without read access to the scope never sees its memories"; denied write likewise.
- Guard: `test/guard.test.ts` covers each rule, checks that no error property carries the input, and has accepted positive controls.
- Provenance: `test/provenance.test.ts` (fields round-trip, op id generated when absent, blank or missing fields refused).
- `bun run typecheck` and `bun run lint` pass.
