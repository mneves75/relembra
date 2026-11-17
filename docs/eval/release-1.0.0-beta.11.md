# Release evidence: 1.0.0-beta.11

A documentation release. The library, the CLI, the export format and the SQLite and Postgres
schemas are unchanged from 1.0.0-beta.10; `src` differs only in `RELEMBRA_VERSION`. It corrects
docs the code no longer matched and adds a latency record (`CHANGELOG.md`).

This record states what was observed; anything not observed is listed as open. Paths are relative
to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Gated candidate | `ce98fc8afa280b2193e9dbf77d2393f44155a2b5` (PR #34) |
| Input digest (`scripts/evidence.ts`) | `148a781233457d4cbea089e942b08cabcdae5e2b2709482b93b43d437b2bd6e6` |
| Report-only commits after it | change only `CHANGELOG.md`, `docs/eval/release-1.0.0-beta.11.md` and `site/index.html`; AGENTS.md's `git diff --quiet ce98fc8 <ref> -- <inputs>` exits 0 |
| Runtimes | Bun 1.4.5 (`237bba51e`), Node v26.13.0, SQLite 3.54.0 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed on `ce98fc8` (attempt `.scratch/release/release-20261117-114848-QBJzH6/`):
- **Gate manifest:** sha256 `7b455babf96ccbb822740cd42f40d64582ec88be2c21cdf2092f6a33dcdd930d`,
  verdict `pass`, all 13 steps exited 0.
- **Tests:**
  - parallel lane: 1714 pass, 23 skip, 0 fail;
  - Postgres lane: 170 pass, 0 fail;
  - Node: 137 pass, 0 fail.
- **Eval:** release gates passed; every negative control failed, as it must.
- **Strict benchmark:** passed. Raw nearest-rank warm find p95 was Bun 5.92 ms and Node 11.35 ms,
  against a 50 ms budget, with n = 500 each. Load averages were 22 to 30 on 18 cores.
- **Artifacts:** `bin/relembra` sha256
  `b2b32e6791c1654128432fb9b953d5b2f15a1fb5f6b13959512da5fba10766fc`; retained archive
  `relembra-1.0.0-beta.11.tgz` sha256
  `81ccf811d0d9fefc1a84dad1a98ee14352b77ab2850b69c12b739f714945b932`.

An earlier strict run on 1.0.0-beta.10's inputs, the same day, is
`docs/eval/bench-2026-11-17-v1.0.0-beta.10.md` (Bun 5.04 ms, Node 20.59 ms, load 24 to 48).

## Review and verification

- **Docs against code:** a read-only audit of every doc against `src`, `scripts` and the
  workflows; each correction checked at its cited source line.
- **Independent verification (`mneves-verify`, fresh context, same model; not high-risk):**
  1. PASS with 4 findings (a Homebrew Bun path in the bench JSON, a half-updated `CLI.md` row, the
     site's MCP row, a CHANGELOG clause), all fixed in `366d4d9`.
  2. Reverify FAIL on one finding (the CHANGELOG lacked the site's MCP row) plus two wording nits,
     all fixed in `6e6fa44`, before the version bump.

## Native builds

| Item | Observed |
|---|---|
| Release commit | `84b9245` (squash of PR #34), tree `d2c3bb68912dee03741ae57317c5d04dec684ec3` |
| Hosted CI on the release commit | run 44112871209 (push to `main`): completed success |
| Hosted CI on the PR #34 head | 26 checks success |
| Artifacts | `scripts/deploy.sh hmo --run 44112871209 --release-check .scratch/release/release-20261117-114848-QBJzH6` checked each hosted binary against its own `relembra.sha256` entry and bound `bin/relembra` and the retained archive to the gate manifest by sha256. The hosted macOS build differed from the gated binary, so the release ships the gated one. The first attempt stopped on an HTTP 502 from GitHub's jobs API; the retry passed |

## Security deploy gate (production)

- **Verdict:** WAIVED (SEC-20, SEC-18, C9.3-K2) on tree `d2c3bb68…`, open blockers 0.
- It reuses the 1.0.0-beta.10 record, plus the delta from `050f5f2`, read in full: in `src` and
  the site bundle only the version constant changes; the rest is docs, site copy and eval reports.
  `gitleaks git` over the two new commits found no leaks.
- **Independent acceptance (GPT-6.1 Sol via Codex, a different model from the finder):** ACCEPT
  (WAIVED) on the first attempt.

## Publication (`scripts/deploy.sh prd`, approved by the owner for this commit)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.11` (annotated, message `v1.0.0-beta.11; security gate: WAIVED SEC-20 SEC-18 C9.3-K2`) → `84b9245`. GitHub answered the push with the ruleset-bypass notice for restricted tag creation, as before |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.11, published 2026-11-17T17:09:00Z, prerelease, immutable, 7 assets, checked again after publishing. The macOS binary's `--version` printed `relembra 1.0.0-beta.11` |
| npm | `release.yml` run 44133760813 staged `relembra@1.0.0-beta.11` with tag `beta`, stage id `d7d75ea5-b7c9-4c11-b902-5b78b84f17fe`, shasum `7b446a71a7d9868ac0d73c39c04a25fc40882913`, integrity `sha512-0KvFdTgKuqFC+Ch2R7WW5Ct7sXy3yhLYW8boS5JMOEoyO4X98O03dJbmLlH+FPk8quhcO5EUIqWoZxgNLA8yYw==`. Waiting for the owner's approval |
| Pages | run 44133862620; HTTPS 200, the page names 1.0.0-beta.11 6 times |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `b2b32e6791c1654128432fb9b953d5b2f15a1fb5f6b13959512da5fba10766fc` |
| `relembra-linux-x64` | `b6f87994792ae79b5cd4641335b0b5153a6903c720dfd527ad3389038762d5e4` |
| `relembra-linux-arm64` | `7bd10f575254e93f5256e93b430a141091d1e1db489035bd2a58fe604dc40f3a` |
| `relembra-windows-x64.exe` | `f43cac1aa81aa8ef786ad02f9fa140a3fdcfc864952e59c4480464807b3eac0d` |
| `relembra-windows-arm64.exe` | `40f1b12d35e2b36de9d885f9f02cf29cc23e859f64b840fd06ca7b6e841f1eb1` |
| `relembra-1.0.0-beta.11.tgz` (the retained gate archive) | `81ccf811d0d9fefc1a84dad1a98ee14352b77ab2850b69c12b739f714945b932` |

## Open

- **npm:** `dist-tags.beta` moves to 1.0.0-beta.11 when the owner approves stage
  `d7d75ea5-b7c9-4c11-b902-5b78b84f17fe`.
- **Waivers:** SEC-18 to 2027-01-31; SEC-20 and C9.3-K2 to 2027-02-28.
- **Not installed:** the Mac and the maintainer's Linux hosts are still on the binary they had.
