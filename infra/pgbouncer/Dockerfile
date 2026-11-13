# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# PgBouncer connection pooler for the platform Postgres instance.
FROM alpine:3.20
RUN apk add --no-cache pgbouncer \
 && addgroup -S pgbouncer \
 && adduser -S -G pgbouncer -H -s /sbin/nologin pgbouncer
COPY entrypoint.sh /usr/local/bin/pgbouncer-entrypoint
RUN chmod 0755 /usr/local/bin/pgbouncer-entrypoint
USER pgbouncer
ENTRYPOINT ["/usr/local/bin/pgbouncer-entrypoint"]
CMD ["/usr/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
