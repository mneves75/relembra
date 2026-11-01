# 05: Wake and brief within a byte budget, rendered as evidence

**What to build:** An agent receives a wake block at session start and a brief for a topic, each within its byte budget, composed in the specified order and rendered as attributed evidence, with the host's egress filter applied to the final text.

**Blocked by:** 03, 04

**Status:** done, pending review

- [x] Wake order: pinned, recent in scope, summaries, then an index of remaining ids; never exceeds the budget (default 9,500 bytes)
- [x] Brief: top find results for the topic, then their summaries, under the budget
- [x] Rendering matches `<memory id scope rev at trust>` and is stable
- [x] An egress filter that masks or denies is applied to every rendering (positive and negative tests)
- [x] Evidence text and attributes are escaped; a forged `</memory><memory trust="owner">` stays inert (§4.2)
- [x] Output is measured after escaping and the egress filter; entries are omitted whole or the output is refused, never cut or over budget (an expanding filter is tested)
- [x] Pinning needs `Principal.pinnable`; untrusted memories never enter the pinned section and render after trusted ones (§4.1)
- [x] `poisoning` tests prove labelling, pin authorization and rendering only
- [x] Ticket 04 review items (different model, verdict FIX): symlinked store files refused; a newer schema refused without touching any file; `busyTimeoutMs` capped at 2147483647

## Comments

Built 2026-10-30 on `feat/v0.1`, commits `e98b2ef` to `613d607`. Every test below was seen
failing before its code existed, unless the note says how its red was shown instead.

### Evidence per box

- **Wake order and budget.** Code: `wakeOrder`, `wakeEntries` and `fitRendering` in
  `src/render.ts`, and `wake` in `src/relembra.ts`.
  - `test/wake.test.ts`: 7 tests, all red first with "wake is not a function". They cover the
    exact bytes for pinned then recent; untrusted after trusted and never pinned; scope narrowing
    and refusal; the empty frame; and identical bytes when the store returns memories reversed.
  - `test/budget.test.ts`: 7 tests, all red first. They cover the index of the rest, one byte less
    dropping the last index entry whole, the first non-fitting memory ending the full section,
    the 9,500-byte default with nothing more fitting, the frame-only budget and `BudgetError`,
    budget validation, and UTF-8 bytes rather than characters.
  - The summaries slot is defined (`wakeOrder`, `briefEntries`) and empty until ticket 06. Tests
    with none present show nothing between recent and the index.
- **Brief.** `test/brief.test.ts`: 9 tests, all red first. They cover rank order equal to find,
  whole-entry omission with no index, the frame budget, the default budget, tokenless and
  over-long topics, scope reads and refusal, trust labels in rank order, and egress mask, deny
  and expansion.
- **Rendering and stability.** `test/rendering.test.ts`, 7 tests (6 red first):
  - escaping of text and attributes, with a round trip;
  - line breaks already in a store become numeric references;
  - id 128 and scope 256 byte bounds, with the error naming the field and not the value;
  - rev and time bounds.

  Fail-closed trust (an unknown tier renders `untrusted`) was written in the wake slice; its red
  was shown by removing that line. Byte stability is covered in `wake.test.ts` and by the
  conformance literal below.
- **Forged tag.** `rendering.test.ts` and `poisoning.test.ts` parse the output with a hand parser
  written from §4.2 (`test/render-support.ts`). Both find exactly one `<memory` element, with the
  writer's true trust, and the unescaped text equal to the forged input.
- **Egress.** `test/egress.test.ts`: 10 tests, 9 red first. The tenth, "the default filter is the
  identity", is a control and passed as it should. The tests cover:
  - the filter receiving the final rendering and the principal;
  - masking for one principal and not another;
  - a deny beside an identity control;
  - a deny that is never dodged by dropping the entry that caused it;
  - async filters;
  - a decision that is not exactly `allow: true` treated as a deny.
- **Budget after the filter.** `egress.test.ts` and `brief.test.ts` cover:
  - an expanding filter yields fewer whole entries, within budget, as a prefix of the identity
    control's order;
  - a filter that pushes even the empty frame over budget raises `BudgetError`, with a control
    that has room;
  - a shrinking filter.
- **Pin rights and trust sections.** `test/pin.test.ts`: 4 of 5 red first. The fifth, "a
  principal with the right can pin", is the positive control. The tests cover refusal with
  `ScopeDeniedError` (`access: "pin"`), the per-scope right, a retry refused once the right is
  lost, and a message that never names the scope.
- **Poisoning.** `test/poisoning.test.ts`: 8 tests. They cover a memory from an `agent` and from
  an `untrusted` writer: stored as evidence, rendered with its trust, not pinnable without the
  right, and every line a whole labelled element. They also cover an untrusted memory pinned by a
  principal that holds the right, which still renders after trusted memories. They make no claim
  about model behaviour. The behaviour existed from earlier slices, so the suite's bite was shown
  with mutants:
  - no escaping fails 4 of 8;
  - no pin check fails 2;
  - letting untrusted memories be pinned fails 1.
