#!/bin/sh
# Installs the relembra binary, but only after its sha256 matches the checksum file.
#
#   sh install.sh <binary> <checksum-file> [<dest-dir>]
#
# <checksum-file> is in sha256sum format ("<64 hex>  <name>"), as build/cli.ts writes it; the line
# whose name is the binary's file name is the one checked. <dest-dir> defaults to ~/.local/bin.
# Exit codes: 0 installed, 1 refused (verification failed, nothing installed), 2 usage.
set -eu

usage() {
  echo "usage: sh install.sh <binary> <checksum-file> [<dest-dir>]" >&2
  exit 2
}

refuse() {
  echo "install.sh: $1; nothing was installed" >&2
  exit 1
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
binary=$1
sums=$2
dest=${3:-${HOME:?HOME is not set}/.local/bin}
[ -f "$binary" ] || usage
[ -f "$sums" ] || refuse "checksum file $sums not found"

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  refuse "neither sha256sum nor shasum is available to verify the binary"
fi

name=$(basename "$binary")
# The expected hash: the first field of the line whose second field is exactly the name.
expected=$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1; exit }' "$sums")
case $expected in
  "") refuse "no sha256 for $name in $sums" ;;
esac
if [ "${#expected}" -ne 64 ] || ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]+$'; then
  refuse "the sha256 for $name in $sums is malformed"
fi

# mv onto a directory, or a symlink to one, would put the file inside it; onto a symlink to a
# file it would leave the link's target in place. Only a regular file (or nothing) is replaced.
if [ -L "$dest/relembra" ] || [ -d "$dest/relembra" ]; then
  refuse "$dest/relembra is a directory or a symlink"
fi

# Copy first, then verify the copy, so the bytes checked are the bytes installed.
mkdir -p "$dest"
tmp=$(mktemp "$dest/.relembra.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cp "$binary" "$tmp"
actual=$(hash_of "$tmp")
if [ "$actual" != "$expected" ]; then
  refuse "sha256 mismatch for $name"
fi
chmod 755 "$tmp"
mv -f "$tmp" "$dest/relembra"
trap - EXIT HUP INT TERM
echo "installed $dest/relembra (sha256 $actual)"
