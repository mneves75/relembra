# Working notes

What worked and what did not in this repository's tooling and releases, for the next session.
Dated entries, newest first. Keep out secrets, local paths, private names and session identifiers;
the repository is public. Code and procedure live in their own files; this file holds only what
those files cannot say: the mistake, the dead end, the thing that turned out to matter.

## 2026-11-04: release tooling (scripts/deploy.sh, scripts/init.sh)

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
