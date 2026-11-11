#!/usr/bin/env bash
# The "Publication" section of docs/RELEASE.md as a program, in two stages that write nothing the
# other needs to undo.
#
#   scripts/deploy.sh hmo --run <main CI run id> --release-check <.scratch/release/release-...>
#   scripts/deploy.sh prd
#
# hmo (homologação) touches nothing outside .scratch/deploy/<version>/: it binds HEAD to the
# release check (the gated binary, the retained archive, the same relevant inputs, and the marker
# scripts/check-release.sh writes last), to the hosted CI run of the push to main (every job green
# on this commit) and to the security gate record (pass or waived, independently accepted, no
# expired waiver); downloads the hosted binaries and checks each against the checksum beside it;
# lays out the seven release assets under their release names with SHA256SUMS and the release
# notes from CHANGELOG.md; and writes plan.json, which records every asset's sha256. It can be
# rerun after removing that directory.
#
# prd (produção) publishes that plan and nothing else, in docs/RELEASE.md's order: rechecks every
# asset against plan.json, tags HEAD with the gate verdict, pushes the tag, creates the draft
# release with every asset, downloads the draft's assets and checks them, reads GitHub's clock,
# publishes, follows the release.yml run and binds the staged npm archive to the release's by its
# sha1, dispatches pages.yml and follows it, then downloads the published assets and checks them
# again.
# published.json holds what the evidence record needs. Until the release is published every step
# can be undone, and a failure prints the commands that undo it; after it, a failure is reported
# and nothing is undone, because a published release is immutable.
#
# Needs bash 3.2 or later, git, gh (signed in), bun and node, curl, tar (for
# scripts/stage-release.ts), openssl, and sha256sum and sha1sum or shasum. Exit codes: 0 done,
# 1 refused or failed (the reason on stderr), 2 usage.
# RELEMBRA_DEPLOY_POLL (seconds between polls, default 20) and RELEMBRA_DEPLOY_TIMEOUT (seconds to
# wait for a workflow run, default 1200) exist for the tests.
#
# shellcheck disable=SC2016  # the node -e programs below are single-quoted on purpose
set -uo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/deploy.sh hmo --run <main CI run id> --release-check <release check directory>
       scripts/deploy.sh prd
EOF
  exit 2
}

refuse() {
  echo "deploy.sh: $1" >&2
  exit 1
}

# Every path printed or compared is the checkout's real path; the tests resolve theirs the same way.
root=$(git rev-parse --show-toplevel 2>/dev/null) || refuse "not in a git repository"
cd -- "$root" || exit 1

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | cut -d ' ' -f 1; }
  sha1_of() { sha1sum "$1" | cut -d ' ' -f 1; }
  check_sums() { sha256sum -c "$1"; }
else
  hash_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
  sha1_of() { shasum -a 1 "$1" | cut -d ' ' -f 1; }
  check_sums() { shasum -a 256 -c "$1"; }
fi
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

# json FILE PATH: a value from a JSON file by dotted path; strings bare, anything else as JSON.
# Exit 3 when the path is absent, so a caller can tell "missing" from "empty".
json() {
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const found = process.argv[2].split(".").reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), value);
    if (found === undefined) process.exit(3);
    process.stdout.write(typeof found === "string" ? found : JSON.stringify(found));
  ' "$1" "$2"
}

version=$(json package.json version) || refuse "package.json has no version"
tag="v$version"
plan="$root/.scratch/deploy/$version"
case $version in *-*) prerelease=1 ;; *) prerelease=0 ;; esac
head=$(git rev-parse HEAD) || exit 1
tree=$(git rev-parse 'HEAD^{tree}') || exit 1
# Temporary files, and the plan directory while hmo is still filling it, go when the script ends.
tmp_now='' tmp_view='' run_json='' plan_created=''
# shellcheck disable=SC2154  # rc is assigned inside the trap
trap 'rc=$?; rm -f "$tmp_now" "$tmp_view" "$run_json"; [ "$rc" = 0 ] || [ -z "$plan_created" ] || rm -rf "$plan"' EXIT

# ---------------------------------------------------------------------------------------------
# Shared by both stages
# ---------------------------------------------------------------------------------------------

