#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Generate PgBouncer's auth file at container start so the database password
# stays in .env / the container environment instead of a committed file.
set -eu

: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"

escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

umask 077
{
  printf '"%s" "%s"\n' "$(escape "$DB_USER")" "$(escape "$DB_PASSWORD")"
} > /tmp/userlist.txt

exec "$@"
