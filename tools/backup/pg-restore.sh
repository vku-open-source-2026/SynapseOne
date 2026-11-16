#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Restore one pg-backup dump into a database (default: the dump's name prefix).
#
#   tools/backup/pg-restore.sh <file.dump> [database]
#
# Run on the Docker host from the repository root. Stop the services that use
# the database first (e.g. `docker compose stop iam base workflow ...`). The
# dump is verified against its .sha256 file when present, then restored with
# --clean --if-exists inside one transaction. Objects in the dump replace the
# current ones; objects created after the dump (e.g. a new table) are left alone.
# Set COMPOSE_FILE_ARGS="-f docker-compose.yml -f docker-compose.prod.yml" when
# the stack runs with the prod overlay (default: docker-compose.yml only).
set -eu

file="${1:-}"
[ -n "$file" ] && [ -f "$file" ] || { echo "usage: pg-restore.sh <file.dump> [database]" >&2; exit 2; }
db="${2:-$(basename "$file" | sed 's/-[0-9]\{8\}T[0-9]\{6\}Z\.dump$//')}"
# Same compose files the stack was started with (add the prod overlay if you use it).
compose="docker compose ${COMPOSE_FILE_ARGS:--f docker-compose.yml}"

if [ -f "$file.sha256" ]; then
  expected=$(cut -d' ' -f1 "$file.sha256")
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || { echo "checksum mismatch for $file" >&2; exit 1; }
fi

echo "Restoring $file into database '$db' (existing objects are replaced)."
printf 'Type the database name to continue: '
read -r answer
[ "$answer" = "$db" ] || { echo "aborted"; exit 1; }

$compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --clean --if-exists --no-owner --single-transaction' sh "$db" < "$file"
echo "done: restored $db"
