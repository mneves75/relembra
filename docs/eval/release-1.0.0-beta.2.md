# Release evidence: 1.0.0-beta.2

The CLI for Linux and Windows. This record states what was observed; anything not observed is
listed as open. Paths are relative to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.2`, squash of PR #5) | `54fd154b65adaffe55f36242a07537f2d1a96ec5` |
| Tree | `e7b8b403d9b3e3672473359d2511dd3d3622f0fb` |
| Measured candidate | `b9ff48d0d51e9fe49101a44bca32fd490accfeb3`, the PR head, the same tree; `main` (`8fc9f98`) was its ancestor, so the squash kept the tree |
| Input digest (`scripts/evidence.ts`) | `2ea1ee7d94781a12c6ae741b1fdeb138b267cd91daf568f7a07a6373cd83ed3b`, identical before and after |
| Runtimes | Bun 1.4.4-canary.1 (`da867c60b`), Node v26.12.1 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.2 arm64 |

## Local acceptance

`scripts/check-release.sh` passed, attempt `.scratch/release/release-20261102-043054-uy8Rat/`.

- Gate manifest sha256 `43c27646d6d9a3bf96b907ce056e5c67fe2a4dd3664cbe35ae8436a76c083b29`,
  verdict `pass`, complete, no failures. Steps (all exit 0): identity, install, lint, typecheck,
  gitleaks, zizmor, cli, tests, node, pack, sbom, eval, identity-after. Tests: parallel lane
  1505 pass / 10 skip / 0 fail, Postgres lane 162 pass / 0 fail; Node 132 pass / 0 fail.
- Strict benchmark (`bench/bench-2026-11-02-043223-aWYJtR/bench.json`), check passed. Raw
  nearest-rank warm find p95: Bun 2.77 ms, Node 7 ms (budget 50 ms, n = 500 each).
- Earlier attempts on the same branch are not release evidence: two failed on identity because a
  tracked file changed during the run, one was stopped, and three passed on trees that a later fix
  replaced.

## Native builds

`--aot` cannot cross-compile, so each platform's binary was built on its own runner by the Bun
pinned in `build/bun-toolchain.txt` (`@oven/bun-<platform>@1.4.4-canary.20261029.1`, sha512 per
platform, revision `1.4.4-canary.1+da867c60b`).

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 41408417933 (push to `main`): 18 jobs, all passed the first time, including `cli binary` and `bun` on ubuntu-latest, ubuntu-24.04-arm, macos-latest, windows-latest and windows-11-arm |
| Bun each `cli binary` job printed | `1.4.4-canary.1+da867c60b` on all five |
| Artifacts | `gh run download 41408417933 --pattern 'relembra-cli-*'` into an empty directory; each binary passed `shasum -a 256 -c` against the `relembra.sha256` beside it, then was renamed without changing bytes |
| Windows | in run 41408417933 both `bun` jobs ran the suite against the binary their runner built: 1472 pass / 205 skip (POSIX-only by design) / 0 fail each, all 12 Windows ACL and account tests passing |
| Linux smoke | each Linux binary in `debian:trixie-slim` with no network (x64 under emulation): init, note, find exit 0, store folder 0700, store 0600; a blank and a 5,000-byte note refused (`blank`, `too-long`), `find` without a query exits 2 |

## Review and security gate

- Independent code review (GPT-6.1 Sol, `autoreview --max-priority P3`), ten rounds over the
  branch's Windows commits; every finding was fixed or is covered by the waiver below, and the
  last four rounds were scoped-clean.
- Security deploy gate (production): WAIVED on tree `e7b8b403…`. Independent acceptance by
  GPT-6.1 Sol in five rounds (REJECT on NV-1, NV-2, NV-3 and NV-4 in turn, then ACCEPT (WAIVED)).
  - NV-2: the second of two concurrent first opens ran `icacls /reset` beside the first one's store. Fixed.
  - NV-4: running as LocalSystem collapsed the expected accounts to two. Fixed.
- Owner waivers to 2026-11-30:
  - SEC-20, unchanged from beta.1.
  - W-NV1 (Windows): the store folder is secured by path, so it is protected only when no other
    account can change the folder or its parent. That covers NV-1's retained handle and NV-3's
    parent swap. The default folder under the user's profile is outside the waiver.
    Remedy: set the ACL and create the store through Windows handles.

## Publication

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.2` (annotated) → `54fd154`; no tag of that name existed before |
| GitHub release | prerelease, immutable; GitHub's asset digests equal the record below, and a fresh download passed `shasum -a 256 -c SHA256SUMS` with a `SHA256SUMS` byte-identical to the one uploaded |
| npm | `release.yml` run 41409299314 staged `relembra@1.0.0-beta.2` with tag `beta`, stage id `fa81b4cd-d0e1-4d87-8df6-5057e859e02d`, with a provenance statement; staged shasum `5bc9ce7cf2d61350cec834ff10f0e0f0936c1f82` and integrity `sha512-0V6O8Cp8LqhIY+paRm/cZaJfUti27yUS3deZ517Wu4CKWMOB8beWndecLt4cZXXhrBeD+djPR/UFQkYcEx71xQ==` equal the released archive's |
| Pages | run 41409430046 from `54fd154`; HTTPS 200, HTTP → HTTPS 301, `.well-known/security.txt` 200, the page names 1.0.0-beta.2; all 16 served files byte-identical to `scripts/site/assemble.sh` output |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `6339cb6497a16ff412ddca105cc0245b6497aaf1c7cfb474d9bc39f22220a731` |
| `relembra-linux-x64` | `123d33a4df881b807981f5fffdf275eb2205b3c8b7dd994cd1573cdc514318ea` |
| `relembra-linux-arm64` | `096e52cca43b102c4a7040d01964aaba31e8a2c8589edae8370d2b96ab92b67a` |
| `relembra-windows-x64.exe` | `f2842b62bd9f8f63917084ecdbb0b9442247f26a15396d8b7f37d2a72a7c74bb` |
| `relembra-windows-arm64.exe` | `84e217b958a0520c3babf8e432356947d8377ce904cb61d75c7f3aa67eff0c88` |
| `relembra-1.0.0-beta.2.tgz` (the retained gate archive) | `0d433e3b7492579dee644bb634354d3d7a0c3bc6b1e56f938fd0b2634e3c0014` |
| `SHA256SUMS` | `85e7fbaaab42253ac508477824f77af8b2a62eea016184b28b87a47f1acf3dc7` |

