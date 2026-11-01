# Release evidence: 1.0.0-beta.1

The first public release. This record states what was observed; anything not observed is listed
as open. Paths are relative to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (public root, tag `v1.0.0-beta.1`) | `2b56945d53621d095c2c4390ce94d1f8815d90b8` |
| Tree | `24a45a0fa1559438149aadd422e14e9949964da4` |
| Measured candidate | `bb97c98ca39fc1dd29d727ca6ea3c0d10c1504e1` on the pre-release branch, the same tree; the public history starts at the root commit, which carries that tree with no parent |
| Input digest (`scripts/evidence.ts`) | `34e4b9dfcdba0eb4bfac586b7860b9073c838a3db00c0948cd8dfe5a9cc8e264`, identical before and after |
| Runtimes | Bun 1.4.4 (`da867c60`, SQLite 3.54.0), Node v26.12.1 (SQLite 3.54.0) |
| Machine | Apple M5 Pro, 18 cores, 64 GiB, macOS 27.2 arm64 |

## Local acceptance

`scripts/check-release.sh` passed, attempt `.scratch/release/release-20261101-143610-kEQpss/`.

- Gate manifest sha256 `2f4118e1c4ad7544020008644dd4db8823d506210052f9d8228e3dcaba34cadc`,
  verdict `pass`, complete, no failures. Steps (exit, seconds): identity 0, install 0, lint 0,
  typecheck 0, gitleaks 0, zizmor 0, cli 0, tests 0 (205 s), node 0, pack 0, sbom 0, eval 0,
  identity-after 0.
- Strict benchmark `bench.json` sha256
  `47114376b190a4187daf1c650c208bcf7caaeaf51066b1392ad9d7249173e8d1`, check passed. Raw
  nearest-rank warm find p95: Bun 5.23 ms, Node 7.88 ms (budget 50 ms, n = 500 each). The machine
  was loaded (1-minute load 10.5 before, 20.0 after).

## Review and security gate

- Independent code review (GPT-6.1 Sol, `autoreview --max-priority P3`) of the release branch:
  two findings, a top-level npm `tag` the publish check missed (P2) and the integrity comparison's
  missing `sha512-` prefix (P3); both fixed, the fix re-reviewed scoped-clean.
- Security deploy gate (mneves-security, production): WAIVED on tree `24a45a0f…`, independent
  acceptance by GPT-6.1 Sol in three rounds (REJECT, REJECT, ACCEPT (WAIVED)). Open findings: 0.
  Owner waivers to 2026-11-30: SEC-17 (the GitHub side publishes with a long-lived `gh` token;
  remedy: npm trusted publishing and a fine-grained Pages token) and SEC-20 (`security.txt` is
  served under the project path, not the host root; remedy: a host-root file or a custom domain).

## Publication

| Step | Observed |
|---|---|
| Public repository | `mneves75/relembra`, one root commit on `main`; the pre-release history is in the private, archived `mneves75/relembra-archive` |
| Repository settings | private vulnerability reporting enabled (`GET` → `{"enabled": true}`), Dependabot alerts and security updates, secret scanning with push protection, CodeQL default setup, immutable releases; rulesets on `main` (pull request, linear history, 11 required checks) and on `v*` tags |
| Hosted CI on the release commit | run 41338742429: 12 jobs; `bun (ubuntu-latest, postgres)` failed once on a timing-dependent eval fixture and passed on rerun; every other job passed the first time |
| Tag | `v1.0.0-beta.1` (annotated) → `2b56945` |
| GitHub release | prerelease, immutable; assets `relembra-darwin-arm64` sha256 `22b1d5950cec127b4bf8acb9e0f9baa198013adba334e16cf2db5d2ddf0cdf7c`, `relembra-1.0.0-beta.1.tgz` sha256 `4c0baab08145a63589d6e5aa07fe20bc104accad7a6c44ff6a59d3d224a6ce4c`, `SHA256SUMS`; GitHub's own asset digests equal these, and a fresh download passed `shasum -a 256 -c SHA256SUMS` |
| Pages | `https://mneves75.github.io/relembra/` built from `gh-pages` (published by `scripts/site/publish.sh` from the root commit); HTTP → HTTPS 301; CSP served; footer states 1.0.0-beta.1; `.well-known/security.txt` 200; video, poster and bundle 200. In a browser, pt-BR and English in light and dark: the erase demo renders, the video plays, no horizontal overflow at the default viewport or at 390 px, no console errors |
| npm | open: needs the owner's two-factor authentication (see below) |

## Mac installation

- Backup of the previous binary kept with its sha256
  `5cf636b8ae2e2ee709dfc8820bb39f872b34d0803f630800b020e0e5eae0864e` (0.4.0).
- `sh install.sh relembra-darwin-arm64 SHA256SUMS` from the downloaded release assets, with the
  tag's `install.sh`: exit 0; installed sha256 `22b1d595…cdf7c` equals the release checksum and the
  tested binary.
- In a disposable `RELEMBRA_HOME` and `RELEMBRA_SCOPE`, `RELEMBRA_GLOBAL_SCOPE` unset, never the
  live store: init, help, note, find (returns the note), wake (carries it), export (header
  `relembra: "1.0.0-beta.1"`), check all exit 0; a blank, a multi-line and a 400-byte note are
  refused by the guard (`blank`, `multi-line`, `too-long`); an unknown command exits 2.
- `bun bench/cli.ts --binary ~/.local/bin/relembra --size 20000 --seed 20261031 --runs 50` (the
  installed bytes, sha256 above), under heavy contention (1-minute load 25–29 on 18 cores):
  library find p95 8.59 ms; CLI find p50 27.43 ms, p95 276.1 ms; help p95 21.12 ms; hook p95
  80.27 ms. Diagnostic only: not comparable with the 0.4.0 figure taken on an idle machine.

## Open

- npm publication of the retained archive, then `npm view relembra@1.0.0-beta.1 dist.integrity`
  against its SRI value and `npm view relembra dist-tags`.
- The archived repository still serves its old page at `/relembra-archive/` (the API refused to
  turn Pages off); it can be unpublished in the repository's Pages settings.
- The waiver remedies above, by 2026-11-30.
