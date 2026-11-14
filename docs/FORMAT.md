# relembra storage format

Status: event formats 1 and 2, SQLite schema version 6, Postgres schema version 3. Release 1.0.0-beta.8.

This document is the contract for what relembra stores. A reader that follows it needs no
relembra code.

## Versions

Two numbers version the data, and they change independently.

- **Event format** (`format` in every event): the shape of one event's JSON. Format 1 defines
  `note`, `retract`, `redact`, `supersede` and `summarize`; format 2 adds `promote`.
  - A new optional field keeps the format.
  - A removed field, a renamed field, or a changed meaning takes the next format.
  - A new event kind takes the next format, carried by the events of that kind only. A reader
    that does not know the kind then refuses it as too new instead of misreading it, while a
    export without one keeps the older format and stays readable by older readers. So
    `promote` events carry `format: 2`, and every other kind still carries `format: 1`. This
    is about events and exports only: a SQLite file follows its schema version (below), and
    0.1.0 refuses a file a newer release has opened.
  - A reader refuses an event whose format is newer than it knows. It never guesses.
- **Schema version** (the `schema_version` table): the layout of the SQLite file.
  - Migrations move forward only.
  - relembra refuses a file whose schema version is newer than it supports, and leaves the
    file untouched.

## Events

Every change to the store is one event, appended in store order. Events are append-only:
redaction is the one rewrite. It removes the text and provenance of the redacted memory's
`note` or `summarize` event (see "Redacted forms") and appends a `redact` event.

### Common fields

| Field | Type | Meaning |
|---|---|---|
| `format` | integer | Event format version: `2` for `promote`, `1` for every other kind. |
| `kind` | string | What happened. Format 1 defines `note`, `retract`, `redact`, `supersede` and `summarize`; format 2 adds `promote`. |
| `seq` | integer | Store order, assigned by the store when the event is appended. Higher is later. It is the only ordering; timestamps are not. |

### `note`

A memory was written.

| Field | Type | Meaning |
|---|---|---|
| `memoryId` | string | The memory's stable, opaque identity. It carries no chronology. |
| `scope` | string | The host-defined key that names where the memory lives. |
| `principalId` | string | The principal that wrote it, as the host's policy named it. |
| `pinned` | boolean | Whether the memory was noted as pinned. |
| `revision.number` | integer | The revision number, from 1. |
| `revision.text` | string | The memory: one line, at most 280 UTF-8 bytes. |
| `revision.at` | integer | Epoch milliseconds from the writer's clock. Provenance only, never order. |
| `revision.provenance.agent` | string | The agent that wrote it. |
| `revision.provenance.harness` | string | The harness the agent ran in. |
| `revision.provenance.model` | string | The model behind the agent. |
| `revision.provenance.host` | string | The host that ran relembra. |
| `revision.provenance.source` | string, optional | Where the fact came from. |
| `revision.provenance.trust` | string | `owner`, `agent` or `untrusted`. |
| `revision.provenance.opId` | string | The op id that makes the write idempotent, at most 256 bytes. |

Every memory id, scope, principal id and fence key is well-formed Unicode: a string holding a
lone surrogate (which JSON can write as an escape such as `\ud800`) is refused where it enters,
with `IllFormedStringError` in the library and `malformed` in an import. Encoded as UTF-8 it
would become U+FFFD, so two different strings would name the same scope, memory or key. Texts
and provenance fields go through the guard, which refuses them as `ill-formed`.

