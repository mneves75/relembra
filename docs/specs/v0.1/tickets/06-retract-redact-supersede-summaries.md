# 06: Retract, redact, supersede, summaries and retention

**What to build:** A developer retracts, redacts and supersedes memories; agents can list memories due for a summary and submit one bound to source revisions; redaction removes text everywhere, including derived summaries, and calls the erasure hook; a retention sweep redacts expired memories.

**Blocked by:** 04, 05

**Status:** done, pending review

- [x] Retracted memories vanish from find, recall, wake and brief, and remain visible in an owner view, marked
- [x] Redacted text is absent from every view and every summary derived from it; the leak check finds a planted copy (positive control)
- [x] Superseded memories stop being served; the replacement is
- [x] submitSummary is refused when a source revision changed since `pending()`
- [x] sweep(now) redacts exactly the memories older than the scope's maxAgeDays and reports them
- [x] All store-touching behaviour is in the conformance suite
- [x] Redaction scrubs cached op results and content fingerprints; a retry of the redacted op returns a terminal `redacted` outcome with no text (§4.3)
- [x] A summary's trust is the least of its sources
- [x] Redaction records outbox rows for erasure work in the same transaction (delivery is ticket 16)

## Comments

Built 2026-10-30 on `feat/v0.1`, commits `2f09445` to `1cc4891`. Every test below was seen
failing before its code existed. "Both stores" means the case is in `storeConformanceCases` and
runs on the memory store (`test/conformance.test.ts`) and the SQLite store
(`test/sqlite.test.ts`); "flaws" are the flawed-store controls in
`test/conformance-controls.test.ts`, each of which must fail its case with an error that is not a
ReferenceError, TypeError or SyntaxError.

### Evidence per box

- **Retract.** `retract` and `recall({ includeRetracted })` in `src/relembra.ts`. Conformance
  (both stores): retracted memories vanish from find, recall, wake and brief and the owner's
  recall shows them with `status: "retracted"`; live-only reads; retracted scopes; the retract
  cascade to derived summaries. Flaws: `serves-retracted`, `hides-retracted`,
  `retracted-everywhere`, `drops-status`, `forgets-on-reopen`, `append-stores-nothing`,
  `no-derived`. Unit: `test/retract.test.ts`.
- **Redact and the leak check.** `redact`, `redactWithDerived` in `src/relembra.ts`;
  `tx.redact` in both stores. Conformance case "a redacted memory's text is gone from every
  view, derived summary, event, op record and stored byte, while a planted copy is found": it
  searches recall, find, wake, brief, the derived summary, events, op records and, for SQLite,
  the raw bytes of the database, `-wal` and `-shm` files, for any 16-byte piece of the text,
  beside a planted copy that must be found. Flaws: `redact-noop`, `redact-keeps-event-text`,
  `redact-keeps-fingerprint`, `no-derived`, `forgets-erasures`, `keeps-freed-bytes`. The SQLite
  store runs with `secure_delete` on (checked at open); `test/sqlite.test.ts` shows the same
  rewrite leaves the text on disk with it off and not with it on, and that a reader holding an
  old snapshot defers the WAL truncation until a later commit. A truncation that cannot finish
  is recorded in `wal_scrub` and retried at the next commit, close or open; `walScrubPending()`
  reports it and `close()` rejects with `WalScrubError` (commit `ed37e5c`).
- **Supersede.** `supersede` in `src/relembra.ts`. Conformance: a chain on both handles with a
  retried supersede returning the first replacement; retracted and redacted targets refused,
  writing nothing; pinned and over-ceiling targets refused; derived summaries retracted. Flaws:
  `serves-superseded`, `drops-superseded-by`, `no-op-enforcement`, `forgets-on-reopen`,
  `drops-status`, `redact-noop`, `drops-pinned`, `drops-trust`, `no-derived`. Unit:
  `test/supersede.test.ts`, 8 tests, including the owner superseding its own pinned rule.
- **submitSummary refused on a changed source.** Conformance: a source superseded, retracted or
  given a new revision after `pending()` makes `submitSummary` reject with `SourceChangedError`
  and write nothing; the current revision is accepted. Existence is checked first by the rule
  every read uses (`visible`): a reader that does not own the scope gets `MemoryNotFoundError` for
  a retracted, superseded or redacted source, never `SourceChangedError`, so it cannot learn the
  source exists; the owner gets `SourceChangedError`. Flaw: `drops-status`. "Due" is: live,
  unpinned, not a summary, and not covered by a live summary of at least its trust at its current
  revision, oldest first (an agent or untrusted summary of a more trusted memory leaves it due). Conformance case for `pending` (flaws `drops-sources`, `drops-pinned`,
  `forgets-on-reopen`). Unit: `test/summary.test.ts`.
