# 03: Ranked find per the ranking specification

**What to build:** An agent searches the memories it may read and gets BM25-ranked results with Portuguese and English accent and plural folding, exactly as `docs/specs/ranking-algorithm.md` specifies.

**Blocked by:** 01

**Status:** ready-for-agent

- [x] Every property in ranking-algorithm.md §6 has a test that fails without the implementation
- [x] Out-of-scope memories never influence N, df or results (positive control included)
- [x] Results are deterministic, with ties broken by newer first, then id
- [x] The implementation is written from the specification only (no other project's source consulted)

## Comments

Spec readings, 2026-10-30 (branch `feat/v0.1-t03`). Each one is added as a sentence in `docs/specs/ranking-algorithm.md`:

- §3 fallback: read literally ("the query keeps its stop words"), a stop-word-only query could never match, because documents have lost their stop words. That was shown red: `the` found nothing. For that query the documents keep their stop words too, which also changes `N`, `df`, `|d|` and `avgdl` for that query only.
- §2: the digit exception means a decimal digit (`\p{Nd}`).
- §5: a memory's store sequence is the seq of the event that produced its current revision (`Memory.seq`, added to the model). Ids are compared ascending, by UTF-16 code unit.
- §5: `|d|` and `f(t,d)` count exact forms after stop-word removal. A stem-only match uses stem `f` and stem `df` over the candidates' token stems, as standard BM25 does over a second field.

Evidence, 2026-10-30 (branch `feat/v0.1-t03`, all in `test/find.test.ts`):

- §6 properties. Every test fails without `find`; beyond that, each is red-first or pinned by a mutation:
  - accent folding both ways ("accents fold both ways"): red first; also fails under "no accent folding";
  - plural folding ("plurals fold: agentes finds agente, and migrações finds migração"): red first;
  - exact over stem-only, with the stem-only memory newer so the tie-break alone would put it first: red first. It differs by idf as well as weight, so the 0.5 weight itself is pinned only by the hand-computed scores;
  - scope ("a memory the principal may not read never counts in N, df or the results"): passed on its first run (slice 1 already filtered in the store); pinned by the "store ignores scopes" mutation;
  - determinism ("the same store and query always give the same order and scores"): passed on its first run; no mutation fails it alone. The order it depends on is pinned by the seq and id tie-break tests.
- Also passed on their first run, because earlier slices had written the code: the hand-computed scores (pinned by the mutations below), the `#3274`, `snake_case` and `v0.1` split cases, and the four bounds tests.
- Out-of-scope: the reader's results and scores in a store holding other-scope memories are equal to those from a store that never held them. Positive control: a principal that reads both scopes sees those memories, and the in-scope score moves. Mutation "store ignores scopes" fails both scope tests.
- Order: "equal scores put the newer memory first", and "equal scores and equal store sequence fall back to memory id, ascending" (a stub host Store that returns equal seqs). The mutations "seq older first" and "id descending" each fail a test.
- Scoring: hand-computed BM25 for a three-memory corpus, worked in a comment and asserted to 1e-9. It pins k1, b, idf, the 0.5 stem weight, stop-word removal and single-character dropping in `|d|`. Mutations k1 = 2.0, b = 0.5, stem weight = 1.0, idf without `1 +`, stem added on exact match, no accent folding and no query dedupe each fail at least one test.
- §2 and §3 cases: `#3274`, `snake_case`, `v0.1`, single characters dropped except digits, English and Portuguese stop words, and the stop-word-only fallback.
- Clean room: written from `docs/specs/ranking-algorithm.md` only. No other project's source was opened and no web search was made.
- `bun test` 71 pass, 0 fail. `bun run typecheck` and `bun run lint` are clean.
- Store contract for ticket 02: `Store.liveMemories({ scopes })` returns every live memory in the scopes, with no limit and no text prefilter. `Memory.seq` must be persisted by `putMemory`.
