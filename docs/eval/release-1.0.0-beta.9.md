# Release evidence: 1.0.0-beta.9

Closes the items 1.0.0-beta.8 left open:
- the Postgres shared-pool first-open race;
- per-command CLI help and `--version` (C-3);
- three import consistency fixes (CORE-2, CORE-3 and K-2's retract, supersede and redact);
- the Windows question of a foreign write right on an empty parent folder (P-W1, P-W2).

The export format, the SQLite and Postgres schemas and the CLI's exit codes are unchanged from
1.0.0-beta.8.

This record states what was observed; anything not observed is listed as open. Paths are relative
to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.9`, squash of PR #30) | `720974b395bb08f87093b76e31a63c407a1ca706` |
| Tree | `704b18edbd305cc6126a975e8b46c93802b6e0c2` |
| Measured candidate | `718445ae0f0075c670cc970d120fb774af6fad7e`, the PR #30 head, the same tree (`git diff 718445a 720974b` is empty) |
| Input digest (`scripts/evidence.ts`) | `6f6d177c6ec675d0348650703866de6f49fa9f5b74aae10a1816a6baf872b3b5` |
| Runtimes | Bun 1.4.5 (`b6e7b9cdc`), Node v26.13.0, SQLite 3.54.0. The macOS binary was built by that host Bun; the hosted builds use the pin in `build/bun-toolchain.txt` |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed on `718445a`, attempt
`.scratch/release/release-20261115-220257-RyD4gg/`.

- Gate manifest: sha256 `532c977f3bc2bb90c0b0002c0f0f777c0c40341f5850efd57b6df51025ac8775`, verdict
  `pass`. Every step exited 0: identity, install, lint, typecheck, gitleaks, zizmor, cli, tests,
  node, pack, sbom, eval, identity-after.
- Tests:
  - parallel lane: 1714 pass, 23 skip, 0 fail;
  - Postgres lane: 170 pass, 0 fail;
  - Node: 137 pass, 0 fail.
- Strict benchmark (`bench/bench-2026-11-15-220627-gtdKEb/bench.json`): the check passed.
  - Raw nearest-rank warm find p95: Bun 9.19 ms, Node 26.46 ms (budget 50 ms, n = 500 each).
  - Load averages on 18 cores: 42.5 at the start, 108.4 at the end.
- Earlier attempts did not pass and are not evidence for this release:
  - On `1b20d2c`: a `test/gate.test.ts` `afterAll` hook timed out under load. The file passes
    alone.
  - On `718445a`: the gate passed, but the benchmark failed on load (Bun 48.74 ms, Node 56.73 ms,
    with load between 66 and 100).

## Native builds

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 43795265432 (push to `main`): completed success |
| Hosted CI on the PR #30 head `718445a` | 26 checks success |
| Artifacts | `scripts/deploy.sh hmo --run 43795265432 --release-check .scratch/release/release-20261115-220257-RyD4gg` checked each hosted binary against its own `relembra.sha256` entry, and bound `bin/relembra` and the retained archive to the gate manifest by sha256. The hosted macOS build differed from the gated binary, so the release ships the gated one |

## Review and verification

- **Postgres race:**
  - Reproduced on the unfixed code: 54 of 80 rounds of four openers through one pool failed with
    `23505`.
  - Cause: an advisory lock does not make the backend read catalog invalidations, so a pooled
    connection that had already looked the schema up still saw it as absent.
  - Fix: `LOCK TABLE pg_catalog.pg_namespace IN ACCESS SHARE MODE` after the advisory lock.
    0 failures followed.
  - The new test ("hosts sharing one pool open new schemas at once, round after round") failed
    before the fix and passes with it.
- **Windows control:**
  - A throwaway branch with only the post-create re-read reverted ran hosted CI (run 43759712675).
  - The new test "a store folder made through a junction is refused after creation, and removed"
    failed on `windows-latest` and `windows-11-arm`, the only failure in each Windows Bun job.
  - It passes on the candidate's runs (run 43759802666).
  - The branch was deleted.
- **Windows rule 3:**
  - Per MS-FSA, setting a reparse point on a folder takes FILE_WRITE_DATA (which, for a folder, is
    FILE_ADD_FILE) or FILE_WRITE_ATTRIBUTES.
  - So a new store is now refused when another account holds more than read and execute on the
    deepest existing folder above it.
  - This was not tested with a second Windows account; the refusal makes the question moot.
- **Independent review (`reviewer` agent, fresh context):** PASS. One Low finding, pre-existing and
  open below.
- **Security deploy gate (production):** WAIVED (SEC-20, SEC-18, C9.3-K2) on tree `704b18ed…`.
  - The audit (Claude Opus 5.5) ran on `1b20d2c`; `718445a` differs from it in `README.md` only.
  - SEC-11/W-1's waiver was dropped: the rule 3 change removes its precondition.
  - Coverage is partial in the same way as 1.0.0-beta.8.
- **Independent acceptance (GPT-6 via Codex):** four fresh attempts.
  1. Voided by the verifier itself: it ran repository test files that write under the OS
     temporary folder.
  2. Rejected on C9.3: tracked text describes the open K-2 residual. Also C4.3 NOT VERIFIED: its
     sandbox got 403 for job logs. The full Windows job logs were then supplied with their
     checksums.
  3. Rejected on C9.3 for the `src/transfer.ts` comment, which the first waiver did not cover.
  4. ACCEPT (WAIVED). The only item NOT VERIFIED is the finder's own reading history (C2.2),
     which does not reject.
- **Owner decisions (2026-11-15):**
  - SEC-20: waiver kept (to 2027-02-28).
  - Release: "Ship beta.9".
  - C9.3-K2 (to 2027-02-28): the tracked statements of the Low K-2 id-namespace residual are kept.
    These are the `docs/FORMAT.md` paragraph "Ids across scopes (residual)" and the
    `src/transfer.ts` comment, with its compiled copy.

## Publication (`scripts/deploy.sh prd`)

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.9` (annotated, message `v1.0.0-beta.9; security gate: WAIVED SEC-20 SEC-18 C9.3-K2`) → `720974b`. GitHub answered the push with the ruleset-bypass notice for restricted tag creation, as before |
| GitHub release | https://github.com/mneves75/relembra/releases/tag/v1.0.0-beta.9, published 2026-11-16T03:08:33Z, prerelease, immutable. The draft's assets were checked against `SHA256SUMS` before publication. All six assets were downloaded again by hand and `shasum -a 256 -c SHA256SUMS` passed. The macOS binary's `--version` printed `relembra 1.0.0-beta.9`, and `--version --json` printed `data.version` `1.0.0-beta.9` |
| npm | `release.yml` run 43796351976 staged `relembra@1.0.0-beta.9` with tag `beta`, stage id `1ac7508d-f4b6-4cce-a5ec-36f27e1c529b`, shasum `b2018be6daa9db96c99995b87e0c4ff0f8bc4104`, integrity `sha512-by1YO9yetFbQRA9AMI5PnizB1h1D1ZYMJcvdoDpB/Cw+jiyPeJLW09XfBBoWzXYeUIYk63MMskwJ3iGeYdCtgg==`. Waiting for the owner's approval |
| Pages | run 43796399370; HTTPS 200, the page names 1.0.0-beta.9 6 times |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `db50922b71773ee705dc7b46054ed9c120036d8d05d4ff187ff89ea166bb80ad` |
| `relembra-linux-x64` | `3429acf839961308893833d0062d94055ab61e0c3b38301851cb23848168352c` |
| `relembra-linux-arm64` | `541a01ad9cdc6f059f66be0a8c08871814b689453398811550a362ace003366d` |
| `relembra-windows-x64.exe` | `44e569e171801ff9f6071c3ea1c7ac2cb957ef68e394fbd4a7f49909cf4ece82` |
| `relembra-windows-arm64.exe` | `bc6226d819e3c85e207414591e69157bb990d0bad830678900b7262c924d5980` |
| `relembra-1.0.0-beta.9.tgz` (the retained gate archive) | `85d2000160733da2f7580433798954c523948e0e15933d7fb4aadacdd1690985` |

## Open

- npm: `dist-tags.beta` moves to 1.0.0-beta.9 when the owner approves stage
  `1ac7508d-f4b6-4cce-a5ec-36f27e1c529b`.
- Waived:
  - to 2027-01-31: SEC-18 (gate plan item P-18);
  - to 2027-02-28: SEC-20 (P-3) and C9.3-K2.
- K-2's residual (Low): described in `docs/FORMAT.md`, "Ids across scopes (residual)", and
  waived as C9.3-K2.
- The reviewer's Low finding, pre-existing: a replayed second supersede of a memory the file holds
  only in redacted form answers `conflict`, where a stored one is skipped.
- Not installed by this release run: the Mac and the maintainer's Linux hosts are still on the
  binary they had.
