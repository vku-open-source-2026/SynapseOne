#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Logical Postgres backups (pg_dump custom format) with retention.
#
# One-off, from the repository root on the Docker host:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm pg-backup --once
# The prod overlay also runs it as the `pg-backup` service (--loop, daily).
#
# Environment: PGHOST, PGUSER, PGPASSWORD, BACKUP_DATABASES ("synapseone authentik"),
# BACKUP_DIR (/backups), BACKUP_INTERVAL_SECONDS (86400), BACKUP_RETENTION_DAYS (7).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_DATABASES="${BACKUP_DATABASES:-synapseone}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION="${BACKUP_RETENTION_DAYS:-7}"

run_once() {
  mkdir -p "$BACKUP_DIR"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  status=0
  for db in $BACKUP_DATABASES; do
    if ! psql -d postgres -Atqc "select 1 from pg_database where datname = '$db'" | grep -q 1; then
      echo "[pg-backup] skip $db (database does not exist)"
      continue
    fi
    out="$BACKUP_DIR/$db-$stamp.dump"
    if pg_dump -d "$db" -Fc -Z 6 -f "$out.part" && mv "$out.part" "$out"; then
      sha256sum "$out" > "$out.sha256"
      echo "[pg-backup] $db -> $out ($(du -h "$out" | cut -f1))"
    else
      rm -f "$out.part"
      echo "[pg-backup] FAILED $db" >&2
      status=1
    fi
  done
  # Retention: drop dumps (and their checksums) older than RETENTION days.
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.dump.sha256' \) -mtime +"$RETENTION" -print -delete \
    | sed 's/^/[pg-backup] expired /'
  return $status
}

case "${1:---once}" in
  --once) run_once ;;
  --loop)
    echo "[pg-backup] every ${INTERVAL}s, keep ${RETENTION} days: $BACKUP_DATABASES"
    while :; do
      run_once || echo "[pg-backup] run finished with errors" >&2
      sleep "$INTERVAL"
    done
    ;;
  *) echo "usage: pg-backup.sh [--once|--loop]" >&2; exit 2 ;;
esac
