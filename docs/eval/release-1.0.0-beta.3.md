# Release evidence: 1.0.0-beta.3

Windows store protection checks the store folder's whole path. This record states what was
observed; anything not observed is listed as open. Paths are relative to the checkout that ran
the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.3`, squash of PR #8) | `2f69a2685ae3995a9fadbe58776306c80f8f3be1` |
| Tree | `0c657c4993a9ba39d1764927e6481e612bc31989` |
| Measured candidate | `4e9a234dce64daaf8631491caa7326da09b6bc14`, the PR head, the same tree. Its parent `ab8f6b1` (PR #7) was `main`, so the squash kept the tree |
| Input digest (`scripts/evidence.ts`) | `5e25159012c0ff541ab9211c93c8c11b2c1286aa56cc94b2d8e9d99520828a9f`, identical before and after |
| Runtimes | Bun 1.4.4-canary.1 (`da867c60b`), Node v26.12.1 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.2 arm64 |

## Local acceptance

`scripts/check-release.sh` passed, attempt `.scratch/release/release-20261102-131456-7aZitv/`.

- Gate manifest sha256 `7b52817e56ee95a68304cd3fffed06c59186da40b60b2ac349801b6261816133`,
  verdict `pass`, complete, no failures. Steps (all exit 0): identity, install, lint, typecheck,
  gitleaks, zizmor, cli, tests, node, pack, sbom, eval, identity-after.
- Tests: parallel lane 1524 pass / 15 skip / 0 fail, Postgres lane 162 pass / 0 fail; Node 132
  pass / 0 fail.
- Strict benchmark (`bench/bench-2026-11-02-131845-UPpqdb/bench.json`), check passed. Raw
  nearest-rank warm find p95: Bun 6.52 ms, Node 20.23 ms (budget 50 ms, n = 500 each). The
  1-minute load average was 19.9 to 26.4 on 18 cores; beta.2 measured 2.77 and 7 ms on a quieter
  machine.

## Native builds

Each platform's binary was built on its own runner by the Bun pinned in
`build/bun-toolchain.txt` (revision `1.4.4-canary.1+da867c60b`).

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 41484310647 (push to `main`): 18 jobs, all passed on the first attempt |
| Bun each `cli binary` job printed | `1.4.4-canary.1+da867c60b` on all five |
| Artifacts | `gh run download 41484310647 --pattern 'relembra-cli-*'` into an empty directory; each binary passed `shasum -a 256 -c` against the `relembra.sha256` beside it, then was copied under its release name and compared with `cmp` |
| Windows | both `bun` jobs ran the suite against their own runner's binary: 1496 pass / 205 skip (POSIX-only by design) / 0 fail each, all 15 Windows ACL tests passing, the four path rules and the junction case included |
| Linux smoke | each Linux binary ran in `debian:trixie-slim` with no network (x64 under emulation): init, note, find exit 0; store folder 0700, store 0600; a blank and a 5,000-byte note refused (exit 1); `find` without a query exits 2 |

## Review and security gate

- **Independent code review** of PR #7 (GPT-6.1 Sol, `autoreview --max-priority P3`), three rounds:
  - **Round 1:** three P1s: the chain read on the canonical path, quotes in conditional ACEs, and forgeable `icacls /save` files.
  - **Round 2:** the first two closed. The third remained: under Node, a handle opened before the scratch folder's ACL step keeps its access. The owner accepted it as a named residual.
  - **Round 3:** scoped-clean.
- **Security deploy gate (production):** WAIVED on tree `0c657c49…`. Independent acceptance by GPT-6.1 Sol: ACCEPT (WAIVED), all six criteria passing.
- **Owner waivers, to 2026-11-30:**
  - SEC-20, unchanged.
  - W-NV1, narrowed by this release. relembra now refuses a store folder whose path another account could change, as its folders' access lists show (`docs/specs/w-nv1/spec.md`). Still covered:
    - (a) a folder on the path owned by another account whose access list does not name that account;
    - (b) a folder, or a handle to one, from before the path became private;
    - (c) `TEMP`, where the access lists are written, which must give other accounts no access to what is made in it.

    The default locations under the user's profile are outside the waiver. Remedy: create folders with their security descriptor at birth and read owners through the Windows API, or renew the waiver.

## Publication

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.3` (annotated) → `2f69a26`; no tag of that name existed before |
| GitHub release | prerelease, immutable. The first `gh release create` stopped with HTTP 422 ("ReleaseAsset.name already exists") after six uploads; the archive was added with `gh release upload` while the release was still a draft. GitHub's digests for all seven assets equal the table below, and a fresh download passed `shasum -a 256 -c SHA256SUMS` with a `SHA256SUMS` byte-identical to the one uploaded |
| npm | `release.yml` run 41486606170 staged `relembra@1.0.0-beta.3` with tag `beta`, stage id `26faae06-6d86-461b-b613-7b5e6b7ad132`, with a provenance statement; staged shasum `337bd8573f36557016075f71dbbd49d79e172429` and integrity `sha512-RxkmPPvoUkegJDksISDc0WRizht3x9k3FeL3zuvAZe1VJ3ayh1dozOEnKTesHgPyQxFGaMNE/06ln88JjTkMrQ==` equal the released archive's |
| Pages | run 41487332527 from `2f69a26`; HTTPS 200, HTTP → HTTPS 301, `.well-known/security.txt` 200, the page names 1.0.0-beta.3; all 16 served files byte-identical to `scripts/site/assemble.sh` output |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `29acba6cba32aa7e8506c0820a0b7b374a326da8dd857233f1412fcb1e0bd5bd` |
| `relembra-linux-x64` | `c1c5b64b47aa9f8a88947cd7668a8772027729404386da01a6723db51d2836c1` |
| `relembra-linux-arm64` | `e6f6086a56c8a0b08a644debb79d3ffff04dfb850612bc1c0e02580c29df9d08` |
| `relembra-windows-x64.exe` | `601a60c1c6fa93bc2552cdcc71c31284f18b96dd2768e657d7e95c9ceb97a788` |
| `relembra-windows-arm64.exe` | `f11573834ef4eb4973b15c317cc7c707cf4210d0d64bfee5a76525c770b1c742` |
| `relembra-1.0.0-beta.3.tgz` (the retained gate archive) | `9f3db6e929418d365b0b766a395f94dbc487f56af784bdae2b7ed91a1d1956ce` |
| `SHA256SUMS` | `f57f568bf082aab6df211275ee7b20da0b8871d503e11af7d78839475428b64a` |

