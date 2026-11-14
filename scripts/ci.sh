#!/usr/bin/env bash
# The checks of .github/workflows/ci.yml, on this machine, bound to one committed candidate.
# It is the release gate; hosted CI runs the same checks on more platforms (AGENTS.md, "Checks").
#
#   scripts/ci.sh [DIR]
#
# Steps that do not depend on each other run at the same time; each writes its own log, command
# and exit code into the attempt directory: DIR (an absolute path that must not exist yet) or a new
# .scratch/ci/ci-<time>-XXXXXX. The required steps, the candidate's identity before and after
# (scripts/evidence.ts: commit, every relevant input, Bun and Node) and the hashes of the tested
# artifacts go into its manifest.json (scripts/gate-manifest.ts), which starts as "pending" and
# says "pass" only when every required step exited 0, the candidate was committed and did not
# change, and the CLI binary and the package tarball are the bytes that were tested. Exit 0 only
# then. The tarball stays in DIR/package, installed by both Node and Bun.
#
# Needs Docker (scripts/with-postgres.sh), gitleaks, and zizmor or uvx. It covers one platform and
# one Node: the workflow's other cells (the CLI built and tested on Linux x64 and arm64, macOS arm64
# and Windows x64 and arm64, Node 24.14 and 26 on Linux and Windows) and its informational
# pi-durable@latest probe run on every push to main and pull request, or when it is dispatched.
set -u

# Inherited settings that would change or skip what the gate runs, refused by name before any Bun
# or Node starts: under BUN_OPTIONS=--version, for one, every `bun` prints its version and exits 0
# without doing its work. RELEMBRA_SKIP_BUILD_TOOLCHAIN=1 would skip the build toolchain tests.
unsafe=$(env | awk -F= '/^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_BE_BUN|BUN_BYTECODE_ORDER_OUT|BUN_JSC_[A-Za-z0-9_]*|JSC_[A-Za-z0-9_]*|RELEMBRA_SKIP_BUILD_TOOLCHAIN)=./ { print $1 }' | sort -u | tr '\n' ' ')
if [ -n "$unsafe" ]; then
  echo "scripts/ci.sh: refusing to run with ${unsafe}set; unset them" >&2
  exit 2
fi

# The repository this script belongs to, never one CDPATH points at; nothing runs elsewhere.
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || {
  echo "scripts/ci.sh: cannot enter the repository" >&2
  exit 1
}
cd -- "$root" || exit 1

if [ "$#" -gt 0 ]; then
  case $1 in
  /*) mkdir -- "$1" || exit 1 ;;
  *)
    echo "scripts/ci.sh: the attempt directory must be an absolute path" >&2
    exit 1
    ;;
  esac
  logs=$1
else
  mkdir -p .scratch/ci || exit 1
  logs=$(mktemp -d "$root/.scratch/ci/ci-$(date +%Y%m%d-%H%M%S)-XXXXXX") || exit 1
fi
printf '{\n  "verdict": "pending",\n  "complete": false\n}\n' >"$logs/manifest.json" || exit 1
began=$SECONDS

# step NAME COMMAND...: runs COMMAND in the background, logging to $logs/NAME.log. NAME.cmd is
# written when it starts and NAME.rc only when it ends, so a killed step has no exit code.
step() {
  local name=$1
  shift
  printf '%s\n' "$*" >"$logs/$name.cmd"
  (
    local start=$SECONDS
    "$@" >"$logs/$name.log" 2>&1
    echo "$? $((SECONDS - start))" >"$logs/$name.rc"
  ) &
}

passed() { [ -f "$logs/$1.rc" ] && [ "$(cut -d' ' -f1 "$logs/$1.rc")" = 0 ]; }

# zizmor as installed, else the version the workflow's zizmor-action is checked against.
zizmor_cmd() {
  if command -v zizmor >/dev/null; then zizmor "$@"; else uvx zizmor@1.31.1 "$@"; fi
}

# One tarball, kept in the attempt directory: the allowlist check builds dist/, the tarball is
# packed from it and hashed, then Node and Bun each install that same file.
pack_stage() {
  node scripts/pack-check.ts &&
    mkdir "$logs/package" &&
    npm pack --ignore-scripts --pack-destination "$logs/package" &&
    set -- "$logs"/package/*.tgz &&
    [ "$#" = 1 ] && [ -f "$1" ] &&
    bun scripts/gate-manifest.ts record "$logs" package "$1" &&
    node scripts/pack-smoke.ts --tarball "$1" &&
    bun scripts/pack-smoke.ts --tarball "$1"
}

# The candidate as committed; anything uncommitted stops the gate here.
step identity sh -c 'bun scripts/evidence.ts >"$1"' identity "$logs/identity-before.json"
wait

if passed identity; then
  step install bun install --frozen-lockfile
  wait
fi

if passed install; then
  step lint bun run lint
  step typecheck bun run typecheck
  step gitleaks gitleaks git --no-banner --redact
  step zizmor zizmor_cmd .github/workflows
  # Built for this candidate, never a cached binary, and hashed before any test runs it.
  step cli sh -c 'bun build/cli.ts --force && bun scripts/gate-manifest.ts record "$1" cli "$2"' \
    cli "$logs" "$root/bin/relembra"
  wait
fi

if passed cli; then
  # The binary this run built, whatever RELEMBRA_BINARY the shell exported.
  step tests scripts/with-postgres.sh env RELEMBRA_REQUIRE_BINARY=1 \
    RELEMBRA_BINARY="$root/bin/relembra" bun run test:all
  step node bun run test:node
  step pack pack_stage
  step sbom sh -c 'npm sbom --sbom-format cyclonedx >"$1"' sbom "$logs/relembra.cdx.json"
  step eval bun run eval --out "$logs/eval"
  wait
fi

# Also after a failure: the manifest says whether the inputs moved.
step identity-after sh -c 'bun scripts/evidence.ts --expect "$1" >"$2"' identity-after \
  "$logs/identity-before.json" "$logs/identity-after.json"
wait

bun scripts/gate-manifest.ts finish "$logs"
finished=$?
printf 'total %ss\nmanifest: %s\n' $((SECONDS - began)) "$logs/manifest.json"
# The manifest's verdict decides, so a Bun that exits 0 without running the script cannot pass.
if [ "$finished" = 0 ] && grep -qx '  "verdict": "pass",' "$logs/manifest.json"; then exit 0; fi
exit 1
