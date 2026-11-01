# Find latency before and after the term index (ticket 19), 2026-10-31

Warm find p95 on 20,000 memories, on a heavily loaded machine. Before the index (three runs): Bun
991.86 to 1604.58 ms, Node 594.83 to 3646.8 ms. At the final commit `ff3380e`, after the merge of
`feat/v0.1` (three runs): Bun 6.38 to 24.88 ms, Node 12.21 to 35.42 ms, so the 50 ms budget was
met in all three. Three earlier after runs, at `0b7e367` and `09681c5`, met it once (Bun 29.72,
Node 44.27) and missed it twice (Bun 131.86 and 102.19, Node 314.35 and 130.84), during heavier
contention. Over all six after runs: met in 4. CPU time per find, which load inflates far less,
fell from a p95 of 141.42 ms to between 6.74 and 9.9 ms on Bun, and from 216.54 ms to between
12.11 and 17.24 ms on Node. No run on an idle machine was possible.

Every run below is ticket 09's benchmark, unchanged: `bun bench/eval-latency.ts --out <dir>`,
the same corpus (bulkCorpus, seed 20261030, 20,000 memories in one scope, text sha256
`d05ab8090a189959b5f2de29ffe10d2a5beaf18042b6e8868d2c6681e8c39e6d`), the same ten queries, 500
warm and 30 cold samples per operation, nearest-rank percentiles. Machine: Apple M5 Pro, 18 cores,
64 GiB, macOS 27.2; Bun 1.4.4 and Node v26.12.1, both with SQLite 3.54.0.

- **Before:** commit `0ed923e`, the ticket 19 base (ticket 09's benchmark, no term index).
- **After:** commit `0b7e367` (run 1) and `09681c5` (runs 2 and 3). Both have the term index;
  `09681c5` adds the merges of tickets 08 (`fda8d9e`) and 09 (`d8f2a03`) and a test deadline, and
  changes nothing on the find path. Ticket 08's migration 3 changed, so the store's zeroed
  sha256 differs between the two commits. `3dc7865`, used for CPU time below, is `09681c5` plus a
  formatting commit and a documentation commit: the same find path as runs 2 and 3.
- **Final:** commit `ff3380e` (runs final 1 to 3): the branch with `feat/v0.1` at `86d5551`
  merged (tickets 07, 08 and 09 final, and the SQLite race fix). Find reads the index exactly as
  before; the store's zeroed sha256 differs again because migrations 2 and 3 changed on
  `feat/v0.1`. The final runs ran in the branch's own worktree, with a clean tree.

The runs ran one at a time, each in its own worktree at that commit, on a machine shared with
other work: the one-minute load average stayed between about 200 and 1,000 on 18 cores
throughout. The load averages at each run's start and end do not by themselves separate the runs
(after run 1 started at 383 and met the budget; after run 3 ended at 225 and missed it). Three
measurements taken inside the runs do:

- Bun warm find p50 is flat across the three after runs (5.58, 6.05, 6.42 ms) while p95 moved
  (29.72, 131.86, 102.19). A slower find would move the median; a run queue moves the tail. Node's
  p50 moved too (10.5, 57.91, 18.42), so on Node even the median felt the load.
- Wake and brief, which this change does not touch, slowed by the same factor or more in the same
  runs: Bun warm wake p95 220.76, 510.53, 1014.07 ms; Bun warm brief p95 622.11, 1130.36, 2337.73.
- The store build, the same write path on the same corpus, took 53,294 ms in after run 1, 62,786 in
  run 2 and 146,967 in run 3.

The same three measures say the final runs saw less contention than after runs 2 and 3, though
their start and end load averages (80 to 960) look alike: their builds took 27,774 to 45,961 ms,
Bun warm wake p95 was 82.36 to 163.29 ms, and Bun warm find p50 was 2.76 to 3.66 ms. The budget
held at those loads; it did not hold in the two heaviest earlier runs.

CPU time per find (below) is the load-independent comparison.

## Warm find (ms)

| run | commit | Bun p50 | Bun p95 | Bun p99 | Node p50 | Node p95 | Node p99 | load before (1, 5, 15 min) | load after |
|---|---|---|---|---|---|---|---|---|---|
| before 1 | `0ed923e` | 252.97 | 1000.48 | 1770.3 | 1205.88 | 3646.8 | 6043.11 | 844.50 923.37 836.62 | 917.86 832.64 263.10 |
| before 2 | `0ed923e` | 348.75 | 991.86 | 1327.89 | 217.19 | 594.83 | 1113.22 | 225.18 323.60 425.75 | 366.49 237.75 253.80 |
| before 3 | `0ed923e` | 398.6 | 1604.58 | 2191.77 | 761.01 | 2279.17 | 3392.95 | 366.49 237.75 253.80 | 391.73 337.08 303.36 |
| after 1 | `0b7e367` | 5.58 | 29.72 | 88.44 | 10.5 | 44.27 | 160.2 | 383.58 281.58 998.42 | 203.90 1000.12 781.63 |
| after 2 | `09681c5` | 6.05 | 131.86 | 248.7 | 57.91 | 314.35 | 544.85 | 343.92 421.21 627.99 | 585.09 585.03 521.76 |
| after 3 | `09681c5` | 6.42 | 102.19 | 148.66 | 18.42 | 130.84 | 220.13 | 585.09 585.03 521.76 | 225.18 323.60 425.75 |
| final 1 | `ff3380e` | 3.66 | 24.88 | 59.47 | 7.17 | 35.42 | 80.55 | 283.10 961.25 946.13 | 245.91 649.50 820.25 |
| final 2 | `ff3380e` | 2.76 | 6.38 | 9.16 | 5.83 | 12.21 | 14.5 | 245.91 649.50 820.25 | 202.88 325.80 591.62 |
| final 3 | `ff3380e` | 3.07 | 8.46 | 14.22 | 6.12 | 27.38 | 92.42 | 202.88 325.80 591.62 | 79.81 175.32 427.10 |

Ticket 09's own record (`docs/eval/bench-2026-10-31.md`, commit `6c62ccc`, no term index, at a
lower load of 33 rising to 205) measured warm find p95 at Bun 407.01 and Node 1850.32.

