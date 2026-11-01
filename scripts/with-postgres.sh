#!/bin/sh
# Runs a command beside a throwaway Postgres 17 container, with RELEMBRA_POSTGRES_URL pointing at
# it, and removes the container when the command ends, whatever its outcome:
#   scripts/with-postgres.sh env TMPDIR=/tmp RELEMBRA_REQUIRE_BINARY=1 bun test
# The data directory is a tmpfs, so no volume is created. The password is a literal for tests.
set -eu

# The digest of the multi-platform index, the same as .github/workflows/ci.yml.
image=postgres:17.11@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1
name="${RELEMBRA_POSTGRES_CONTAINER:-relembra-pg-$$}"

docker run --detach --rm --name "$name" \
  --env POSTGRES_PASSWORD=relembra-test \
  --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 \
  "$image" >/dev/null
trap 'docker rm --force --volumes "$name" >/dev/null 2>&1 || true' EXIT INT TERM

port=$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')
# The image's first start runs initdb on a socket-only server, then restarts on TCP: wait for TCP.
tries=0
until docker exec "$name" pg_isready --quiet --host 127.0.0.1 --username postgres; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then
    echo "Postgres in $name did not start" >&2
    exit 1
  fi
  sleep 0.2
done

RELEMBRA_POSTGRES_URL="postgres://postgres:relembra-test@127.0.0.1:$port/postgres" "$@"