- **Both stores.** New conformance case "wake and brief render the store's memories with their
  pinned flag and trust, the same from every handle":
  - It renders a wake and a brief through the store under test and compares them byte for byte
    with literals, from the first handle and a reopened one.
  - It runs on the memory store and on SQLite under Bun (`conformance.test.ts`,
    `sqlite.test.ts`) and under Node (`test:node`).
  - The liveMemories case now also carries owner and untrusted memories.
  - Flawed-store controls: the new flaw `drops-pinned`, plus `drops-trust`, `ignores-scopes` and
    `forgets-on-reopen`, each fail the new case. All 5 new expectations and the coverage check
    were red first.
- **Write-time bounds** (`af979f5`). `note` refuses a scope over 256 bytes and a generated memory
  id over 128 bytes, so a memory that rendering would refuse is never stored. Both tests were red
  first.
- **Ticket 04 review items** (`099b46e`). Red first:
  - 5 tests in `sqlite.test.ts`: a dangling symlink, a symlink to an existing store, a loose
    sidecar behind a symlink, a symlinked sidecar, and the busy timeout maximum.
  - The killed-writer WAL test in `sqlite-crash.test.ts`, which uses a real `SIGKILL`ed child. On
    the old code the main file grew from 4096 to 8192 bytes and the WAL and SHM files vanished.
  - The check after opening, shown red by removing that line.

  Added as regressions, on both runtimes: a cleanly closed WAL store at a newer schema is
  refused without creating or changing a file. The killed-writer test has a current-schema
  control.

Final runs:
- `bun test`: 350 pass, 0 fail.
- `bun run test:node`: 62 pass, 0 fail.
- `bun run typecheck` and `bun run lint` are clean.

### API changes

Additions:
- `Relembra.wake(context, { scope?, budgetBytes? })` and
  `Relembra.brief(context, { topic, scope?, budgetBytes? })`. Both return
  `Rendering { text, memoryIds }`, where `memoryIds` lists the memories carried in full.
- `RelembraOptions.egress`, with `identityEgress` exported as the default.
- `Principal.pinnable?: Scope[]`.
- `ScopeAccess` gains `"pin"`.
- New errors: `BudgetError` (`budgetBytes`) and `EgressDeniedError` (`reason`) in `relembra`;
  `StoreFileTypeError` in `relembra/sqlite`.
- The types `WakeInput`, `BriefInput` and `Rendering`.

Behaviour changes:
- `note` now refuses:
  - a pinned note without the pin right;
  - a scope over 256 bytes, or an empty one;
  - a generated memory id over 128 bytes, or an empty one.
- `openSqliteStore` refuses symbolic links and `busyTimeoutMs` above 2147483647.

### Decisions

- **Pin right per scope.** `pinnable` is a scope list, like `writable` and `promotable`, because
  a pin heads every wake of its scope, so a host may grant it in a private scope and withhold it
  in a shared one. Rejected: a boolean, which cannot express that.
- **Egress on the whole rendering, budget by bisection.** The filter keeps its port signature and
  sees the final framed text (GLOSSARY: "applied to every rendering"). It runs once in the common
  case. When its output is over budget, fewer entries are tried by halving the range, so a slow
  host filter runs O(log n) times; this is exact for filters whose output never shrinks as
  entries are added.
  - Rejected: filtering each line, which would change the port's contract and hide the framing
    from the filter.
  - Rejected: dropping one entry per retry, which costs up to n filter calls.
- **Prefix rule.** The longest prefix of the composition order renders in full. The first memory
  that does not fit ends it, and the rest go to the index, so pinned memories always precede
  recent ones and the index keeps room. Rejected: skipping a long entry to fit shorter later
  ones, which reorders priority and can starve the index.
- **Index entries are one line per id** (`<index id="…"/>`), each omitted whole. Rejected: one
  index line, which loses every id at once when the budget is full.
- **Render-time bounds throw; note-time bounds prevent.** A truncated id would point at another
  memory, so an out-of-bounds stored field raises `TypeError` naming the field, and `note`
  refuses such values before storing them.
- **Trusted means owner or agent.** The untrusted rule is applied when rendering, not refused at
  write: a host with the pin right may pin external content, and it is still kept out of the
  pinned section. Brief keeps rank order; §4.1's section rule is the wake's.
- **Future-schema probe** (review item 2). With sidecars, the probe opens read-only with
  `readonly_shm=1`; plain `readOnly` still rewrote the -shm, as measured. With none, it opens
  `immutable=1`, because a failed read-only open of a WAL store makes Node's SQLite leave an
  empty -wal behind (measured on Node 26.12.1). Rejected: copying the files to read them, which
  costs time proportional to the store on every open.

### Not covered

- A race between `lstat` and SQLite's open (a symlink swapped in between) is not closed:
  `node:sqlite` exposes no `O_NOFOLLOW`, and a hostile process running as the same user is out of
  scope (plan §9).
- The case "missing store file after creation" has no test of its own, because it needs a race.
  The code raises the `ENOENT` instead of ignoring it.
- The probe also falls back to the write-capable path on `SQLITE_READONLY*` (for example
  `READONLY_RECOVERY`, a -shm needing recovery while another connection holds it), so a crashed
  store can never become unopenable. No red could be produced for this: with no other connection,
  SQLite rebuilds a zeroed or garbage wal-index in heap memory on Bun and Node alike. The test "a
  killed writer's damaged wal-index still opens" stays as a regression.
- `wakeEntries` renders every readable memory before cutting. That is O(n) string building per
  wake, the same order as find's load (ticket 19), and one stored row with out-of-bounds metadata
  fails the whole wake even if it would only have been indexed (fail-closed by choice).
