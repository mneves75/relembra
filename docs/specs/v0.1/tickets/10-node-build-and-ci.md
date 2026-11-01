# 10: Node library build, subpath exports and CI

**What to build:** A Node or Bun program installs relembra from the built package and uses the core, `relembra/sqlite` and `relembra/testing`; CI runs typecheck, lint, Bun tests, the Node smoke test and the AOT build on macOS and Linux.

**Blocked by:** 03, 07 (part A needed only 03; part B needs 07)

**Status:** part A done, pending review; part B waits for 07

Part A done here; the AOT job on macos-latest and ubuntu-latest is added after 07 merges.

- [x] tsc emits ESM with .d.ts; package exports map `.`, `./sqlite` and `./testing`
- [x] A Node 24+ smoke test imports the packed tarball and runs a note-find round trip
- [ ] GitHub Actions workflow: Bun + Node matrix, AOT build on macos-latest and ubuntu-latest, gitleaks
  - [x] Part A: Bun + Node matrix and gitleaks (`.github/workflows/ci.yml`)
  - [ ] Part B: the AOT build job on macos-latest and ubuntu-latest, after 07
- [x] `npm pack --dry-run` lists no test fixtures, no .scratch and no secrets
- [x] Runtime matrix per §4.6: Node 24.14+, Node 26 and Bun 1.4+, with SQLite conformance on each; `engines` says `>=24.14`
- [x] `npm sbom` output is produced in CI

## Comments

Part A built 2026-10-31 on `feat/v0.1-t10` (from `feat/v0.1` at `01b676a`), commits `09a7efe`
to `9385be1`.

**CI has not run yet.** Run 41165840617 (head `9385be1`) failed before any job started. Each of
the eight jobs has this annotation: "The job was not started because recent account payments have
failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in
your settings". The workflow has therefore been checked locally only (below). After billing is
fixed, the CI boxes are proved by the first green run.

### Evidence per box

- **Build and exports.** `tsconfig.build.json` extends the root config. It emits from `src` to
  `dist`: `dist/index.js`, `dist/sqlite/index.js` and `dist/testing/index.js`, each with a
  `.d.ts`, and no Bun type references. `bun run build` deletes `dist` first, so a deleted module
  never ships, and `prepack` runs the build. `exports` maps the three subpaths, with `types` and
  `import` conditions, to `dist`. `files` is `dist` and `docs/FORMAT.md`; npm adds README,
  LICENSE and package.json. `"private": true` blocks an accidental publish; ticket 11 or the
  owner removes it.
- **Tests stay on source.** With the exports pointing at `dist` and no `dist` built, the old
  resolution fails: `bun test` reports "Cannot find package 'relembra'", tsc reports 155 errors,
  and `test:node` fails with ERR_MODULE_NOT_FOUND for `dist/sqlite/index.js`. With `paths` in
  `tsconfig.json` and the Node hook reading them: `bun test` 557 pass, `test:node` 98 pass, and
  typecheck and lint are clean.
- **Packed smoke.** `scripts/pack-smoke.ts` builds, runs `npm pack`, installs the tarball into a
  fresh directory under the OS temp dir, and runs `scripts/pack-smoke-consumer.js` there. The
  consumer runs on the same runtime as the script: `npm run test:pack` uses Node, and
  `bun scripts/pack-smoke.ts` uses Bun. It imports `relembra`, `relembra/sqlite` and
  `relembra/testing`, notes two memories into a temp SQLite file, and asserts:
  - `find` returns only the matching memory;
  - `recall` returns both, newest first;
  - a scope outside the policy is refused with `ScopeDeniedError`;
  - the reopened file recalls the same texts;
  - the in-memory store from `relembra/testing` round-trips.

  It passes on node v26.12.1 (npm 12), node v24.22.1 (npm 11) and bun 1.4.4. Planted faults:
  - `./sqlite`'s `import` target pointed at a missing file: it fails with ERR_MODULE_NOT_FOUND
    for `.../T/relembra-pack-*/consumer/node_modules/relembra/dist/sqlite/missing.js`. The path
    shows the consumer resolves from its own install, not from the repository.
  - A `bun` condition pointing at `src`: Bun fails with "Cannot find package 'relembra'".

  `package.json` was restored after each plant and matches the commit.
- **Pack hygiene.** `scripts/pack-check.ts` builds and reads `npm pack --dry-run --json`. It fails
  on any of these:
  - a denied path: `test/`, `eval/`, `.scratch`, `*.db` (and `-wal` or `-shm`), `.env*`, or
    `fixture` anywhere in the path;
  - a file outside the allowlist: `dist/`, package.json, README.md, LICENSE and docs/FORMAT.md;
  - an `exports` target missing from the tarball.

  It passes with 36 files. Planted faults, each restored afterwards:
  - `files` plus `test`: 41 "forbidden: test/..." lines, exit 1;
  - `files` plus eval, `.env.t10probe`, `probe-t10.db` and `docs/fixtures-probe`: all four
    reported, exit 1;
  - the broken `./sqlite` target: "exported but not packed: dist/sqlite/missing.js", exit 1;
  - `"files": []` with `"exports": {}`: six "missing export" lines, exit 1. Review found that
    the check had passed this case vacuously ("3 files, every export present"). It now requires
    `.`, `./sqlite` and `./testing`, each with `types` and `import` targets in the tarball;
  - `./testing` without `types`: "missing export: ./testing types", exit 1;
  - `"files": []` with the exports intact: six "exported but not packed" lines, exit 1.
