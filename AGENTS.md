# relembra: agent instructions

TypeScript memory core for AI agents. Design: `docs/ARCHITECTURE.md`. Vocabulary: `GLOSSARY.md`.

## Rules

- Public repository, MIT licence. Never commit secrets, personal memory content, transcripts,
  real user queries, local paths, or the names of private clients, deployments or people. Run
  `gitleaks git` before every push.
- Clean room: no code copied from other projects. In particular, never open OptMem's `memo`
  source (it has no licence). The tokenizer and ranking are written from
  `docs/specs/ranking-algorithm.md`.
- The implementation plan is `docs/specs/IMPLEMENTATION-PLAN.md`. Where a ticket and the plan
  disagree, the plan wins until the ticket is updated.
- Zero runtime dependencies in the library. Optional peer dependencies only (pi-durable).
- The library runs on Node (≥ 24.14) and Bun (≥ 1.4). The CLI is a Bun AOT binary. Use only APIs both
  runtimes provide (for example `node:sqlite`).
- Test-first. Every negative result needs a positive control.
- Work on a branch, never commit to `main`; merging is the owner's.

## Checks

A fresh checkout starts with `scripts/init.sh`: it confirms the tools and versions below, runs
`bun install --frozen-lockfile` (which enables the pre-push hook) and `bun run build:cli`;
`scripts/init.sh --check` only reports.

Hosted CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request.
Local runs are the release evidence. Before a merge, run the whole gate:

```sh
scripts/ci.sh      # install, lint, typecheck, gitleaks, zizmor, CLI build, every test with Postgres
                   # and the binary, Node, pack (Node and Bun consumers), SBOM, eval; independent
                   # steps at once, a timed summary at the end
```

The gate runs on the committed candidate: uncommitted inputs, and inherited runtime overrides or
skips (`BUN_OPTIONS`, `NODE_OPTIONS`, `RELEMBRA_SKIP_BUILD_TOOLCHAIN`, …), stop it. Each attempt
writes `.scratch/ci/<attempt>/manifest.json` (every required step's exit code, the candidate's
identity before and after, the tested binary's and tarball's sha256) and keeps the tarball. A
release adds the strict benchmark on the same candidate, after the gate:

```sh
scripts/check-release.sh   # scripts/ci.sh, then bun bench/eval-latency.ts --check, one candidate
                           # throughout; prints the kept manifest, benchmark record and tarball
```

Run it as a script (or `npm run check:release`), not through `bun run`: Bun acts on `BUN_OPTIONS`
before any script starts.

Local evidence covers only this machine's platform and the actual Bun/Node executables recorded.
Hosted CI adds Linux x64/arm64, macOS arm64 and Windows x64/arm64 jobs, Node 24.14/26 jobs on Linux
and Windows, and an informational pi-durable@latest probe; local runs do not attest those cells.
Keep the shared checks aligned; local release acceptance additionally requires candidate/artifact
provenance and strict latency acceptance. The main steps, one by one:

```sh
bun run build:cli                        # the CLI tests run bin/relembra
scripts/with-postgres.sh env RELEMBRA_REQUIRE_BINARY=1 bun run test:all
                                         # Postgres files in series, the rest in parallel workers;
                                         # without the variable, a missing binary skips the CLI tests
bun run test:node
bun run typecheck && bun run lint
bun run eval                             # rewrites docs/eval/results-*; commit them only at a release
```

`bun install` enables the pre-push hook (`prepare` sets `core.hooksPath` to `.githooks`). It runs gitleaks,
lint, typecheck and the tests the change can affect (`bun test --changed=origin/main`, without
Postgres), so a docs-only push takes seconds.

`scripts/with-postgres.sh` starts a throwaway `postgres:17.11` container, pinned by digest as in
the workflow (Docker, tmpfs, no volume), sets `RELEMBRA_POSTGRES_URL`, runs the command and
removes the container. Without that variable the Postgres tests fail; `RELEMBRA_SKIP_POSTGRES=1`
skips them on purpose, and a merge needs a run with them.

A release's pack step checks package contents and installs the same retained `.tgz` in Node and
Bun consumers; do not repack for publication. The gate manifest records before/after hashes of
that archive and the tested binary, and actual exits for every required step; preserve failed
attempts and logs too. `--check` accepts only raw nearest-rank warm find p95 <=50 ms on both
runtimes, pinned corpus/sampling, stable clean identity, deterministic rebuild and read integrity.
Cold latency is diagnostic. See [docs/RELEASE.md](docs/RELEASE.md) for paths and delivery checks.
Publication runs through `scripts/deploy.sh hmo|prd` ([docs/RELEASE.md](docs/RELEASE.md#publication)).

Commit release eval reports only when preparing a release. The gate and strict benchmark must
name the same committed candidate. If report-only commits follow, compare every relevant input
with the final release ref, not just `bun.lock`. `scripts/evidence.ts` is the
authoritative input list (including the Node runtime loader under `test/`):

```sh
git diff --quiet <evidence-commit> <release-ref> -- \
  src eval bench build scripts test examples .github .githooks \
  package.json bun.lock bunfig.toml .npmrc .nvmrc .node-version \
  tsconfig.json tsconfig.build.json biome.json .gitattributes .gitignore .gitleaksignore .gitleaks.toml \
  install.sh README.md LICENSE docs/FORMAT.md docs/CLI.md ':!eval/out'
```

Generated output (`.scratch`, `docs/eval`, `eval/out`, `bin`, `dist`, `node_modules`) and local
sealed eval sets (`eval/sealed`) are excluded from input identity; generated output is not excluded
from artifact verification. Any changed relevant input requires a new
gate and benchmark; bind the final candidate, evidence and release asset hashes explicitly.

## Agent skills

### Issue tracker

Local markdown under `docs/specs/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repository root. See `docs/agents/domain.md`.

### Landing page

`PRODUCT.md` (who the product is for and what it does) and `DESIGN.md` (the shipped design system:
tokens, type, the tick motif, components) at the repository root govern `site/`. Read both before
changing the page; `test/site.test.ts` holds its invariants.

### Working notes

`docs/agents/notes.md` records what worked and what did not in this repository's tooling and
releases, so a later session does not learn it again. Read it at the start of a task; add a dated
entry when you learn something the next session needs. It carries no secrets, local paths, private
names or session identifiers.