## Cold find, and wake and brief (ms)

Wake and brief do not read the term index; their rows show what load alone does between runs.

| run | Bun cold find p50 | Bun cold find p95 | Node cold find p50 | Node cold find p95 | Bun warm wake p95 | Bun warm brief p95 | Node warm wake p95 | Node warm brief p95 |
|---|---|---|---|---|---|---|---|---|
| before 1 | 1234.18 | 1653.13 | 593.3 | 1246.99 | 1005.76 | 2811.62 | 1758.24 | 1913.82 |
| before 2 | 210.24 | 627.12 | 1048.97 | 2053.31 | 449.18 | 507.47 | 1500.75 | 1322.43 |
| before 3 | 969.74 | 1422.5 | 781.38 | 1340.78 | 521.45 | 794.82 | 1682.22 | 1747.09 |
| after 1 | 230.96 | 632.01 | 238.72 | 907.68 | 220.76 | 622.11 | 472.22 | 645.01 |
| after 2 | 60.64 | 142.44 | 1757.51 | 4112.63 | 510.53 | 1130.36 | 1551.86 | 2037.3 |
| after 3 | 73.28 | 222.54 | 498.96 | 946.73 | 1014.07 | 2337.73 | 1536.24 | 2085.85 |
| final 1 | 183.18 | 436.93 | 148.56 | 193.56 | 148.45 | 636.68 | 369.36 | 344.96 |
| final 2 | 63.97 | 144.19 | 149.43 | 192.32 | 163.29 | 236.36 | 237.64 | 569.03 |
| final 3 | 54.64 | 71.07 | 152.6 | 219.74 | 82.36 | 219.69 | 225.57 | 226.41 |

## Store

