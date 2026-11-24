# Release evidence: 1.0.0-beta.12

Repository-wide hardening across the core library, SQLite and Postgres adapters, CLI, MCP server,
`pi-durable` integration, and release/CI tooling (`CHANGELOG.md`). The export format, SQLite and
Postgres schemas, and CLI exit codes are unchanged from 1.0.0-beta.11.

This record states what was observed; anything not observed is listed as open. Paths are relative
to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Gated candidate | `43faf7fbbf2b867284a47ab95dc1b366baa197ed` (PR #41) |
| Release commit | `45c34bb9b5e3b3dd01935c349247ed6fc54f904d` (squash of PR #41), tree `cb254a50ae1b3d83f8b04bef61d917e6ff77df56` (identical tree) |
| Input digest (`scripts/evidence.ts`) | `54ea9e91a25d8e6c680fb89e3b9f8b7f859ed70cc63bac8ba30db6f8b968887c` |
| Hardening PRs included | PR #38 (`bf090d9`, core/guard/transfer/OptMem), PR #40 (`88f8352`, release/CI/site scripts), PR #39 (`e0b50a3`, SQLite/Postgres/CLI/MCP/`pi-durable`) |
| Runtimes | Bun 1.4.4 (`da867c60b`, pinned `1.4.4-canary.20261029.1`, SQLite 3.54.0), Node v26.13.1 (SQLite 3.54.1) |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed on `43faf7f` (attempt `.scratch/release/release-20261124-032039-U8P8Y0/`):
- **Gate manifest:** sha256 `e1c292891fb5db5a27f9035a02a03351a16f5a742cae813de67c7a1ca307b39c`,
  verdict `pass`, all 13 steps exited 0.
- **Tests:**
  - parallel lane: 1754 pass, 23 skip, 0 fail (93 files);
  - Postgres lane (`postgres:17.11`): 174 pass, 0 fail (10 files);
  - Node: 139 pass, 0 fail.
- **Eval:** release gates passed (40/40, 0 leaks across find/brief/wake); every negative control
  failed, as it must.
- **Strict benchmark:** passed. Raw nearest-rank warm find p95 was Bun 6.13 ms and Node 10.18 ms,
  against a 50 ms budget, with n = 500 each. Load averages were 63 to 78 on 18 cores.
- **Artifacts:** `bin/relembra` sha256
  `584ded9706e91412340e832be74f4952dda9d3594acfcc851e60ab07e532ec26`; retained archive
  `relembra-1.0.0-beta.12.tgz` sha256
  `7da8280917f2da42bc1395c09a8460c96a867f822eee809dfbb7941251a4e48c` (62 files).

## Review and verification

- **Adversarial hardening reviews (GPT-6.2 Astra via Codex, fresh read-only context, high effort):**
  two full rounds across PRs #38, #39, and #40 surfaced 11 defects in round 1 plus micro-edge-cases
  in round 2; all fixed with regression tests before merge.
- **Hosted CI on PR #41 (`43faf7f`):** `ci` run `45339702113` and `CodeQL` run `45339696765`
  completed success (26/26 checks across Linux x64/arm64, macOS arm64, Windows x64/arm64, Node
  24.16/26, Postgres, zizmor, gitleaks, SBOM, and eval).

## Native builds

| Item | Observed |
|---|---|
| Release commit | `45c34bb9b5e3b3dd01935c349247ed6fc54f904d` (squash of PR #41), tree `cb254a50ae1b3d83f8b04bef61d917e6ff77df56` |
| Hosted CI on the release commit | run `45376677003` (push to `main`): completed success |
| Artifacts | `scripts/deploy.sh hmo --run 45376677003 --release-check .scratch/release/release-20261124-032039-U8P8Y0` verified every hosted binary against its `relembra.sha256` entry and bound `bin/relembra` and the retained archive to the gate manifest by sha256. The hosted macOS arm64 build was byte-identical to the locally gated binary (`584ded97…`) |

## Security deploy gate (production)

- **Verdict:** WAIVED (SEC-20, SEC-18, C9.3-K2) on tree `cb254a50…`, open blockers 0.
- Full security audit of the 74-file delta from `84b9245`, with unchanged files carried from the
  prior gated record. Fresh `bun audit --json` returned `{}`; `gitleaks` scanned all 52 commits,
  the 6-commit delta, `src`, `site`, `docs`, and the unpacked tarball with 0 leaks (positive
  control exited 1); `zizmor v1.31.1` returned 0 findings (2 suppressed).
- **Independent acceptance (GPT-6.2 Astra via Codex, high effort, fresh read-only context,
  different model from the finder):** `ACCEPT (WAIVED)` across all six frozen criteria (C1–C6),
  confirming zero new Critical/High defects. Earlier attempts caught audit-record wording
  imprecisions only, all corrected in the private gate record without modifying the candidate.

## Publication (`scripts/deploy.sh prd`, approved by the owner for this commit)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.12` (annotated, message `v1.0.0-beta.12; security gate: WAIVED SEC-20 SEC-18 C9.3-K2`) → `45c34bb`. GitHub answered the push with the ruleset-bypass notice for restricted tag creation, as before |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.12, published 2026-11-24T10:48:31Z, prerelease, immutable (`immutable: true`), 7 assets, checked again after publishing |
| npm | `release.yml` run `45378272209` staged `relembra@1.0.0-beta.12` with tag `beta`, stage id `12043bcf-dcb6-4c12-80e7-5091c48e0b3d`, shasum `72f6f2fce00f7967c9e944e9f9dc85ac823bb2cf`, integrity `sha512-7rj1anxkSBiCi1MFIJSKanyPMFzaLuM5I9dAR/hVFoerHHriCdiW3gONfELWsD8iFUyR6bkj3g7gMTNoDbi9Vw==`. Waiting for the owner's 2FA approval |
| Pages | run `45378346955`; https://mneves75.github.io/relembra/ answered HTTP 200 naming `1.0.0-beta.12` 6 times; separate live `curl -I` confirmed HTTP 301 → HTTPS 200 and project-path `.well-known/security.txt` 200 |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (hosted & gated binary, byte-identical) | `584ded9706e91412340e832be74f4952dda9d3594acfcc851e60ab07e532ec26` |
| `relembra-linux-x64` | `6bfa8ab694030b2f6feb88c71079b8f1fcb6ca7b0495d1b29bcd9781b5521a42` |
| `relembra-linux-arm64` | `cd204b06bdde5b86b469b7eff3c797191fbe38fe636b1ee2790b9ec5fd3a91d3` |
| `relembra-windows-x64.exe` | `00db7990143d0be90ce4c5fff633d43d2d83a4208069e705cab4358c2148d120` |
| `relembra-windows-arm64.exe` | `d15f98a133964e18080713afc98df256e927f00944e40a5cc6b5c519e2a84ae9` |
| `relembra-1.0.0-beta.12.tgz` (the retained gate archive) | `7da8280917f2da42bc1395c09a8460c96a867f822eee809dfbb7941251a4e48c` |

## Installation

- **Maintainer's Mac (macOS arm64):** upgraded from `1.0.0-beta.11` via `sh install.sh` with
  `SHA256SUMS` verification (`584ded97…`, `relembra --version` → `relembra 1.0.0-beta.12`);
  verified in a disposable `0700` store (`init`, `note`, `find`, `wake`, `export`, `check`, plus
  blank/secret/malformed negative controls).
- **Maintainer's Linux x64 hosts:** installed/upgraded via `sh install.sh` with `SHA256SUMS`
  verification (`6bfa8ab6…`, `relembra 1.0.0-beta.12`) and disposable `0700` `init`/`note`/`check`
  smoke tests.

## Open

- **npm:** `dist-tags.beta` moves to `1.0.0-beta.12` when the owner approves stage
  `12043bcf-dcb6-4c12-80e7-5091c48e0b3d`.
- **Waivers:** SEC-18 to `2027-01-31`; SEC-20 and C9.3-K2 to `2027-02-28`.
- **Coverage note:** supersede replay on a redacted target when the caller lacks pin rights reads
  scope event history to check the historical pin flag; large-scope memory/latency was not
  benchmarked.
