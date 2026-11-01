# 17: Promotion

**What to build:** A principal promotes a memory, at an exact revision, into a scope it may promote into.

**Blocked by:** 05, 06

**Status:** merged into `feat/v0.3` (0.3.0)

- [x] The copy keeps a link to its origin and revision; promotion is refused if the revision changed
- [x] The copy's trust is at most the origin's
- [x] Redacting the origin reaches the copy

Decisions (docs/FORMAT.md, `promote`): retracting or superseding the origin does not reach the
copy; a summary is not promoted; promote events carry event format 2; the CLI has no promote
command (docs/CLI.md).
