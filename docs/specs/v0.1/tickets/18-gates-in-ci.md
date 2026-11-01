# 18: Release gates in CI

**What to build:** CI enforces the v0.1 release gates on the synthetic set.

**Blocked by:** 09, 11

**Status:** merged into `feat/v0.3` (0.3.0); configured only (hosted runs are blocked by account billing)

- [x] CI runs the eval on the synthetic set and fails on any leak, scope denial below 100%, empty retrieval, or hit@5 below the pinned floor
- [x] The sealed real-question set stays local; personal data never enters the repository

The `eval` job runs `bun run eval`, which exits 1 unless `gate()` (eval/score.ts) passes for
relembra on both stores: leaks 0, scope denial 1, hit@5 and wake coverage at least 0.9 (an empty
retrieval fails both, and the empty control candidate must fail), no failed request. A control
candidate that passes fails the run too. `test/eval-sealed.test.ts` checks that git ignores
`eval/sealed/` (with a positive control) and that nothing there is tracked.

Also in this ticket: the configured `bun` job could never pass (the Postgres tests need
`RELEMBRA_POSTGRES_URL`, and under `CI` the CLI tests build a binary that stable Bun refuses);
it is split into a canary `cli` build and stable Bun test jobs with a Postgres service on Linux.
