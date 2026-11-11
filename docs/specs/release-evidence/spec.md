# Trustworthy performance evidence and verified release

Status: historical. Its 0.4.0 prerelease was private, and this repository does not carry that
history (`docs/eval/release-0.4.0.md` included); release evidence is now
`docs/eval/release-<version>.md`.

## Implementation contract

Source intent: owner-approved execution plan, 2026-10-31. Base:
`938f7bc54de905271494186659204ab63a6d0244`. Work branch: `fix/release-evidence`.

Make performance and release claims verifiable, fix reproduced defects, and optimize only
current measured bottlenecks without weakening quality, isolation, security or durability.
Deliver a private GitHub prerelease (target 0.4.0) and install those verified released bytes
on this Mac. Skip staging, hosted CI, public npm, frontend and live-memory migrations.

Preserve public library/CLI behavior, ranking, storage/schema and runtime compatibility;
keep zero library runtime dependencies. Do not touch sibling repositories, shell config,
credentials, hooks or live memory stores. Use synthetic fixtures/disposable stores only.

## Release preparation checkpoint

The bounded version/docs unit prepares 0.4.0 on 2026-11-01, including the existing unreleased
global-scope capability. It preserves `private: true`, zero library runtime dependencies and
CLAUDE.md's `@AGENTS.md` pointer; the lockfile has no root package version to bump. It performs
focused version/export checks, typecheck and lint, then commits explicit owned paths. No agents,
full gate, pinned benchmark, merge, tag, publication, installation or live-memory access run in
this unit. The parent owns integration, independent review/security and final acceptance.

The candidate remains prepared, not published or installed. Final measured evidence belongs in
`docs/eval/release-0.4.0.md` once available; no passing figures are assumed. See
[the release procedure](../../RELEASE.md) for the actual serial command, unique attempt paths,
input/runtime identity, package/asset binding, private native Mac target and rollback. Historical
reports stay unchanged, and contended baseline timings support no optimization/savings claim.

## Acceptance

- Record unchanged-base library timing: 20,000 memories, seed 20261030, 50 warm-ups,
  500 warm measurements, 30 fresh-process measurements; CLI: size 20,000, seed 20261031,
  50 measured calls. Record every attempt and load; run timings without concurrent gates.
- Add explicit `bench/eval-latency.ts --check`. Exploratory runs stay informational.
  Strict mode requires pinned corpus, sufficient sampling, both complete runtimes, finite
  nonnegative timings, deterministic rebuild, read integrity, stable available clean input
  identity and warm find p95 <=50 ms on both runtimes. Diagnostics survive failures.
- Retain raw timing samples and unique attempt directories. Separate acceptance logic from
  timing so deterministic planted values prove all rejection paths.
- Compare the budget against raw nearest-rank p95; rounding for display must never make an
  over-budget value pass. Reject inherited skip controls in the required gate. Bind release
  binary/package hashes to the artifacts actually tested, and reproduce cached-build corruption
  before fixing any demonstrated cache-identity defect.
- Capture source/runtime/corpus identity before measurements and compare afterward. Cover
  src, eval, bench, build, scripts, package metadata, lockfile, runtime configuration and Node
  resolver; reject relevant untracked/dirty/mutated inputs, exclude generated output.
  Gate identity also includes all tests, TypeScript/lint configuration, workflows and scanner
  rules; a changed verifier invalidates its result. Publish one preserved package tarball
  exercised by both Node and Bun consumers, with its before/after test hash recorded.
- `scripts/ci.sh` must fail on repository-entry errors, failed/missing/killed/skipped required
  steps and unstable inputs. Emit a candidate-bound manifest of all required steps and actual
  exit codes. Add one documented serial local gate + strict benchmark command; no hosted CI.
- Test-first controls: passing budget; either runtime over budget; wrong corpus/samples;
  missing/nonfinite results; failed integrity; exploratory small runs; mutation versus generated
  output; untracked source; failed Git/runtime discovery; failed/missing/killed gate steps;
  separate attempts. Every negative has a positive control. Never lower a threshold.
- Audit scope/trust/provenance/egress/erasure/import-export/replay/concurrency/fencing/package
  contents/secrets; reproduce findings before narrowly fixing them. Keep ranking oracle.
- Complete local `scripts/ci.sh`: Postgres, binary, Node, package consumers, SBOM, evaluation.
  Eval: zero leaks/label violations/superseded results/failed requests, complete scope denial,
  hit@5 and wake coverage >=0.9. Exercise affected flows with valid and invalid inputs.
