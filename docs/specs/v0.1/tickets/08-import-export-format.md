# 08: OptMem import, JSONL export and the documented format

**What to build:** A developer imports an existing OptMem store into a scope and exports any store as JSONL that `docs/FORMAT.md` fully describes; importing twice adds nothing.

**Blocked by:** 07

**Status:** done, pending review

- [x] docs/FORMAT.md specifies every export field and its version
- [x] Export then re-import into an empty store reproduces every memory's text byte for byte
- [x] OptMem import is idempotent by source id, tested on a synthetic OptMem-format fixture written for this repo
- [x] A truncated or modified source prefix is refused
- [x] The export header carries format and relembra versions; an import refuses a newer format
- [x] Imports keep namespaced source ids and tombstones and never grant `owner` trust or pins

## Comments

Built 2026-10-31 on `feat/v0.1-t08` (from ticket 07 at `9138814`), commits `c367890` to the
ticket-close commit. Every test below was seen failing before its code existed, except where a
row says otherwise.

### Evidence per box

- **FORMAT.md, every field and its version.** "JSONL export" documents the header (`export`,
  `format`, `relembra`, `scopes`) and the event lines field by field (they are the "Events"
  section's events, `seq` included); "Import of an export" and "OptMem import" give the rules;
  the SQLite layout is schema version 3. `RELEMBRA_VERSION` (`src/version.ts`) is checked
  against `package.json` by a test.
- **Round trip, byte for byte.** `test/round-trip.test.ts`: 40 seeded random corpora on the
  memory store and 5 on SQLite (notes with accents, combining marks, emoji, JSON and XML
  specials; pins; supersedes; summaries of summaries; retractions; redactions), exported and
  imported into an empty store: every memory's id, scope, status, links and text match, texts
  compared as UTF-8 bytes. A second import and the copy's own export imported back add nothing.
  The corpora cover every event kind and both redacted forms (checked); a tampered export is
  caught (positive control). The property found two bugs before it passed: cascade lines were
  counted wrong, and retract and supersede lines of later-redacted memories were dropped.
- **OptMem idempotent by source id, on a synthetic fixture.** `test/fixtures/optmem/memory/LOG.txt`
  (six generic 100-byte records, written for this repo). `test/optmem.test.ts`: a second import
  adds nothing, with the checkpoint and without one (a store rebuilt from an export holds the ids
  but no checkpoint); a redacted record stays redacted; a grown log imports only its new records.
- **Truncated or modified prefix refused.** Four shapes (cut, cut and regrown past the old
  length, one byte changed, changed and grown) refuse with `truncated` or `modified` and write
  nothing; the unchanged log is accepted beside them. The checkpoint holds only a length and the
  record width: a shorter log is `truncated`, another width is `modified`, and each record is
  compared with the memory it became before the guard sees it (`modified`). A change at a
  redacted or guard-refused record is not seen, by design (see the security reviews).
- **Header versions; newer format refused.** `test/transfer.test.ts`: the header is
  `{ export, format: 1, relembra, scopes }`; `format: 2` in the header (line 1) or in an event
  (line 2) refuses with `format-too-new` and writes nothing; the same file at format 1 imports.
  The CLI test refuses it end to end (`import`, rule `format-too-new`).
- **Namespaced source ids, tombstones, no owner trust or pins.** OptMem record `n` keeps the
  namespaced source id `optmem:<store>:<n>` in its provenance; its memory id is
  `om-<32 hex of sha256(scope NUL optmem:<store> NUL n)>`, minted per destination scope (op id
  the same). An export keeps memory
  ids; its tombstones are imported as tombstones (redacted forms and the `redact` event). A
  memory the target holds as a tombstone, with text in the file, refuses the import
  (`redacted-in-target`, the item deferred from 06), beside a positive control into a store
  without the tombstone. An owner-trust pinned memory imports as `agent`, unpinned;
  `untrusted` stays `untrusted`; a principal with a lower ceiling caps it further.

### Store and schema

`Store.events({ scopes })` (scoped in the read) and `tx.checkpoint` / `tx.putCheckpoint`, with
two conformance cases on both stores and seven flaws that fail them. Migration 3 adds
`import_checkpoints` (`source`, `bytes`, `width`: no hash) and an `events (scope, seq)` index; a
schema-2 file with a memory, a
tombstone and a scrubbed op record migrates keeping all three (red without migration 3). The
three tests that listed schema versions `[1, 2]` now list `[1, 2, 3]`. `src/sqlite/database.ts`
was not touched: it reads `MIGRATIONS.length`.

### Security review fixes (2026-10-31)

- **Future dates.** An export's revision `at` became `notedAt` unchecked, so a far-future date
  escaped every retention sweep. `importJsonl` now takes the host's `clock` and refuses a revision
  dated more than 5 minutes (`MAX_IMPORT_SKEW_MS`, clock skew) past it (`future-time`). Decision:
  keep the original `at` as provenance and `notedAt`. Bounded by the host's clock, a file can at
  most make a memory as young as its import, while an old memory keeps its age and retention
  sweeps it. Rejected: the import time as `notedAt`, which resets every imported memory's age.
  OptMem imports take their time from the injected clock only; a date inside a record is text.
- **Cross-scope oracle.** OptMem checkpoints and ids were keyed by store name alone, so an
  import into scope B was compared with scope A's (a shorter log answered `truncated`, shown
  against the old code). Keys now include a scope key (16 hex of the scope's sha256): each
  scope's import is independent. The importer must own the scope, checked before anything is
  read, and a planted id in another scope is a `conflict`, never compared. Rejected: refusing the
  second scope, since one OptMem home serving several repositories is the expected use.

### Second security review (Sol, at `ece5599`)

Four findings, each reproduced red before its fix, with positive controls.
- **Fingerprint after redaction (P1).** The checkpoint kept the sha256 of the prefix read, so a
  redacted record's hash still confirmed a guess of its text, on both stores (invariant 4). The
  checkpoint is now `{ source, bytes }`. Every import reads the whole log and compares each record
  with the memory it became; refused records are reported again on each run. Migration 3 changed
  in place: it exists only on this unmerged branch. Proved by two logs differing only in a
  redacted record leaving equal checkpoints on both stores, before and after a reimport, and by
  none of the record's hashes in the SQLite files after redaction. Rejected: per-record hashes
  scrubbed on redaction (the coordinator's example). A live record is already checked against its
  stored text, a redacted record's hash is the fingerprint to erase, and a refused record's hash
  fingerprints a credential, so no per-record hash would ever be used. Cost: a change at a
  redacted or refused record cannot be seen, since seeing it needs a fingerprint.
- **Supersede authority (P1).** A replayed `supersede` now makes the direct path's checks against
  the store's copy, ceiling first, then pin: `denied` with detail `above-ceiling` or `pin`.
  Retract and redact need ownership only, as their direct paths do.
- **Summary source oracle (P2).** A source's existence and scope are checked before its status:
  another scope's source is `malformed` whether live, redacted or absent.
- **Tombstone scope (P2).** A memory known only by its redacted form keeps its scope; its redact,
  retract or supersede, or its use as a replacement, from another scope refuses the import.

### Third security review (Sol round 2, at `fda8d9e`)

The round-1 fixes held on both stores. New findings, each red before its fix except where noted:
- **Cross-scope id oracle (P2).** The coordinator decided to keep one id namespace (no re-keying
  to `(scope, id)`). OptMem ids are now minted per destination scope (`om-<hash>`, deterministic,
  so re-imports stay idempotent), and one log imported into two scopes gives distinct ids, both
  imported fully. For JSONL, the residual (someone who already knows an id learns that it exists)
  is documented in FORMAT.md and at the check. The default `Ids` port was already
  `crypto.randomUUID`; a guard test pins it (green from the start: nothing to fix).
- **Guard refusal hid a change (P2).** Each record's memory is now read before the guard runs. A
  live record replaced by a blank or non-UTF-8 record is `modified`, and nothing is written.
- **Width change inside the checkpoint (P2).** The checkpoint stores the record width (migration
  3 edited in place again, still unreleased). A width change is `modified` before replay.
- **Self-supersession (P2).** A `supersede` may not replace itself (`malformed`). Round 2 also
  required the replacement's note on the line before; round 3 relaxed that (below).
- **Scope test flake.** `test/cli/scope.test.ts`'s every-command test has a 60 s deadline.

### Fourth security review (Sol round 3, at `b701e92`)

- **Overlapping imports (P2).** The adjacency rule broke on the store's own export. Import
  `[note(new)]`, then `[note(old), note(new), supersede(old→new)]`: the second import skips the
  held note, so the store's export reads note(new), note(old), supersede, and re-importing it was
  refused. The invariant now is that every successful import leaves an export that imports again.
  A supersede's replacement must be in the store or noted on an earlier line of the file, in the
  same scope (text or redacted form), at a distinct id. Self-supersession and the authority checks
  stay strict, and the replacement check now also covers a supersede of a memory known only by
  its tombstone. Rejected: reordering the export, which lists events in seq order and checks it.
  Proved by Sol's sequence on both stores and by a property test: 40 seeded corpora, six imports
  each of random partial exports into one store, every successful import's export re-imported
  into an empty store (red before; over 10 of those imports overlapped).
- **Lone-surrogate names (P2).** Two scopes differing only by a lone surrogate became the same
  scope once UTF-8 encoded, so their OptMem ids and checkpoint keys collided. Fixed at the root:
  `IllFormedStringError` (field `scope`, `principal id`, `memory id` or `fence key`) wherever
  such a name enters the library. That covers every principal from the policy and those given to
  transfers, caller and `Ids` memory ids, summary sources, retention scopes and fence keys. In an
  import file it is `malformed`. Texts and provenance fields were already refused by the guard.
  The CLI receives one only through a JSON escape in an import file, since argv and the
  environment are decoded from bytes.

### Fifth security review (Sol round 4, at `d6f6692`)

- **Supersession cycles (P2).** Once the round-3 fix only required the replacement to exist,
  `note(A), note(B), supersede(A→B), supersede(B→A)` imported. That left no live memory and
  cyclic links, which export and re-import kept. It also worked across two imports and among
  tombstone-only memories. Replay now applies the direct path's rule. When a supersede is
  applied, after earlier lines and the stored state, its target and its replacement must both
  be live in its scope (`conflict` otherwise). A memory known only by its tombstone carries the
  status its retract and supersede lines give it. A replacement is never already replaced, so no
  cycle forms and no graph walk is needed. The direct path was unchanged: its replacement is
  written fresh, so it is always live. Trade-off, documented in FORMAT.md: a file that
  supersedes into a memory the store has since superseded (an older export after a newer one) is
  refused. Chains (A→B, then B→C) still import, in one file or across imports, and through
  tombstones.
- **Event principal ids (P3).** A lone surrogate in an event's `principalId` imported. A
  non-null `principalId` must now be well-formed on every event kind; a `redact`'s may be null.
- **Slow tests.** In this branch's runs at load average about 459, the only 5 s timeout was
  the CLI scope test, given 60 s in round 2. The other failures were in ticket 09's eval tests
  (eval-transport, eval-score): assertion failures under load, not timeouts, and passing alone.
  In the passing full run, the slowest ticket-08 test was the overlapping-import property
  (2.1 s), now given 60 s.

### Integration with ticket 07 (at `d1cd76f`)

- The CLI's export and import run at `agent` trust (`transferPrincipal`), where they ran at
  `owner` before 07. 07's owner trust needs a person's confirmation at a terminal, and no prompt
  covers an import's lines. A replayed supersede of an owner memory is therefore now
  `denied:above-ceiling` through the CLI, proved by `test/cli/import-trust.test.ts`, which fails
  at an owner ceiling.
- A replayed redact of a stored memory builds 07's `redactionPlan` in the import's transaction,
  so it erases the same derived closure as the direct path. Replayed retract and supersede keep
  `retractDerived`, whose signature 07 did not change. Replay has no approval to match, so
  `matchPlan` has no counterpart, and no replay runs a sweep.
- A CLI import's `retract` or `redact` line changed an owner memory without 07's confirmation
  (found by a probe against the binary at `c5db3ff`). 07 then moved the rule into the library
  (`enforceCeiling`, at `fb42e4e`), and replay calls it. A replayed retract or supersede checks
  the target and its live derived summaries (`liveDerived`), then retracts exactly that list
  (`retractAll`). A replayed redact checks the plan's whole closure. A refusal maps to `denied`,
  detail `above-ceiling`, before anything is written. Tombstone-only history is exempt: it
  changes nothing the store held.
- A replayed redact of a stored memory is recorded as the importer's request (cause `request`,
  the importer's id), whatever cause the file names. A file's `retention` cause, with a null
  principal, replays only for a memory known only from the file.

### Integration with feat/v0.1 (at `145dfd2`: 06's final fixes)

- 06 refuses to supersede a summary (`SummarySupersedeError`, 03ce584). Replay now refuses a
  `supersede` whose target or replacement is a summary, stored or known only by its tombstone,
  as `malformed` with detail `summary-supersede`. Format 1 has no such event: the operation
  never produces one, whatever the authority, so `denied` would suggest that more rights could
  allow it. The round-trip corpora supersede only plain, unpinned memories; every event kind is
  still exercised.
- Other 06-final rules, checked: nested summaries import, floored at the source summary's trust,
  as `submitSummary` floors them (test). The summary trust floor and the source checks (scope,
  live, current revision) match `submitSummary`. A foreign source answers as an absent one, the
  existence-oracle rule (existing test). A stored tombstone with text in the file is
  `redacted-in-target` (existing test). Wake and pending ordering (e42644d) is read-side only.

### Decisions

- **Export and import take a principal** (`exportJsonl(store, principal, …)`), like
  `advanceFence(store, …)`: export needs ownership of every exported scope (it is the owner
  view: retracted memories and tombstones); a JSONL import needs ownership and write access to
  every header scope; an OptMem import needs both for its scope. The CLI exports and imports the
  current scope only, so no argument widens a scope (story 8). Rejected: a whole-store export
  through the CLI, which would let an agent in one repository read every other's memories.
- **An import replays events into one transaction**, keeping memory ids, so a stale export can be
  recognised by id and refused. Events carry the importing principal's id; no op records are
  written (an exported op id would collide with the importer's own retries, and its fingerprint
  no longer matches once trust is capped). A replayed `retract`, `supersede` or `redact` cascades
  in the target as the operation does. A `redact` line for a memory the target holds with text
  redacts it there: erasure dominates (invariant 4).
- **A JSONL import is all or nothing** (a guard failure refuses the whole file by line: an export
  passed the guard when written, so a failure means tampering). **An OptMem import reports guard
  refusals by line and imports the rest**, since an OptMem log cannot be edited to drop a line.
  They are reported on every import: no fingerprint of a refused line is kept.
- **OptMem layout.** Read from OptMem's README and CHANGELOG only, never its code or a real store.
  FORMAT.md separates what they state (fixed-width, newline-terminated, append-only records;
  position as identity; zero-filled crash remnants) from what is inferred: the width is the
  first record's, and trailing spaces are padding. Any leading date stays in the text. `TREE/` is
  not read (OptMem calls it a rebuildable cache). Rejected: parsing a date prefix, which needs
  the undocumented layout.
- **OptMem store name** is the sha256 of the log directory's real path (CLI). Moving the
  directory imports its records again under new ids; a changed first record is still caught
  while its memory holds its text. Rejected: naming by the first record's hash, which a modified first record
  would escape (it would look like a new store and import everything again).
- **One transaction per import, one checkpoint per run.** Rejected: batched transactions, which
  need concurrent-checkpoint rules; real OptMem stores hold thousands of records.

### Not verified

- **The inferred OptMem layout against a real OptMem store.** Reading OptMem's code or a real
  store was out of bounds. If the inference is wrong, the importer refuses (`not-optmem`) or
  keeps padding in the text; it never imports silently misaligned records. The owner can check
  it with `relembra import --optmem ~/.optmem` on a throwaway `RELEMBRA_HOME`.
- Exports are written to stdout; the CLI cannot set the file's mode. CLI.md says to redirect
  into a file only the user can read.
- Imports read the whole file into memory (an OptMem log of a million records is about 600 MB),
  and every OptMem import reads one memory per record.
- Residual, accepted by the coordinator: memory ids are global, so an import line whose id
  another scope holds is refused (`conflict`) where an absent id imports. That reveals the id
  exists, not its state or text. Generated ids are random UUIDs. OptMem ids are per scope but
  deterministic, so someone who knows a scope's name and an OptMem store's name (the CLI names
  it by the hash of the log directory's path) can compute them and probe whether that record was
  imported.