- **Runtime matrix and SQLite conformance.** These jobs do the work:
  - `node (24.14)` and `node (26)` run `test:node`, which includes the SQLite and memory store
    conformance suites under `node:test`. They then run the smoke under Node and under Bun, and
    the pack check.
  - `bun (ubuntu-latest)` and `bun (macos-latest)` run `bun test`, which includes the SQLite
    conformance suite under Bun.
  - `engines` is `>=24.14`, and the matrix floor is 24.14, so the floor itself is tested.

  Locally, `test:node` passes on node v26.12.1 and v24.22.1. Node 24.14.x itself is not
  installed here.
- **CI.** `.github/workflows/ci.yml`, triggered by push (main, `feat/**`) and pull_request:
  - Top-level `permissions: contents: read`; no job raises it.
  - Concurrency per ref; only pull-request runs are cancelled.
  - Every job has a timeout. Checkout uses `persist-credentials: false`.
  - Every action is pinned to a full SHA with its tag. Each SHA was checked with
    `gh api repos/<o>/<r>/commits/<tag>`, including upload-artifact v7.0.2 `cf430e0`.
  - Jobs: `check`, `bun (ubuntu-latest)`, `bun (macos-latest)`, `node (24.14)`, `node (26)`,
    `gitleaks`, `sbom`, `zizmor`.

  actionlint 1.7.12 reports 0 errors, with shellcheck present. `uvx zizmor@1.31.1 --offline .`
  reports no findings in the regular or pedantic persona; the online audits run only in CI.
- **SBOM.** `npm sbom --sbom-format cyclonedx` works on the Bun-installed tree without a
  package-lock and produces CycloneDX 1.5. The `sbom` job uploads it as the `sbom-cyclonedx`
  artifact. The SBOM lists the dev toolchain, and npm marks it `required` because it reads Bun's
  `node_modules` without a lockfile. `--omit dev` gives 0 components, because the library has no
  runtime dependencies.
- **Dependabot.** `.github/dependabot.yml` covers `github-actions` and `bun`. Each runs weekly,
  with one group, and `cooldown.default-days: 7`. The Dependabot options reference lists both
  ecosystems as supporting `default-days`. Dependabot does not see the versions written into the
  workflow: Bun 1.4.4, the Node matrix, and gitleaks 8.30.1 with its sha256. Those are bumped by
  hand.

### Decisions

- **Source resolution for tests: tsconfig `paths`.** The root `tsconfig.json` maps the three
  specifiers to `src`, and Bun and tsc both read that. Node does not read tsconfig, so
  `test/sqlite-node-resolve.ts` reads the same `paths`. This is the only test-helper change.
  Rejected, the strongest alternative: a `bun` export condition pointing at `src`. It ships in
  the published package.json, so a Bun consumer of the tarball resolves to `src`, which `files`
  leaves out. The smoke fails that way, as shown above. The other rejected option was building
  before every test run: tests would no longer run from source, and a stale `dist` could hide a
  change.
- **`test:node` runs from source, not from `dist`.** The test imports `src/sqlite` internals
  directly. Pointing only the public specifiers at `dist` would load two module graphs.
  `erasableSyntaxOnly` makes tsc's output the same JavaScript as Node's type stripping, and the
  packed smoke covers `dist` on both runtimes. The hook's old comment said ticket 10 would move
  this test to the built library; that is superseded. Rejected: `test:node` against `dist`.
- **The smoke runs the consumer on whichever runtime runs the script.** Bun resolves `exports`
  conditions with its own resolver, and Bun is a supported runtime. Rejected: a Node-only smoke.
  It would have passed with the broken `bun` condition.
- **Pack check uses a denylist, an allowlist and an export check.** Rejected: the denylist
  alone. It would let a new top-level path, such as `src/` or `docs/specs/`, ship without notice.
- **Scripts build first, then pack with `--ignore-scripts`.** A `prepack` that prints anything
  corrupts `npm pack --json` on stdout. `prepack` stays for a manual `npm pack` or
  `npm publish`. Rejected: relying on `prepack` in the scripts.
- **Nested npm calls in the smoke drop `npm_config_*` variables.** Under `npm run`, npm 11.19
  refused the nested install with EALLOWSCRIPTS: the user's `allow-scripts` setting was passed
  through as a command-line flag. Rejected: documenting a direct `node scripts/...` run instead.
  The `npm run` path is the one CI uses.
- **gitleaks: the 8.30.1 binary, verified by sha256, over the full history.** Rejected:
  gitleaks-action v3.0.0, which was briefed. Its source (`src/gitleaks.js` `Scan`,
  `src/index.js`) limits the scan:
  - on push, to `--no-merges --first-parent <first>^..<last>` of the pushed commits;
  - on a pull request, to the same range over the first page of the PR's commits, with no
    pagination (30 commits by default).

  It also defaults to gitleaks 8.24.3. The binary runs the same `gitleaks git` as the pre-push
  gate: `git log --all --full-history`, with `.gitleaksignore` honoured and `--redact` set. The
  cost: the version and checksum are bumped by hand.
- **The Node floor is 24.14, not bare `24`.** This tests the `engines` claim. Rejected:
  `24`, which tests whichever 24.x is newest.
- **zizmor uses `advanced-security: false` and `annotations: true`.** SARIF upload needs code
  scanning, which this private repository does not have. Rejected: the default SARIF upload,
  which would also need `security-events: write`.
- **The Bun consumer smoke runs in the `node` jobs, not the `bun` jobs.** The `node` jobs install
  both runtimes explicitly. The `bun` jobs would have relied on the runner's preinstalled Node
  for npm. Rejected: adding setup-node to the `bun` jobs.
- **Concurrency cancels only pull-request runs, as briefed.** Rejected:
  `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`. It would also cancel superseded
  pushes to feature branches and save minutes on this private repository.
