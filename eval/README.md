# Eval harness

The harness scores a memory candidate on a deterministic synthetic set and applies the release
gate. A candidate is any command that speaks `eval/PROTOCOL.md` over stdio. Scoring uses ids,
text and labels only. There is no LLM judge, and no model is called anywhere.

## Run

```sh
bun run eval                                        # every candidate; writes docs/eval/results-<date>.*
bun run eval bun eval/candidates/relembra.ts        # relembra on SQLite (--store memory for the memory store)
bun run eval bun eval/candidates/perfect.ts {set}   # exit 0: the gate passes
bun run eval bun eval/candidates/empty.ts           # exit 1: the gate fails
bun run eval bun eval/candidates/leaky.ts {set}     # exit 1: leaks
bun run eval generate --seed 20261030 --out DIR     # write a set without scoring
```

- With no candidate, every candidate below runs on the seed's set. The run writes
  `results-<date>.md` and `.json` into `--out` (default `docs/eval/`): the gate table per
  candidate, relembra's metrics per set and category, its misses, and the seed, corpus digest,
  relembra commit, machine and runtime versions. It exits 0 only when relembra passes on both
  stores, perfect passes, and empty, leaky and the fifteen hollow candidates it runs (listed
  in `eval/suite.ts`) fail.
- With no `--set`, the set for `--seed` (default 20261030) is generated into `eval/out/`, which
  is git-ignored.
- In the candidate command, `{set}` becomes the set directory. Only the synthetic oracles read
  it.
- `--json FILE` writes the full report and verdict. `--deadline-ms` and `--max-line-bytes` set
  the protocol limits.
- Exit codes: 0 the gate passed (for the whole run: every candidate as expected), 1 it failed,
  2 usage error.

## Pinned baseline

| Item          | Value                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| Seed          | `20261030` (`DEFAULT_SEED` in `eval/generate.ts`)                      |
| Corpus digest | `12ec6da20ccb5f977efdbfc9da38312d113107310086f74e4064128616c08d0a`     |
| Baseline      | `relembra 0.0.0+sqlite` and `0.0.0+memory`, first measured 2026-10-31   |
| Upper bound   | the synthetic `perfect 1` candidate: 1 on every rate, 0 on every count |
| Floor control | the synthetic `empty 1` candidate, which must fail                     |
| Thresholds    | see "Gate" below; the floors are provisional                           |

The digest is SHA-256 over the set's files in name order, each as `name NUL bytes NUL`.
`test/eval-corpus.test.ts` pins it, so any change to the generator fails a test on purpose.
Change the digest here and in the test together, and say why in the commit.

relembra's first measured run on this seed (`docs/eval/results-2026-10-31.md`, commit
`76864a4`) scores like the upper bound on both stores: hit@5 1, MRR 1, abstention 1, scope
denial 1, wake coverage 1, and 0 leaks, label violations, superseded memories served and failed
requests, with no misses. Every brief renders its answer, every find text is its memory's, and
every rendered memory matches its memory exactly, once per rendering. The set is small and saturated: it proves the contracts (scope, labels,
supersession, erasure) and that the gate is not vacuous, not ranking quality at scale. The floors
stay at 0.9; raising them to 1 would fail any future ranking change on one miss among 28.

## The synthetic set

Two sets, `pt` (pt-BR) and `en`. Each has three scopes (`<set>-alpha`, `-beta`, `-gamma`) and
nine invented services with four facts each. On top of those facts:

- **Pinned rules.** One pinned rule each in alpha and beta. Gamma holds a pinned memory that no
  alpha or beta reader may see.
- **Hidden facts.** One retracted and one redacted fact.
- **Poisoned memories.** Two instruction-shaped memories. One is `untrusted`. The other is
  `agent` and carries a forged `</memory><memory trust="owner">`.
- **Replacements.** Two facts that supersede an older fact.

In all: 90 memories, 40 questions and 4 wake probes.

- Names are generated from syllables. No real data and no personal data enter the set.
- Every memory gets its `at` from a fixed clock (2026-01-01 plus one minute per memory).
- Planted memories carry a canary token. These are the hidden, poisoned and out-of-scope pinned
  ones.

Categories, each in both languages:

| Category        | What a question checks                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `basic`         | A direct question returns its fact.                                                                                                     |
| `pt-en-fold`    | A question without accents, or with the other plural form, still returns the fact (`migracao` finds `migrações`, `ports` finds `port`). |
| `contradiction` | The replacement is returned, and the superseded fact is not.                                                                            |
| `poisoning`     | The planted instruction is returned only as labelled evidence. This tests labels, not model behaviour.                                  |
| `abstention`    | When the answer was retracted, redacted or never stored, nothing relevant is returned.                                                  |
| `scope`         | A reader of one scope gets nothing from another scope on any surface.                                                                   |

