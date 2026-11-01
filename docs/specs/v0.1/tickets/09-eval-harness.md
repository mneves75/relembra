# 09: Eval harness in TypeScript with the reviewer's findings fixed

**What to build:** A maintainer scores relembra and a baseline on the same question sets through a JSON-lines stdio protocol, gets hit@5, MRR, abstention, scope denial, leaks and wake coverage per set and category, and measures latency on 20,000 synthetic memories.

**Blocked by:** 07

**Status:** done, pending review

- [x] Protocol document plus scorer; synthetic perfect, empty and leaky candidates are protocol commands
  - `eval/PROTOCOL.md` (version 1) and `eval/protocol.ts`, `eval/session.ts`, `eval/score.ts`.
    `eval/candidates/perfect.ts`, `empty.ts` and `leaky.ts` are commands that speak it over stdio.
  - `test/eval-score.test.ts` ("the controls"): perfect passes with every metric at its best,
    empty fails on hit@5, wake coverage and scope denial, leaky fails on leaks with perfect
    retrieval. `test/eval-cli.test.ts` runs them through `bun run eval`.
- [x] Fixed findings, each with a test: as_of applies to brief and every question surface; id-only renderings are caught; every collected wake response and every tested scope is leak-checked; responses are validated by type (distinct ids, known ranking ids, maximum length, integer ids); request deadlines and response-size limits
  - `as_of`: not applicable. It is out of v0.1 (plan §6, amendment below), because relembra has
    no temporal read surface; no temporal question exists to test.
  - Id-only renderings: "an id-only rendering is caught (index line in wake, see-also line in
    brief)" and "an id hidden behind a character reference is caught as a wake leak".
  - Every wake and scope: "the wake of a principal no wake probe names is leak-checked", "every
    readable scope of every tested principal is leak-checked", "an over-budget wake fails, loses
    its coverage and is still leak-checked", "a leak in the 11th find result is still inspected".
  - Validation by type (`test/eval-protocol.test.ts`): ids that only coerce to the request id are
    refused; find results must be distinct, known and within the limit; note ids are distinct,
    well-shaped and new; brief and wake text stays within the byte budget in UTF-8. Ids are
    opaque strings, not integers (amendment below).
  - Deadlines and sizes (`test/eval-transport.test.ts`, `test/eval-score.test.ts`): a hung
    candidate is killed at its deadline and scored as failed; a line over the size limit is
    refused and the candidate killed; a restarted candidate is reloaded on fresh ids; a kill
    reaches processes the candidate started.
  - The transport tests raced their fixtures under load (pid NaN in 2 of 1,384 runs). They now
    wait for the fixture's ready line first: 600 test runs (`--rerun-each` 20, then 40), 0
    failures at a 1-minute load of 155 to
    880 on 18 cores, and both child tests fail when the kill reaches only the leader.
- [x] Ranking-metric tests fail for rank 6-10 counted as hit@5 and for constant MRR
  - "hit@5 counts ranks 1 to 5 only; reciprocal rank is 1/rank" and "end to end, gold at rank
    2, 5, 6 and 10 scores exactly; MRR is not constant" (`test/eval-score.test.ts`). The report's
    misses now name the rank (`rank 6`, `rank 10`), asserted in the same test.
