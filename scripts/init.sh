#!/bin/sh
# Sets a checkout up for AGENTS.md's checks: confirms the tools and their versions, installs the
# pinned dependencies (which enables the pre-push hook) and builds the CLI binary the tests run.
#
#   scripts/init.sh           # check, install, build
#   scripts/init.sh --check   # only report the tools
#
# Required: git, bun >= 1.4, node >= 24.14, gitleaks, and zizmor or uvx (scripts/ci.sh runs the
# scanners). Optional, reported when absent: docker (the Postgres tests), gh (scripts/deploy.sh)
# and shellcheck (lints these scripts). Exit codes: 0 ready, 1 a required tool is missing or old
# (every problem is listed), 2 usage.
set -u

usage() {
  echo "usage: scripts/init.sh [--check]" >&2
  exit 2
}

check_only=0
case $# in
0) ;;
1) [ "$1" = --check ] || usage; check_only=1 ;;
*) usage ;;
esac

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || {
  echo "init.sh: cannot enter the repository" >&2
  exit 1
}
cd -- "$root" || exit 1

problems=0
problem() {
  echo "init.sh: $1" >&2
  problems=$((problems + 1))
}

# at_least VERSION MAJOR.MINOR: whether VERSION (a leading "v" allowed) is MAJOR.MINOR or newer.
at_least() {
  version=${1#v}
  have_major=${version%%.*}
  rest=${version#*.}
  have_minor=${rest%%.*}
  want_major=${2%%.*}
  want_minor=${2#*.}
  case "$have_major$have_minor" in *[!0-9]*) return 1 ;; esac
  [ "$have_major" -gt "$want_major" ] ||
    { [ "$have_major" -eq "$want_major" ] && [ "$have_minor" -ge "$want_minor" ]; }
}

if command -v git >/dev/null 2>&1; then
  echo "git: $(git --version)"
else
  problem "git is not installed"
fi

if command -v bun >/dev/null 2>&1; then
  bun_version=$(bun --version)
  if at_least "$bun_version" 1.4; then
    echo "bun: $bun_version (>= 1.4)"
  else
    problem "bun $bun_version is older than 1.4 (AGENTS.md)"
  fi
else
  problem "bun is not installed (https://bun.sh)"
fi

if command -v node >/dev/null 2>&1; then
  node_version=$(node --version)
  if at_least "$node_version" 24.14; then
    echo "node: $node_version (>= 24.14)"
  else
    problem "node $node_version is older than 24.14 (AGENTS.md)"
  fi
else
  problem "node is not installed (>= 24.14, AGENTS.md)"
fi

if command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks: $(gitleaks version 2>/dev/null || gitleaks --version)"
else
  problem "gitleaks is not installed (the pre-push hook and scripts/ci.sh run it)"
fi

if command -v zizmor >/dev/null 2>&1; then
  echo "zizmor: $(zizmor --version)"
elif command -v uvx >/dev/null 2>&1; then
  echo "zizmor: $(uvx --version) (uvx zizmor@1.31.1 in scripts/ci.sh)"
else
  problem "neither zizmor nor uvx is installed (scripts/ci.sh runs zizmor)"
fi

if command -v docker >/dev/null 2>&1; then
  echo "docker: $(docker --version)"
else
  echo "docker: not installed; the Postgres tests need it (scripts/with-postgres.sh)"
fi

if command -v gh >/dev/null 2>&1; then
  echo "gh: $(gh --version | head -n 1)"
else
  echo "gh: not installed; releases need it (scripts/deploy.sh)"
fi

if command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck: $(shellcheck --version | sed -n 's/^version: /version: /p')"
else
  echo "shellcheck: not installed; lints the shell scripts"
fi

[ "$problems" -eq 0 ] || exit 1

if [ "$check_only" -eq 1 ]; then
  echo "ready: run scripts/init.sh without --check to install and build"
  exit 0
fi

# The pinned dependencies; `prepare` points core.hooksPath at .githooks, so pushes are gated.
bun install --frozen-lockfile || exit 1
# The CLI tests run bin/relembra; without it they are skipped (AGENTS.md, "Checks").
bun run build:cli || exit 1
cat <<'EOF'
ready. Next:
  bun test                                  # the suite without Postgres and the binary gate
  scripts/with-postgres.sh env RELEMBRA_REQUIRE_BINARY=1 bun run test:all
  bun run typecheck && bun run lint
  scripts/ci.sh                             # the whole gate, before a merge
EOF