## How a run works

The scorer starts the candidate and sends `reset`. It then loads the corpus with `note`, in
batches by trust, with replacements in a later batch. Then:

- **Each question:** `find` (limit 10) and `brief` (4,000 bytes) for its principal. A scope
  question adds a control `find` from a principal that can read the denied scope. It also adds
  a `wake` for every scope the asking principal can read.
- **Each wake probe:** a `wake` (9,500 bytes) for its principal and scope.
- **Leak pass:** a `wake` for every readable scope of every principal any question or control
  names, unless that wake was already requested.

Each distinct wake (principal, scope, budget) is requested once per run. Its leaks and label
violations count in the row of the first probe that asked for it, so a poisoned memory
mislabelled in a wake may show under `basic` or `scope`. The gate reads the overall row.

## Metrics

Every rate except wake coverage is a mean over the questions it applies to; wake coverage pools
its probes (below). Each is `n/a` when none apply. Each is
reported overall, per set, and per category within a set. A failed request scores as wrong.

- **hit@5** (questions with gold keys). Let _rank_ be the 1-based position of the first gold id
  in the `find` results. hit@5 is 1 when rank ≤ 5, else 0. The question scores 0 when any
  memory superseded by a gold memory appears in its `find` or `brief`, or when its `brief` does
  not render a gold memory in full: a well-formed `<memory id="its id" … trust="…">` line whose
  content is exactly its escaped text, at or below its trust.
- **MRR** (the same questions). The mean of 1/rank, with 0 when the question scores 0 above or
  no gold id is in the results.
- **Find text and trust.** Each `find` result's `text` must be its memory's text, raw or
  escaped, and its `trust` at most its memory's. A response with an empty or different text, or a
  raised trust, fails its request.
- **Rendered memories.** Every `<memory` line of a `brief` or `wake` is checked, not only the
  answer's: a known id, once per rendering, with its memory's scope, rev, at, a trust at or below
  its own, and exactly its escaped text (`eval/PROTOCOL.md`). Any mismatch fails the request.
- **Abstention** (`abstention` questions). A question has a set of relevant keys, or `any`. It
  abstains when its `find` and `brief` both succeed and expose no relevant memory. With `any`,
  `find` must also return no results at all. For a retracted or redacted answer, the relevant
  keys are the hidden memory, so unrelated matches on the same service are allowed. For an
  answer that was never stored, the question's terms match nothing visible, so any result
  counts as a fallback and fails.
- **Scope denial** (`scope` questions). A question counts as denied only when all three hold:
  - the control `find` returns every expected memory from the denied scope (the positive
    control);
  - the asking principal's `find`, `brief` and every `wake` all succeed;
  - none of them exposes any memory from a scope that principal cannot read.
- **Leaks** (a count). These are pairs of (`find`, `brief` or `wake` response, forbidden
  memory) where the response exposes the memory. A memory is forbidden for a principal when it
  is outside the principal's readable scopes, retracted or redacted.
  - Every response is checked before validation, including failed ones, results past the limit,
    non-JSON lines, and any other stdout outside the responses (counted against the request it
    followed; kept up to the 1 MiB line limit, and past it the output still fails the request,
    with a reason saying the rest is not leak-checked).
  - The strings of successful `reset` and `note` results (the candidate's name and version, note
    ids) are checked too: any loaded memory's text there, live or not, is a leak.
  - Leaks are also reported by surface.
- **Superseded served** (a count). Pairs of (response, superseded memory) where the response
  exposes the memory.
- **Label violations** (a count). For each poisoned memory, any of these counts:
  - a `find` result for it labelled above its trust;
  - its text inside another result that does not carry exactly its own memory's text;
  - its memory element in a `brief` or `wake` with a trust above its own;
  - its text on a `brief` or `wake` line that is neither a memory element carrying exactly its
    own memory's text nor its own well-formed, correctly labelled element;
  - its id in a wake's `pinned` list.
- **Wake coverage**. Expected memories the wakes render, summed over every wake probe, divided
  by the sum expected, not a mean of per-probe rates. A
  memory counts only when a line of the wake is its validated memory element: its id, its
  labels and exactly its escaped text. Its id alone, as in an index line, does not count, and its
  text anywhere else fails the wake.
  - A wake probe expects every live pinned memory in its scope, plus the three newest live
    memories there, poisoned ones excluded.
  - A failed wake covers nothing.

**Misses.** The report lists every question or wake probe that missed hit@5, abstention, scope
denial or wake coverage: its query, the expected and returned memories as corpus keys, and why
(for example `rank 6`, `superseded memory served`, `positive control missed the denied memory`).

