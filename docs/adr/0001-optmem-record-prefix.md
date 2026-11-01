# 0001: The OptMem record prefix leaves the text; its date goes to provenance

Date: 2026-10-31. Status: accepted.

## Context

A real OptMem 1.3.5 store, read byte by byte, shows every record as `#<n> <YYYY-MM-DD> <text>`,
padded with spaces to the record width. `<n>` counts from 0 and equals the record's position
minus one, and the text alone is at most 280 bytes. `docs/FORMAT.md` had assumed the whole record
is text ("including any date it begins with"), noting that the assumption was never checked
against a real store. Under that rule, 766 of 3,341 real records are refused as `too-long`.
Removing only the counter still leaves 526 of them over 280 bytes.

## Decision

- Remove the whole `#<n> <YYYY-MM-DD> ` prefix. What remains, with the trailing padding removed,
  is the memory's text.
- The date goes into the record's provenance `source`, which becomes
  `optmem:<store>:<n>:<YYYY-MM-DD>`. Nothing is lost. `notedAt` stays the import's acceptance
  time: as before, a file never sets a memory's time, so retention still counts from the import.
- `<n>` must equal the record's position minus one. A record whose counter does not match, or a
  log that mixes records with and without the prefix, is refused as `not-optmem`, which catches a
  spliced or reordered log.
- A log whose records have no prefix is read as before.
- A record that begins with `#<digits> <YYYY-MM-DD> ` always carries the prefix; there is no
  plain reading of it. OptMem always writes the prefix, so a log whose every record begins
  `#<position − 1> <real date> ` is the OptMem format by definition, even if someone meant it as
  plain text: `#0 2026-07-27 Deploy on Friday.` imports as `Deploy on Friday.` with the date in
  `source`.

## Consequences

- A store that imported a prefixed log under 0.3.x has memories that still begin with
  `#<n> <date>`. Importing the same log again gives the same ids with different text, so it is
  refused as `modified`. The repair is a fresh destination scope or store, never redaction: an
  import skips a tombstone and never writes over it, so a redacted record stays redacted and its
  corrected text is never imported there. No shim is added.
- The `<n>` in `source` is the record's position from 1, as in the memory id and in a plain
  record's `optmem:<store>:<n>`, not the prefix's counter from 0; the counter is that position
  minus one, so nothing is lost.
- The memory ids are unchanged: they are minted from the scope, the store name and the record's
  position, never from the text.

## Rejected

- **Keep the date in the text.** Simplest, but 526 records still fail the 280-byte rule.
- **Set `notedAt` from the date.** That lets a file choose a memory's time, which FORMAT.md forbids
  so that a file cannot keep a memory out of retention.
