#!/usr/bin/env bash
# Publishes site/ to the gh-pages branch, which GitHub Pages serves.
#
# What ships is fixed before anything runs: every tracked file comes from HEAD:site (never from
# the working tree), plus the four explainer video files, which are git-ignored on main to keep
# the source history small. Those are taken from site/assets/video/ only if their SHA-256 matches
# scripts/site/video.sha256, which is committed; any other file in that folder stops the run.
#
# The commit is built with a temporary index (no checkout, no local branch) on top of
# origin/gh-pages, and pushed without force: a concurrent publish makes the push fail instead of
# overwriting it.
#
#   scripts/site/publish.sh            # build, check, commit and push
#   scripts/site/publish.sh --dry-run  # everything except the push
set -euo pipefail

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) echo "usage: scripts/site/publish.sh [--dry-run]" >&2; exit 64 ;;
esac

root=$(git rev-parse --show-toplevel)
cd "$root"

source_sha=$(git rev-parse HEAD)
manifest_blob=$(git rev-parse "$source_sha:scripts/site/video.sha256")

# The tests run on the working tree, so it must equal the commit they vouch for.
if ! git diff --quiet "$source_sha" -- site scripts/site test/site.test.ts ||
  [ -n "$(git ls-files --others --exclude-standard -- site scripts/site)" ]; then
  echo "site/, scripts/site/ or test/site.test.ts differ from HEAD: commit first." >&2
  exit 1
fi
bun test test/site.test.ts

video=site/assets/video
expected=$(git cat-file blob "$manifest_blob" | awk '{ print $2 }' | sort)
present=$(cd "$video" && find . -type f | sed 's|^\./||' | sort)
if [ "$present" != "$expected" ]; then
  echo "$video/ must hold exactly the files in scripts/site/video.sha256:" >&2
  diff <(echo "$expected") <(echo "$present") >&2 || true
  exit 1
fi

mkdir -p .scratch
index=$(mktemp "$root/.scratch/pages-index.XXXXXX")
trap 'rm -f "$index"' EXIT
rm -f "$index"
export GIT_INDEX_FILE="$index"

git read-tree "$source_sha:site"
while read -r sum name; do
  # Hash the blob git stored, not the file again, so what is checked is what ships.
  blob=$(git hash-object -w -- "$video/$name")
  actual=$(git cat-file blob "$blob" | shasum -a 256 | awk '{ print $1 }')
  if [ "$actual" != "$sum" ]; then
    echo "$video/$name does not match scripts/site/video.sha256" >&2
    exit 1
  fi
  git update-index --add --cacheinfo "100644,$blob,assets/video/$name"
done < <(git cat-file blob "$manifest_blob")
git update-index --add --cacheinfo "100644,$(git hash-object -w --stdin </dev/null),.nojekyll"
tree=$(git write-tree)

# Every local file index.html points at must be in the tree that ships.
missing=0
while IFS= read -r path; do
  if ! git cat-file -e "$tree:$path" 2>/dev/null; then
    echo "index.html points at $path, which is not in the published tree" >&2
    missing=1
  fi
done < <(git cat-file blob "$tree:index.html" | grep -oE '(src|href|poster)="assets/[^"#?]+"' |
  sed -E 's/^[a-z]+="//; s/"$//' | sort -u)
[ "$missing" -eq 0 ] || exit 1

remote_url=$(git remote get-url origin)
git fetch --quiet origin
parent=$(git rev-parse --quiet --verify refs/remotes/origin/gh-pages || true)
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "gh-pages already holds this exact site ($parent); nothing to publish."
  exit 0
fi

commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} \
  -m "site: publish from ${source_sha:0:12}" \
  -m "Built from $source_sha by scripts/site/publish.sh.")

echo "files in the published tree:"
git ls-tree -r -l "$tree" | awk '{ printf "  %10d  %s\n", $4, $5 }'
echo "commit $commit (parent ${parent:-none}, source $source_sha)"

if [ "$dry_run" -eq 1 ]; then
  echo "dry run: not pushed"
  exit 0
fi

git push origin "$commit:refs/heads/gh-pages"
echo "pushed to gh-pages on $remote_url"
