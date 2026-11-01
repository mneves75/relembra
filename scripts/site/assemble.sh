#!/usr/bin/env bash
# Builds what GitHub Pages serves into a new directory. .github/workflows/pages.yml uploads it and
# deploys it with OIDC, so no stored token can change the site.
#
# What ships is fixed by the commit, never by the working tree: every file of HEAD:site, plus the
# explainer video files, which are git-ignored on main and kept on the gh-pages branch. Each video
# comes from origin/gh-pages and must match the SHA-256 in the commit's scripts/site/video.sha256.
#
#   git fetch origin gh-pages && scripts/site/assemble.sh <new directory>
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/site/assemble.sh <new directory>" >&2
  exit 64
fi
if [ -e "$1" ]; then
  echo "$1 already exists: give a new directory." >&2
  exit 1
fi
# Resolved here, from the caller's directory: the script changes directory below. A bare
# assignment, so a parent that cannot be resolved stops the script (set -e).
parent=$(cd "$(dirname "$1")" && pwd -P)
out="$parent/$(basename "$1")"

cd "$(git rev-parse --show-toplevel)"
source_sha=$(git rev-parse HEAD)
pages=$(git rev-parse --verify refs/remotes/origin/gh-pages)

index=$(mktemp)
trap 'rm -f "$index"' EXIT
rm -f "$index"
export GIT_INDEX_FILE="$index"

git read-tree "$source_sha:site"
while read -r sum name; do
  blob=$(git rev-parse --verify "$pages:assets/video/$name")
  actual=$(git cat-file blob "$blob" | shasum -a 256 | awk '{ print $1 }')
  if [ "$actual" != "$sum" ]; then
    echo "$name does not match scripts/site/video.sha256 (gh-pages has $actual)" >&2
    exit 1
  fi
  git update-index --add --cacheinfo "100644,$blob,assets/video/$name"
done < <(git cat-file blob "$source_sha:scripts/site/video.sha256")
git update-index --add --cacheinfo "100644,$(git hash-object -w --stdin </dev/null),.nojekyll"
tree=$(git write-tree)

# Every local file index.html points at must be in the tree that ships.
missing=0
while IFS= read -r path; do
  if ! git cat-file -e "$tree:$path" 2>/dev/null; then
    echo "index.html points at $path, which is not in the site" >&2
    missing=1
  fi
done < <(git cat-file blob "$tree:index.html" | grep -oE '(src|href|poster)="assets/[^"#?]+"' |
  sed -E 's/^[a-z]+="//; s/"$//' | sort -u)
[ "$missing" -eq 0 ] || exit 1

mkdir -p "$out"
git archive "$tree" | tar -x -C "$out"
echo "site from $source_sha (tree $tree) in $out:"
git ls-tree -r -l "$tree" | awk '{ printf "  %10d  %s\n", $4, $5 }'
