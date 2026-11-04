# Release evidence: 1.0.0-beta.5

Release tooling only: `scripts/deploy.sh` (hmo, prd), `scripts/init.sh`, the `release-check.json`
marker written by `scripts/check-release.sh`, and `docs/agents/notes.md`. The library, the CLI, the
store schemas and the export format are unchanged from 1.0.0-beta.4; the binaries and the archive
differ from beta.4's only in the version string. This record states what was observed; anything
not observed is listed as open. Paths are relative to the checkout that ran the release check.
This is the first release published through `scripts/deploy.sh` itself.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.5`, squash of PR #14) | `f2e502cbdcc5c6862ddb8cc29ec15e15ea94666f` |
| Tree | `db4d1c921d95ce9de0f4c15dd5fcd34da7ac6e87` |
| Measured candidate | `b116a51aeff94861ed7f8769f27debd8afbaf35d`, the PR #14 head (the version bump on `main` `60dea1f`, PR #13 squashed), the same tree |
| Input digest (`scripts/evidence.ts`) | `22919ae4aedb6cf5dabd80114dca78700276053b621c6eb8bd858180505f35e6` |
| Runtimes | Bun 1.4.4 (`da867c60b`), Node v26.12.1, SQLite 3.54.0 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed on `b116a51`, attempt `.scratch/release/release-20261104-092435-EONdlv/`
(gate 209 s); its `release-check.json` names the manifest and the benchmark record below.

- Gate manifest sha256 `c47b267082e4f62e94e78279a43167f5611bc432f22adfc70b973415ee7a2844`,
  verdict `pass`, complete, no failures. Steps (all exit 0): identity, install, lint, typecheck,
  gitleaks, zizmor, cli, tests, node, pack, sbom, eval, identity-after.
- Tests: parallel lane 1609 pass / 21 skip / 0 fail (the 79 tooling tests included), Postgres lane
  162 pass / 0 fail; Node 132 pass / 0 fail.
- Strict benchmark (`bench/bench-2026-11-04-092804-xI3PTe/bench.json`), check passed. Raw
  nearest-rank warm find p95: Bun 4.98 ms, Node 15.01 ms (budget 50 ms, n = 500 each), 1-minute
  load 37.7 before and 18.7 after on 18 cores (other sessions' work on the machine).

## Native builds

Each platform's binary was built on its own runner by the Bun pinned in `build/bun-toolchain.txt`
(revision `1.4.4-canary.1+da867c60b`).

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 41830234425 (push to `main`): completed success, 22 of 22 jobs success |
| Artifacts | `scripts/deploy.sh hmo --run 41830234425 --release-check .scratch/release/release-20261104-092435-EONdlv`: each hosted binary checked against its own `relembra.sha256` entry, copied under its release name; `bin/relembra` and the retained archive bound to the gate manifest by sha256; the hosted macOS build was byte-identical to the gated binary |
| Hosted CI on the PR #14 head `b116a51` | run 41828971880, `ci` success, 26 checks |
| Hosted CI on PR #13's final head `9089e6f` (the tooling) | run 41827274513, 26 checks SUCCESS; earlier branch runs had the hosted `bun` lanes red for test-portability reasons, fixed in `0db2c88` and `9089e6f` |

## Review and security gate

- **Independent code review of the tooling (PR #13):** Opus `reviewer` agent, 8 findings (fixed
  in `a93123b`); GPT-6.1 Sol `autoreview` rounds 2, 3 and 4: 4, 2 and 1 P2 findings (fixed in
  `e836927`, `477d855`, `20c9b65`). Every fix carries a test (`test/deploy-contract.test.ts`).
- **Security deploy gate (production):** WAIVED on tree `db4d1c92…`, record
  `.scratch/security-gate/b116a51aeff94861ed7f8769f27debd8afbaf35d/production.md` (copied to the
  release commit's folder with `reused_from`). Independent acceptance by GPT-6.1 Sol:
  ACCEPT (WAIVED), all six criteria PASS, manifest/CLI/archive hashes recomputed, `scripts/evidence.ts --expect` exit 0 on 243 inputs (`independent-acceptance.md` in the record folder). Findings in the delta: none confirmed open; G-1 (hosted-runner binaries) and
  G-6 (clock skew, measured at 1 s on 2026-11-04) needs-validation; G-3/G-4 were the review
  findings, fixed before merge.
- **Owner waivers, to 2026-11-30, carried unchanged:** SEC-20; W-NV1 narrowed to (b′) historical
  ancestor handles. The delta touches none of the code they cover.

## Publication (`scripts/deploy.sh prd`)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.5` (annotated, message `v1.0.0-beta.5; security gate: WAIVED SEC-20 W-NV1`) → `f2e502c`; no tag of that name existed before (`hmo` and `prd` both checked origin and the checkout). GitHub answered the push with "Bypassed rule violations for refs/tags/v1.0.0-beta.5: Cannot create ref due to creations being restricted": the branch ruleset restricts tag creation and the owner's role bypasses it |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.5, immutable prerelease published 2026-11-04T12:44:27Z with 7 assets; the draft's assets were downloaded and checked against `SHA256SUMS` before publication, the published ones after; GitHub's asset sizes match the plan's |
| npm | `release.yml` run 41831878878 staged `relembra@1.0.0-beta.5` with tag `beta`, stage id `08ae360a-bc56-4136-bd2e-880bafd2105d`, shasum `e536808edfb08f5108597681753d02fc0dd0f611` (equal to the archive's sha1), integrity `sha512-zIEI0szF3fm4RimWd/dLz4UlS/oqTFivp6HfPe2TdDz+KF/XqxI7Wh+Yah/x/uSsOW1G7JtpiSe4pZeVr/LRnA==` (computed locally from the archive; the log abbreviates it). Owner approval pending |
| Pages | run 41831945928 (`workflow_dispatch`, from `main` = `f2e502c`, `origin/main` re-read right before the dispatch); HTTPS 200, the page names 1.0.0-beta.5 4 times (whole-version match); by hand: HTTP → HTTPS 301, `.well-known/security.txt` 200 |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `ea8e79b2e2a12fc0426534780da152b17ce8b94f41183f26b618695fd652ac5b` |
| `relembra-linux-x64` | `3c77e8e830d138d6d8c8d397742ee4930a7a05ba52554ec75d5ebdc7774a9c25` |
| `relembra-linux-arm64` | `ebd16d4ac3b1f32ef6b6045aa9178508bb8345d278cba6aba53fbc9559ebc3e7` |
| `relembra-windows-x64.exe` | `9e1ce934cbde186a4a0f9c78fb37b72340e3ef30acb141e6a5670e50fbc1d4f1` |
| `relembra-windows-arm64.exe` | `1fe430931013ffc2950e9bc2c2ead48a998226550dc32db608f27a8fd0655c64` |
| `relembra-1.0.0-beta.5.tgz` (the retained gate archive) | `b1f4c8f171aa0688ff7c3a9567c97ef97378fd868256b17ac8350640f98b35be` |
| `SHA256SUMS` | `27e2b24ebc90f89e145a26e8a7af12fc8515fc3f535ecb0acdf071ad3c712006` |

## Mac installation

Not performed in this release run: installing to `~/.local/bin` is a write outside the repository and the release request did not name this Mac. When wanted, from a checkout of the tag: keep the current binary as a rollback copy, then `sh install.sh relembra-darwin-arm64 SHA256SUMS` with the published assets, and the smoke test and benchmark of `docs/RELEASE.md`.

## Open

- `npm stage approve` for the beta.5 stage (owner, 2FA), after `npm stage view` and
  `npm stage download` (its sha256 must equal the archive's above); then
  `npm view relembra@1.0.0-beta.5 dist.integrity` must equal the SRI in `published.json` and
  `dist-tags.beta` must point at 1.0.0-beta.5. The beta.2, beta.3 and beta.4 stages are still
  pending the same approval.
- SEC-20 and W-NV1 expire 2026-11-30: renew, remedy or close as documented boundaries.
- First-contact notes from this `deploy.sh` run: `hmo` and `prd` ran end to end on the first real use with no refusal and no manual step; `prd` took about 4 minutes, most of it waiting for `release.yml` and `pages.yml`. Real `gh` output matched what the tests modeled (`run list` fields, draft download, log lines). The one message the tests did not model is GitHub's ruleset bypass notice on the tag push, above. The machine's clock was 1 s from GitHub's..
