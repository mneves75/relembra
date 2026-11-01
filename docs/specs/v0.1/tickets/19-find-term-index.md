# 19: Find latency with a store-maintained term index

**What to build:** Find stays fast on large stores: a per-scope term index with exact BM25 statistics replaces loading and retokenizing every readable memory on each query, without changing a single ranking.

**Blocked by:** 09

**Status:** done, pending review

- [x] The index holds N, df, avgdl and per-memory term frequencies (exact and stem forms) per scope, updated in the same transaction as every write, retraction, supersession and redaction
  - `documentTerms` (`src/ranking.ts`) gives each memory's lengths and per-term counts, exact
    and stem, for both §3 modes at once: every token (`all`) and stop words removed (`kept`).
    Stores keep, per scope, N and the two length sums (avgdl is their quotient at read time),
    and per live memory its counts. df is the number of a term's postings in the scopes read.
  - Both stores update it inside `putMemory` and `redact`, the only two writes that change a
    memory, so every note, retraction, supersession, summary, redaction, retention sweep and
    import updates it in its own transaction. SQLite: migration 4 (`term_scopes`, `term_docs`,
    `term_postings`, `src/sqlite/term-index.ts`); memory store: a copy-on-write map.
  - Migration 4 follows plan §4.5: it runs under migrate()'s `BEGIN IMMEDIATE`, rereads the
    version, and applies the tables, the backfill of every live memory (`Migration.backfill`)
    and the version row in one transaction. Tests (`test/sqlite.test.ts`): a schema-3 store
    with data (notes, a retraction, a supersession, a summary, a redaction, two scopes) whose
    schema equals the current migration 3's migrates, and its backfilled index equals, row for
    row, the one the writes built; switching the backfill off made that test fail. A backfill
    that throws leaves the store at schema 3 with no index table (positive control: the real
    migration applies). The crash tests now expect versions 1 to 4. Migration 4 names no column
    of `import_checkpoints`.
  - Conformance (`src/testing/conformance.ts`), on both stores: "findByTerms reads N, lengths
    and term counts over the live memories of the scopes asked, and loads what was chosen, in
    order" (counts worked out by hand, a memory with no tokens counted in N, retracted and
    superseded ones not, a live memory retracted later dropped); "find ranks exactly as the full
    scan after every note, retraction, supersession, summary, redaction and sweep, and a
    rolled-back write changes nothing" (each step must change the results, so a missed update
    shows); the dirty-read case now covers `findByTerms`.
  - Seven new flawed stores in `test/conformance-controls.test.ts` (index ignores scopes, serves
    non-live memories, misses updates, keeps redacted memories, writes outside the transaction,
    keeps freed terms, loads out of order), each failing its case; every case has a failing flaw.
  - Erasure: "a redacted memory's terms leave the term index and every stored byte, while a
    planted copy's stay". The terms are folded, lower-case forms that exist only as index terms,
    and the case reads the SQLite file and WAL bytes as the other erasure tests do. The planted
    copy's terms are found after the first redaction; after the copy is redacted too, none is.
  - Tickets 07 and 08's write paths (`retractAll`, `liveDerived`, the plan-approved mutations,
    JSONL replay and the OptMem import) write memories only through `putMemory` and `redact`.
    `test/find-index.test.ts`, "find equals the full scan after every write path", on both
    stores: retract, supersede, redact and sweep, each approved with its preview's `expect`; a
    stale approval and a summary supersede, refused, leave the rankings as they were; a JSONL
    import into a store that already holds a memory, an OptMem import, a redaction of an
    imported memory, and both imports repeated. Each write must move the rankings. Stores that
    keep a memory in the index after it stops being live failed all four cases.
- [x] A property test on random corpora shows rankings and scores identical to the specification's reference computation (the current full-scan ranker kept as the test oracle)
  - `test/find-index.test.ts`: 300 seeded corpora on the memory store and 40 on SQLite, over
    three scopes, with notes, retractions, supersessions, summaries, redactions and retention
    sweeps interleaved. Words cover accent and plural folding, stop-word-only queries,
    stop words whose stems collide with content words (`does` stems to `dao`), digits,
    supplementary-plane letters and queries past the cap. Six readers (each scope, pairs, all
    three, a policy listing a scope twice) compare find with `rank()` over `liveMemories`:
    equal results, and equal ids, seqs and IEEE 754 score bits. 48,157 assertions.
  - Negative control: swapping the two §3 lengths in the read fails on seed 1, while the
    unchanged store passes the same seed.
  - `rank()` is unchanged apart from sharing `parseQuery`, and still serves brief.