- Independent Standards and Spec review on fixed diff, adversarial challenge, security deploy
  gate on exact final tree, fresh independent verification. Preserve failed evidence.
- Recheck tags, bump version constants/package/changelog/README/operational/agent docs; keep
  CLAUDE.md as pointer. Small verified commits, gitleaks before push, hooks enabled.
- Merge after acceptance; revalidate final commit identity. Annotated v0.4.0 tag and private
  prerelease with native tested Mac binary/checksum, package and sanitized evidence only.
- Back up installed executable + hash, download release and verify checksum, install with
  existing checksum-verifying installer, compare installed bytes. Disposable RELEMBRA_HOME:
  help, representative CLI, export-version, invalid inputs; benchmark installed executable.
  Restore backup if installation acceptance fails. Never access the live memory database.
- Restore visible main; remove only task-owned temporary resources and merged branch. Preserve
  security records, cited evidence and rollback artifact through acceptance.

## Design choice

Use small deterministic checks around existing benchmark and gate entry points. A generic
release framework or memory-engine rewrite adds maintenance without a demonstrated need.
Pure acceptance checks plus real subprocess integration controls provide reliable failures
without fragile wall-clock test assertions. Keep source/build identity separate from generated
reports so evidence can be committed without invalidating the code it measures.

## Ordered implementation and delivery

1. Recheck `git ls-remote origin refs/heads/main` and tags; require a clean base and no
   unintegrated remote change. Record runtime revisions and existing dependencies/artifacts.
2. Run `bun bench/eval-latency.ts --memories 20000 --seed 20261030 --warmup 50 --warm 500
   --cold 30` with task-specific `--out`/`--work`. Build the unchanged CLI, then run
   `bun bench/cli.ts --size 20000 --seed 20261031 --runs 50`. Preserve exit codes, load and
   every attempt; no tests/builds overlap timing.
3. Add one failing acceptance control at a time in benchmark/gate tests, run it red, then
   implement the smallest correction. Capture red/green logs under ignored task evidence.
4. Implement input identity shared by benchmark/gate, with clean/mutated/untracked/generated
   controls. Add complete step manifest and serial release-check entry point.
5. Reproduce artifact cache corruption and any product-boundary findings before fixing them;
   retain positive controls, ranking equivalence and original product contracts.
6. Prepare 0.4.0 version/docs, then pass `bun run typecheck`, `bun run lint` and focused tests.
   Commit explicit paths; run `gitleaks git --no-banner --redact` before working-branch push.
7. Collect optional `cccc` evidence; run independent Standards and Spec axes on the fixed
   nonempty diff from the base. Reproduce supported findings, correct and reverify once.
8. Run `scripts/check-release.sh` directly (or `npm run check:release`, never through `bun run`)
   on committed clean inputs: the full `scripts/ci.sh` finishes before the strict pinned
   benchmark starts. The wrapper rechecks its raw verdict and gate/benchmark/final identity.
   Retain the unique `.scratch/release/release-<time>-<suffix>/` with `gate/manifest.json`,
   step commands/logs/exits, one Node+Bun-tested package archive and raw `bench/bench-*/bench.json`.
   Missing proof or a changed relevant input blocks release and requires a new attempt.
9. Inspect eval verdicts, every required exit, read/rebuild integrity, source/runtime identity,
   raw nearest-rank warm find p95 <=50 ms on both runtimes, binary/package before/after hashes
   and all failure logs. Record candidate SHA/input digest and evidence hashes. Compare baseline
   and candidate only within recorded load limits; claim no unmeasured performance savings.
10. Run the full exact-tree security deploy gate and fresh independent verification against
    this contract, including real disposable CLI positive/invalid-input controls.
11. Recheck origin/tags, merge only after acceptance, verify unchanged measured inputs and
    tested artifact hashes at merged main using all inputs in `scripts/evidence.ts`, including
    bench/scripts/tests/Node loader/config/package inputs (AGENTS.md's comparison). Annotate
    v0.4.0 with security verdict; publish the private prerelease's tested `relembra-darwin-arm64`,
    matching `SHA256SUMS` and retained `relembra-0.4.0.tgz`. Bind final candidate/evidence/asset
    hashes and verify downloaded bytes. Skip staging/beta suffix and hosted workflow dispatch.
12. Back up the installed executable, use `install.sh` for the authorized Mac target, verify
    installed bytes, disposable-store export metadata (no `--version` flag) and installed
    benchmark. Clear the inherited global scope; never open `~/.relembra`. Restore backup on
    failure; otherwise retain release/security evidence and clean only task-owned resources.
