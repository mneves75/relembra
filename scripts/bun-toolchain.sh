#!/usr/bin/env bash
# Puts the pinned Bun (build/bun-toolchain.txt) for one platform into a new directory, after its
# package's sha512 matches the pin, and prints the directory holding the executable.
#
#   scripts/bun-toolchain.sh <platform> <new directory>
#
# <platform> is a name from the pin file (linux-x64, windows-aarch64, ...). Runs in bash on macOS,
# Linux and Git Bash on Windows. Exit codes: 0 ready, 1 refused (nothing usable left), 2 usage.
set -euo pipefail

usage() {
  echo "usage: scripts/bun-toolchain.sh <platform> <new directory>" >&2
  exit 2
}
refuse() {
  echo "bun-toolchain: $1" >&2
  exit 1
}

[ "$#" -eq 2 ] || usage
platform=$1
dest=$2
# Both overrides exist for test/bun-toolchain.test.ts, which serves a fake package from disk.
pin=${RELEMBRA_BUN_PIN:-"$(cd "$(dirname "$0")/.." && pwd -P)/build/bun-toolchain.txt"}
registry=${RELEMBRA_BUN_REGISTRY:-https://registry.npmjs.org}
[ -e "$dest" ] && refuse "$dest already exists"

field() { awk -v key="$1" '$1 == key { print $2; exit }' "$pin"; }
version=$(field version)
revision=$(field revision)
integrity=$(field "$platform")
[ -n "$version" ] && [ -n "$revision" ] || refuse "$pin has no version or revision"
[ -n "$integrity" ] || refuse "no pin for platform $platform"

mkdir -p "$dest"
archive="$dest/bun.tgz"
url="$registry/@oven/bun-$platform/-/bun-$platform-$version.tgz"
curl -fsSL --retry 3 -o "$archive" "$url" || refuse "could not download $url"
actual="sha512-$(openssl dgst -sha512 -binary "$archive" | base64 | tr -d '\n')"
if [ "$actual" != "$integrity" ]; then
  rm -f "$archive"
  refuse "$url does not match the pinned sha512"
fi
tar -xzf "$archive" -C "$dest"
rm -f "$archive"

bin="$dest/package/bin"
exe="$bin/bun"
[ -f "$exe.exe" ] && exe="$exe.exe"
[ -f "$exe" ] || refuse "the package has no bin/bun"
chmod +x "$exe"
got=$("$exe" --revision)
[ "$got" = "$revision" ] || refuse "the unpacked Bun is $got, the pin says $revision"
echo "$bin"