- [x] Distinct query terms are capped at 32
  - `parseQuery` keeps the first 32 distinct terms in query order, after the §3 stop-word step;
    later terms are ignored. It is part of the specification (`ranking-algorithm.md` §5) and
    of `rank()` too, so the oracle and the index agree on every query, and brief follows the
    same rule. Documented on `FindInput` and `BriefInput`.
  - "only the first 32 distinct query terms are scored, in query order" (`test/find.test.ts`)
    failed first (the 33rd term was still found); the positive control finds the 33rd term alone.
- [x] Warm find p95 <= 50 ms on 20,000 memories on Bun and Node, measured by ticket 09's benchmark; the measured baseline before the change is recorded beside it
  - `docs/eval/bench-2026-10-31-term-index.md`: three runs before, three after at earlier
    commits and three at the final commit, side by side with `uptime` for each, plus CPU time
    per find.
  - At the final commit `ff3380e` (with `feat/v0.1` merged), met in 3 of 3 runs: Bun 24.88,
    6.38 and 8.46 ms; Node 35.42, 12.21 and 27.38 ms. Before the index: Bun 991.86 to 1604.58
    ms, Node 594.83 to 3646.8 ms.
  - Not met in every run: of the three earlier after runs, run 1 (`0b7e367`) met it (Bun 29.72,
    Node 44.27) and runs 2 and 3 (`09681c5`) missed it (Bun 131.86 and 102.19, Node 314.35 and
    130.84), so 4 of the 6 after runs met it. Every run saw one-minute loads of 80 to 1,000 on 18
    cores. Inside the runs, the misses track contention, not code: Bun's warm find p50 stayed at
    2.76 to 6.42 ms in all six after runs (before: 252.97 to 398.6) while the tail moved; wake
    and brief, which the index does not touch, slowed as much or more in the two missed runs;
    and the same store build took 28 to 46 s in the final runs against 147 s in the slowest.
    CPU time per find, p95: Bun 141.42 ms before, 6.74 to 9.9 ms after; Node 216.54 ms before,
    12.11 to 17.24 ms after.
  - Not measured: a run on an idle machine. Under the heaviest contention seen here the budget
    did not hold.
- [x] Out-of-scope memories never touch the statistics (positive control included)
  - Conformance case "memories outside the scopes read never change find's scores, and
    memories inside do" (both stores): writes in scope B that would move df and avgdl, and one
    retracted again, leave a reader of A with the same results and score bits. Positive
    controls: a reader of both scopes gets the full scan of both, which differs; a write in A
    moves A's scores. The read case asserts each scope's N and sums separately and added up.
    Flaw `index-ignores-scopes` fails both cases.

## Comments

- **Port.** `Store.findByTerms` is a new required method; ticket 12's Postgres store inherits
  it. The store reads the index, hands it to the core's pure `choose` (which scores and picks
  the best `limit`), and loads the chosen memories, all in one snapshot (SQLite: a deferred
  read transaction). Rejected: two separate calls (index read, then load), which could join
  two snapshots under a concurrent write, or would need a verify-and-retry loop.
- **df.** df is counted from the postings that find has to read anyway to score, rather than
  kept in a df table: a table would need the same rows, could drift, and would keep a
  redacted text's terms in rows whose count dropped to 0 unless they were deleted too.
- **Stop words** are indexed with `kept` 0, so a stop-word-only query (§3 fallback) reads the
  same rows with the `all` counts and lengths.
- **Cost.** The index costs space and write time: on the 20,000-memory benchmark the store grew
  from 16.7 MB to 30.4 MB, and building it through `note` took 53 to 147 s instead of 17 to
  49 s. The builds ran at different loads, so the write slowdown at equal load is unverified.
- **Brief** still ranks every live memory (it needs them all for summaries), so its latency is
  unchanged by this ticket.
- **CLI timeouts.** `test/cli/scope.test.ts` timed out at Bun's 5 s default under load, on this
  branch and on the base commit alike; it has a 60 s deadline, with no assertion changed
  (`feat/v0.1` carries the same deadline).
- **Base.** Built on 09 with 08 merged in, then `feat/v0.1` at 86d5551 (tickets 07, 08 and 09
  final, and the SQLite race fix) merged. The full suite with the binary required, `test:node`,
  typecheck, lint and `bun run eval` were rerun on that merge.
