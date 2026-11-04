#!/bin/sh
# The local release check, on one candidate from start to end: the whole gate (scripts/ci.sh),
# then the strict latency benchmark (bench/eval-latency.ts --check), one after the other, so
# nothing else runs while it measures. It stops at the first failure and never dispatches hosted
# CI.
#
#   scripts/check-release.sh
#
# The candidate is the one the gate's first snapshot names (gate/identity-before.json): the
# benchmark's record must name it before and after the measurement, and the checkout must still be
# it at the end, so two clean runs on different commits cannot make a release. The first Bun this
# starts runs inside ci.sh, behind its guard against inherited runtime overrides. Each run keeps
# everything in its own .scratch/release/release-<time>-XXXXXX: gate/ (manifest.json, step logs,
# the tested tarball), bench/ (the benchmark attempt with its raw samples) and
# identity-final.json. After the gate it pins the manifest's sha256, before the benchmark; at the
# end the manifest must still have it, and the binary and the package it names must still be the
# tested bytes, the package alone in its directory. The paths printed at the end are those.
set -u

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || {
  echo "release check FAILED: cannot enter the repository" >&2
  exit 1
}
cd -- "$root" || exit 1
mkdir -p .scratch/release || exit 1
run=$(mktemp -d "$root/.scratch/release/release-$(date +%Y%m%d-%H%M%S)-XXXXXX") || exit 1
echo "release check: $run"

fail() {
  echo "release check FAILED: $1" >&2
  echo "kept: $run" >&2
  exit 1
}

manifest=$run/gate/manifest.json
scripts/ci.sh "$run/gate" || fail "gate ($manifest)"
# Pinned in this shell before the benchmark starts: the final check accepts only these bytes, so a
# manifest rewritten later, however consistent with itself, cannot name what is released.
pinned=$(bun scripts/gate-manifest.ts pin "$manifest") || fail "gate manifest ($manifest)"
[ "${#pinned}" = 64 ] || fail "gate manifest: no sha256 ($manifest)"
case $pinned in *[!0-9a-f]*) fail "gate manifest: no sha256 ($manifest)" ;; esac
echo "gate manifest sha256: $pinned"
bun bench/eval-latency.ts --check --out "$run/bench" --work "$run/work" ||
  fail "benchmark (exit $?, $run/bench)"
set -- "$run"/bench/bench-*/bench.json
{ [ "$#" = 1 ] && [ -f "$1" ]; } || fail "benchmark: no record in $run/bench"
record=$1
bun scripts/gate-manifest.ts bench "$run/gate/identity-before.json" "$record" ||
  fail "benchmark ($record)"
bun scripts/evidence.ts --expect "$run/gate/identity-before.json" >"$run/identity-final.json" ||
  fail "candidate (changed since the gate, $run/identity-final.json)"
# The tested binary and the one package archive, as the pinned manifest names them, rechecked.
verified=$(bun scripts/gate-manifest.ts artifacts "$manifest" "$pinned") ||
  fail "artifacts (changed since the gate, $manifest)"
case $verified in *"package: "*) ;; *) fail "artifacts: none verified ($manifest)" ;; esac

# Written last, after every check above passed: what scripts/deploy.sh reads to know this run
# finished, and which manifest bytes it finished on. Nothing earlier in the run writes it.
json_string() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
printf '{\n  "passed": true,\n  "manifest": "%s",\n  "manifestSha256": "%s",\n  "benchmark": "%s",\n  "finishedAt": "%s"\n}\n' \
  "$(json_string "$manifest")" "$pinned" "$(json_string "$record")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >"$run/release-check.json" || fail "cannot write $run/release-check.json"

echo "release check passed"
echo "gate manifest: $manifest (sha256 $pinned)"
echo "benchmark: $record"
echo "$verified"