**Identifiers.** Every memory id, scope, principal id and fence key also passes the guard's rules
within its byte cap, wherever it enters: memory ids at most 128 UTF-8 bytes, scopes, principal ids
and fence keys at most 256. So an identifier is not blank, is one line, and holds no control
character (NUL and the C0 and C1 controls included), no format, bidi, zero-width or other
default-ignorable character (the emoji joiners and selectors the guard allows excepted) and no
credential shape. The library refuses one with `IdentifierError` (field and rule, never the
value) before any store call: the scopes and id of every principal the host's policy returns, every
memory id an operation names (zoom, retract, redact, supersede, redaction preview, a summary's
sources, a promotion's origin), the scope of a note, a summary, a promotion and a retention rule, a
fence key, and every id the host's
`Ids` port returns (a host bug, refused loudly). Every store therefore holds the same names (a
text column that cannot hold NUL never meets one), and no rendering shows one raw. An import
applies the same rule to the identifiers in its file (see "Import of an export").

A supersede writes its replacement with a `note` event, immediately followed by the `supersede`
event that names it.

### `retract`

A memory was retracted: agents no longer see it; an owner of its scope still does. Retracting a
memory also retracts the live summaries derived from it, each with its own `retract` event. It
does not retract the copies promoted from it (see `promote`).

| Field | Type | Meaning |
|---|---|---|
| `memoryId` | string | The retracted memory. |
| `scope` | string | Its scope. |
| `principalId` | string | The owner that retracted it. |

### `supersede`

A memory was replaced by a newer one and is no longer served. The live summaries derived from it
are retracted, each with a `retract` event; the copies promoted from it are not.

| Field | Type | Meaning |
|---|---|---|
| `memoryId` | string | The replaced memory. |
| `scope` | string | Its scope, which is also the replacement's. |
| `principalId` | string | The principal that superseded it. |
| `by` | string | The replacement's memory id, written by the `note` event just before. |

### `summarize`

A summary was written: a memory that stands for its sources at their exact revisions.

| Field | Type | Meaning |
|---|---|---|
| `memoryId` | string | The summary's memory id. |
| `scope` | string | Its scope, which every source shares. |
| `principalId` | string | The principal that submitted it. |
| `sources` | array | `{memoryId, revision}` objects, 1 to 100, sorted by `memoryId`, each memory once. |
| `revision` | object | As in `note`. `provenance.trust` is at most the least trust of the sources. A summary is never pinned. |

### `promote` (format 2)

A memory was promoted: copied, at an exact revision, into another scope, as a new memory that
keeps a link to it. The copy is a plain memory (not a summary) in its own scope.

| Field | Type | Meaning |
|---|---|---|
| `format` | integer | `2`. |
| `memoryId` | string | The copy's memory id. |
| `scope` | string | The copy's scope, never the origin's. |
| `principalId` | string | The principal that promoted it. |
| `origin` | object | `{memoryId, revision}`: the memory copied, at the revision it was read at. Never a summary. |
| `revision` | object | As in `note`: number 1, the origin's text at that revision, the promoter's provenance. `provenance.trust` is at most the origin's. A copy is never pinned. |

Promotion needs promote rights on the copy's scope (`Principal.promotable`; write access to it
is not needed) and read access to the origin, which must be live at that revision. The copy
keeps the link for good:

- Redacting the origin redacts the copy in the same transaction, with a `redact` event of cause
  `source`, and so on to the summaries of the copy and the copies of the copy. Erasure reaches
  every copy relembra made, whatever scope it is in and whoever may read it.
- Retracting or superseding the origin leaves the copy live. A copy lives in a scope with its own
  owners, and the origin's owner holds no right there. A copy can be retracted, redacted or
  superseded in its own scope like any plain memory; superseding it writes a plain memory that
  carries no link.

### `redact`

A memory was redacted: replaced by a tombstone, its text removed from every place relembra holds
it.

| Field | Type | Meaning |
|---|---|---|
| `memoryId` | string | The redacted memory. |
| `scope` | string | Its scope. |
| `cause` | string | `request` (an owner asked), `retention` (a retention sweep expired it) or `source` (a memory it was derived from was redacted: a summary's source, or a promoted copy's origin). |
| `principalId` | string or null | The owner whose request led to it; `null` for a retention sweep, which the host runs. |

### Redacted forms

After a memory is redacted, its `note`, `summarize` or `promote` event keeps every field except
`revision`, which is removed, and gains `redacted: true` (a `promote` event keeps its `origin`). Every other event about the memory is
kept as it was: none of them carries text.

## JSONL export

An export is UTF-8 text: one JSON object per line, each line ending with `\n` (no `\r`, no blank
lines). `exportJsonl` in the library and `relembra export` in the CLI write it. It holds exactly
the events above, so a reader needs only this document.

### Header (line 1)

| Field | Type | Meaning |
|---|---|---|
| `export` | string | Always `relembra`. What makes the file an export. |
| `format` | integer | The newest event format of the lines after it: `1` when none is a `promote` line, so a format 1 reader still reads the file, and `2` when one is. |
| `relembra` | string | The relembra version that wrote the file, such as `1.0.0-beta.8`. Informational: a reader decides by `format` alone. |
| `scopes` | array of strings | The scopes exported. Every event's `scope` is one of them. |

### Events (lines 2 onward)

Every event of the exported scopes, one per line, in `seq` order, each with every field its kind
has under "Events" (`seq` included, as the exporting store assigned it). `format`, `kind` and `seq`
come first in each line; the order of the other fields carries no meaning.