- [x] A relembra candidate passes on a synthetic set: scope denial 100%, leaks 0
  - `eval/candidates/relembra.ts`: the library in process, on SQLite (default) or the memory
    store, with an injected clock and counter ids; the request's principal is the policy's
    result; output returned untouched.
  - `docs/eval/results-2026-10-31.md` (`bun run eval`, scorer at 16a048f, seed 20261030; the
    file records the exact commit): on both stores, leaks 0, scope denial 1, hit@5 1, MRR 1,
    abstention 1, wake coverage 1, label violations 0, superseded served 0, failed requests 0, no
    misses. Perfect passes; empty, leaky and the fifteen hollow controls in the suite fail, so the
    gate is not vacuous.
  - Responses hold exactly the fields `eval/PROTOCOL.md` defines (envelope, error, results, find
    result entries), each key once per object; any other field or a repeated key fails the
    request, and every value, a repeated key's included, is still leak-checked. relembra on both
    stores emits only documented fields. Leak texts compare with whitespace normalized, so
    forbidden text in a find response counts the same leaks raw or wrapped: in an extra field
    (34), appended to a result's text (34) or as an error message (46).
  - The gate reads content (review fixes): a positive question needs its answer rendered in full
    in the brief; every find text must be its memory's; every brief and wake line must be empty or
    one of the protocol's line forms (frame, id-only index, memory element; the grammar is in
    `eval/PROTOCOL.md`), and every memory element must match its memory (scope, rev, at, trust at
    or below, exact escaped text) and appear once; wake coverage counts validated elements only.
    relembra's real output on both stores uses only frame lines and memory elements.
    `eval/candidates/hollow.ts` keeps ids and ranking but empties the brief (hit@5 0), empties or
    alters find text (34 failed requests), falsifies scope, rev or at or repeats a memory in
    briefs and wakes (38 failed requests in the suite, hit@5 0, wake coverage 0), or adds a line
    that is not a protocol line: an indented conflicting duplicate, wrapped text or an
    entity-encoded duplicate (34 failed requests each, hit@5 4/28, wake coverage 0), or wake text
    in index attributes (10 failed wakes, wake coverage 0); every mode fails.
  - Leaks, staleness and labels are attributed by id wherever the response carries one, so two
    memories sharing a text are not confused (tested on hand-built sets: a correct candidate gets
    0 leaks and 0 label violations); `generate()` refuses a corpus with a shared text or a text
    equal to a canary.
  - Escaping follows relembra's: line separators in text and attributes become decimal
    references (`&#10;`). `test/eval-relembra.test.ts` runs the set with a line break in every
    scope through both stores and the oracle; all pass.
  - `test/eval-relembra.test.ts`: the adapter on both stores, and the gate through the stdio
    protocol. Mutants of the adapter failed the gate: every scope readable (401 leaks); retract
    and redact skipped (40 leaks); brief "" (hit@5 0); find text "" (44 failed requests).
- [x] Latency benchmark: fixed seed, byte-identical store for the same seed; warm and cold p50/p95/p99 printed with machine and versions
  - `bench/eval-latency.ts` and `bench/eval-worker.ts`; `docs/eval/bench-2026-10-31.md` and
    `.json`. 20,000 memories from `bulkCorpus` (seed 20261030); find, wake and brief warm (50
    warm-up, 500 measured) and cold (one process per call, 30 measured) on Bun and Node, with the
    commit, machine, runtime and SQLite versions and `uptime` before and after.
  - Byte-identical: the store is built twice and the run fails unless the files match outside
    SQLite's file change counter (header offsets 24 and 92, which count checkpoints and vary) and
    the migration times (`src/sqlite/migrations.ts` records `Date.now()`). 120 consecutive
    rebuild pairs matched; both raw hashes are recorded.
  - Recorded run: warm find p95 407 ms on Bun and 1,850 ms on Node, so ticket 19's 50 ms budget
    is not met. The machine's 1-minute load rose from 33 to over 800 during the run (other
    agents), so every number is an upper bound. Repeat on an idle machine before quoting.
  - The budget is judged only on 20,000 memories from the pinned seed; any other run records it
    as not evaluated (`evaluatesBudget`, tested).
- [x] Amended by IMPLEMENTATION-PLAN §6: ids are opaque strings (not integers); an empty candidate fails (positive retrieval and wake coverage required); the baseline, corpus, metrics and thresholds are pinned in `eval/README.md`; `as_of` is out of v0.1; fixtures use injected deterministic `Clock` and `Ids`; categories include `contradiction` and `poisoning`
  - Opaque ids: `ID_PATTERN` in `eval/protocol.ts`; the relembra candidate returns
    `relembra-000001`-style ids.
  - The empty candidate fails (above, and `bun run eval` requires it to).
  - `eval/README.md` pins the seed, corpus digest, the measured relembra baseline, the metrics and
    the thresholds; `test/eval-corpus.test.ts` pins the digest.
  - `as_of` is out of v0.1, listed under "Not yet built" in `eval/README.md`.
  - The relembra candidate and the benchmark inject `Clock` (each memory's `at`) and `Ids` (a
    counter).
  - `contradiction` and `poisoning` are categories in both language sets; both score 1 for
    relembra.

## Comments

- **Loader ownership.** The protocol asks a `note` batch to retract, redact and supersede what it
  noted, so the relembra candidate's loader owns the scopes it writes. Readers own nothing.
- **Floors.** The set is saturated (relembra scores 1 everywhere), so it proves contracts and a
  non-vacuous gate, not ranking quality at scale. The hit@5 and wake floors stay at 0.9.
- **Misses.** The report lists every miss by corpus key with its query, expected and returned
  memories and the reason, so a ranking change (ticket 19) can be judged question by question.
- **For another ticket (library):** `migrate()` records `applied_at` with `Date.now()`. A Clock
  there, or a fixed value, would make the store file reproducible apart from SQLite's counter.
