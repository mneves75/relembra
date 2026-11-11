# Release evidence: 1.0.0-beta.7

One MCP hardening and four landing-page fixes: a JSON-RPC batch that arrives before negotiation is
judged against the next `initialize` the client did not cancel (H-19 from the 1.0.0-beta.6 gate),
and on the site, a repeated save keeps one memory, the erase demo keeps its state across a language
switch, the 320 px header fits inside the content margins, and the ticks and hatches draw the same
in Firefox and WebKit as in Chromium. The library API, the store schemas, the export format and the
CLI's exit codes are unchanged from 1.0.0-beta.6. This record states what was observed; anything not
observed is listed as open. Paths are relative to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.7`, squash of PR #23) | `13a8229a470efe8efeef53e338aab5c56d7d9cc1` |
| Tree | `99b01d92491e56df2716a1917781dcef549a28ce` |
| Measured candidate | `327d9106c34aa4d7ad1e28bc4afd9c5c7639418e`, the PR #23 head, the same tree |
| Input digest (`scripts/evidence.ts`) | `4ca109ed0deb739fdd4d1fa9a88eb51e71fedb4b9afee56f49ac927b4f7dc1a1` |
| Runtimes | Bun 1.4.4 (`2596ac5d3`), Node v26.13.0, SQLite 3.54.0 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed on `327d910`, attempt
`.scratch/release/release-20261111-125245-aAEGR4/`; its `release-check.json` names the manifest and
the benchmark record below.

- Gate manifest sha256 `ac0bab357c4ca41c5dcc0596785380e0d3e281fbffce99dc79e7218cca8857b5`,
  verdict `pass`. Steps (all exit 0): identity, install, lint, typecheck, gitleaks, zizmor, cli,
  tests, node, pack, sbom, eval, identity-after.
- Tests: parallel lane 1663 pass / 21 skip / 0 fail, Postgres lane 162 pass / 0 fail; Node 133
  pass / 0 fail.
- Strict benchmark (`bench/bench-2026-11-11-125514-82ve3g/bench.json`), check passed. Raw
  nearest-rank warm find p95: Bun 4.79 ms, Node 10.10 ms (budget 50 ms, n = 500 each); 1-minute
  load 20.6 before and 94.2 after on 18 cores.
- An earlier attempt on the same candidate, `.scratch/release/release-20261111-105304-qbFsKS/`,
  passed the gate and failed the benchmark (warm find p95 Bun 92.5 ms, Node 143.1 ms) with a
  1-minute load of 228.8 before and 177.4 after, from other sessions' work and this release's own
  verifiers running at the same time. Its p50 was normal (Bun 4.23 ms). It is kept, and is not the
  release's evidence.

## Native builds

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 43069765163 (push to `main`): completed success |
| Hosted CI on the PR #23 head `327d910` | 26 checks success |
| Artifacts | `scripts/deploy.sh hmo --run 43069765163 --release-check .scratch/release/release-20261111-125245-aAEGR4`: each hosted binary checked against its own `relembra.sha256` entry; `bin/relembra` and the retained archive bound to the gate manifest by sha256. The hosted macOS build differed from the gated binary; the release ships the gated one |

## Review and verification

- **Independent verification of the code (GPT-6 via Codex, 7 frozen criteria, on `327d910`):**
  PASS. The new admission test fails with only the `src/cli/mcp.ts` change removed and passes with
  it; cancellation after the batch, several queued initializes and invalid versions were
  challenged; the committed site bundle equals a fresh build; typecheck, lint and 118 focused
  tests pass.
- **Independent verification of the landing page (Claude Fable 5.2, source-blind, Chromium 157,
  Firefox 158 and WebKit 27.2, 5 frozen criteria):** PASS. A repeated save leaves one copy and says
  so in both languages and after a switch; a credential is refused and nothing saved; the erase
  demo's state and message survive a language round trip in 10 action sequences per engine and
  Restart resets it; the header controls run from 20 to 300 px at 320 (100 to 1340 at 1440),
  matching the content edges in every engine; the ruler draws its marks on the same 28-slot grid in
  all three engines; no horizontal scroll, smallest text 14 px, reduced motion honoured, version
  text 1.0.0-beta.7.
- **Security deploy gate (production):** WAIVED (SEC-20) on tree `99b01d92…`, record
  `.scratch/security-gate/327d9106c34aa4d7ad1e28bc4afd9c5c7639418e/production.md` (copied to the
  release commit's folder with `reused_from`). A new full audit for the new tree; H-19 judged fixed.
  Independent acceptance by GPT-6 via Codex took three rounds: rounds 1 and 2 rejected on record
  wording (claims broader than their evidence) with every behavioural check passing, and confirmed
  one pre-existing Low finding, K-2, recorded in the gate's plan; round 3, on the corrected record
  and the unchanged candidate: ACCEPT (WAIVED), 35 of 35 criteria pass.
- **Owner decisions applied (2026-11-11):** SEC-20 waived to 2027-02-28; W-NV1 closed as a
  documented boundary. `src/sqlite` is unchanged since the last gated release.

## Publication (`scripts/deploy.sh prd`)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.7` (annotated, message `v1.0.0-beta.7; security gate: WAIVED SEC-20`) → `13a8229`. GitHub answered the push with the ruleset-bypass notice for restricted tag creation, as before |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.7, published 2026-11-11T17:46:57Z; the draft's assets were checked against `SHA256SUMS` before publication. Downloaded again by hand: `shasum -a 256 -c SHA256SUMS` passed for the macOS and Linux x64 binaries |
| npm | `release.yml` run 43071463112 staged `relembra@1.0.0-beta.7` with tag `beta`, stage id `807f9293-c5ff-4f40-9f64-d6c3f5285f20`, shasum `0ef64f71259e7724e5b028dc509c92344090df11`, integrity `sha512-v0hMD2OSt6W7ASuccVODqxj4gfanQmDUrrloxJXuAwDz93VwmMUbEl1wZ2vqqy3yiVdnfc7Udaz2IYATG1WhZQ==`. Waiting for the owner's approval |
| Pages | run 43071538286; HTTPS 200, the page names 1.0.0-beta.7 6 times. By hand: HTTP → HTTPS 301, `.well-known/security.txt` 200, and the served `index.html`, `assets/site.js`, `assets/site.css` and `assets/relembra.js` are byte-identical to the commit's |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `89d056d9f95cdf36edaa606aa53f7a0bfe479084fc7d32a8292b43f92215aa09` |
| `relembra-linux-x64` | `19d16d3c7fd8354f635f358cfc963f0f60853fb7255dd045c2a04cc1924f2a07` |
| `relembra-linux-arm64` | `d64b279080f886f4ba28be0878ed20eef044b0d26bba80e9d45b3baf71a4e7c1` |
| `relembra-windows-x64.exe` | `3fffdfe0a45882b90bd0702c0f6790222af2b54e581dd53635070070be326c48` |
| `relembra-windows-arm64.exe` | `b18f8846c1e396ec859b925ac77d37e79922fa43824d98f3b88c0dcdcd065f58` |
| `relembra-1.0.0-beta.7.tgz` (the retained gate archive) | `4f28388f5d866c4d4c76bb5e3af50d0fb50e822db0e0a2480fc75b629fdda5c5` |