- An export of a copy's scope holds its `promote` line, whose `origin` may name a memory in a
  scope the export does not hold: that file imports only where the origin is (see "Import of an
  export", Promotions).
- A redacted memory appears only in its redacted forms: its `note`, `summarize` or `promote` line has
  `redacted: true` and no `revision`, and its `redact` line follows. Its text is in no line.
- An export is the owner view: retracted and superseded memories, and tombstones, are included.
- Op records, fingerprints, fences, the erasure outbox and import checkpoints are not exported:
  they belong to the store that holds them.

### Import of an export

`importJsonl` and `relembra import <file>` replay an export into a store, in one transaction:
all of it, or nothing and an error naming the rule and line (`docs/CLI.md`, `import`).

- **Refused files.** A header or event whose `format` is newer than the reader knows
  (`format-too-new`); an event whose `format` is above its header's, or a `promote` line of
  format 1 (`malformed`); a missing header, a line that is not one JSON object, an unknown `kind`, a
  missing or mistyped field, a scope, memory id or `principalId` that is not well-formed Unicode
  (a `redact`'s `principalId` may be null), a `seq` not above the line before, an event about a
  memory no earlier line noted, or a `supersede` whose `by` is its own memory or whose replacement
  `by` is
  neither in the store nor noted on an earlier line of the file, in the same scope (in text or
  redacted form) (`malformed`). The replacement need not be on the line before: when an import
  skips a note the store already holds, the store's own export has the two lines apart, and it
  must import again; a `supersede` whose target or replacement is a summary, in the store or
  known only by its tombstone (`malformed`, detail `summary-supersede`): the operation refuses to
  supersede a summary (retract it and submit a new one) and always replaces with a plain memory,
  so format 1 has no such event, whatever the importer's authority; a text or provenance field
  the guard refuses (`guard`, `provenance`), since an import file is untrusted input; an
  identifier that breaks the identifier rule below (`malformed`, detail `<field>:<rule>`).
- **Identifiers.** Every identifier a file carries goes through the guard's rules, as a memory's
  text does, within its own byte cap: `memoryId`, a `supersede`'s `by`, each source's
  `memoryId` and a `promote`'s `origin.memoryId` (detail fields `memoryId`, `by`, `sources`,
  `origin`; at most 128 UTF-8 bytes, the most a rendering shows), every `scope` in the header and the events (`scope`; at most 256 bytes),
  every `principalId` but a `redact`'s `null` (`principalId`; at most 256 bytes, though the
  import writes the importer's id in its place) and the header's `relembra` version
  (`relembra`; at most 64 bytes): the rule of "Identifiers" above. So an identifier is one line, not blank, with no control,
  format, bidi, zero-width or other invisible character (the emoji joiners and selectors the
  guard allows excepted) and no credential shape, and the rule is the detail: a memory id holding
  ESC is refused as `malformed`, detail `memoryId:control-character`. A string that is not one,
  is empty or is not well-formed Unicode stays plain `malformed`. Provenance fields already go
  through the guard (`provenance`). What a line holds on its own (its JSON
  shape, format, fields, `seq` order, identifiers, text, provenance and the `future-time` bound) is
  checked for every line of the file, then the header's scopes against the importer's rights
  (see Principal), before the first event is written. That happens inside the import's
  transaction, because the `future-time` bound needs the acceptance time read there (see Time).
  What depends on the store or on earlier lines (an event about a memory no earlier line noted, a
  replacement's whereabouts, and the rules under Identity, Summary sources, Promotions, Live
  target and replacement and Authority) is checked as each line is applied, after the lines
  before it were written in that transaction. A refusal at any point rolls the transaction back,
  so it writes nothing. The importing principal itself is checked first, before the transaction,
  as for every operation: a principal listing a scope the rule refuses is an `IdentifierError`.
- **Identity.** Memories keep their ids. A memory the store holds with the same scope, text,
  sources and origin is skipped, so importing a file twice adds nothing; one it holds with other content
  refuses the import (`conflict`). A memory keeps its scope through the file: a line that names
  it in another scope than the line that noted it, or than the store's copy, refuses the import
  (`conflict`), tombstones included, and a replacement must be in its target's scope
  (`malformed`).
- **Ids across scopes (residual).** Memory ids are one namespace for the whole store, so a line
  whose id another scope holds refuses the import (`conflict`) where an absent id imports. An
  importer who already knows an id from a scope it cannot read learns that the memory exists;
  never its text, state or scope. Ids are kept unguessable so that knowing one takes having seen
  it: the default `Ids` port (`randomIds`) gives random version 4 UUIDs from the platform's
  cryptographic generator (`crypto.randomUUID`), and a host that supplies its own `Ids` should do
  the same. OptMem ids are minted per destination scope but are deterministic (see "OptMem
  import", Identity).
- **Summary sources.** A summary's sources must be in the store, in the summary's scope, live and
  at the revision the line names. A source in another scope is refused as an absent one is
  (`malformed`), whatever its state, so an import cannot learn whether another scope's memory was
  redacted; a redacted source in the summary's own scope is `redacted-in-target`.
- **Promotions.** A `promote` line for a copy the store lacks is replayed under the operation's
  rules, checked when it is applied:
  - the importer needs promote rights on the copy's scope (`denied`, detail `promote`);
  - the origin must be in the store, where the importer may see it (any status in a scope it
    owns, live in one it reads). An origin that is absent, noted only in the file, or in a scope
    the importer cannot see is refused alike (`malformed`), so an import learns nothing of
    another scope. So a copy's export imports only into a store that holds its origin: a copy
    whose origin is absent would be out of reach of the origin's redaction;
  - an origin in the copy's own scope, a copy that names itself as its origin (`malformed`), or a
    summary as the origin (`malformed`, detail `summary-promote`) is refused whatever the
    importer's authority;
  - a redacted origin is `redacted-in-target`; one retracted, superseded or at another revision
    than the line names is a `conflict`;
  - the line's text must be the origin's text at that revision, since the operation copies it
    and never takes text from the promoter: a line whose text differs is a `conflict`, so a file
    cannot write arbitrary text under a link that names a real memory. The copy is written with
    the stored origin's text. A `promote` line's revision number is always 1 (`malformed`
    otherwise).

  A `promote` line in its redacted form is history: its origin is not checked, and its tombstone
  is written with the `redact` line that follows.
- **Live target and replacement.** When a replayed `supersede` is applied, after the earlier
  lines and what the store held, its target and its replacement must both be live: not
  retracted, superseded or redacted, as a direct supersede's target is and its freshly written
  replacement always is. Otherwise the import is refused (`conflict`). A replacement is always a
  fresh note, so a replacement that is a promoted copy is refused (`malformed`, detail
  `copy-replacement`). A memory the file knows
  only by its tombstone has the status its earlier retract and supersede lines gave it. A
  replacement is never already replaced, so supersession never forms a cycle. Chains (A by B,
  then B by C) import, in one file or across imports. A file that supersedes into a memory the
  store has since superseded (an older export imported after a newer one) is refused.
- **Authority.** A replayed `retract`, `supersede` or `redact` needs what the operation needs
  over what it changes in the store, and is checked when it is applied, before anything is
  written:
  - a memory more trusted than the importer's ceiling refuses the import (`denied`, detail
    `above-ceiling`). A retract or supersede checks the memory and the live summaries derived
    from it, which it retracts; a redact checks the memory and every summary and promoted copy
    derived from it, which it erases (a copy's trust is never above its origin's);
  - a `supersede` of a pinned fact, when the importer may not pin in its scope, refuses it too
    (`denied`, detail `pin`). Retract and redact check no pin rights, as the operations do not.

  History of a memory the file knows only by its tombstone changes nothing the store held, so
  no ceiling applies to it.
- **Tombstones win.** A memory the store holds as a tombstone, with text in the file, refuses the
  import (`redacted-in-target`): a stale export never resurrects a redaction. A `redact` line for a
  memory the store holds with text redacts it there, with the summaries and promoted copies derived
  from it, and records erasure work as any redaction does. A tombstone for a memory the store
  never held is written with its `redact` event and no `erasure_outbox` row: no text of it was ever
  there.
- **Trust and pins.** An imported memory is never pinned, and its trust is at most `agent` (and at
  most the importing principal's ceiling); `untrusted` stays `untrusted`. A summary's trust is
  also at most its sources' in the store, and a copy's at most its origin's.
- **Principal.** Every event written carries the importing principal's id as `principalId`. The
  exception is a `redact` whose cause is `retention` for a memory the file knows only by its
  tombstone: it replays with `null`, as written. A `redact` line for a memory the store holds is
  recorded as the importer's request (cause `request`, the importer's id) whatever cause the file
  names, so a file cannot pass an erasure off as a retention sweep with no principal. The importer
  must own, and may write, every scope in the header. No op records are written.
- **Time.** A replay keeps each memory's age: a revision's `at` is kept as written, as provenance
  and as the memory's `notedAt`, which retention measures age from. A revision dated more than
  5 minutes (`MAX_IMPORT_SKEW_MS`, clock skew between machines) after the import's acceptance time
  refuses the import (`future-time`): a file cannot date a memory into the future to outlive every
  retention sweep. The acceptance time is the store's own time when it keeps one (the database
  clock on Postgres), read inside the import's transaction, else the importing host's clock.
  Keeping the original time instead of the import time is the stricter choice for retention: the
  acceptance time bounds it, so a file can at most make a memory as young as the import, never
  younger, while an old memory keeps its age and is swept as if it had never moved.
