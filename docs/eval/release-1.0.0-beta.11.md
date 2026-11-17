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
| Report-only commits after it | change only `site/index.html`, `CHANGELOG.md`, `docs/eval/` and `docs/agents/notes.md`; AGENTS.md's `git diff --quiet ce98fc8 <ref> -- <inputs>` exits 0 |
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

## Open

- **Hosted CI** on the merge to `main`, and on PR #34's head.
- **Security deploy gate:** not run; required before any publication.
- **Publication** (`scripts/deploy.sh hmo|prd`: tag, GitHub release, npm, Pages): not started; it
  needs the owner's approval. Until then npm `beta` and the live site stay at 1.0.0-beta.10.
- **Waivers** carried from 1.0.0-beta.10: SEC-18 to 2027-01-31; SEC-20 and C9.3-K2 to 2027-02-28.
