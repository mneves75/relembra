# Working notes

What worked and what did not in this repository's tooling and releases, for the next session.
Dated entries, newest first. Keep out secrets, local paths, private names and session identifiers;
the repository is public. Code and procedure live in their own files; this file holds only what
those files cannot say: the mistake, the dead end, the thing that turned out to matter.

## 2026-11-11: 1.0.0-beta.6 (audit fixes, the rebuilt site)

- `npm deprecate "relembra@<1.0.0-beta.6" …` also matched `0.0.0-stage`: npm's range match for
  deprecation takes prereleases of every version, where a strict semver check says that range
  excludes it. Dry-run and read the whole list, not its last lines. The command needs the
  owner's interactive terminal: from a shell without one it fails with `EOTP`.
- Owner decision, 2026-11-11, for the next gate: W-NV1 is closed as a documented boundary
  (`docs/specs/w-nv1/spec.md`), and the SEC-20 waiver is renewed to 2027-02-28. Releases through
  1.0.0-beta.6 keep the waivers they shipped with; their records are not rewritten.

- Scratch for a verifier or a second checkout goes outside the repository, or under an ignored
  path. A checkout nested in the tree brings its own `biome.json`, and `bun run lint` then fails
  on a nested root; `.gitignore` now lists `/.claude/worktrees/` for that reason.
- `scripts/pack-smoke.ts` installs its consumer under the temporary directory and asserts that the
  optional peer cannot be resolved. With `TMPDIR` inside the checkout, Node finds the peer in the
  checkout's own `node_modules` and the smoke test fails: a layout fault, not a package fault.
- The pseudo-terminal tests (`test/cli/race.test.ts`, `test/cli/trust.test.ts`) need a real
  terminal as well as python3. In a sandbox without one they fail with `no-tty`; that is the
  environment's answer, not the code's.
- Two store-building tests take 11 to 32 s on a good hosted Windows run and two to three times
  that on a bad one. Their limits are scaled on `win32` only; a red `bun (windows-latest)` lane
  with only those two timeouts is the runner.
- A full-page screenshot of the site taken while an entrance animation runs shows blank bands and
  a half-drawn highlight. Measure `document.documentElement.scrollHeight` and capture after the
  page settles before calling anything a defect.
- A hosted build job that fails at the pinned-Bun download (`curl: (35) … Connection was reset`)
  is the registry, not the repository: `gh run rerun <id> --failed` re-runs it and the lanes
  skipped behind it, and `hmo` then accepts the run on its second attempt.
- An acceptance brief that says more than was measured gets rejected on that sentence even when
  the candidate is sound ("all four tests fail on the old code" when two are controls). State what
  each test does on the old code, one by one.
- An audit claim about a script is checked by reading what the script calls, not only the script:
  `deploy.sh` never names `tar`, and still needs it through `scripts/stage-release.ts`.

## 2026-11-10: deploy.sh follow-ups

- A bare `mktemp` on this macOS ignores `TMPDIR`, so a test that points `TMPDIR` at an empty
  directory and checks it stays empty passes whether or not the script leaks. A `mktemp` shim
  first on PATH that writes into the test's directory and logs each file is the reliable check.
- `prd`'s `since` comes from the `Date` header of `gh api -i rate_limit`, which the `gh` shim
  serves from `date-header` in the fixtures; a fake `date` ahead of real time is how the skew is
  tested.

## 2026-11-04: release tooling (scripts/deploy.sh, scripts/init.sh)

- First real use (1.0.0-beta.5, the same day): `hmo` and `prd` ran end to end with no refusal
  and no manual step, about four minutes for `prd`, most of it waiting for `release.yml` and
  `pages.yml`. Real `gh` output matched the shim. The one message the tests did not model is
  GitHub's "Bypassed rule violations for refs/tags/v…: Cannot create ref due to creations being
  restricted" on the tag push: the ruleset restricts tag creation and the owner's role bypasses
  it. The clock was 1 s off GitHub's `Date` header; `prd` now reads that header itself (G-6).
- Hosted CI red while the Mac is green usually means the test, not the script: a test name that
  touched `spawnSync("/bin/bash").stdout` where there is no `/bin/bash` (Windows collects skipped
  files too), a PATH that hid `/usr/bin` to remove one tool (Linux keeps everything there), and
  process-spawning tests over Bun's 5 s default on two-core runners (`setDefaultTimeout`). A
  `node:24-bookworm` container with `npm i -g bun` reproduces the Linux lane in a minute.