- **Cascades.** A replayed `retract`, `supersede` or `redact` cascades to the derived summaries in
  the store, and a replayed `redact` to the promoted copies too, as the operation itself does; the
  file's own lines for that cascade then find their work done.

### Import limits

An import is bounded before any line is parsed, so an import file cannot make the importer hold
or parse an unbounded amount of text. Each refusal is `too-large`, with the detail saying which
limit (`ImportError.detail`; the CLI's rule `too-large:<detail>`), and writes nothing.

| Limit | Value | Detail | Why this number |
|---|---|---|---|
| A whole export, or an OptMem log (`MAX_IMPORT_BYTES`) | 64 MiB (67,108,864 bytes) | `file`, line 0 | A note line is about 600 bytes, so 64 MiB holds the event limit's 100,000 lines of that size. |
| One line of an export, its `\n` left out (`MAX_IMPORT_LINE_BYTES`) | 256 KiB (262,144 bytes) | `line`, at that line | The longest event format 1 holds (a summary of 100 sources whose 128-byte ids all need JSON escapes, every provenance field at its cap) is under 40 KiB; the rest leaves a header room for several hundred scopes. |
| Events after the header, or records of an OptMem log (`MAX_IMPORT_EVENTS`) | 100,000 | `events` at line 100,002, or `records` at record 100,001 | Far above what a curated memory holds; one import is one transaction. |

Every limit counts UTF-8 bytes. The CLI checks the file's size before it reads it, and reads only
a regular file (`docs/CLI.md`, `import`).

**Unknown fields stay ignored.** A header or event field this document does not name is ignored
on import, and never stored: "A new optional field keeps the format" (Versions), so a format 1
reader must accept the optional fields a later relembra adds without a new format. The line limit
is what bounds a file that pads a line with them.

## OptMem import

`importOptmem` and `relembra import --optmem <dir>` read an OptMem store's `LOG.txt` (OptMem is a
separate tool; its own documentation is the source). Only the log is read: `TREE/` holds
summaries that OptMem's README calls a cache rebuildable from the log, so it is skipped.