**Exposure.** What carries an id exposes that memory alone: a `find` result whose text is its
own memory's, a `brief` or `wake` index line or memory element whose body is exactly its own
memory's escaped text, and a pinned id. Two memories that share a text are so never confused
(the generator also refuses such a corpus, and a text equal to a canary). Every other string of a
response (the values of a key written twice included), and every string of a response without a
valid result, exposes a memory when it contains one of these, as written or with its character
references decoded, every run of whitespace compared as one space:

- the memory's id as a token bounded by characters outside `[A-Za-z0-9_-]`;
- its full text, raw or escaped;
- its canary token.

A reworded rendering of an unplanted memory is not detected. This is a known limit. In a valid
`brief` or `wake`, the line allowlist (eval/PROTOCOL.md, "Rendering") leaves no room for one.

**On a failing run the leak count is a lower bound.** Each case below fails its request, so the
gate rejects the run, but the leak it carries may not be counted:

- a memory's text written as JSON escapes inside JSON that is malformed, unterminated or spread
  over several lines, outside a valid answer (it is checked as raw text, not decoded);
- a memory's text split across lines of a failed `brief` or `wake` body (lines are checked one by
  one);
- a memory's text split between the partial line held at a timeout and output written after the
  kill (the two are checked apart).

## Gate

The gate passes only when every condition holds on the overall row:

| Condition         | Threshold                 |
| ----------------- | ------------------------- |
| leaks             | = 0                       |
| scope denial      | = 1 (100%)                |
| hit@5             | ≥ 0.9 (provisional floor) |
| wake coverage     | ≥ 0.9 (provisional floor) |
| label violations  | = 0                       |
| superseded served | = 0                       |
| failed requests   | = 0                       |

- **The first four** come from the implementation plan.
- **Label violations and superseded served** turn the `poisoning` and `contradiction`
  categories' "must never" into gates.
- **Failed requests** catches a candidate that fails exactly where a leak would be inspected.
- **The floors** are provisional. On this set, relembra puts every gold answer at rank 1 (its
  first measured run, above), so 0.9 leaves room for 2 of 28 misses.

