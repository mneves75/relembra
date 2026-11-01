# Global memory beside the project's, and a lossless OptMem import

Status: built (tickets 01 and 02 on feat/global-memory). Owner decisions taken 2026-10-31.

## Problem

A user moving from OptMem to relembra has two gaps.

1. **The OptMem import drops and corrupts memories.** Every record in a real OptMem 1.3.5 `LOG.txt`
   begins with `#<n> <YYYY-MM-DD> `: the record's counter, from 0, then the date it was noted.
   `docs/FORMAT.md` assumed the whole record is the memory's text, so the import keeps that prefix.
   The memory's own text fits OptMem's 280-byte rule, but the prefix pushes it over relembra's: on
   a real store of 3,341 records, 766 were refused as `too-long`, and every imported memory begins
   with `#<n> <date>`. Keeping only the date still leaves 526 records over 280 bytes.
2. **No memory reaches every project.** OptMem is one flat memory, so standing rules and lessons
   learned in one project reach every session. The CLI gives each git project its own scope, and a
   session reads only that scope.

## Decisions

- **Importer (ticket 01).** A record that begins with `#<n> <YYYY-MM-DD> ` has that prefix removed
  before the text is guarded and stored. The date moves to provenance (ADR 0001). `<n>` must equal
  the record's position minus one, or the import is refused as `not-optmem`. A record without the
  prefix is read as today.
- **Global scope (ticket 02).** `RELEMBRA_GLOBAL_SCOPE` names a scope that the CLI principal can
  also read, wherever it runs. Writes still go to the session's scope only. The library's invariant
  does not change: a principal reads only the scopes its policy grants, and the CLI's policy now
  grants two. To write, retract, redact or supersede in the global scope, the caller sets
  `RELEMBRA_SCOPE` to it. No argument changes the scope, as today.
- No flag, configuration file or MCP tool argument is added.

## Out of scope

- Postgres for the CLI, and changing the library API.
- Importing OptMem's `TREE/` summaries; the summaries are rebuilt in relembra with
  `pending` and `summarize`.
- Pinning owner rules after an import: the owner does that at the terminal.

## Tickets

Both built and reviewed (gpt-6.1-sol, P3): 01, the OptMem record prefix (ADR 0001), and 02,
`RELEMBRA_GLOBAL_SCOPE`. The ticket files were removed when the work finished; their evidence
is in the commits and in this branch's pull request.
