# Release evidence: 1.0.0-beta.4

Windows stores are created private from birth, and two processes opening a missing store at once
both succeed. This record states what was observed; anything not observed is listed as open.
Paths are relative to the checkout that ran the release check.

## Candidate

| Item | Value |
|---|---|
| Release commit (tag `v1.0.0-beta.4`, squash of PR #11) | `1b1feee4d2fa1957c4887d1b28487ddf25b37219` |
| Tree | `5336a7492fb38940c9c53619a82276a2649f509b` |
| Measured candidate | `1427383661cbd55704ce17ae7e6be33d1c6663df`, the PR #11 head (version bump `3f62670` plus the acceptance-round fixes), the same tree. Its parent `7c2b3a2` (PR #10) was `main`, so the squash kept the tree |
| Input digest (`scripts/evidence.ts`) | `2368c009d83c6a7ad0ca7798c469d1b0bc7f68676de62a2a6e8b7ae6b2bea89f`, identical before and after |
| Runtimes | Bun 1.4.4-canary.1 (`da867c60b`), Node v26.12.1, SQLite 3.54.0 |
| Machine | Apple M5 Pro, 18 cores, macOS 27.3 arm64 |

## Local acceptance

`scripts/check-release.sh` passed, attempt `.scratch/release/release-20261104-022001-lPTbBC/`.

- Gate manifest sha256 `47eeae59e25f608e0afe7258e0717c5d00bcf9ecde04569097f2d6cd1aa65592`,
  verdict `pass`, complete, no failures. Steps (all exit 0): identity, install, lint, typecheck,
  gitleaks, zizmor, cli, tests, node, pack, sbom, eval, identity-after.
- Tests: parallel lane 1530 pass / 21 skip / 0 fail, Postgres lane 162 pass / 0 fail; Node 132
  pass / 0 fail.
- Strict benchmark (`bench/bench-2026-11-04-022135-yd9c4w/bench.json`), check passed. Raw
  nearest-rank warm find p95: Bun 3.30 ms, Node 6.83 ms (budget 50 ms, n = 500 each), 1-minute
  load 5.8 before and 6.2 after on 18 cores. An earlier attempt on the version bump alone
  (`3f62670`, `release-20261104-003509-3HA7Lu/`, manifest `e3820662…`) also passed at 7.25 and
  17.53 ms under load 22.9 to 225.6.

## Native builds

Each platform's binary was built on its own runner by the Bun pinned in
`build/bun-toolchain.txt` (revision `1.4.4-canary.1+da867c60b`).

| Item | Observed |
|---|---|
| Hosted CI on the release commit | run 41780884305 (push to `main`): 22 jobs, all passed on the first attempt (run 41780884031, CodeQL, passed too) |
| Bun each `cli binary` job printed | `1.4.4-canary.1+da867c60b` on all five |
| Artifacts | `gh run download 41780884305 --pattern 'relembra-cli-*'` into an empty directory; each binary passed `shasum -a 256 -c` against the `relembra.sha256` beside it, then was copied under its release name and compared with `cmp` |
| Windows | both `bun` jobs ran the suite against their own runner's binary: x64 then arm64: 1508 pass; 205 skip; 0 fail; ; 1508 pass; 205 skip; 0 fail, the simultaneous first-open test and every Windows ACL test included; `node (windows-*, 24.14 and 26)` 132 pass / 0 fail each |
| Windows startup probe (`scripts/windows-cli-startup.ts`, both `cli binary` Windows jobs) | system PowerShell, stdin, Framework JSON and ACL probes exit 0; `folder-inheritance-model`: a file .NET creates in a `D:P` folder carries inherited entries, `CreateDirectory` drops the `AI` bit of a `D:PAI` request and `SetAccessControl` restores it; the candidate binary answers `--help` |
| Linux smoke | each Linux binary ran in `debian:trixie-slim` with no network (x64 under emulation): init, note, find exit 0; store folder 0700, store 0600; a blank note refused (exit 1) |

Earlier runs on the fix branch (PR #10): 41689802952 on `0a98a32`, red on Windows (six Bun
failures per architecture: the first-open race and the file entries not marked inherited; one
Node failure per cell); 41762474475 on `2975fcd`, red on two attributions (Node 24's
ExperimentalWarning in a killed child's stderr, PowerShell's startup creating a missing TEMP);
41764047120 on `c5cbfae`, 22/22 green, Windows Bun 1506 pass / 205 skip / 0 fail per
architecture, Node 132 / 0. PR #11: run 41768035715 on `3f62670`, attempt 1 21/22 (one `bun run
eval` exit 1 on windows-latest, not reproduced), attempt 2 22/22; run 41778543036 on `1427383`,
22/22 on the first attempt, Windows Bun 1508 / 205 / 0 per architecture with the two creation-step
tests, Node 132 / 0.

## Review and security gate

- **Independent code review** of the fix round (`0a98a32..c5cbfae`, GPT-6.1 Sol through `codex
  exec`, reasoning high, read-only): no actionable findings (PR #10 comment). The automated
  security review of `2975fcd` flagged the predictable `Global\` mutex name (denial of creation
  by squatting; Low; kept as designed, `Local\` recorded as the alternative).
- **Security deploy gate (production):** WAIVED on tree `5336a749…`, record
  `.scratch/security-gate/1427383661cbd55704ce17ae7e6be33d1c6663df/production.md`. Independent
  acceptance by GPT-6.1 Sol: round 1 on `3f62670` REJECT (IA-1 orphan leaf after a failed step,
  IA-2 adoption without the folder model, IA-3 SEC-20 wording), all three closed in `1427383` and
  the record; round 2: round 2 rejected only on the brief's frozen commit (IA-4, the brief still named `3f62670`); round 3 ACCEPT (WAIVED), all six criteria PASS (`independent-acceptance.md`, round 2 kept as `independent-acceptance-round2.md`).
- **Owner waivers, to 2026-11-30:**
  - SEC-20, unchanged.
  - W-NV1, narrowed by this release. Beta.3's remedy is implemented: owners are read as SIDs
    through .NET and a foreign or unverifiable owner refuses the ancestry (a); no TEMP, save file
    or scratch folder participates (c); a new store never reuses an existing leaf, whose
    protected descriptor is supplied to `CreateDirectory` itself and read back (b). Still
    covered: (b′) a handle another account held to an existing ancestor from before its
    permissions were restricted, which current reads cannot see
    (`docs/specs/w-nv1/spec.md`). The owner approved the release packet on 2026-11-04 ("yes to all, do it all") with the waiver kept at this narrowing and its expiry unchanged.
- **Production readiness gate (`mneves-production-readiness`):** not run for this release, with the owner's approval in the decision packet: no ledger exists, so a baseline would add a tracked file and change the frozen candidate; relembra has no server, takes no money and stores data only on the user's machine. Follow-up: a baseline ledger by PR.

## Publication

| Step | Observed |
|---|---|
| Tag | `v1.0.0-beta.4` (annotated, message `v1.0.0-beta.4; security gate: WAIVED SEC-20 W-NV1`) → `1b1feee`; no tag of that name existed before (`git ls-remote --tags origin`) |
| GitHub release | prerelease, published 2026-11-04T05:51:59Z from a draft that held all seven assets; GitHub's digests for the seven assets equalled the table below before publishing; a fresh `gh release download` into an empty directory passed `shasum -a 256 -c SHA256SUMS`, with `SHA256SUMS` byte-identical to the one uploaded |
| npm | `release.yml` run 41781854733 staged `relembra@1.0.0-beta.4` with tag `beta`, stage id `d039c1e8-667d-4cc9-9bda-6057444e3704`, with a provenance statement (sigstore log index 3686407592); the staged shasum `a7a6a3f958a390078489dc1609205a02634b7692` equals the released archive's sha1, and the archive's integrity is `sha512-J65Xsci5GCGrxZx6LUZ+AIb68K3Lb82b6Nsik+eDA6mRBX8Jz1RDizdbq5VLFcHnoSEf6SO6SVzFB5Ytlagxuw==`; the owner's `npm stage approve` is pending |
| Pages | run 41781856475 from `1b1feee` (`workflow_dispatch`); HTTPS 200, HTTP → HTTPS 301, `.well-known/security.txt` 200, the page names 1.0.0-beta.4 (4 occurrences) |

| Asset | sha256 |
|---|---|
| `relembra-darwin-arm64` (the locally gated binary) | `d25dbd55cb3efb4c7fd86be96db9fd5f6233944f4f3844e697fb6bc5f7637564` |
| `relembra-linux-x64` | `4d3863e2f5342a2024e8ba86e00ede29e62524a37bfee9a5ce9c106639d1732b` |
| `relembra-linux-arm64` | `72d68ace58d6d1ca47fdbe384d4ee9414e9c86cb6683c76191baf5b6ee8b0a51` |
| `relembra-windows-x64.exe` | `750044477043ea0db944b43cf319529759c7187d6596c05bbd29eb8f75395ae8` |
| `relembra-windows-arm64.exe` | `69cbd28537fc5b00e28734867f2ba7a33abb9b0f0ed62a216678bfe05447d759` |
| `relembra-1.0.0-beta.4.tgz` (the retained gate archive) | `bb96a7712574fb75cf11808630b171ba58615dc36c31ec269e68e2c65697df86` |
| `SHA256SUMS` | `a46e3c4d3ad93ac30a89aeecde8788d24c35e1fca2c2becf2b895984cb5c742e` |

## Mac installation

The beta.3 binary (`29acba6c…`) was copied with its sha256 to `.scratch/beta4/rollback/` before
replacement. `sh install.sh relembra-darwin-arm64 SHA256SUMS` from the `1b1feee` checkout, with the
downloaded assets, installed `~/.local/bin/relembra` with sha256
`d25dbd55cb3efb4c7fd86be96db9fd5f6233944f4f3844e697fb6bc5f7637564`, equal to the release checksum
and the tested binary.

Smoke test in a disposable `RELEMBRA_HOME` and `RELEMBRA_SCOPE`, `RELEMBRA_GLOBAL_SCOPE` cleared:
`init`, `--help`, `note`, `find`, `wake`, `export` (header `"relembra":"1.0.0-beta.4"`) and
`check` exit 0; a blank note and a 5,000-byte note are refused by the guard (exit 1); `find`
without a query and an unknown flag are usage errors (exit 2); the store folder is 0700 and the
store 0600.

`bun bench/cli.ts --binary ~/.local/bin/relembra --size 20000 --seed 20261031 --runs 50`: p95
help 18.41 ms, find 38.98 ms, wake 92.08 ms, hook 102.83 ms, wake (git) 107.80 ms, hook (git)
116.43 ms; library find p95 4.03 ms (n = 500). Binary sha256 confirmed by the benchmark record.

## Open

- `npm stage approve` for `d039c1e8…` (beta.4), and for the beta.2 and beta.3 stages still pending; then
  `npm view relembra@1.0.0-beta.4 dist.integrity` must equal the SRI above and `dist-tags.beta`
  must point at 1.0.0-beta.4.
- SEC-20 and W-NV1 (narrowed) expire 2026-11-30: renew, remedy, or close W-NV1 as a documented
  boundary.
- Production-readiness baseline ledger (follow-up PR).
- F-1: keep the `Global\` mutex name or move to `Local\`.
- Add the four `node (windows-*)` job names to the branch ruleset's required checks.
- Not exercised: Windows on a real machine, a second account, LocalSystem, cross-session mutex
  coordination, a TEMP outside the profile.
