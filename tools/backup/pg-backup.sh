#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Logical Postgres backups (pg_dump custom format) with retention and retries.
#
# One-off, from the repository root on the Docker host:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm pg-backup --once
# The prod overlay also runs it as the `pg-backup` service (--loop, daily).
#
# Environment: PGHOST, PGUSER, PGPASSWORD, BACKUP_DATABASES ("synapseone authentik"),
# BACKUP_DIR (/backups), BACKUP_INTERVAL_SECONDS (86400), BACKUP_RETENTION_DAYS (7),
# BACKUP_DB_WAIT_ATTEMPTS (30), BACKUP_DB_WAIT_SECONDS (5),
# BACKUP_RETRY_SECONDS (300), BACKUP_MAX_RETRY_SECONDS (3600).
#
# A failed daily run must not wait a full day before trying again: sidecars can
# start before Postgres/S3 are reachable after a redeploy. The loop retries with
# bounded exponential backoff and records a machine-readable status file for
# monitoring (`$BACKUP_DIR/.last-status.json`).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_DATABASES="${BACKUP_DATABASES:-synapseone}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION="${BACKUP_RETENTION_DAYS:-7}"
DB_WAIT_ATTEMPTS="${BACKUP_DB_WAIT_ATTEMPTS:-30}"
DB_WAIT_SECONDS="${BACKUP_DB_WAIT_SECONDS:-5}"
RETRY_SECONDS="${BACKUP_RETRY_SECONDS:-300}"
MAX_RETRY_SECONDS="${BACKUP_MAX_RETRY_SECONDS:-3600}"
STATUS_FILE="$BACKUP_DIR/.last-status.json"

write_status() {
  ok="$1"
  detail="$2"
  mkdir -p "$BACKUP_DIR"
  printf '{"ok":%s,"at":"%s","detail":"%s"}\n' \
    "$ok" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$detail" > "$STATUS_FILE" 2>/dev/null || true
}

wait_for_db() {
  i=1
  while [ "$i" -le "$DB_WAIT_ATTEMPTS" ]; do
    if psql -d postgres -Atqc 'select 1' >/dev/null 2>&1; then
      [ "$i" -gt 1 ] && echo "[pg-backup] postgres reachable after $i attempt(s)"
      return 0
    fi
    echo "[pg-backup] waiting for postgres ($i/$DB_WAIT_ATTEMPTS)" >&2
    i=$((i + 1))
    sleep "$DB_WAIT_SECONDS"
  done
  return 1
}

run_once() {
  mkdir -p "$BACKUP_DIR"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  status=0
  if ! wait_for_db; then
    echo "[pg-backup] postgres is not reachable" >&2
    write_status false "postgres unreachable"
    return 1
  fi
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
  if [ "$status" -eq 0 ]; then
    # Retention only advances after a clean run, so a partial failure cannot
    # delete the last known-good copy.
    find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.dump.sha256' \) -mtime +"$RETENTION" -print -delete \
      | sed 's/^/[pg-backup] expired /'
    write_status true "ok"
  else
    write_status false "one or more databases failed"
  fi
  return $status
}

case "${1:---once}" in
  --once) run_once ;;
  --loop)
    echo "[pg-backup] every ${INTERVAL}s, retry ${RETRY_SECONDS}s (max ${MAX_RETRY_SECONDS}s), keep ${RETENTION} days: $BACKUP_DATABASES"
    retry="$RETRY_SECONDS"
    while :; do
      if run_once; then
        retry="$RETRY_SECONDS"
        sleep "$INTERVAL"
      else
        echo "[pg-backup] run finished with errors; retrying in ${retry}s" >&2
        sleep "$retry"
        retry=$((retry * 2))
        [ "$retry" -gt "$MAX_RETRY_SECONDS" ] && retry="$MAX_RETRY_SECONDS"
      fi
    done
    ;;
  *) echo "usage: pg-backup.sh [--once|--loop]" >&2; exit 2 ;;
esac
