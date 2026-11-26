# Release evidence: 1.0.0-beta.13

Security-audit hardening across the CLI, core guard and transfer, SQLite and Postgres stores, and
CI workflow, plus configurable wake budgets on `relembra hook` (`CHANGELOG.md`). The export format,
SQLite and Postgres schemas, and CLI exit codes are unchanged from 1.0.0-beta.12.

This record states what was observed; anything not observed is listed as open. Paths are relative
to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Gated candidate | `9eee8d4e9378c50279ce1830b15a07421445a8ac` (PR #44) |
| Release commit | `7b167ec78825c1043a65faf00971d0bbd0d8a30b` (squash of PR #44), tree `81b915066583008ab3c7ea71e12899ab52b0915c` (identical tree) |
| Input digest (`scripts/evidence.ts`) | `4c4d3e75fec8d57376862c5a9bd78de99631c21aab8ddb85da3858ca53f059ec` |
| PRs included since beta.12 | PR #37 (`0f5a1d4`, hook `--budget` / `RELEMBRA_WAKE_BUDGET`), PR #28 (`8eca0fc`, `zizmor-action` v0.8.1), PR #29 (`237e47a`, Bun/devDeps updates + optional peer `pi-durable` 1.5.2), PR #43 (`c3a7b8b`, security audit run-1 hardening + test pruning) |
| Runtimes | Bun 1.4.6 (`e13b16bc7ed7f69252196cb5c93852d6337fbcba`, SQLite 3.54.0), Node v26.13.1 (SQLite 3.54.1) |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed on `9eee8d4` (attempt `.scratch/release/release-20261126-171216-PTXSDy/`):
- **Gate manifest:** sha256 `57bf9f96e8d00d6afd200907dcb76cb96b2d4aa611750234cbf8b20cda10ae44`,
  verdict `pass`, all 13 steps exited 0 (99s).
- **Tests:**
  - parallel lane: 1757 pass, 22 skip, 0 fail (93 files, 26018 expects);
  - Postgres lane (`postgres:17.11`): 175 pass, 0 fail (10 files);
  - Node: 139 pass, 0 fail (3 suites).
- **Eval:** release gates passed (40/40, 0 leaks across find/brief/wake, 0 misses).
- **Strict benchmark:** passed. Raw nearest-rank warm find p95 was Bun 3.04 ms (`3.0434 ms`) and
  Node 6.68 ms (`6.6818 ms`), against a 50 ms budget, with n = 500 each. Load averages were 4.61 to
  8.09 on 18 cores.
- **Artifacts:** `bin/relembra` sha256
  `e432257d3b8105634a78f2b76e366c71521374d1481674c35eec1a13058e7554` (42,979,058 bytes); retained
  archive `relembra-1.0.0-beta.13.tgz` sha256
  `b750247177c30fd48e621a19f35f605184008f75493cfde0770b9a633df2c45c` (62 files).

## Review and verification

- **Independent different-model verification (`mneves-verify`, Codex `gpt-6.2-sol`, fresh read-only
  context):** two rounds on PR #43 surfaced edge cases in bare-repo preflight (`objects` symlink,
  decoy `.git`), `mainCheckout` trailing spaces, compound-token scanning, atomic Postgres catalog
  ownership checks before reading `schema_version`, and isolated regression tests; all addressed and
  re-gated before merge.
- **Hosted CI on PR #43 (`c3a7b8b`) and PR #44 (`9eee8d4`):** 26/26 checks green across Linux
  x64/arm64, macOS arm64, Windows x64/arm64, Node 24.16/26, Postgres, CodeQL, zizmor, gitleaks,
  SBOM, and eval.

## Native builds

| Item | Observed |
|---|---|
| Release commit | `7b167ec78825c1043a65faf00971d0bbd0d8a30b` (squash of PR #44), tree `81b915066583008ab3c7ea71e12899ab52b0915c` |
| Hosted CI on the release commit | run `45896255983` (push to `main`): completed success (`pi-durable (latest, informational)` skipped on push per `if: github.event_name != 'push'`) |
| Artifacts | `scripts/deploy.sh hmo --run 45896255983 --release-check .scratch/release/release-20261126-171216-PTXSDy` verified every hosted binary against its `relembra.sha256` entry and bound `bin/relembra` and the retained archive to the gate manifest by sha256. The hosted macOS arm64 build (pinned Bun `1.4.4`) differed from the locally gated binary (host Bun `1.4.6`); per `docs/RELEASE.md`, the release ships the locally gated binary (`e432257d…`) |

## Security deploy gate (production)

- **Verdict:** WAIVED (`SEC-20`, `SEC-18`, `C9.3-K2`) on tree `81b91506…`, open blockers 0.
- Full security audit of the 39-file delta from `45c34bb`, with unchanged files carried from the
  prior gated record. Fresh `bun audit --json` returned `{}`; `gitleaks` scanned all 54 commits plus
  `src`, `site`, and `docs` with 0 leaks (synthetic token positive control exited 1); `zizmor
  v1.31.1` returned 0 findings (2 suppressed); `site/assets/relembra.js` had 0 DOM/eval sinks.
- **Independent acceptance (Codex `gpt-6.2-sol`, fresh read-only context, different model from
  builder/finder):** `ACCEPT (WAIVED)` across all six frozen criteria (C1–C6), confirming zero new
  Critical or High defects. Private gate record copied to `7b167ec78825c1043a65faf00971d0bbd0d8a30b`
  (`reused_from: 9eee8d4e9378c50279ce1830b15a07421445a8ac`) on identical tree `81b91506…`.

## Publication (`scripts/deploy.sh prd`, approved by the owner for this release)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.13` (annotated, message `v1.0.0-beta.13; security gate: WAIVED SEC-20 SEC-18 C9.3-K2`) -> `7b167ec`. GitHub answered the push with the ruleset-bypass notice for restricted tag creation |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.13, published 2026-11-26T21:20:10Z, prerelease, immutable, 7 assets verified against `SHA256SUMS` before and after publication |
| npm | `release.yml` run `45897414356` staged `relembra@1.0.0-beta.13` with tag `beta`, stage id `c50c2448-cbec-46b6-a7a0-eb9dc8236f80`, shasum `3fdae760ed11d7303be2d2d94aec3607de50f817`, integrity `sha512-XxXvSvsf4l6U5O76Y0spcuWQ5s3w8aFnzm29FxOwMki5X8yPkSDp1M03WeZBkT0x0RifAwrFTFKIStMIAVAvbg==`. Waiting for the owner's 2FA approval |
| Pages | run `45897475481`; https://mneves75.github.io/relembra/ answered HTTP 200 naming `1.0.0-beta.13` 6 times; separate live `curl -I` confirmed HTTP 301 -> HTTPS 200 and project-path `.well-known/security.txt` HTTP 200 |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (locally gated binary) | `e432257d3b8105634a78f2b76e366c71521374d1481674c35eec1a13058e7554` |
| `relembra-linux-x64` | `a8ac7e043eea7c8370c84d4511d80c4120575f4cd0b836b524929939310245a2` |
| `relembra-linux-arm64` | `0d85060d5bda39eec56c8bf04afb2b31c34bdb6545ed97f214c78d6ca1f7bc90` |
| `relembra-windows-x64.exe` | `5c4e673e605b5862fdebca492dceb820479b121db2aae9687e48420f33f7a77b` |
| `relembra-windows-arm64.exe` | `1354d16656f5d0608b4fe10b4cd27cee997d9509c8b26b1e7a58644f48f242d1` |
| `relembra-1.0.0-beta.13.tgz` (the retained gate archive) | `b750247177c30fd48e621a19f35f605184008f75493cfde0770b9a633df2c45c` |

## Installation

- **Maintainer's Mac (macOS arm64):** upgraded via `sh install.sh` from the published GitHub release
  assets with `SHA256SUMS` verification (`e432257d…`, rollback binary backed up with sha256
  `79a6adc2…`, `relembra --version` -> `relembra 1.0.0-beta.13`); verified in a disposable `0700`
  store (`init`, `note`, `find`, `wake`, `export` header `"relembra":"1.0.0-beta.13"`, `check`
  `integrity:"ok"`, plus blank exit 1, synthetic credential exit 1, and unknown-flag exit 2).
- **Installed CLI benchmark (`bun bench/cli.ts --size 20000 --seed 20261031 --runs 50`, load 48–81
  on 18 cores):** `help` p95 21.68 ms, `find` p95 31.29 ms, `wake` p95 50.59 ms, `hook` p95
  60.84 ms, `wakeGit` p95 95.17 ms, `hookGit` p95 93.31 ms, `libraryFind` p95 4.54 ms (p50 1.46 ms).

## Open

- **npm:** `dist-tags.beta` moves to `1.0.0-beta.13` when the owner approves stage
  `c50c2448-cbec-46b6-a7a0-eb9dc8236f80`.
- **Waivers:** `SEC-18` to `2027-01-31`; `SEC-20` and `C9.3-K2` to `2027-02-28`.
- **Follow-ups recorded in private security gate:** `K-35` (`mainCheckout` synchronous read on
  non-regular `.git`/`commondir` files) and Windows canonical `.GIT` component casing in
  `mainCheckout`; macOS inherited ACLs on `0600` stores and Windows pre-created existing store ACLs
  remain `needs-validation`.