## Mac installation

- The previous binary was kept with its sha256
  `6339cb6497a16ff412ddca105cc0245b6497aaf1c7cfb474d9bc39f22220a731` (1.0.0-beta.2).
- `sh install.sh relembra-darwin-arm64 SHA256SUMS` ran from the downloaded release assets with the
  tag's `install.sh` and exited 0. The installed sha256 `29acba6c…0bd5bd` equals the release
  checksum and the tested binary.
- Smoke test in a disposable `RELEMBRA_HOME` (made by relembra) and `RELEMBRA_SCOPE`, with
  `RELEMBRA_GLOBAL_SCOPE` unset, never the live store:
  - init, help, note, find (returns the note), wake (carries it), export (header
    `"relembra":"1.0.0-beta.3"`) and check all exit 0;
  - a blank, a multi-line and a 400-byte note are refused by the guard (`blank`, `multi-line`,
    `too-long`);
  - an unknown command exits 2.
- `bun bench/cli.ts --binary ~/.local/bin/relembra --size 20000 --seed 20261031 --runs 50` ran on
  the installed bytes, with a 1-minute load average of about 21 on 18 cores. This is diagnostic
  only:

  | Operation | p50 | p95 |
  |---|---|---|
  | Library find | 1.65 ms | 5.47 ms |
  | CLI find | 44.59 ms | 49.49 ms |
  | help | 17 ms | 18.95 ms |
  | hook | 92.18 ms | 123.99 ms |

  beta.2 measured 25.56 and 31.25 ms for CLI find at a load average of about 9. This release
  changes only Windows code paths, so the difference is attributed to load. That is not proven:
  the run was not repeated on a quiet machine.

## Open

- npm: the owner approves the staged version with two-factor authentication:
  1. `npm stage view 26faae06-6d86-461b-b613-7b5e6b7ad132`;
  2. `npm stage download` it and compare its sha256 with `SHA256SUMS`;
  3. `npm stage approve 26faae06-6d86-461b-b613-7b5e6b7ad132`.

  Then check `npm view relembra@1.0.0-beta.3 dist.integrity` against the SRI value above, and
  `npm view relembra dist-tags`: `beta` on 1.0.0-beta.3, `latest` unchanged. 1.0.0-beta.2's
  staged version (`fa81b4cd-d0e1-4d87-8df6-5057e859e02d`) also awaits approval or rejection.
- The waiver remedies above, by 2026-11-30.
- Not exercised: Windows on a real (non-runner) machine, a second Windows account, LocalSystem,
  and a `TEMP` outside the profile.