| run | date (UTC) | bytes | build ms | sha256, change counter and migration times zeroed | unchanged by the reads |
|---|---|---|---|---|---|
| before 1 | 2026-10-31T12:18:34.540Z | 16699392 | 17389 | `ce6009e3f2afc760…` | yes |
| before 2 | 2026-10-31T14:14:41.021Z | 16699392 | 23204 | `ce6009e3f2afc760…` | yes |
| before 3 | 2026-10-31T14:50:49.705Z | 16699392 | 48893 | `ce6009e3f2afc760…` | yes |
| after 1 | 2026-10-31T12:27:11.279Z | 30375936 | 53294 | `b36f2cb822e3b1d1…` | yes |
| after 2 | 2026-10-31T13:14:45.903Z | 30375936 | 62786 | `1c652c9303c2f664…` | yes |
| after 3 | 2026-10-31T13:49:38.066Z | 30375936 | 146967 | `1c652c9303c2f664…` | yes |
| final 1 | 2026-10-31T15:53:49.452Z | 30375936 | 34327 | `5fdf7d505ec78f21…` | yes |
| final 2 | 2026-10-31T16:00:39.489Z | 30375936 | 27774 | `5fdf7d505ec78f21…` | yes |
| final 3 | 2026-10-31T16:06:44.077Z | 30375936 | 45961 | `5fdf7d505ec78f21…` | yes |

The index nearly doubles the store (16.7 MB to 30.4 MB) and is written by every `note`. Builds
through `note` took 17 to 49 s before and 28 to 147 s after, at loads of several hundred; ticket
09's record built the store without the index in 12 s at load 33. The write slowdown at equal
load is not measured.

## CPU time per warm find

User plus system CPU time of the process around each `find` (`process.cpuUsage`), on the same
20,000-memory store and the same ten queries, after 20 warm-up calls. Load inflates wall time
far more than CPU time, so these columns compare the code more closely. Measured with a script
that imports the repository's own `bench/eval-latency.ts` store builder and `eval/generate.ts`
corpus; it is not part of the benchmark.

| runtime | version | n | CPU p50 | CPU p95 | CPU mean | wall p50 | wall p95 |
|---|---|---|---|---|---|---|---|
| Bun | before (`0ed923e`) | 100 | 110.81 | 141.42 | 111.19 | 419.92 | 706.4 |
| Bun | after (`0b7e367`) | 500 | 4.6 | 9.9 | 5.17 | 6.32 | 115.81 |
| Bun | after (`3dc7865`, with the merges) | 500 | 4.18 | 9.6 | 4.95 | 5.36 | 123.56 |
| Node | before (`0ed923e`) | 100 | 175.5 | 216.54 | 180.22 | 1063.01 | 2647.39 |
| Node | after (`0b7e367`) | 500 | 8.4 | 17.24 | 10.15 | 72.81 | 631.26 |
| Node | after (`3dc7865`, with the merges) | 500 | 7.88 | 16.79 | 9.73 | 16.47 | 108.36 |
| Bun | final (`ff3380e`) | 500 | 2.66 | 6.74 | 3.48 | 2.93 | 15.35 |
| Node | final (`ff3380e`) | 500 | 5.82 | 12.11 | 7.07 | 6.1 | 18.66 |

The `3dc7865` rows ran during after run 3 (load about 400 to 500), on a store built at that
commit whose zeroed sha256 equals after run 2's. One more single-threaded process beside a load
of several hundred added little to that run's load, but it did add some. CPU p95 per find stays
under 10 ms on Bun and 17 ms on Node, so where a wall-clock p95 above exceeds 50 ms, most of it
was spent off the CPU. The `ff3380e` rows ran after the final runs, at a load of about 80 to 100,
on a store built at that commit whose zeroed sha256 equals theirs; CPU time came out lower there
too, which suggests contention also inflates CPU time somewhat (shared caches and cores), so
these columns compare the code only roughly.

## A long query

The longest query find accepts: 177 distinct corpus words in 997 characters (the 1,000-character
input limit; the plan's 250-term case does not fit). Before, all 177 terms were scored; after,
the cap scores the first 32. Bun only; Node was not measured.

| version | n | CPU p50 | CPU p95 | wall p50 | wall p95 |
|---|---|---|---|---|---|
| before | 5 | 534.66 | 542.15 | 1012.65 | 1640.73 |
| after | 20 | 116.21 | 126.29 | 235.17 | 1158.3 |

It costs more than the benchmark's three-word queries because each of its 32 scored terms has
its own postings to read; the cap is what bounds that cost.
