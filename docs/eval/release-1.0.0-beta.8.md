# Release evidence: 1.0.0-beta.8

A pass over the repository's comments and the fixes from a second full read of the project: Windows
stores under non-ASCII paths, an export a duplicate owned scope made unrestorable, Postgres schema
names that are reserved words, `recordExposure`'s retry error, the WAL page-size branch, the
in-memory store's `erasures()` order, MCP text for the global scope, a sealed eval set that stopped
the release gate, benchmark queries that were all pt-BR, and test controls that could not fail. The
export format, the SQLite schema and the CLI's exit codes are unchanged from 1.0.0-beta.7. This
record states what was observed; anything not observed is listed as open. Paths are relative to the
checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.8`, squash of PR #25) | `e813db79a902af4df4763b58d711e49676ffaf64` |
| Tree | `029c0a810d197fb2a8296f0c84306a1df34275d2` |
| Measured candidate | `b78d06b88ae3050c211f55ae8b1fef17718ce008`, the PR #25 head, the same tree |
| Input digest (`scripts/evidence.ts`) | `f6c7dae4caefd3b95f7411696ebeb8b6140428dbf916bdf2619b6e504d6b22cf` |
| Runtimes | Bun 1.4.5 (`b6e7b9cdc`), Node v26.13.0, SQLite 3.54.0 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed on `b78d06b`, attempt
`.scratch/release/release-20261114-064759-7z5O2P/`; its `release-check.json` names the manifest and
the benchmark record below.

- Gate manifest sha256 `96f1621c46d01a1c77ee656136c863ba70688b6b8b04b58e44ae440707a47c79`,
  verdict `pass`. Steps (all exit 0): identity, install, lint, typecheck, gitleaks, zizmor, cli,
  tests, node, pack, sbom, eval, identity-after.
- Tests: parallel lane 1688 pass / 22 skip / 0 fail, Postgres lane 169 pass / 0 fail; Node 137
  pass / 0 fail.
- Strict benchmark (`bench/bench-2026-11-14-065050-cqcWDd/bench.json`), check passed. Raw
  nearest-rank warm find p95: Bun 6.56 ms, Node 23.03 ms (budget 50 ms, n = 500 each); 1-minute
  load 26.8 before and 47.3 after on 18 cores. The ten queries now alternate pt-BR and English, so
  this p95 is not comparable one to one with earlier records.
- An earlier `scripts/ci.sh` run on `9e9e1e8` (before the last two commits) also passed; it is not
  the release's evidence.

## Native builds

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 43586323049 (push to `main`): completed success |
| Hosted CI on the PR #25 head `b78d06b` | 26 checks success |
| Artifacts | `scripts/deploy.sh hmo --run 43586323049 --release-check .scratch/release/release-20261114-064759-7z5O2P`: each hosted binary checked against its own `relembra.sha256` entry; `bin/relembra` and the retained archive bound to the gate manifest by sha256. The hosted macOS build differed from the gated binary; the release ships the gated one |

## Review and verification

- **Windows control:** the non-ASCII store fix has no local Windows proof, so a throwaway branch
  with only that fix reverted ran hosted CI (run 43577610766): the test "a store under a folder
  named with an accent is created private and opens" failed on `windows-latest` and
  `windows-11-arm`, the only failure in each Windows job, and passes on the candidate's runs. The
  branch was deleted.
- **Independent review (Claude Opus 5.5 `reviewer`, fresh context, on `9e9e1e8`):** PASS with one
  Low finding, fixed in `b71595b`: rendering a wake lazily had stopped refusing a memory with
  out-of-bounds metadata past the budget. A second observation (concurrent first opens of a new
  Postgres schema through one shared Bun SQL pool fail with a duplicate-key error) reproduces on
  1.0.0-beta.7 as well; it is open below.
- **Independent verification of the code (GPT-6 via Codex, 6 frozen criteria, on `b71595b`):**
  round 1 BLOCKED with no failure (its sandbox denied a terminal to the 11 pseudo-terminal tests,
  and Windows cannot run there); round 2, fresh and full, without that sandbox and reading the
  hosted Windows runs: PASS. Each fix's test fails with the fix reverted and passes with it; the
  pseudo-terminal tests ran and passed; public export keys and type names are unchanged; wake
  output, promote fingerprints and OptMem ids match 1.0.0-beta.7's.
- **Security deploy gate (production):** WAIVED (SEC-20, SEC-18, SEC-11/W-1) on tree `029c0a81…`.
  A new full audit (Claude Opus 5.5) of tree `c39de09c…` (`b71595b`); `b78d06b` differs from it
  only by one CHANGELOG line, which the gate's finder asked for: the beta.8 section had overstated
  how the old Windows behaviour failed. Independent acceptance by GPT-6 via Codex: round 1 rejected
  on the record (a search claim broader than the search, and two launch controls answered too
  generously: SEC-18 and the Windows part of SEC-11); after the record was corrected and the owner
  named waivers, round 2: ACCEPT (WAIVED). No Critical or High finding; K-2 stays Low.
- **Owner decisions applied (2026-11-14):** SEC-18 and SEC-11/W-1 waived to 2027-01-31; SEC-20
  carried to 2027-02-28; W-NV1 stays a closed, documented boundary.

## Publication (`scripts/deploy.sh prd`)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.8` (annotated, message `v1.0.0-beta.8; security gate: WAIVED SEC-20 SEC-18 SEC-11/W-1`) → `e813db7`. GitHub answered the push with the ruleset-bypass notice for restricted tag creation, as before |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.8, published 2026-11-14T16:21:31Z; the draft's assets were checked against `SHA256SUMS` before publication. Downloaded again by hand: `shasum -a 256 -c SHA256SUMS` passed for the macOS binary and the archive, and the macOS binary's `--help` ran in a disposable `HOME` |
| npm | `release.yml` run 43615171621 staged `relembra@1.0.0-beta.8` with tag `beta`, stage id `6bb3852d-b9ac-495d-8093-44808504db7c`, shasum `cd9277ef4d994e12de0660bd5e446395ff0c5f5a`, integrity `sha512-dUrmaruEMvYs7+Jxea4jLARXGZP+Knb3ezBPcPlIiHKYMUk3/CVoEQqY3shilW9WLEEcJWYKD6AL+YiVUNT4+w==`. Waiting for the owner's approval |
| Pages | run 43615216032; HTTPS 200, the page names 1.0.0-beta.8 6 times |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `d257cdf97820fc242989a1e8ed6f476f58f7cdc90c3b9fbf9743633a4850aa0f` |
| `relembra-linux-x64` | `aea70547af051e9e8ec70798dc5121dfad66d301b2e7e7d73b5e5740e1507fb7` |
| `relembra-linux-arm64` | `2a21ff8525f5d4cd81d6359a679c8ca4915f36d5cad11918830f946ea62bb5aa` |
| `relembra-windows-x64.exe` | `b71199c5995b7f3b901fcf0c8a5b4c9cea522f5b7687aec018a1dba947d502c4` |
| `relembra-windows-arm64.exe` | `c55986d320e362c751eafa19ed890c6407768c288082479e1c344cfd1dae52ce` |
| `relembra-1.0.0-beta.8.tgz` (the retained gate archive) | `bb6a5803b8a304c428e9dc695bec901f7633836e2c421bdebbf9af6f45beb2a0` |

## Open

- npm: `dist-tags.beta` moves to 1.0.0-beta.8 when the owner approves stage
  `6bb3852d-b9ac-495d-8093-44808504db7c`.
- Waived to 2027-01-31: SEC-18 (gate plan item P-18) and SEC-11/W-1 (P-W1-check, then P-W1).
- K-2 (Low, pre-existing, gate plan item P-K2), unchanged from 1.0.0-beta.7.
- Concurrent first opens of a new Postgres schema through one shared Bun SQL pool can fail with a
  duplicate-key error (reproduced on 1.0.0-beta.7 and 1.0.0-beta.8; one pool per opener does not
  fail). Cause not yet found.
- Not installed by this release run: the Mac and the maintainer's Linux hosts are still on the
  binary they had.