## Mac installation

- Backup of the previous binary kept with its sha256
  `22b1d5950cec127b4bf8acb9e0f9baa198013adba334e16cf2db5d2ddf0cdf7c` (1.0.0-beta.1).
- `sh install.sh relembra-darwin-arm64 SHA256SUMS` from the downloaded release assets, with the
  tag's `install.sh`: exit 0; installed sha256 `6339cb64…a731` equals the release checksum and the
  tested binary.
- In a disposable `RELEMBRA_HOME` (made by relembra, mode 0700) and `RELEMBRA_SCOPE`,
  `RELEMBRA_GLOBAL_SCOPE` unset, never the live store: init, help, note, find (returns the note),
  wake (carries it), export (header `relembra: "1.0.0-beta.2"`) and check all exit 0. A blank, a
  multi-line and a 400-byte note are refused by the guard (`blank`, `multi-line`, `too-long`); an
  unknown command exits 2.
- `bun bench/cli.ts --binary ~/.local/bin/relembra --size 20000 --seed 20261031 --runs 50` (the
  installed bytes, sha256 above), 1-minute load about 9 on 18 cores: library find p95 3.1 ms; CLI
  find p50 25.56 ms, p95 31.25 ms; help p95 14.75 ms; hook p95 70.49 ms (96.16 ms in a git
  checkout). Diagnostic only.

## Open

- npm: the owner approves the staged version with two-factor authentication (`npm stage view`,
  `npm stage download` and its sha256 against `SHA256SUMS`, `npm stage approve`). Then
  `npm view relembra@1.0.0-beta.2 dist.integrity` against the SRI value above, and
  `npm view relembra dist-tags` with `beta`, not `latest`, on 1.0.0-beta.2.
- The waiver remedies above, by 2026-11-30.
- Not exercised: Windows on a real (non-runner) machine, a second Windows account, and LocalSystem.
