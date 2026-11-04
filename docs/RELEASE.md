# Release procedure

A release is a SemVer version in `package.json` and `src/version.ts` (`scripts/pack-check.ts`
refuses a mismatch), a tag `v<version>`, the retained package archive published to npm, and a
GitHub release carrying the CLI binaries (macOS arm64, Linux x64 and arm64, Windows x64 and
arm64), `SHA256SUMS` and the same archive. A
prerelease (`1.0.0-beta.1`) publishes under the npm dist-tag `beta`, never `latest`, and its
GitHub release is marked as a prerelease. The evidence record `docs/eval/release-<version>.md`
establishes which steps have completed; this document only describes them.

## Local acceptance

Commit all relevant inputs first. Both the gate and strict benchmark reject dirty or relevant
untracked inputs and inherited runtime overrides; the gate also refuses
`RELEMBRA_SKIP_BUILD_TOOLCHAIN`. The authoritative input list is `scripts/evidence.ts`, including
source, eval, benchmark, build, scripts, tests/Node loader, examples, workflows/hooks, compiler,
lint/scanner/runtime configuration, installer and package inputs ([AGENTS.md](../AGENTS.md#checks)).
Generated reports and build output are excluded from input identity.

Run directly, or with `npm run check:release`; do not use `bun run check:release`, since Bun
acts on `BUN_OPTIONS` before the script can guard it:

```sh
scripts/check-release.sh
```

The wrapper runs `scripts/ci.sh` then `bun bench/eval-latency.ts --check` serially, stopping on
failure. Keep other gates, builds and timings idle during measurement. Every run retains a new
`.scratch/release/release-<time>-<suffix>/` containing:

- `gate/manifest.json`: required steps and real exits, candidate commit/input digest, identity
  snapshot paths, binary/package before/after sha256 and hashes of eval/SBOM outputs. Each step
  has `.cmd`, `.log` and, when it finishes, `.rc` files. Missing, killed or failed steps cannot pass.
- `gate/package/relembra-<version>.tgz`: the one archive installed by both Node and Bun consumers,
  hashed before and after testing. Publish these bytes, not a freshly packed archive.
- `bench/bench-<date>-<time>-<suffix>/bench.json` and `bench.md`: raw samples, completeness,
  corpus/store hashes, integrity, machine load, source/runtime identity and strict verdict.
- `identity-final.json`: final identity compared with the gate's initial snapshot. The wrapper
  also recomputes the strict verdict from the benchmark record and compares both benchmark
  snapshots with the gate candidate. Different commits cannot combine into one passing run.

Once the gate passes, and before the benchmark starts, the wrapper pins the manifest's sha256
(`bun scripts/gate-manifest.ts pin`) and prints it as `gate manifest sha256:`. The pin is
refused unless the manifest passed and records exactly one verified `cli` and one verified
`package` artifact with matching before/after hashes. After the benchmark,
`bun scripts/gate-manifest.ts artifacts MANIFEST SHA256` requires the manifest to still have
the pinned hash, rehashes the binary and the package against the original before-test hashes,
requires the binary's `.sha256` file to name that hash, and requires the package to be the only
`.tgz` in its directory. The final
output names the pinned manifest and then the binary and package paths as that check verified
them. The wrapper never rewrites `manifest.json`; a manifest or artifact changed during the
benchmark, or an extra archive beside the tested one, fails the release check.

The native binary is `bin/relembra`, whose hash the manifest verifies after tests. For the gate
alone, `scripts/ci.sh [DIR]` accepts an absolute directory that does not yet exist; without it,
the gate creates `.scratch/ci/ci-<time>-<suffix>/`. Preserve failed attempts and logs. A later
pass does not erase a failure or prove an unrun step.

Strict latency acceptance requires seed 20261030, the pinned 20,000-memory corpus, at least
50 warm-ups, 500 warm measurements and 30 cold measurements after 3 warm-ups. Bun and Node
must each have complete finite nonnegative samples. Raw nearest-rank warm find p95 must be
<=50 ms on both; display rounding cannot grant a pass. Rebuild determinism, unchanged reads,
SQLite integrity and stable available clean input/runtime identity must pass too. Cold latency
and contended baseline runs are diagnostic. Standalone exploratory runs omit `--check` and do
not enforce the latency budget; `--out` and `--work` choose output/work parents.

Compatibility remains Node >=24.14 and Bun >=1.4. Report only the actual local OS/architecture,
Bun version/revision, Node version, resolved executable hashes and SQLite versions measured.
Hosted CI adds Linux/macOS and Node 24.14/26 coverage on every push and pull request; local
evidence does not attest those cells. Local release acceptance additionally binds
provenance and latency. Report performance only from the candidate's recorded measurements.

## Candidate and asset binding

Record final evidence in `docs/eval/release-<version>.md` after acceptance. Include the
candidate SHA/input digest, exact commands/exits, attempt paths relative to the repository, the
manifest/benchmark hashes, actual runtime/platform identities, eval verdicts, raw p95s and every
retained failure. Do not substitute a historical report for the final candidate. Report-only
commits may follow only when every relevant input is identical to the measured candidate (the
comparison in AGENTS.md); otherwise rerun acceptance. Record the final release commit and its
relationship to the candidate.

Independent review, verification and the security deploy gate on the exact final commit are
prerequisites. Bind that commit to the tested native Mac binary, published as
`relembra-darwin-arm64`, its `SHA256SUMS` entry and the retained `relembra-<version>.tgz`, and
record asset names and hashes beside the gate/benchmark hashes. Renaming the binary must preserve
its bytes; the checksum entry must name the release asset.

`--aot` cannot cross-compile, so the other binaries come from the hosted CI run of the push to
`main` that made the final commit: its `cli` job builds each platform natively with the Bun
pinned in `build/bun-toolchain.txt`, and `bun-linux` and `bun-native` run the suite against
those exact binaries. Every job of that run must pass. Download the artifacts into an empty
directory, check each against the `relembra.sha256` beside it, and rename without changing bytes:

| Artifact | Release asset |
|---|---|
| `relembra-cli-linux-x64/relembra` | `relembra-linux-x64` |
| `relembra-cli-linux-aarch64/relembra` | `relembra-linux-arm64` |
| `relembra-cli-windows-x64/relembra.exe` | `relembra-windows-x64.exe` |
| `relembra-cli-windows-aarch64/relembra.exe` | `relembra-windows-arm64.exe` |

```sh
gh run download <run-id> --dir <empty-dir> --pattern 'relembra-cli-*'
```

Record the run id, its commit (which must be the final commit), the Bun revision each job
printed, and every binary's sha256 in the evidence record. The macOS artifact of that run is a
second build, not the release binary: the release ships the locally gated one.

## Publication

`scripts/deploy.sh` runs this section, in two stages, and the steps below say what each does, so
the two cannot drift. Run a step by hand only when the script refuses and its reason has been dealt
with.

```sh
scripts/deploy.sh hmo --run <main run id> --release-check <.scratch/release/release-...>
scripts/deploy.sh prd
```

`hmo` writes nothing outside `.scratch/deploy/<version>/`. It refuses unless the working tree is
clean and HEAD is `origin/main`; `package.json`, `src/version.ts` and a `## [<version>]` CHANGELOG
section agree; no `v<version>` tag exists anywhere; the release check finished (its
`release-check.json`, which `scripts/check-release.sh` writes after its last check, names a gate
manifest whose bytes are unchanged) and verified the current `bin/relembra` and a retained archive
named `relembra-<version>.tgz`, on the same relevant inputs as HEAD (by content, so a squash that
keeps the tree is accepted); a production security gate record for HEAD's tree is `pass` or
`waived`, independently accepted, every waiver with a valid expiry still ahead; and the named
hosted run is the `ci` workflow's push to `main` for HEAD, completed, with at least one job and
every job green. It then downloads that run's artifacts, checks each against its
`relembra.sha256`, lays out the seven assets under their release names, writes `SHA256SUMS`, the
notes (the CHANGELOG section plus the asset paragraph and the gate verdict), and `plan.json`,
which records every asset's sha256; and runs `scripts/stage-release.ts` on the result, so an
archive `release.yml` would refuse is caught before anything is public.

`prd` publishes that plan and nothing else, in the order below, after rechecking every asset and
`SHA256SUMS` against the hashes in `plan.json`, the gate record (a waiver may have expired since
`hmo`), and that HEAD and `origin/main` are still the plan's commit; `origin/main` is checked
again right before the Pages dispatch, which deploys `main` as the remote has it at that moment: tag
(annotated with the gate verdict), push the tag, draft release with every asset, download and
check the draft's assets, publish, follow the `release.yml` run and bind the staged archive to the
release's by sha1, dispatch and follow `pages.yml`, then download the published assets and check
them again, and write `.scratch/deploy/<version>/published.json` with what the evidence record
needs. Until the draft is published every step can be undone, and a failure prints the commands
that undo it; after that a failure is reported and nothing is undone, because a published release
is immutable. When publishing itself reports an error, the script reads the release back before
deciding which of the two it is, and when that read fails too it reports the state as unknown and
offers no undo. The script runs on bash 3.2 or later, with `sha256sum` or
`shasum`.

Before publishing, check that no `refs/tags/v<version>` exists yet, peeled ref included
(`git ls-remote --tags origin`); a collision blocks the release. Then, in this order:

1. Tag the final commit (`git tag -a v<version>`) and push the tag.
2. Create the GitHub release as a draft with every asset attached, then publish it.
   `SHA256SUMS` must list every binary and the retained archive. With immutable releases enabled
   on the repository, the published release's assets and tag can no longer change:

   ```sh
   gh release create v<version> --verify-tag --draft --prerelease --title v<version> \
     --notes-file <notes> relembra-darwin-arm64 relembra-linux-x64 relembra-linux-arm64 \
     relembra-windows-x64.exe relembra-windows-arm64.exe SHA256SUMS relembra-<version>.tgz
   gh release edit v<version> --draft=false
   ```

   Download the published assets into an empty directory and compare their hashes with the
   evidence record before installing.
3. Publishing the release runs `.github/workflows/release.yml`. It downloads the release's
   archive and `SHA256SUMS`, refuses an archive whose bytes, name, version or manifest do not
   match (`scripts/stage-release.ts`), and stages those exact bytes on npm through trusted
   publishing, under the dist-tag the manifest declares (`beta` for a prerelease). Staging
   makes nothing installable and needs no stored token; the job's npm provenance names the
   workflow run. If the job fails, fix the cause and re-run it; the release cannot change.
4. Approve the staged version from a terminal; the approval asks for the owner's two-factor
   key. Approve only a release you published, and check what npm itself read first, since the
   workflow's checks catch release mistakes, not a crafted archive:

   ```sh
   npm stage list relembra
   npm stage view <stage-id>         # version and dist-tag must be the release's
   npm stage download <stage-id>     # its sha256 must equal the archive's in SHA256SUMS
   npm stage approve <stage-id>
   ```

   Then check that `npm view relembra@<version> dist.integrity` equals the archive's SRI value,
   and that `npm view relembra dist-tags` points `beta`, not `latest`, at a prerelease:

   ```sh
   printf 'sha512-%s\n' "$(openssl dgst -sha512 -binary <tgz> | base64 | tr -d '\n')"
   ```

   A staged version that must not ship is removed with `npm stage reject <stage-id>`.

The npm trust configuration lets only this workflow, in this repository, stage the package; it
cannot publish without the approval. The owner creates it once, from a terminal:

```sh
npm trust github relembra --repo mneves75/relembra --file release.yml --allow-stage-publish
npm trust list relembra
```

Renaming the workflow file or the repository breaks it until the configuration is replaced
(`npm trust revoke`, then the command above).

## Mac installation and rollback

Installation targets `~/.local/bin/relembra` on macOS arm64. Before replacement, retain the
existing executable and sha256 as a rollback artifact. Use `install.sh` from a checkout of the
release tag with the downloaded binary and checksum file:

```sh
sh install.sh relembra-darwin-arm64 SHA256SUMS
```

The installer verifies the copied bytes before replacing the destination. Compare the installed
binary's sha256 with both the release checksum and recorded tested binary hash. There is no
`--version` flag: check the version through an export's `relembra: "<version>"` header instead.

In a disposable directory, set explicit disposable `RELEMBRA_HOME` and `RELEMBRA_SCOPE` and
clear inherited `RELEMBRA_GLOBAL_SCOPE`. Run `relembra init` there first to create the test store,
then help, representative note/find/wake/export/check behavior and invalid inputs (blank,
malformed, oversized). Verify export metadata there. Benchmark the installed executable with
`bun bench/cli.ts --binary <installed-path> --size 20000 --seed 20261031 --runs 50`.
Never open `~/.relembra` or migrate live memory as part of release verification. Record installed
bytes, per-flow exits and benchmark evidence.

On failure, put the saved executable back and verify its saved hash; leave live stores untouched.
Retain rollback and security evidence through acceptance, then clean only task-owned temporary
resources. Publication and installation completion require their own observed evidence.

For a leaked credential, a lost laptop or a bad published version, see [RUNBOOK.md](RUNBOOK.md).