**What OptMem's README and CHANGELOG state** (read 2026-10-31, no code read): `LOG.txt` holds every
memory, one per line, append-only and never edited; records are fixed width, so a memory's
position is its identity; every record ends in a newline; a trailing record a crash left filled
with zero bytes counts as never written; a memory is one line of at most 280 bytes.

**What a real OptMem 1.3.5 `LOG.txt` shows** (its bytes read 2026-10-31, no code read; ADR 0001):
every record is `#<n> <YYYY-MM-DD> <text>`, then ASCII spaces up to the record width, then `\n`
(320 bytes in that store). `<n>` counts from 0 and equals the record's position minus one on every
record, and the text after the prefix is at most 280 bytes on every record. With the prefix kept
as text, 766 of its 3,341 records would be over 280 bytes.

**What relembra infers, not shown there:** the record width is the length of the first record, up
to and including its first `\n`; trailing ASCII spaces before it are padding, not text; and a
record that does not begin with the prefix (an older or hand-written log) is all text, kept byte
for byte, including any date it begins with.

How a log is read:

| Step | Rule |
|---|---|
| Width | `W` = the byte offset of the first `\n`, plus 1. A non-empty log without one is refused (`not-optmem`). |
| Records | The log is cut into `W`-byte records; record `n` (from 1) starts at byte `(n − 1) × W`. |
| Never written | From the end, records that contain a zero byte or do not end in `\n` (a short last one included) are dropped. A record like that before the last good one refuses the import (`not-optmem`). |
| Prefix | A record whose bytes begin with `#<digits> <YYYY-MM-DD> ` (`#`, one or more decimal digits, one space, the date, one space; matched against the whole record before its `\n`, so a counter of any length is seen) carries OptMem's prefix. There is no plain reading of such a record: OptMem always writes the prefix, so a log shaped that way is the OptMem format by definition, whatever its author meant, and its text is what follows the prefix. A log is all prefixed or all plain, and the first record decides which. In a prefixed log, record `n` (from 1) must carry the counter `n − 1` written in decimal without a leading zero (`#00` and an oversized counter are not) and a real calendar date (`2026-13-40` and `2026-02-29` are not); a record without the prefix in a prefixed log, or with it in a plain one, is a mixed log. Each of these refuses the import (`not-optmem` at that line), which catches a spliced or reordered log. The check is on bytes, before the transaction, so a refusal writes nothing, and it names the line, never the record's bytes. |
| Text | The record's bytes before its `\n`, without the prefix when it has one, trailing spaces removed, decoded as UTF-8 (refused per line as `ill-formed` when not valid). The 280-byte rule applies to this text, not to the prefix. |
| Guard | Every text without a memory yet goes through relembra's guard. A refused line is reported as `{ line, rule }`, on every import of the log, and never imported or echoed. A record whose memory the store holds is compared with it first (see Idempotency), so a refusal never hides a change to it. |
| Identity | Record `n` of a store named `<store>`, imported into a scope, becomes the memory `om-<id>` in that scope, where `<id>` is the first 32 hex characters of the sha256 of `<scope>`, a zero byte, `optmem:<store>`, a zero byte and `n` in decimal (UTF-8). Its provenance `opId` is the memory id and its `source` is `optmem:<store>:<n>`, or `optmem:<store>:<n>:<YYYY-MM-DD>` for a prefixed record, the date being its prefix's. In both, `<n>` is the record's position from 1, as in the id, not the prefix's counter from 0 (the counter is that position minus one, so nothing is lost). A store name is 1 to 64 ASCII letters, digits, `.`, `_` or `-` (a `RangeError` otherwise), and every source it forms goes through the same guard as a direct note's source, before anything is written: a name the guard refuses there, such as a credential shape, refuses the whole import with a `ProvenanceError` and writes no memory, event or checkpoint. The id is minted per destination scope and is deterministic, so importing again finds the memory, and one OptMem store imported into two scopes gives two independent sets of memories, whose ids never collide. Its checkpoint is `optmem:<scope key>:<store>`, the scope key being the first 16 hex characters of the sha256 of the scope (UTF-8), and an import never compares anything with another scope's. The CLI names the store by the first 16 hex characters of the sha256 of the real path of the directory that holds `LOG.txt`. |
| Authorization | The importer must own, and may write, the scope, checked before the log or the store is read. The scope must pass the identifier rule ("Identifiers"; an `IdentifierError` otherwise: the scope is the host's argument, not the file's). A memory under the import's id in another scope (only a crafted export can put one there) refuses the import as `conflict`, its content never compared. |
| Trust and pins | Trust `agent` (or the principal's lower ceiling); never pinned. |
| Time | Revision `at` is the import's time from the host's clock, and `notedAt` is its acceptance time: the store's own time when it keeps one (the database clock on Postgres), else the same host clock (the input has no time field). A record's date never sets a memory's time: a prefix's date goes to `source` only, and a date in a plain record's text stays text. So a file cannot keep a memory from retention, and retention counts from the import. |
| Idempotency | Every import reads the whole log. A record whose memory the store holds with the same text, or as a tombstone, is skipped: importing twice adds nothing, and a redacted record stays redacted. The same memory with another text, or with a record that is now not UTF-8 or that the guard refuses, refuses the import (`modified`). |
| Checkpoint | Each import records, in its transaction, `optmem:<scope key>:<store>` with the bytes it read and the record width (`import_checkpoints`). The next import of that store into that scope refuses a log shorter than that (`truncated`) or with another record width (`modified`): a new width moves every record boundary, so records could be inserted inside the part already read. The checkpoint keeps no hash of the log, and nothing else keeps a hash of a record: a hash would outlive the record's redaction and confirm a guess of the erased text. |

Trade-offs:
- A store that imported a prefixed log under 0.3.x (which kept the prefix as text) holds
  memories whose text begins with `#<n> <date>`. Importing that log again gives the same ids with
  another text, so it is refused as `modified`. Redaction does not repair it: a tombstone is
  skipped, never written over, so a redacted record stays redacted and its corrected text is
  never imported there. The repair is a fresh destination scope or a fresh relembra store.
- A moved OptMem directory gets a new store name, so its records import again under new ids.
- A changed record is caught by comparing it with the memory it became, so a change is caught
  only where that memory still holds its text. A change at a redacted record, or at a record the
  guard refused, is not seen: seeing it would need a fingerprint of the erased text or of the
  credential. A refused record that no longer breaks a rule imports at its position.
- The ids are deterministic, so someone who knows a scope's name and an OptMem store's name can
  compute them. Memory ids are one namespace across scopes, so such a person, importing an
  export into a scope of their own, can learn whether the other scope imported that record (see
  "Import of an export", Identity); never its text or state.

## SQLite layout (schema version 6)

Every table is `STRICT`. Integers are 64-bit. Version 2 adds the memory status columns, the
`tombstones`, `erasure_outbox` and `wal_scrub` tables, and makes `ops.fingerprint` nullable.
Version 3 adds the `import_checkpoints` table and the `events_by_scope` index on
`events (scope, seq)`, which the export reads by. Version 4 adds the term index (`term_scopes`,
`term_docs`, `term_postings`), which find reads; its migration builds it from every live memory
already stored, in the same transaction as the schema change. Version 5 adds `memories.origin`
and the `memories_by_origin` index on its memory id, so a redaction finds the copies of a memory.
Version 6 adds the `exposures`, `erasure_deliveries` and `erasure_pending` tables (erasure
delivery, ticket 16).

The connection runs with `secure_delete` on, so SQLite zeroes the bytes it frees. After a
redaction commits, relembra runs `wal_checkpoint(TRUNCATE)`, so the old page images in the WAL
leave the disk too.

### `events`

The log. `body` is authoritative; the other columns copy fields out of it for lookup.

| Column | Meaning |
|---|---|
| `seq` | Primary key and store order. |
| `kind`, `memory_id`, `scope` | Copies of the event's `kind`, `memoryId` and `scope`. |
| `body` | The event as JSON, without `seq`. |

### `memories`

The current state of each memory, derived from the events and rebuildable from them.

| Column | Meaning |
|---|---|
| `position` | Insertion order. A memory keeps its position when it is replaced. |
| `id` | The memory id, unique. |
| `scope` | Its scope. |
| `seq` | The seq of the event that produced the current revision. |
| `pinned` | 1 if pinned, 0 if not. |
| `noted_at` | Epoch milliseconds of revision 1, when the store accepted it: the writer's clock on SQLite, the database clock on Postgres. |
| `revision_number`, `text`, `revised_at` | The current revision's number, text and timestamp. |
| `provenance` | The current revision's provenance as JSON, with the fields listed under `note`. |
| `status` | `live`, `retracted` or `superseded`. A redacted memory has no row here. |
| `superseded_by` | The replacement's memory id when `status` is `superseded`, otherwise null. |
| `sources` | For a summary, its `sources` as JSON (as in `summarize`); null for any other memory. |
| `origin` | For a promoted copy, its `origin` as JSON (as in `promote`); null for any other memory. Indexed by its memory id (`memories_by_origin`). |

### `tombstones`

One row per redacted memory. Its row in `memories` is deleted in the same transaction.

| Column | Meaning |
|---|---|
| `id` | The memory id, primary key. |
| `scope` | Its scope. |
| `seq` | The seq of its `redact` event. |

### `ops`

One row per idempotent write: the outcome of its first commit, written in the same transaction
as the write.

| Column | Meaning |
|---|---|
| `principal_id`, `op_id` | Primary key together. An op id belongs to its principal. |
| `fingerprint` | SHA-256 (hex) of the write's canonical payload, or null once the memory it wrote was redacted (a fingerprint can confirm a guessed text). Format 1 encodings are listed below. |
| `memory_id`, `at`, `seq` | The memory id, timestamp and seq of the first commit. A retry returns them, or a terminal redacted outcome when that memory was redacted. Indexed by `memory_id`. |

Fingerprint encodings, each hashed as the UTF-8 of `JSON.stringify` of the array:

- note: `[1, "note", scope, principalId, text, pinned, trust, agent, harness, model, host, source or null]`
- supersede: `[1, "supersede", supersededMemoryId, principalId, text, pinned, trust, agent, harness, model, host, source or null]`
- summarize: `[1, "summarize", scope, principalId, text, [[memoryId, revision], …] sorted by memoryId, requested trust or null, agent, harness, model, host, source or null]`.
  The requested trust, not the stored one: the stored trust also depends on the sources.
- promote: `[1, "promote", originMemoryId, originRevision, scope, principalId, requested trust or null, agent, harness, model, host, source or null]`.
  The origin and revision stand for the copy's text; the requested trust, as for a summary.

### `erasure_outbox`

Erasure work recorded in the redaction's transaction, for the erasure hook to deliver
(`Relembra.deliverErasures`). A redaction that rolls back leaves no row.

| Column | Meaning |
|---|---|
| `seq` | The seq of the `redact` event, primary key. |
| `memory_id` | The redacted memory. |
| `carriers` | JSON array of `{ "id", "kind" }`, in id order: the carriers with an exposure of the memory when it was redacted. Empty when no rendering given a carrier had carried it. |

### `exposures`

Which carriers received which memories, ids only: a rendering given a carrier (`wake`, `brief`,
`findRendering` with `carrier`) writes one row per memory it carries before it is returned, in
an autocommit statement of its own, never in a store transaction. A redaction reads the rows of
each memory it erases into its outbox rows. No text, no scope: an exposure names no memory's
content. Rows are never deleted in v0.3; the table grows with carriers times memories.

| Column | Meaning |
|---|---|
| `carrier_id`, `memory_id` | Primary key together. A second recording of the pair changes nothing. |
| `carrier_kind` | The carrier's kind, as first recorded (`pi-durable`, `mcp`, or the host's). |
| `first_seen` | Epoch milliseconds of the first recording, by the recording relembra's Clock. |