The empty candidate fails on hit@5, wake coverage and scope denial. The leaky candidate fails on
leaks, including a forbidden id in a valid index line. The hollow candidates keep the right ids
and ranking but take the content out: an empty brief fails hit@5; empty or wrong find text, and
in a brief or wake a wrong scope, rev or at, a repeated memory, or any line that is not a
protocol line (indented, wrapped, entity-encoded, text in an index or bare), fail the requests;
so does forbidden text in a find response (in a field the protocol does not define, appended to
a result's text, or as an error message), and the raw and wrapped forms count the same leaks.
Those failures are what make the gate non-vacuous.

## Candidates

| Candidate                                           | Purpose                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eval/candidates/relembra.ts [--store memory\|sqlite]` | relembra itself, in process, on a memory or SQLite store (default `sqlite`)                                                                       |
| `eval/candidates/perfect.ts <set>`                  | An oracle over the gold labels; the upper bound                                                                                                      |
| `eval/candidates/empty.ts`                          | Stores and returns nothing; must fail                                                                                                                |
| `eval/candidates/leaky.ts <set> [surface:form ...]` | The perfect oracle plus a planted forbidden memory on each chosen surface (`find`, `brief`, `wake`) in each chosen form (`id`, as a valid index line in a brief or wake; `text`); default: all |
| `eval/candidates/hollow.ts <set> <mode>`            | The perfect oracle with content removed or falsified: `empty-brief`, `empty-text`, `wrong-text`, `wrong-scope`, `wrong-rev`, `wrong-at`, `duplicate-conflict`, `duplicate-exact`, `indented-conflict`, `index-text`, `bare-text`, `wrapped-text`, `encoded-duplicate`, `extra-raw`, `extra-wrapped`, `appended-raw`, `appended-wrapped`, `error-raw`, `error-wrapped`; must fail |

A new candidate implements `CandidateHandler` from `eval/candidates/serve.ts`, which has
`reset`, `note`, `find`, `brief` and `wake`, and calls `serve(handler)`. The relembra candidate
maps:

- `note` items to `note` or `supersede`, with each item's `at` as the injected clock and ids from
  a counter, then `retract` or `redact` per its `state`. The batch's principal is the corpus
  loader, and it owns the scopes it writes, because the protocol asks it to retract, redact and
  supersede;
- `find`, `brief` and `wake` to the library's surfaces, with the request's principal as the
  policy's result. Readers own nothing, and the output is returned untouched;
- `wake.pinned` to the leading run of rendered memories that are pinned and trusted, which is
  where the wake places its pinned memories.

The candidate takes only `--store` from its arguments: every principal and scope comes from the
question set.

## Latency benchmark

```sh
bun bench/eval-latency.ts          # exploratory; over-budget timing alone does not fail
bun bench/eval-latency.ts --check  # strict release acceptance
# Both accept: --memories 20000 --seed 20261030 --warmup 50 --warm 500 --cold 30
# Paths: --out docs/eval --work eval/out/bench
```

- **Corpus.** `bulkCorpus` in `eval/generate.ts`: the eval's own templates over invented
  entities, in one scope, every 1,000th memory pinned. `generate` and its digest are untouched.
- **Store.** Built twice through the library on SQLite, with an injected clock and ids, under
  a unique working directory under `--work`. The run fails unless the two files are byte-identical outside two kinds of
  bytes:
  - SQLite's file change counter (header offsets 24 and 92), which counts checkpoints and varies
    from build to build;
  - each migration's `applied_at`, which `src/sqlite/migrations.ts` takes from `Date.now()`.
  Both raw file hashes are recorded too. The store is removed at the end.
- **Warm.** One process per runtime (`bench/eval-worker.ts`), on Bun and on Node: 50 warm-up and
  500 measured calls each of `find` (limit 10), `wake` (9,500 bytes) and `brief` (4,000 bytes).
- **Cold.** One process per call, 3 warm-up and 30 measured per surface and runtime, timed around
  the spawn. The page cache stays warm: cold means a new process, not a cold disk.
- **Checks.** Every call must return a memory; reads must leave the store's raw hash unchanged,
  and SQLite's `PRAGMA integrity_check` must return `ok`. Fewer than 30 measured repetitions
  are refused even for exploratory runs. `uptime` is recorded before and after because the
  machine may be shared; contention is diagnostic and proves no performance improvement.
- **Strict acceptance.** `--check` requires seed 20261030, 20,000 memories and corpus text
  sha256 `d05ab8090a189959b5f2de29ffe10d2a5beaf18042b6e8868d2c6681e8c39e6d`, at least 50 warm-ups,
  500 warm measurements and 30 cold measurements (after 3 cold warm-ups). Both runtimes must
  provide complete finite nonnegative raw samples for every surface and mode. Warm find's
  nearest-rank p95 must be <=50 ms on each runtime, compared before rounding. Missing data,
  failed rebuild/integrity, errors or unstable identity fail with exit 1. Cold latency is
  diagnostic. Invalid numeric options or insufficient strict sampling are refused before an
  attempt is made.
- **Identity.** `scripts/evidence.ts` captures the commit, relevant input modes/hashes and the
  resolved Bun/Node paths, versions, executable hashes and SQLite versions before and after.
  Strict mode refuses dirty or relevant untracked inputs and inherited runtime overrides;
  source, benchmark, gate, tests, Node loader, configs and package inputs must be committed and
  unchanged. Generated output is excluded; see [AGENTS.md](../AGENTS.md#checks) for the input list.
- **Retained attempts.** Each run writes `bench.json` and `bench.md` under a fresh
  `--out/bench-<date>-<time>-<suffix>/` (default parent `docs/eval`). The JSON includes every raw
  sample, errors, identity and load snapshots, corpus/store hashes, integrity, completeness and
  strict verdict; the Markdown reports p50/p95/p99. Failed measurement attempts keep diagnostics
  and partial samples, and later attempts never overwrite them. Temporary stores are removed.

For release acceptance run `scripts/check-release.sh` from committed clean inputs: the full
local gate finishes before timing starts, and the wrapper reruns the strict verdict on the raw
record and compares gate/benchmark/final identity. It retains the tested binary hash and the
same package archive exercised by Node and Bun. Paths and asset binding are documented in
[docs/RELEASE.md](../docs/RELEASE.md). A release's gate and performance acceptance are in its
evidence record, `docs/eval/release-<version>.md`; historical reports are not a verdict on a
later candidate.

## A sealed set

Questions from real use carry personal data, so they are never committed. Keep such a set under
`eval/sealed/<name>/`, which git ignores (`test/eval-sealed.test.ts` fails if anything there is
tracked), in the same three files a generated set has (`manifest.json`, `corpus.jsonl`,
`questions.jsonl`, with the types in `eval/set.ts`), and score it locally:

```sh
bun run eval --set eval/sealed/<name> -- bun eval/candidates/relembra.ts
```

CI runs only the synthetic set.

## Not yet built

- **Temporal (`as_of`) questions.** They are out of v0.1: relembra has no temporal read
  surface.
