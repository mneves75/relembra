# Release evidence: 1.0.0-beta.10

This release raises the Node floor to 24.16 or later in 24, or 26.1 or later (`engines`:
`>=24.16 <25 || >=26.1`). Those are the first releases whose `node:sqlite` has
`DatabaseSync#deserialize`, which reading a store left with a WAL and no `-shm` needs.

The export format, the SQLite and Postgres schemas and the CLI are unchanged from 1.0.0-beta.9.

This record states what was observed; anything not observed is listed as open. Paths are relative
to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.10`, squash of PR #32) | `050f5f28baf6afa5769bdfb54272087d89813429` |
| Tree | `04cfbdbedaef579b0bd58cabe4cb8b31d259c53c` |
| Gated candidate | `f25731f22b9295d5bda42bbb52376b9e81878151`, the PR #32 head, with the same tree |
| Measured candidate | `b25a8a2cf7babdd7e9becd839b2407ec70486e2b`. `b25a8a2..f25731f` changes only `docs/eval/release-1.0.0-beta.9.md`, which is outside the input identity: AGENTS.md's `git diff --quiet` over the evidence inputs exits 0 |
| Input digest (`scripts/evidence.ts`) | `18de96dfa448035d2798ca8e8c42d8341b14e7ce6e706d8d681a13cb3f6e7a78` |
| Runtimes | Bun 1.4.5 (`237bba51e`), Node v26.13.0, SQLite 3.54.0 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Which Node versions have `deserialize`

On the official darwin-arm64 builds, `typeof new DatabaseSync(":memory:").deserialize` gave:
- v24.15.0: `undefined`;
- v24.16.0, v24.21.0 and v26.13.0: `function`;
- Bun 1.4: `function`.

The Node API docs agree:
- the 24.x docs say "added v24.16.0";
- the 26.1.0 docs list it;
- the 25.x and 26.0.0 docs do not.

The code comment it replaces said 24.22, which was wrong.

Every Node 24 release (24.14.0 to 24.22.3), and 26.1.0, bundles npm 11. So the scripts keep parsing
both npm 11's and npm 12's `pack --json` shapes.

## Local acceptance

`scripts/check-release.sh` passed on `b25a8a2` (attempt `.scratch/release/release-20261116-143426-UfPQ9G/`):
- **Gate manifest:** sha256 `603184d022a9d088821042ab40bf52a61ef380cba483adb2cabb4514450d34d1`,
  verdict `pass`, all 13 steps exited 0.
- **Tests:**
  - parallel lane: 1714 pass, 23 skip, 0 fail;
  - Postgres lane: 170 pass, 0 fail;
  - Node: 137 pass, 0 fail.
- **Strict benchmark:** passed. Raw nearest-rank warm find p95 was Bun 39.55 ms and Node 17.03 ms,
  against a 50 ms budget, with n = 500 each. Load averages were 89 to 138 on 18 cores, from other
  work on the machine.
- **Node floor:** the Node suite also ran on the official Node v24.16.0 binary, 137 pass, 0 fail.

## Native builds

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 43934534687 (push to `main`): completed success |
| Hosted CI on the PR #32 head `f25731f` | 26 checks success, including the new `node (24.16)` lanes on Linux and both Windows runners |
| Artifacts | `scripts/deploy.sh hmo --run 43934534687 --release-check .scratch/release/release-20261116-143426-UfPQ9G` checked each hosted binary against its own `relembra.sha256` entry, and bound `bin/relembra` and the retained archive to the gate manifest by sha256. The hosted macOS build differed from the gated binary, so the release ships the gated one |
| Ruleset | With the owner's approval, the three required checks `node (…, 24.14)` in the `main protection` ruleset were renamed `node (…, 24.16)`. Nothing else in the ruleset changed (compared before and after) |

## Review and verification

- **Code review:** `autoreview` (Codex, P0 to P2) on `origin/main..b25a8a2` was scoped-clean:
  "patch is correct", 0.89.
- **Security deploy gate (production):** WAIVED (SEC-20, SEC-18, C9.3-K2) on tree `04cfbdbe…`.
  - It reuses the 1.0.0-beta.9 record, plus the delta, read in full.
  - Removing the `typeof deserialize` guard keeps the reader fail-closed: the call sits in a `try`
    whose `catch` turns any error into `StoreUnverifiedError`.
  - The beta.9 evidence record's K-2 line was reworded so that it points to `docs/FORMAT.md` instead
    of restating the residual, which keeps C9.3-K2's scope exact.
- **Independent acceptance (GPT-6 via Codex):** three fresh attempts.
  1. Rejected on C11.3 only. The criterion's wording allowed only matrix values to change in
     `ci.yml`, and a comment changed too. The owner decided that comments are in scope.
  2. Rejected on C9.1 only. The inherited criterion predated the C9.3-K2 waiver; it was updated to
     the three waivers the owner decided.
  3. ACCEPT (WAIVED). The verifier probed the missing-`deserialize` refusal with the method stubbed
     away, plus 17 Node-version controls of `scripts/init.sh`.

## Publication (`scripts/deploy.sh prd`, approved by the owner for this commit)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.10` (annotated, message `v1.0.0-beta.10; security gate: WAIVED SEC-20 SEC-18 C9.3-K2`) → `050f5f2`. GitHub answered the push with the ruleset-bypass notice for restricted tag creation, as before |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.10, published 2026-11-16T19:32:04Z, prerelease, immutable. All six assets were downloaded again and `shasum -a 256 -c SHA256SUMS` passed. The macOS binary's `--version` printed `relembra 1.0.0-beta.10` |
| npm | `release.yml` run 43940324479 staged `relembra@1.0.0-beta.10` with tag `beta`, stage id `4e8fc780-d506-4e0c-8cd2-b9ca687401e9`, shasum `42eef7d3b0f03baa1f98a2fc917619bfe6d8280a`, integrity `sha512-xh1Qt2tQRZRhGhhiJL2GCkmuw+nLoU6X18aNAyZ5EYU+kiUXgbsVq37dM4DxItMqP8/E09v1KKRMBkLdRxxr6Q==`. Waiting for the owner's approval |
| Pages | run 43940408624; HTTPS 200, the page names 1.0.0-beta.10 6 times |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `90161a8133bd4f3ac32ca04c16d62a4d7343570a825793e226b18d57cf77794f` |
| `relembra-linux-x64` | `68890ce2132e52153c19c391e681133cc69870ba05cb36ab35a80a999d28b4d5` |
| `relembra-linux-arm64` | `8250a2021af4bcb1cc6e7cf4a8adf208656c3493777d668b4baf605558e7e770` |
| `relembra-windows-x64.exe` | `d540b218b4819c5113309d71ee03cdc2d128e94c9f1384cdf78f3c54d4b2f988` |
| `relembra-windows-arm64.exe` | `352b32fd0ef43a92d67bc60690301eed28bb9fa5d3b33a1f5b2ca7032753ad04` |
| `relembra-1.0.0-beta.10.tgz` (the retained gate archive) | `9becfd8dfb6927323a327c796315046c337612a78c1a441ec7c01272e6bb22a1` |

## Open

- **npm:** `dist-tags.beta` moves to 1.0.0-beta.10 when the owner approves stage
  `4e8fc780-d506-4e0c-8cd2-b9ca687401e9`.
- **Waivers:**
  - SEC-18, to 2027-01-31;
  - SEC-20, to 2027-02-28;
  - C9.3-K2, to 2027-02-28.
- **Not tested:** the WAL-without-`-shm` read path itself was not exercised on Node 24.16. It rests
  on the method being present there and on `test/wal-image.test.ts` under Bun.
- **Still open from 1.0.0-beta.9:** K-2's residual (Low) and the reviewer's Low finding.
- **Not installed:** the Mac and the maintainer's Linux hosts are still on the binary they had.