`exposures_by_memory` indexes `exposures (memory_id)`, for the redaction's read.

### `erasure_deliveries`

The outcome the host's hook gave each carrier of an outbox row. A carrier listed in
`erasure_outbox.carriers` with no row here is pending, and has a row in `erasure_pending`. A row
is never changed or deleted in v0.3: the first outcome stays.

| Column | Meaning |
|---|---|
| `seq`, `carrier_id` | Primary key together: the outbox row and the carrier. |
| `status` | `acknowledged` (the host said it handled its copy) or `unsupported` (the host said the carrier cannot erase). Never "erased": relembra cannot see external copies. |
| `settled_at` | Epoch milliseconds when the outcome was recorded, by the delivering relembra's Clock. |

### `erasure_pending`

The carriers of each outbox row that have no outcome yet. Delivery reads it a bounded page of
rows at a time, in seq order, and `relembra check` counts it, so neither reads settled rows. The
redaction's transaction writes one row per carrier together with the outbox row; the transaction
that stores a carrier's outcome deletes that carrier's row. It always equals the outbox carriers
minus `erasure_deliveries`; the migration that creates it fills it from the outbox rows already
stored.

| Column | Meaning |
|---|---|
| `seq`, `carrier_id` | Primary key together: the outbox row and the carrier. |
| `carrier_kind` | The carrier's kind, as in `erasure_outbox.carriers`. |