# The remote first: a fetch brings its tags here, and the remote is what a release collides with.
no_tag_anywhere() {
  local remote
  remote=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}") ||
    refuse "cannot list origin's tags"
  [ -z "$remote" ] || refuse "tag $tag already exists on origin"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    refuse "tag $tag already exists in this checkout"
  fi
}

# In docs/RELEASE.md's order; SHA256SUMS goes between the binaries and the archive on the release.
assets=(
  relembra-darwin-arm64
  relembra-linux-x64
  relembra-linux-arm64
  relembra-windows-x64.exe
  relembra-windows-arm64.exe
  "relembra-$version.tgz"
)

# gate_check: the security gate record for HEAD's tree, into gate_record_path, gate_verdict and
# gate_waivers (ids, space-separated), or a refusal. A production record, pass or waived,
# independently accepted, every waiver with a valid expiry still ahead. Records are kept under a
# commit's or a tree's name, so they are found by content, this commit's first. Run by hmo and
# again by prd: a waiver can expire between the two.
gate_record_path='' gate_verdict='' gate_waivers=''
gate_check() {
  local record
  if ! record=$(node -e '
    const fs = require("node:fs"), path = require("node:path");
    const dir = ".scratch/security-gate";
    const [tree, commit] = process.argv.slice(1);
    const fail = (m) => { console.error(m); process.exit(1); };
    const records = fs.existsSync(dir)
      ? fs.readdirSync(dir).map((d) => path.join(dir, d, "production.json")).filter((p) => fs.existsSync(p))
          .map((p) => ({ p, r: JSON.parse(fs.readFileSync(p, "utf8")) }))
          .filter(({ r }) => r.target === "production" && r.tree === tree)
      : [];
    records.sort((a, b) => (b.r.commit === commit) - (a.r.commit === commit) || String(b.r.created_at).localeCompare(String(a.r.created_at)));
    const found = records[0];
    if (!found) fail(`no security gate record for tree ${tree} under ${dir}`);
    const { r, p } = found;
    if (r.verdict !== "pass" && r.verdict !== "waived") fail(`security gate verdict is ${r.verdict} (${p})`);
    if (r.independent_acceptance !== "pass") fail(`independent acceptance is ${r.independent_acceptance} (${p})`);
    const waivers = Array.isArray(r.waivers) ? r.waivers : undefined;
    if (r.verdict === "waived" && !(waivers && waivers.length > 0)) fail(`security gate is waived with no waivers (${p})`);
    for (const w of waivers ?? []) {
      if (typeof w.id !== "string" || w.id === "") fail(`a waiver has no id (${p})`);
      // An ISO date, UTC, that exists on the calendar: Date.parse would turn 02-29 into 03-01.
      const iso = typeof w.expires === "string" ? /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/.exec(w.expires) : null;
      const expires = iso ? Date.parse(w.expires) : NaN;
      if (!Number.isFinite(expires) || !new Date(expires).toISOString().startsWith(iso[1])) fail(`waiver ${w.id} has no valid expiry (${JSON.stringify(w.expires)}, ${p})`);
      if (expires <= Date.now()) fail(`waiver ${w.id} expired ${w.expires} (${p})`);
    }
    process.stdout.write([p, r.verdict, (waivers ?? []).map((w) => w.id).join(" ")].join("\n"));
  ' "$tree" "$head" 2>&1); then
    refuse "$record"
  fi
  { read -r gate_record_path; read -r gate_verdict; read -r gate_waivers; } <<<"$record"
}

# ---------------------------------------------------------------------------------------------
# hmo
# ---------------------------------------------------------------------------------------------

hmo() {
  local run='' check=''
  while [ "$#" -gt 0 ]; do
    case $1 in
    --run) [ "$#" -ge 2 ] || usage; run=$2; shift 2 ;;
    --release-check) [ "$#" -ge 2 ] || usage; check=$2; shift 2 ;;
    *) usage ;;
    esac
  done
  [ -n "$run" ] && [ -n "$check" ] || usage
  case $run in '' | *[!0-9]*) refuse "--run takes a numeric run id, not $run" ;; esac
  [ -d "$check" ] || refuse "release check directory $check not found"
  [ -e "$plan" ] && refuse "$plan already exists; remove it to redo hmo"

  # The checkout: committed, pushed, at the version the library reports, with release notes.
  [ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "the working tree has changes"
  local library
  library=$(sed -n 's/^export const RELEMBRA_VERSION = "\([^"]*\)";.*$/\1/p' src/version.ts)
  [ "$library" = "$version" ] || refuse "src/version.ts says $library, package.json $version"
  local notes_body
  notes_body=$(awk -v heading="## [$version]" '
    index($0, heading) == 1 { on = 1; next }
    /^## / { on = 0 }
    on { print }
  ' CHANGELOG.md)
  [ -n "$(printf '%s' "$notes_body" | tr -d '[:space:]')" ] ||
    refuse "CHANGELOG.md has no \"## [$version]\" section"
  git fetch -q origin || refuse "cannot fetch origin"
  local main
  main=$(git rev-parse origin/main) || refuse "origin/main is unknown"
  [ "$main" = "$head" ] || refuse "HEAD is not origin/main (${head:0:7} vs ${main:0:7}): merge and pull first"
  no_tag_anywhere

  # The release check: finished (its marker is written after every check passed), on a manifest
  # that has not changed since, which verified these bytes.
  local marker="$check/release-check.json" manifest="$check/gate/manifest.json"
  [ -f "$marker" ] || refuse "release check did not finish: $check has no release-check.json (scripts/check-release.sh writes it last)"
  [ "$(json "$marker" passed)" = true ] || refuse "release check did not pass ($marker)"
  [ -f "$manifest" ] || refuse "release check $check has no gate/manifest.json"
  [ "$(json "$marker" manifestSha256)" = "$(hash_of "$manifest")" ] ||
    refuse "gate/manifest.json changed after the release check ($marker names another sha256)"
  local artifacts binary_sha archive_sha archive
  artifacts=$(node -e '
    const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (m.verdict !== "pass" || m.complete !== true) { console.error("the gate manifest did not pass"); process.exit(1); }
    const hex = /^[0-9a-f]{64}$/;
    const named = (name) => (m.artifacts ?? []).find((a) => a.name === name && a.verified === true && hex.test(a.sha256Before) && a.sha256After === a.sha256Before && typeof a.path === "string");
    const cli = named("cli"), pkg = named("package");
    if (!cli) { console.error("no verified cli artifact in the gate manifest"); process.exit(1); }
    if (!pkg) { console.error("no verified package artifact in the gate manifest"); process.exit(1); }
    process.stdout.write(`${cli.sha256After}\n${pkg.sha256After}\n${pkg.path}\n`);
  ' "$manifest" 2>&1) || refuse "release check $check: $artifacts"
  { read -r binary_sha; read -r archive_sha; read -r archive; } <<<"$artifacts"
  [ -f bin/relembra ] || refuse "bin/relembra is missing"
  [ "$(hash_of bin/relembra)" = "$binary_sha" ] ||
    refuse "bin/relembra is not the binary the release check tested (sha256 $(hash_of bin/relembra), tested $binary_sha)"
  [ -f "$archive" ] || refuse "the retained archive $archive is missing"
  [ "$(hash_of "$archive")" = "$archive_sha" ] ||
    refuse "$archive is not the archive the release check tested"
  [ "$(basename "$archive")" = "relembra-$version.tgz" ] ||
    refuse "the retained archive is $(basename "$archive"), not relembra-$version.tgz"
  # A squash keeps the inputs and changes the commit, so the binding is by inputs, not by commit.
  tmp_now=$(mktemp) || exit 1
  bun scripts/evidence.ts >"$tmp_now" || refuse "the inputs on disk differ from HEAD, or a runtime is missing"
  local changed
  changed=$(node -e '
    const read = (p) => JSON.parse(require("node:fs").readFileSync(p, "utf8")).inputs.files;
    const before = read(process.argv[1]), after = read(process.argv[2]);
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    process.stdout.write(paths.filter((p) => before[p] !== after[p]).join(" "));
  ' "$check/gate/identity-before.json" "$tmp_now" 2>/dev/null) ||
    refuse "cannot compare the inputs with the release check's ($check/gate/identity-before.json)"
  [ -z "$changed" ] || refuse "inputs changed since the release check: $changed"

  # The security gate record for this tree.
  gate_check
  local record_path=$gate_record_path verdict=$gate_verdict waivers=$gate_waivers gate_line
  gate_line=$(upper "$verdict")
  [ -z "$waivers" ] || gate_line="$gate_line $waivers"

  # The hosted run: the ci workflow's push to main, for this commit, finished, every job green.
  local run_sha run_status run_event run_workflow run_branch jobs red
  run_json=$(mktemp) || exit 1
  gh run view "$run" --json headSha,status,conclusion,jobs,workflowName,event,headBranch >"$run_json" ||
    refuse "cannot read run $run"
  run_sha=$(json "$run_json" headSha) || refuse "run $run has no headSha"
  [ "$run_sha" = "$head" ] || refuse "run $run is for ${run_sha:0:7}, not HEAD ${head:0:7}"
  run_workflow=$(json "$run_json" workflowName) || refuse "run $run has no workflowName"
  run_event=$(json "$run_json" event) || refuse "run $run has no event"
  run_branch=$(json "$run_json" headBranch) || refuse "run $run has no headBranch"
  if [ "$run_workflow" != ci ] || [ "$run_event" != push ] || [ "$run_branch" != main ]; then
    refuse "run $run is a $run_event of $run_workflow on $run_branch, not the ci push to main"
  fi
  run_status=$(json "$run_json" status) || refuse "run $run has no status"
  [ "$run_status" = completed ] || refuse "run $run is $run_status; wait for it"
  jobs=$(json "$run_json" jobs) || refuse "run $run has no jobs"
  red=$(printf '%s' "$jobs" | node -e '
    const jobs = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!Array.isArray(jobs) || jobs.length === 0) { process.stdout.write("has no jobs"); process.exit(0); }
    const bad = jobs.find((j) => j.conclusion !== "success");
    if (bad) process.stdout.write(`job ${bad.name} is ${bad.conclusion}`);
  ') || refuse "run $run: cannot read its jobs"
  case $red in
  '') ;;
  "has no jobs") refuse "run $run has no jobs" ;;
  *) refuse "run $run: $red" ;;
  esac
  [ "$(json "$run_json" conclusion)" = success ] || refuse "run $run concluded $(json "$run_json" conclusion)"

  # From here the plan directory exists; a refusal removes it so a retry starts clean.
  mkdir -p "$plan/dl" || exit 1
  plan_created=1
  gh run download "$run" --dir "$plan/dl" --pattern 'relembra-cli-*' || refuse "cannot download run $run's artifacts"
  local spec artifact file release dir
  for spec in linux-x64:relembra:relembra-linux-x64 linux-aarch64:relembra:relembra-linux-arm64 \
    windows-x64:relembra.exe:relembra-windows-x64.exe windows-aarch64:relembra.exe:relembra-windows-arm64.exe; do
    IFS=: read -r artifact file release <<<"$spec"
    dir="$plan/dl/relembra-cli-$artifact"
    [ -f "$dir/$file" ] && [ -f "$dir/relembra.sha256" ] ||
      refuse "run $run has no relembra-cli-$artifact artifact with $file and relembra.sha256"
    # The entry for this binary by name, as install.sh reads it: a checksum file that names other
    # files cannot vouch for it.
    local expected
    expected=$(awk -v name="$file" '$2 == name || $2 == "*" name { print $1; exit }' "$dir/relembra.sha256")
    [ -n "$expected" ] || refuse "relembra-cli-$artifact: relembra.sha256 has no entry for $file"
    [ "$(hash_of "$dir/$file")" = "$expected" ] ||
      refuse "relembra-cli-$artifact: $file does not match its relembra.sha256"
    if ! { cp "$dir/$file" "$plan/$release" && cmp -s "$dir/$file" "$plan/$release"; }; then
      refuse "could not copy relembra-cli-$artifact/$file"
    fi
  done
  cp bin/relembra "$plan/relembra-darwin-arm64"
  [ "$(hash_of "$plan/relembra-darwin-arm64")" = "$binary_sha" ] || refuse "could not copy bin/relembra"
  cp "$archive" "$plan/relembra-$version.tgz"
  [ "$(hash_of "$plan/relembra-$version.tgz")" = "$archive_sha" ] || refuse "could not copy the retained archive"
  local hosted_darwin="$plan/dl/relembra-cli-darwin-aarch64/relembra"
  if [ -f "$hosted_darwin" ]; then
    if cmp -s "$hosted_darwin" bin/relembra; then
      echo "the hosted macOS build is byte-identical to the gated binary"
    else
      echo "the hosted macOS build differs from the gated binary; the release ships the gated one (docs/RELEASE.md)"
    fi
  fi
  : >"$plan/SHA256SUMS"
  local asset_json=''
  for release in "${assets[@]}"; do
    local sum
    sum=$(hash_of "$plan/$release")
    printf '%s  %s\n' "$sum" "$release" >>"$plan/SHA256SUMS"
    asset_json="$asset_json$release=$sum"$'\n'
  done

  # Notes: the CHANGELOG section as written, then what docs/RELEASE.md says about the assets.
  local waiver_list=''
  [ -z "$waivers" ] || waiver_list=" (${waivers// /, })"
  {
    printf '%s\n' "$notes_body" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
    cat <<EOF

### Assets

\`relembra-darwin-arm64\`, \`relembra-linux-x64\`, \`relembra-linux-arm64\`, \`relembra-windows-x64.exe\`,
\`relembra-windows-arm64.exe\`, \`SHA256SUMS\` and \`relembra-$version.tgz\` (the archive the release gate
tested; npm staging publishes these bytes). Verify with \`shasum -a 256 -c SHA256SUMS\`. Install on macOS
arm64 with \`sh install.sh relembra-darwin-arm64 SHA256SUMS\` from a checkout of this tag.

Security gate: $(upper "$verdict")$waiver_list. Evidence: \`docs/eval/release-$version.md\` (follows by PR).
EOF
  } >"$plan/notes.md"

  # The last check before the stage: what release.yml will do with this archive and SHA256SUMS.
  node scripts/stage-release.ts "$tag" "$plan" >/dev/null || refuse "release.yml would refuse this archive"

  local tag_message="$tag; security gate: $gate_line"
  printf '%s' "$asset_json" | node -e '
    const [out, version, tag, commit, tree, run, prerelease, check, manifest, record, verdict, waivers, binary, archive, sums, message, notes] = process.argv.slice(1);
    const assets = Object.fromEntries(require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map((line) => line.split("=")));
    require("node:fs").writeFileSync(out, `${JSON.stringify({
      version, tag, commit, tree, run, prerelease: prerelease === "1",
      releaseCheck: check, manifest, gateRecord: record, verdict, waivers: waivers ? waivers.split(" ") : [], waiverIds: waivers,
      binarySha256: binary, archiveSha256: archive, assets, sumsSha256: sums, tagMessage: message, notes,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
  ' "$plan/plan.json" "$version" "$tag" "$head" "$tree" "$run" "$prerelease" "$check" "$manifest" \
    "$record_path" "$verdict" "$waivers" "$binary_sha" "$archive_sha" "$(hash_of "$plan/SHA256SUMS")" \
    "$tag_message" "$plan/notes.md" || refuse "could not write plan.json"
  echo "hmo ready: $plan"
  echo "tag message: $tag_message"
  echo "next: review $plan/notes.md and SHA256SUMS, then scripts/deploy.sh prd"
}

# ---------------------------------------------------------------------------------------------
# prd
# ---------------------------------------------------------------------------------------------

poll=${RELEMBRA_DEPLOY_POLL:-20}
timeout=${RELEMBRA_DEPLOY_TIMEOUT:-1200}

# find_run WORKFLOW EVENT SINCE: sets found_run to the id of the newest WORKFLOW run of EVENT on
# HEAD created at or after SINCE (UTC ISO 8601), polling until the timeout, or refuses. Not a
# subshell: a refusal here must end the script. `gh workflow run` and a release event give no run
# id back, so the run is found by what it is for.
found_run=''
find_run() {
  local workflow=$1 event=$2 since=$3 deadline=$((SECONDS + timeout)) listed
  while :; do
    listed=$(gh run list --workflow "$workflow" --event "$event" \
      --json databaseId,headSha,event,createdAt,status,conclusion --limit 10) ||
      refuse "cannot list $workflow runs"
    found_run=$(printf '%s' "$listed" | node -e '
      const runs = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const [commit, since] = process.argv.slice(1);
      const mine = runs.filter((r) => r.headSha === commit && r.createdAt >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (mine[0]) process.stdout.write(String(mine[0].databaseId));
    ' "$head" "$since") || refuse "cannot read the $workflow run list"
    [ -z "$found_run" ] || return 0
    [ "$SECONDS" -lt "$deadline" ] || refuse "no $workflow run for $tag on ${head:0:7} within ${timeout}s"
    sleep "$poll"
  done
}

rollback_hint() {
  cat >&2 <<EOF
deploy.sh: nothing is published. To undo what was done:
  gh release delete $tag --yes          # if a draft exists
  git push --delete origin $tag
  git tag -d $tag
EOF
}

prd() {
  [ "$#" -eq 0 ] || usage
  [ -f "$plan/plan.json" ] || refuse "no plan at $plan/plan.json: run hmo first"
  [ ! -e "$plan/published.json" ] || refuse "$tag was already published by this plan ($plan/published.json)"
  local commit tag_message
  commit=$(json "$plan/plan.json" commit) || refuse "plan.json has no commit"
  tag_message=$(json "$plan/plan.json" tagMessage) || refuse "plan.json has no tagMessage"
  [ "$commit" = "$head" ] || refuse "plan is for ${commit:0:7}, HEAD is ${head:0:7}: redo hmo"
  [ "$(json "$plan/plan.json" tree)" = "$tree" ] || refuse "plan is for another tree: redo hmo"
  [ "$(json "$plan/plan.json" tag)" = "$tag" ] || refuse "plan is for $(json "$plan/plan.json" tag), not $tag"
  [ -f "$plan/notes.md" ] || refuse "$plan/notes.md is missing"
  # Every asset against the hash hmo recorded, and SHA256SUMS against its own: a regenerated
  # checksum file cannot vouch for swapped bytes.
  local changed
  changed=$(node -e '
    const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
    const [dir] = process.argv.slice(1);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    const sha = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"); } catch { return "missing"; } };
    const problems = Object.entries({ ...plan.assets, SHA256SUMS: plan.sumsSha256 })
      .filter(([name, want]) => typeof want !== "string" || sha(name) !== want)
      .map(([name]) => name);
    process.stdout.write(problems.join(" "));
  ' "$plan" 2>/dev/null) || refuse "cannot read $plan/plan.json's assets"
  [ -z "$changed" ] || refuse "assets changed since hmo: $changed; redo hmo"
  # The gate record again: a waiver may have expired since hmo, or the record may have changed.
  gate_check
  if [ "$gate_verdict" != "$(json "$plan/plan.json" verdict)" ] ||
    [ "$gate_waivers" != "$(json "$plan/plan.json" waiverIds)" ]; then
    refuse "the security gate record changed since hmo (now $gate_verdict${gate_waivers:+ $gate_waivers}); redo hmo"
  fi
  # pages.yml runs on main as it is on the remote: it must still be this commit.
  git fetch -q origin || refuse "cannot fetch origin"
  local main
  main=$(git rev-parse origin/main) || refuse "origin/main is unknown"
  [ "$main" = "$head" ] ||
    refuse "origin/main is now ${main:0:7}, not the plan's ${head:0:7}: pages.yml would publish it; redo hmo on the new main"
  no_tag_anywhere

  # The tag: annotated with the verdict, on the remote before the release so --verify-tag holds.
  git tag -a "$tag" -m "$tag_message" "$head" || refuse "cannot tag"
  if ! git push -q origin "refs/tags/$tag"; then
    git tag -d "$tag" >/dev/null
    refuse "cannot push the tag"
  fi
  echo "tagged: $tag -> ${head:0:7} ($tag_message)"

  # The draft, with every asset; its assets downloaded and checked before anything is public.
  local prerelease_flag=()
  [ "$prerelease" = 0 ] || prerelease_flag=(--prerelease)
  local files=() name
  for name in "${assets[@]:0:5}" SHA256SUMS "${assets[5]}"; do files+=("$plan/$name"); done
  if ! gh release create "$tag" --verify-tag --draft ${prerelease_flag[@]+"${prerelease_flag[@]}"} \
    --title "$tag" --notes-file "$plan/notes.md" "${files[@]}" >/dev/null; then
    rollback_hint
    refuse "cannot create the draft release"
  fi
  rm -rf "$plan/draft"
  if ! gh release download "$tag" --dir "$plan/draft" ||
    ! cmp -s "$plan/draft/SHA256SUMS" "$plan/SHA256SUMS" ||
    ! (cd "$plan/draft" && check_sums SHA256SUMS >/dev/null); then
    rollback_hint
    refuse "the draft's assets are not the plan's"
  fi
  echo "draft release created and its assets verified"

  # The runs publication starts are found by createdAt from `since`, on GitHub's clock: a local
  # clock ahead of it would hide them, and the wait would come after the step that cannot be
  # undone. So `since` is the Date header of an authenticated call, read while a refusal can still
  # be undone. An HTTP date is valid only when it prints back unchanged (30 Feb would not).
  local since headers
  if ! headers=$(gh api -i rate_limit); then
    rollback_hint
    refuse "cannot read GitHub's clock (gh api -i rate_limit)"
  fi
  if ! since=$(printf '%s\n' "$headers" | node -e '
    const head = require("node:fs").readFileSync(0, "utf8").split(/\r?\n\r?\n/)[0];
    const line = head.split(/\r?\n/).find((l) => /^date:/i.test(l));
    const value = line === undefined ? "" : line.replace(/^date:[ \t]*/i, "").trim();
    const http = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
    const time = http.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(time) || new Date(time).toUTCString() !== value) {
      process.stdout.write(`no valid Date header (${JSON.stringify(line ?? null)})`);
      process.exit(1);
    }
    process.stdout.write(new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z"));
  '); then
    rollback_hint
    refuse "cannot read GitHub's clock: $since"
  fi
  # Exactly one UTC timestamp, or find_run's `createdAt >= since` would match nothing after
  # publication. Node's stderr stays out of $since; this checks what reached stdout.
  case $since in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
  *)
    rollback_hint
    refuse "cannot read GitHub's clock: $since is not one UTC timestamp"
    ;;
  esac

  # Publication. From here nothing is undone: a published release is immutable.
  tmp_view=$(mktemp) || exit 1
  if ! gh release edit "$tag" --draft=false >/dev/null; then
    # The edit may have gone through before the error reached us; what GitHub holds decides, and
    # an undo is offered only when GitHub says the release is still a draft.
    if ! gh release view "$tag" --json tagName,isDraft,isPrerelease,publishedAt,url >"$tmp_view" 2>/dev/null; then
      refuse "publishing reported an error and the release cannot be read back: its state is unknown; run 'gh release view $tag' and undo nothing while it is not a draft"
    fi
    case $(json "$tmp_view" isDraft) in
    false) refuse "publishing reported an error, but the release is live: nothing is undone; continue by hand from the release.yml step in docs/RELEASE.md" ;;
    true)
      rollback_hint
      refuse "cannot publish the draft"
      ;;
    *) refuse "publishing reported an error and the release's state could not be read: run 'gh release view $tag' before undoing anything" ;;
    esac
  fi
  local published_at url
  gh release view "$tag" --json tagName,isDraft,isPrerelease,publishedAt,url >"$tmp_view" || refuse "cannot read the release"
  [ "$(json "$tmp_view" isDraft)" = false ] || refuse "the release is still a draft"
  published_at=$(json "$tmp_view" publishedAt)
  url=$(json "$tmp_view" url)
  echo "published: $tag ($url, $published_at)"

  # release.yml stages the archive on npm; the stage must hold the release's archive by sha1.
  local release_run log stage_id dist_tag staged_sha1 archive_sha1 integrity
  find_run release.yml release "$since"
  release_run=$found_run
  gh run watch "$release_run" --exit-status >/dev/null || refuse "release.yml run $release_run failed; fix the cause and rerun it (gh run rerun $release_run)"
  log=$(gh run view "$release_run" --log) || refuse "cannot read release.yml run $release_run's log"
  stage_id=$(printf '%s\n' "$log" | sed -n 's/.*staged with id \([0-9a-f-]*\).*/\1/p' | head -n 1)
  dist_tag=$(printf '%s\n' "$log" | sed -n 's/.*staged with tag \([A-Za-z0-9._-]*\).*/\1/p' | head -n 1)
  staged_sha1=$(printf '%s\n' "$log" | sed -n 's/.*npm notice shasum: \([0-9a-f]\{40\}\).*/\1/p' | head -n 1)
  [ -n "$stage_id" ] && [ -n "$staged_sha1" ] || refuse "release.yml run $release_run: no stage id or shasum in its log"
  archive_sha1=$(sha1_of "$plan/relembra-$version.tgz")
  [ "$staged_sha1" = "$archive_sha1" ] ||
    refuse "npm staged shasum $staged_sha1, the archive's is $archive_sha1; reject it: npm stage reject $stage_id"
  # The log abbreviates the integrity; the SRI the owner compares after approval is computed here.
  integrity="sha512-$(openssl dgst -sha512 -binary "$plan/relembra-$version.tgz" | base64 | tr -d '\n')"
  echo "npm: relembra@$version staged with id $stage_id, tag $dist_tag, shasum $staged_sha1 (run $release_run)"

  # Pages, from main: the dispatch runs the remote's tip, which may have moved while npm staged.
  local pages_run
  git fetch -q origin || refuse "cannot fetch origin"
  main=$(git rev-parse origin/main) || refuse "origin/main is unknown"
  [ "$main" = "$head" ] ||
    refuse "origin/main moved to ${main:0:7} during publication: the release is live and npm is staged ($stage_id), but pages.yml was not dispatched; gate the new main and run it by hand (gh workflow run pages.yml --ref main)"
  gh workflow run pages.yml --ref main || refuse "cannot dispatch pages.yml"
  find_run pages.yml workflow_dispatch "$since"
  pages_run=$found_run
  gh run watch "$pages_run" --exit-status >/dev/null || refuse "pages.yml run $pages_run failed"
  echo "pages: run $pages_run"

  # What is public, read back: the release's assets and the site.
  rm -rf "$plan/published"
  gh release download "$tag" --dir "$plan/published" || refuse "cannot download the published assets"
  (cd "$plan/published" && cmp -s SHA256SUMS "$plan/SHA256SUMS" && check_sums SHA256SUMS >/dev/null) ||
    refuse "the published assets differ from the plan's"
  local homepage site_status mentions
  homepage=$(json package.json homepage) || refuse "package.json has no homepage"
  site_status=$(curl -fsS -o "$plan/page.html" -w '%{http_code}' "$homepage") || refuse "the site did not answer"
  # The whole version, not a prefix of another: a page still naming 1.2.3-beta.1 does not name 1.2.3.
  mentions=$(node -e '
    const [file, version] = process.argv.slice(1);
    const escaped = version.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    const whole = new RegExp(`(?<![0-9A-Za-z.-])${escaped}(?![0-9A-Za-z-]|\\.\\d)`, "g");
    process.stdout.write(String((require("node:fs").readFileSync(file, "utf8").match(whole) ?? []).length));
  ' "$plan/page.html" "$version") || refuse "cannot read $plan/page.html"
  [ "$mentions" -gt 0 ] || refuse "the site does not name $version (it may not have deployed yet: $homepage)"
  echo "site: $homepage $site_status, names $version $mentions time(s)"

  node -e '
    const [out, tag, commit, tree, publishedAt, url, releaseRun, stageId, distTag, sha1, integrity, pagesRun, siteStatus, mentions, version] = process.argv.slice(1);
    require("node:fs").writeFileSync(out, `${JSON.stringify({
      version, tag, commit, tree, publishedAt, releaseUrl: url, releaseRun, stageId, distTag,
      archiveSha1: sha1, archiveIntegrity: integrity, pagesRun, siteStatus, siteVersionMentions: Number(mentions),
    }, null, 2)}\n`);
  ' "$plan/published.json" "$tag" "$head" "$tree" "$published_at" "$url" "$release_run" "$stage_id" \
    "$dist_tag" "$staged_sha1" "$integrity" "$pages_run" "$site_status" "$mentions" "$version" ||
    refuse "could not write published.json"
  cat <<EOF
done: $plan/published.json
evidence rows:
| Tag | \`$tag\` -> \`${head:0:7}\` (\`$tag_message\`) |
| GitHub release | $url, published $published_at |
| npm | \`release.yml\` run $release_run staged \`relembra@$version\` with tag \`$dist_tag\`, stage id \`$stage_id\`, shasum \`$staged_sha1\`, integrity \`$integrity\` |
| Pages | run $pages_run; $homepage answered $site_status naming $version ($mentions) |
next, with the owner's two-factor key (docs/RELEASE.md):
  npm stage view $stage_id
  npm stage download $stage_id      # sha256 must equal SHA256SUMS' relembra-$version.tgz line
  npm stage approve $stage_id
EOF
}

[ "$#" -ge 1 ] || usage
mode=$1
shift
case $mode in
hmo) hmo "$@" ;;
prd) prd "$@" ;;
*) usage ;;
esac