- Three releases (beta.2 to beta.4) were published by hand from `docs/RELEASE.md`, and two
  sessions once held the same "go" for the same tag at the same time. The immutable tag is the one
  step that cannot be undone, so `scripts/deploy.sh hmo` refuses a tag that exists on origin before
  anything else, and `prd` checks again right before tagging. Ask who holds a release before
  touching its tag.
- A squash merge keeps the tree and changes the commit, so a release check bound to a commit would
  refuse the release commit. `hmo` binds HEAD to the release check by the relevant inputs
  (`scripts/evidence.ts`, `inputs.files`), not by commit; the gate record is found by tree.
- Security gate records sit under a commit's name in some folders and a tree's in others. Find them
  by content (`production.json`'s `tree`), never by directory name.
- The `release.yml` log prints the npm integrity abbreviated (`sha512-…[...]…`). Bind the staged
  archive by the full `npm notice shasum` (sha1) and compute the SRI locally for the record.
- `gh workflow run` and a release event give no run id back. Find the run by workflow, event,
  `headSha` and `createdAt` after the dispatch, then `gh run watch --exit-status`.
- Hosted CI's `cli binary` job logs do not print the Bun revision; the pin in
  `build/bun-toolchain.txt` is the record.
- Tests of a shell script that drives `gh`: a `gh` shim first on PATH that serves fixtures and logs
  every call, a bare repository as origin, and `realpath` on the temporary directory (macOS's
  temp dir is a symlink, and `git rev-parse --show-toplevel` returns the real path). A fixture
  `package.json` without `"type": "module"` makes Node print a MODULE_TYPELESS warning on stderr.
- The first review of `deploy.sh` found three classes of defect worth remembering in any shell
  tool: a checksum file verified against itself vouches for nothing (bind bytes to a record the
  file cannot rewrite, here `plan.json`); a function that `exit`s inside `$(...)` ends only the
  subshell, so every `x=$(...)` that can fail needs its own `|| refuse`, and a poll loop must not
  live in a subshell; and dates compared as strings accept `"undefined"` and day-first dates as
  the future. Also: a stock Mac's `/usr/bin/env bash` is 3.2, where `${x^^}` is a bad substitution
  and `"${empty[@]}"` is unbound under `set -u`; the tests run the script with `/bin/bash` too.
- The second review (Sol) added four: a checksum file verified as a whole need not name the file
  you are about to ship (read the entry for that name, as `install.sh` does); `Date.parse` turns
  2027-02-29 into March 1, so a date is valid only when it round-trips; when publishing fails and
  the read-back fails too, the state is unknown and no undo may be offered; and `gh workflow run
  --ref main` deploys what the remote's `main` is at that moment, so `prd` must check that
  `origin/main` is still the planned commit before it publishes, and again right before the
  dispatch, since npm staging takes minutes. A third pass added that a plan saved by `hmo` is
  stale evidence: `prd` re-runs the gate record check, because a waiver can expire in between.
  A fourth: a substring match on the site (`grep -F 1.2.3`) is satisfied by a stale page naming
  `1.2.3-beta.1`; count the whole version, with boundaries on both sides.
- `check-release.sh` used to leave no proof that it finished: `identity-final.json` was created by
  redirection before the last checks ran. It now writes `release-check.json` last, naming the
  pinned manifest's sha256, and `deploy.sh` requires it.

## 2026-11-03: Windows store folders (1.0.0-beta.4)

- `Directory.CreateDirectory(path, DirectorySecurity)` on .NET Framework writes the protected DACL
  without the auto-inherit mark (`D:P`, not `D:PAI`); re-apply it with `SetAccessControl` and
  assert the read-back. A file written by the runtime's `openSync` carried its own explicit DACL,
  which first looked like a folder problem.
- Two processes creating the same store at once: refusing every existing leaf folder breaks the
  loser. The creators are serialised by a named mutex and the loser adopts the winner's folder
  after verifying its descriptor (`docs/specs/w-nv1/spec.md`).
- `ConvertFrom-Json` timed out on the arm64 Windows runner; `JavaScriptSerializer` did not.
- Node 24.14 prints an ExperimentalWarning for `node:sqlite` on a child's stderr; a test that
  expects an empty stderr from a killed child must filter it (`test/platform-support.ts`).

## 2026-11-02: path precondition (1.0.0-beta.3)

- A drive root's `icacls /save` output has no name line and its SACL sits on the DACL's line.
- Under Bun, `mkdtemp` on Windows gives explicit user, SYSTEM and Administrators entries, so a
  read-back counts 3 entries, not 1.
- `autoreview` discards its review when a commit lands during the run: commit before or after,
  never during.