### `wal_scrub`

One row (`id` = 1), created by the migration.

| Column | Meaning |
|---|---|
| `redacted` | How many redactions have committed. Each redaction's transaction adds 1. |
| `scrubbed` | The `redacted` count the WAL was last truncated after. |

A scrub is pending while `redacted` > `scrubbed`. Every handle on the file reads the row, and
retries `wal_checkpoint(TRUNCATE)` after each of its commits, at close, and at open before serving
any read. A scrubber reads `redacted` before truncating and, once the truncation succeeds, raises
`scrubbed` to that value only, so a redaction committed after its truncation stays pending.

### `import_checkpoints`

How far an import has read each source, written in the import's transaction (see "OptMem
import").

| Column | Meaning |
|---|---|
| `source` | The source, such as `optmem:<scope key>:<store>`, primary key. |
| `bytes` | How many bytes of the source the imports so far have read. No hash of them is kept. |
| `width` | The source's record width in bytes, 0 when it had no records. |

### The term index: `term_scopes`, `term_docs`, `term_postings`

Derived from `memories`: it holds exactly the live memories, and every write, retraction,
supersession, redaction, sweep and import updates it in its own transaction. Terms are the
tokens and stems of `docs/specs/ranking-algorithm.md` §2–§4, counted twice: with every token
(`_all`) and without stop words (`_kept`), the two modes of §3. Find reads N, the length sums,
and the rows of the query's terms only; df is the number of a term's rows in the scopes read.
A redaction deletes the memory's rows, so no term of its text stays (secure_delete zeroes them).