- **Summaries in wake and brief.** Wake: pinned, recent memories no live summary covers,
  summaries, the covered sources, then the index, with every untrusted memory after every
  trusted one. A summary covers a source only when its trust is at least the source's (with the
  trust floor, an equal trust), so an agent summary of an owner memory leaves that memory in its
  recent place, ahead of the summary. Summaries no summary covers sort most trusted first, so an
  agent summary of an owner summary renders after it; a covered summary joins the covered
  memories. Brief: ranked results, then the live
  summaries covering them not already shown. Both under ticket 05's whole-entry budget.
  Conformance on both handles (flaws `drops-sources`, `forgets-on-reopen`); budget tests in
  `test/summary.test.ts`.
- **sweep(now).** `sweep` and `RelembraOptions.retention` in `src/relembra.ts`;
  `tx.expiring` in both stores. Conformance: exactly `maxAgeDays` old is kept and one
  millisecond more is redacted; pinned and retracted expired memories are redacted; a young
  summary of an expired memory is redacted as derived; a scope with no rule is untouched; events
  carry cause `retention` (derived: `source`) and a null principal; the report lists them.
  Flaws: `expiring-inclusive`, `expiring-ignores-scope`, `expiring-live-only`, `no-derived`,
  `redact-noop`, `forgets-erasures`. Unit: `test/retention.test.ts` (rule validation, `now`
  validation, nothing expires unless the host calls sweep, per-scope rules).
- **Conformance.** Every store-touching behaviour above is a conformance case on both stores,
  and the "every case has a flaw that fails it" guard holds.
- **Scrubbed op results and terminal `redacted`.** Redaction sets every op fingerprint naming
  the memory to null and removes the text and provenance from its `note` or `summarize` event.
  A retry of the op that wrote a redacted memory rejects with `MemoryRedactedError` whatever its
  payload (note, supersede, summarize). Conformance (flaws `redact-noop`, `forgets-on-reopen`)
  and unit tests.
- **Trust floor.** A summary's trust is the least of its sources'; an explicit higher trust is
  `ProvenanceError` `trust` `above-sources`. Conformance (flaw `drops-trust`) and unit.
- **Outbox.** `tx.putErasure` in the redaction transaction. Conformance: a redaction that rolls
  back leaves the memory, events, op record whole and no outbox row. Flaws:
  `redact-outside-transaction`, `erasures-outside-transaction`, `forgets-erasures`.
- **Format.** `retract`, `redact`, `supersede`, `summarize` and the redacted forms are format 1
  events, documented in `docs/FORMAT.md` with schema version 2.

### Not covered here

The plan's amendment "a reimported stale export is refused where the tombstone is kept" needs
import, which is ticket 08. This ticket keeps the tombstone (`tombstones` table, `tx.memory`
returns it) that the import check will read.


**Supersede authority (security review, 2026-10-30).** Superseding hides the target from every
reader, so it is a retract plus a note and needs at least what each needs:

- write access to the target's scope (the replacement is written there);
- ownership of the target's scope (`Principal.owned`), always, as retract requires;
- pin rights on the scope when the target or the replacement is pinned;
- a trust ceiling at or above the target's trust: an agent cannot supersede an owner memory, and
  an untrusted principal cannot supersede an agent or owner one (`ProvenanceError` `trust`
  `above-ceiling`);
- a live target: retracted, superseded and redacted targets are refused (`MemoryStateError`);
- a target that is not a summary (`SummarySupersedeError`).

**Summaries are not superseded (review, 2026-10-31).** A replacement would carry the summary's
facts with no sources, so redacting a source would not reach it. To change a summary, retract it
and submit a new one: `submitSummary` is the only path that checks the sources' current revisions
and trust. Rejected: letting the replacement inherit the summary's sources and trust floor, which
would bind new text to revisions nobody re-checked.

**WAL scrub (review, 2026-10-31).** Every handle reads the persisted `wal_scrub` row, not a flag of
the handle that redacted. The row counts redactions and the count last truncated after, so a scrub
never clears a redaction committed after its own truncation. Refusing a newer schema that another
process committed after the read-only probe closes the writable connection while a read-only one
holds the WAL, so neither the main file nor the WAL changes. A rollback-journal (or new) file is
switched to WAL only after its version is checked under one exclusive lock, kept from the check
through the journal-mode switch, so no upgrader commits in between.

A retry of a supersede rechecks write access and ownership of the replacement's scope (§4.3).
Supersede retracts the live summaries derived from the target, as retract does.

Visibility is unchanged and the same in recall, find, wake and brief: a scope's owner sees every
status, a reader sees live memories only, and anything else is `MemoryNotFoundError`.

Rejected: letting the memory's author supersede it with write access alone. No stored field
identifies the writing principal (`Provenance.agent` is caller-supplied, untrusted per §4.1), so
the rule would need a new authenticated author field or an ops-by-memory store read on both
stores. The spec's story 20 and this ticket put supersede in the developer's hands beside retract.
Revisit if an authenticated author field is added.
