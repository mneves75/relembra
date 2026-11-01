# 14: Sharing across machines

**What to build:** Two host programs on different machines share one memory through Postgres.

**Blocked by:** 12

**Status:** done, pending review

- [x] Two minimal host programs inject one SqlClient and see each other's memories in a shared scope
- [x] Neither ever sees another scope's memories (positive control: the shared scope)
- [x] The shipped CLI stays SQLite-only; a Postgres CLI configuration would be its own ticket

Built 2026-10-31 on `feat/v0.2-t14`, from ticket 12 at `e8b75cd`.

### Evidence per box

- **Shared scope.** `examples/shared-postgres/host-a.ts` and `host-b.ts`, each its own OS
  process with its own Policy, principal and Bun.SQL pool over `host.ts`.
  `test/postgres-sharing.test.ts` runs them as child processes on one database: each finds,
  recalls and zooms the other's shared memories, with the other host's provenance. Red before the
  hosts existed (module not found); a mutant that drops `shared` from host B's policy fails it.
- **Other scopes.** The same file: one query matching all four memories returns the shared two
  and the host's own, a term only the other's private memory holds finds nothing (its owner finds
  it), naming the other's scope is `ScopeDeniedError`, its memory id is `MemoryNotFoundError`, and
  no output carries its text or id, beside the shared scope working in the same run. After host
  A redacts its shared memory, host B's find, recall and zoom drop it and no output holds a piece
  of its text; host B may not redact there. Mutants: host B granted `private-a` fails the leak
  assertions; a redact that checks authority but erases nothing fails B's view after it.
- **CLI.** `test/cli/no-postgres.test.ts`: the CLI's import graph reaches the SQLite store and
  nothing under `src/postgres` or Bun's SQL; it declares no Postgres variable; the binary holds
  SQLite-store literals and no Postgres-store ones; with Postgres variables at a closed port it
  still works on its SQLite file, and Postgres flags are usage errors. The property held already,
  so the red run is a mutant: a CLI that opens the Postgres store when `RELEMBRA_POSTGRES_URL` is
  set fails the graph, binary and behaviour tests.