| Table | Column | Meaning |
|---|---|---|
| `term_scopes` | `scope` | Primary key. A scope with at least one live memory. |
| | `memories` | N: its live memories. |
| | `length_all`, `length_kept` | The sums of their lengths in tokens. |
| `term_docs` | `position` | Primary key: the memory's `memories.position`. |
| | `memory_id`, `scope`, `seq` | Copies of the memory's id, scope and store sequence. |
| | `length_all`, `length_kept` | Its length in tokens. |
| `term_postings` | `scope`, `form`, `term`, `position` | Primary key. `form` 0 is a token's exact form, 1 a stem. |
| | `count_all`, `count_kept` | How many of the memory's tokens have that form. |

`term_postings_by_position` indexes `term_postings (position)`, for removing a memory's rows.

### `fences`

| Column | Meaning |
|---|---|
| `key` | An authority fence key, chosen by the host. |
| `epoch` | The highest epoch seen for the key. A write carrying a lower one commits nothing. |

### `schema_version`

| Column | Meaning |
|---|---|
| `version` | One row per applied migration. The highest is the file's schema version. |
| `applied_at` | Epoch milliseconds when it was applied. |

## Postgres layout (schema version 3)

The Postgres store keeps the tables of SQLite's version 6, with the same columns and meanings, in
one schema (default `relembra`), minus `wal_scrub`. Version 1 matches SQLite's version 4; version 2
adds `memories.origin` and the `memories_by_origin` index on `(origin::jsonb) ->> 'memoryId'`,
as SQLite's version 5 does, plus `memories_by_sources`, a GIN index on `sources::jsonb`, so a
redaction finds a memory's summaries and copies without scanning the table; version 3 adds
`exposures` (with `exposures_by_memory`), `erasure_deliveries` and `erasure_pending`, as SQLite's
version 6 does.
Integers are `bigint` (`integer` for `revision_number`, `width`, the
term counts and lengths), `pinned` is `boolean`, JSON columns are `text`, and `memories.position`
is an identity column. Two things differ:

- `store_lock` holds one row (`id` 1). Every store transaction sets READ COMMITTED, whatever the
  client's default, and locks it (`SELECT … FOR UPDATE`) before reading anything, so transactions
  on the store run one at a time and each statement sees every earlier commit. An exposure
  recording does not take it: it runs in a transaction of its own that holds a shared
  transaction-level advisory lock on `relembra exposures <schema>` from before its insert to its
  commit, and a redaction takes that lock exclusively before it reads exposures, so a recording
  either commits before the read or after the redaction (and then finds the tombstone).
- `memories.noted_at` and `ops.at` are the database clock's time when the write was accepted;
  `revised_at`, and `revision.at` in the events, are the writer's clock. So on Postgres
  `noted_at` is not rebuildable from the events: an export carries `revision.at`, and a replay
  dates the memory by it, bounded by the database clock, as FORMAT's import rules say.

`schema_version.applied_at` is the database clock's time. A migration runs at READ COMMITTED, takes a
transaction-level advisory lock on the schema's name, rereads the version and applies its steps and version row in
one transaction; a schema newer than the code is refused before anything is written.