## Installation

- Mac: the beta.6 binary kept as `.scratch/rollback-beta7/relembra-before-beta7`; `install.sh` from
  the tag installed `~/.local/bin/relembra` with sha256 `89d056d9…`, the gated and released bytes.
  Smoke test in a disposable `HOME`, `RELEMBRA_HOME` and `RELEMBRA_SCOPE`: `init`, `note`,
  `find --json` (1 result), `wake`, `export` (header `"relembra":"1.0.0-beta.7"`) and `check` exit
  0; the store file is mode 0600; a blank note exits 1; `find` without a query exits 2.
- The maintainer's four Linux x64 hosts: the same `install.sh` installed `relembra-linux-x64`
  (`19d16d3c…`) with the hash checked again on each host, the previous binary kept beside it, and
  `relembra --help` run in a home that does not exist.

## Open

- npm: `dist-tags.beta` moves to 1.0.0-beta.7 when the owner approves stage
  `807f9293-c5ff-4f40-9f64-d6c3f5285f20`.
- K-2 (Low, pre-existing, gate plan item P-K2): an import's retract naming a memory id from
  another scope answers `conflict` where an unknown id answers `malformed`, revealing that the id
  exists to a caller who already holds it. For the next release.
- `in srgb` gradient interpolation needs Safari 16.2 or Firefox 127; an older browser drops the
  ruler and hatch backgrounds, and nothing else.
- Not checked: the landing page in the Safari app and with VoiceOver. Safari's WebDriver refused a
  session until "Allow remote automation" is enabled, which needs the owner. WebKit was verified
  through Playwright.
- The short id in the demo's "already saved" message changes after a language switch (the demo's
  store is rebuilt); a trailing space or different capitalisation saves as a separate fact, as the
  library does without normalisation.
