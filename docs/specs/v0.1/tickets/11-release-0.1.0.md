# 11: Release 0.1.0

**What to build:** Cut 0.1.0 after the v0.1 gates pass locally.

**Blocked by:** 08, 09, 10, 19

**Status:** ready-for-agent

- [ ] Local gates pass: leaks 0, scope denial 100%, non-empty retrieval and wake coverage, hit@5 at or above the pinned baseline floor
- [ ] Version 0.1.0 in package.json; CHANGELOG entry; README with install and quick start; docs/CLI.md and docs/FORMAT.md current
- [ ] `install.sh` verifies a sha256 (good and tampered file tested)
- [ ] npm publish and GitHub release binaries are NOT done without the owner's explicit go
