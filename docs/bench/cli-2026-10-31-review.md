# CLI benchmark after the review fixes, 2026-10-31

This re-measures the relembra CLI binary after Sol's review fixes (ticket 07, commit e390b52). The
main change is that the scope now comes from git, which means two git processes per call. The
raw records of the three runs are in `cli-2026-10-31-review.json`. The method, dataset and
queries are the same as in [cli-2026-10-31.md](cli-2026-10-31.md), with one exception: the
dataset now lives in the scope git derives for the bench's repository, not in `bench/cli`.

## Verdict

- **Not comparable to the first record, and not usable to judge a latency gate.** The machine
  was saturated by other agents' work: the 1-minute load was **288 to 783 on 18 cores**,
  against 17 to 55 for the first record. Every number below is inflated by that load, and the
  tails most of all. Even process start alone (`--help`) went from 16–20 ms to 27–32 ms p50.
  Re-measure on a quiet machine before quoting any absolute figure.
- **What git costs.** `wakeGit` runs the same `wake` from a git repository with no
  `RELEMBRA_SCOPE`, so the CLI asks git twice. Across the three runs its p50 was **30 to 55 ms
  above `wake`** (140 vs 110, 177 vs 122, 168 vs 118 ms). Under this load the cost is about
  2 × 15–25 ms per git process. An earlier probe, at a lower load, timed a pair of these git calls
  at about 15 ms. `hookGit` p50 was 161 to 483 ms. Run 3's 483 ms came during the heaviest load,
  and its p95 and p99 move with it.
- **Find is unchanged by the fixes** (it gained no git call when `RELEMBRA_SCOPE` is set). Its
  numbers here only reflect the load. Ticket 19's term index is still needed, as the first
  record concluded.
- `RELEMBRA_SCOPE` stays the fast path for a host that knows its scope: it skips both git calls.

## What was measured

`bun bench/cli.ts --size 20000 --runs 50`, three runs back to back. Each command gets 5
unmeasured warm-up runs and 50 measured ones, one process per call, wall-clock around
`spawnSync`.

| Name | Command | Scope from |
|---|---|---|
| help | `relembra --help` | none (process start alone) |
| wake | `relembra wake` | `RELEMBRA_SCOPE` |
| hook | `relembra hook` | `RELEMBRA_SCOPE` |
| wakeGit | `relembra wake` in the bench's git repository | git (`rev-parse --git-common-dir`, `remote get-url origin`) |
| hookGit | `relembra hook` in the bench's git repository | git |
| find | `relembra find <query>` | `RELEMBRA_SCOPE` |
| libraryFind | `Relembra.find` in one process, 50 warm-up and 500 measured | none |

The bench's repository is `git init` in the temp directory, with origin
`https://example.invalid/bench/cli.git`. `HOME` is the temp directory, so no user git
configuration applies. Each run checks its outputs: every command exits 0, and the wake and the
hook's `additionalContext` from the git-derived scope must equal the `RELEMBRA_SCOPE` wake
byte for byte. That proves both paths served the same 20,000 memories, so no number measures
work that did not happen.

## Artifact, dataset and machine

- **Artifact:** `bin/relembra` built by `bun run build:cli` from commit e390b52, sha256
  `019aa084b35c3f60610b8b52cd80a8f8e1e2478b96ba0176300b67bc004fa9cb`, 39,770,626 bytes,
  darwin-arm64. The same build passed `RELEMBRA_REQUIRE_BINARY=1 bun test` (647/647).
- **Dataset:** seed 20261031, 20,000 memories, text sha256
  `53029c60229408b4845a0de1defe91da6105241710777ffd3cf51be05a91b816` (identical to the first
  record and in all three runs). The store is 20,967,424 bytes, slightly larger than before
  because the scope string is longer. Generating it took 14.1 to 20.7 s, against 3.6 to 5.4 s
  before, which is the load again.
- **Machine and runtimes:** Apple M5 Pro, 64 GiB, macOS 27.2 arm64; Bun 1.4.4 (da867c60),
  SQLite 3.54.0; git 2.56.0.

## Results (ms)

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| load 1m before → after | 783 → 310 | 288 → 689 | 689 → 745 |
| help p50 / p95 | 26.7 / 34.9 | 27.3 / 34.7 | 32.4 / 79.2 |
| wake p50 / p95 | 110.5 / 232.4 | 122.3 / 230.3 | 117.8 / 556.2 |
| hook p50 / p95 | 104.9 / 314.8 | 102.9 / 228.8 | 102.8 / 294.8 |
| wakeGit p50 / p95 | 140.0 / 344.9 | 177.4 / 304.8 | 168.4 / 521.7 |
| hookGit p50 / p95 | 192.0 / 490.6 | 161.4 / 266.7 | 482.8 / 1351.1 |
| find p50 / p95 | 686.6 / 1707.9 | 422.8 / 878.8 | 701.9 / 3070.2 |
| libraryFind p50 / p95 | 831.7 / 2693.4 | 490.0 / 2735.2 | 476.9 / 2586.2 |

p99, min, max and mean are in the JSON.
