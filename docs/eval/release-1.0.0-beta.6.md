# Release evidence: 1.0.0-beta.6

Fixes from a full read of the repository, a rebuilt landing page and a smaller npm package: one
new CLI refusal code (`summary-supersede`), an ill-formed memory id refused as `invalid-argument`,
`zoom` no longer hiding store failures, the store opened by reading its 20-byte header, `--help`
with one line per command, `relembra mcp`'s initialize-based negotiation released for the first
time, and `dist/cli/` gone from the package. The store schemas and the export format are unchanged
from 1.0.0-beta.5. This record states what was observed; anything not observed is listed as open.
Paths are relative to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.6`, squash of PR #20) | `9a654c1fd483ce01aacba41a29de452f22ac21d9` |
| Tree | `3b63c6cd468176f667ca7bd81b8ba1315aae5e6f` |
| Measured candidate | `9393d33aa7dca561d2ef3047ced3a994b68b7101`, the PR #20 head, the same tree |
| Input digest (`scripts/evidence.ts`) | `a702c1b56ea5c9da6c19d99f90961ab08131c176ddf2788168a4aa0cdc834e03` |
| Runtimes | Bun 1.4.4 (`2596ac5d3`), Node v26.13.0, SQLite 3.54.0 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed on `9393d33`, attempt
`.scratch/release/release-20261111-000908-vtUim4/`; its `release-check.json` names the manifest and
the benchmark record below. An earlier attempt on a superseded candidate (`c89cd91`, before the
last MCP fix) also passed and is not the release's evidence.

- Gate manifest sha256 `fdcfda068848f337d04f18254e52227d7629afb53146c7e1998430a0206629f0`,
  verdict `pass`, complete. Steps (all exit 0): identity, install, lint, typecheck, gitleaks,
  zizmor, cli, tests, node, pack, sbom, eval, identity-after.
- Tests: parallel lane 1658 pass / 21 skip / 0 fail, Postgres lane 162 pass / 0 fail; Node 133
  pass / 0 fail.
- Strict benchmark (`bench/bench-2026-11-11-001332-nA7NWa/bench.json`), check passed. Raw
  nearest-rank warm find p95: Bun 6.09 ms, Node 16.06 ms (budget 50 ms, n = 500 each), 1-minute
  load 66.9 before and 54.9 after on 18 cores (other sessions' work on the machine).

## Native builds

Each platform's binary was built on its own runner by the Bun pinned in `build/bun-toolchain.txt`.

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 42955841915 (push to `main`): completed success on its second attempt, 22 of 22 jobs success. The first attempt failed in `cli binary (windows-latest)` at the pinned-Bun download (`curl: (35) Recv failure: Connection was reset` from the npm registry), which left the dependent `bun` lanes skipped; only the failed and skipped jobs were re-run |
| Artifacts | `scripts/deploy.sh hmo --run 42955841915 --release-check .scratch/release/release-20261111-000908-vtUim4`: each hosted binary checked against its own `relembra.sha256` entry and copied under its release name; `bin/relembra` and the retained archive bound to the gate manifest by sha256. The hosted macOS build differed from the gated binary; the release ships the gated one |
| Hosted CI on the PR #20 head `9393d33` | run 42951334312, 26 checks success |
| Hosted CI on the superseded head `c89cd91` | run 42950165370: `bun (windows-latest)` failed once on `bun run eval > the suite runs every candidate…` after 28 s; every other check passed, and the same lane passed on `9393d33` and on `main` |

## Review and verification

- **Independent review of the five CLI and library fixes (PR #19, included here):** a fresh
  reviewer wrote 15 tests from the requirements and found no defect.
- **Independent verification of the code, CLI, package and tooling (GPT-6.1 Sol, 13 frozen
  criteria, on `c9bdf9c`):** 11 pass by running the real binary and suites. Two were reported
  failed for reasons of the verifier's layout, not the code: a package consumer installed inside
  the checkout resolved the optional peer from the checkout's own `node_modules`, and a scratch
  clone inside the tree gave the linter a second root. A second run with scratch outside the
  checkout passed the package criterion and lint; its sandbox had no terminal, so the eleven
  pseudo-terminal tests failed there with `no-tty` after passing in the first run. No single
  independent run was green end to end; the gate above and hosted CI are the complete runs.
- **Independent verification of the landing page (a fresh source-blind verifier driving the page
  in a browser, 14 frozen criteria):** first run 13 pass, 1 fail (a long unbroken string in the
  scope demo's search field made the page scroll sideways on phones); after one correction, a full
  second run passed all 14 (heights 6,038 / 5,988 px at 1440x900 and 9,402 / 9,401 px at 390x844,
  no horizontal scroll in 191 states per width and language, smallest text 14 px, hostile input
  rendered as text, reduced motion honoured).
- **Security deploy gate (production):** WAIVED on tree `3b63c6cd…`, record
  `.scratch/security-gate/9393d33aa7dca561d2ef3047ced3a994b68b7101/production.md` (copied to the
  release commit's folder with `reused_from`). The audit covered everything since the last gated
  tree, including the MCP negotiation that reached `main` after 1.0.0-beta.5 and the site rewrite.
  Independent acceptance by GPT-6.1 Sol took three rounds: round 1 rejected on two claims, one a
  misstatement in the record (an ill-formed id exits 2, as documented, not 1) and one a real
  finding, IA-1 (Low), fixed before the merge in `16239d9` and `9393d33` with tests; round 2
  found every security criterion passing and rejected on one overstated sentence about those
  tests; round 3, on the corrected sentence and the unchanged candidate: ACCEPT (WAIVED), all
  eight criteria pass. One Low residual, H-19, is recorded in the gate's plan.
- **Owner waivers, to 2026-11-30, carried unchanged:** SEC-20; W-NV1 (historical ancestor
  handles). The delta touches none of the code they cover.

## Publication (`scripts/deploy.sh prd`)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.6` (annotated, message `v1.0.0-beta.6; security gate: WAIVED SEC-20 W-NV1`) → `9a654c1`; no tag of that name existed before. GitHub answered the push with the ruleset-bypass notice for restricted tag creation, as for beta.5 |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.6, immutable prerelease published 2026-11-11T04:08:35Z with 7 assets; the draft's assets were downloaded and checked against `SHA256SUMS` before publication, the published ones after. Downloaded again by hand into an empty directory: `shasum -a 256 -c SHA256SUMS` passed for all six files and `SHA256SUMS` is byte-identical to the plan's |
| npm | `release.yml` run 42957286663 staged `relembra@1.0.0-beta.6` with tag `beta`, stage id `7f29c566-c9d8-4da1-966a-414b86a87982`, shasum `86fab8b8ade4589a8c7d1b069710d831e400d19b` (equal to the archive's sha1), integrity `sha512-xA/N54mRtoXE0zrrApjiVVMPBa4hUKW6hZu5bxmj/odyMOMm86yv62CmtnmIGahoo8LuYOi4G/NHihJKZRIIqA==`. Approved by the owner on 2026-11-11: `npm view relembra@1.0.0-beta.6 dist.integrity` and `dist.shasum` equal these values (62 files), and `dist-tags.beta` names 1.0.0-beta.6 |
| Pages | run 42957334531 (`workflow_dispatch`, from `main` = `9a654c1`); HTTPS 200, the page names 1.0.0-beta.6 6 times (whole-version match). By hand: HTTP → HTTPS 301, `.well-known/security.txt` 200, the video answers a range request with 206, and the served `index.html` and `assets/site.js` are byte-identical to the commit's. In a browser at 1440x900 and 390x844: 6,038 and 9,401 px tall, no horizontal scroll, both fonts loaded, a pasted credential refused as `credential` with the save button unavailable, a saved fact shown in the session wake |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `796a0e5acff5c3f422b3e5d97cf3a0c7f7bc09537f9070a4f7cf0c273875453a` |
| `relembra-linux-x64` | `1d8efcc68c9fd5aeb1709958efae8d105c43292a8b0b74167005acc5f8bbc1e3` |
| `relembra-linux-arm64` | `d9c71a61caa59e3a76fcb8627a36d69c54d496f976718d893cfdeca46886f234` |
| `relembra-windows-x64.exe` | `256e09d5f3ad6ac8db19c1e26182980934c613c6929cca9ba3eb4ecb88fc0c7b` |
| `relembra-windows-arm64.exe` | `b71fc88fef5067b0cbf1161b3e2afd9aac97f5de4cbfaa9904883a81e1333a1a` |
| `relembra-1.0.0-beta.6.tgz` (the retained gate archive) | `700c49e7777b2d07d99b6a817023595a691139e7832db10285b753c96167766e` |
| `SHA256SUMS` | `5f833e38da53d36ef6a2db990f2f5b3baa9575ce84647ee8cf0c53a8bcc38961` |

## Mac installation

Done on 2026-11-11 after the owner's go, per `docs/RELEASE.md`:

- Rollback: the installed beta.5 binary (`ea8e79b2e2a12fc0426534780da152b17ce8b94f41183f26b618695fd652ac5b`)
  kept as `.scratch/rollback-beta6/relembra-before-beta6` with its sha256 beside it.
- `sh install.sh relembra-darwin-arm64 SHA256SUMS` from the `main` checkout (`install.sh` identical
  to the tag's), on the assets downloaded again above, installed `~/.local/bin/relembra` with
  sha256 `796a0e5acff5c3f422b3e5d97cf3a0c7f7bc09537f9070a4f7cf0c273875453a`, the gated and released
  bytes.
- Smoke test in a disposable `HOME`, `RELEMBRA_HOME` and `RELEMBRA_SCOPE`, with an otherwise empty
  environment: `init`, `--help` (the Commands table), `note`, `find --json` (1 result), `wake`,
  `summarize`, `export` (header `"relembra":"1.0.0-beta.6"`) and `check` exit 0; the store file is
  mode 0600; `supersede` on the summary exits 1 with `summary-supersede`; a blank note, a
  300-character note and a credential-shaped note exit 1; `find` without a query exits 2; `zoom`
  of a missing id exits 1. Over `relembra mcp`: an initialize for 2025-06-18 negotiates it, and
  `retract` with a lone-surrogate id returns the tool refusal
  `invalid-argument (memory-id:ill-formed)`.

## Open

- SEC-20 and W-NV1, as this release shipped them, expire 2026-11-30. Decided by the owner on
  2026-11-11, for the next gate: W-NV1 closed as a documented boundary, SEC-20 renewed to
  2027-02-28.
- npm's `latest` still names 1.0.0-beta.1, since a prerelease never takes `latest`. On
  2026-11-11 the owner deprecated 1.0.0-beta.1 to 1.0.0-beta.5 ("Superseded by a newer beta.
  Install relembra@beta") and `0.0.0-stage` ("Placeholder. Install relembra@beta"), so a bare
  install of `latest` now warns and points at the `beta` tag; read back with
  `npm view relembra@<version> deprecated`.
- H-19 (Low) from the gate's plan, for the next release.
- `bun (windows-latest)`: `bun run eval > the suite runs every candidate…` failed once on a
  superseded commit after 28 s and passed on the next two runs; if it recurs, give it a
  Windows-only limit as the two store-building tests now have.
- Not checked: Safari, Firefox and a real screen reader on the landing page; the page was
  verified in Chrome and through the accessibility tree.
- This run of `deploy.sh`: `hmo` and `prd` ran end to end with no refusal. The one manual step
  was re-running the failed hosted build job before `hmo`. `prd` read GitHub's clock itself for
  the first time.
