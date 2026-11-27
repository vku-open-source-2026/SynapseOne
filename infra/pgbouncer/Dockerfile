# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# PgBouncer connection pooler for the platform Postgres instance.
FROM alpine:3.20
RUN apk add --no-cache pgbouncer \
 && addgroup -S pgbouncer \
 && adduser -S -G pgbouncer -H -s /sbin/nologin pgbouncer
COPY infra/pgbouncer/entrypoint.sh /usr/local/bin/pgbouncer-entrypoint
RUN chmod 0755 /usr/local/bin/pgbouncer-entrypoint
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="SynapseOne PgBouncer" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseOne" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/licenses/synapseone/
COPY licenses /usr/share/licenses/synapseone/licenses
RUN set -eux; \
    test -s /usr/share/licenses/synapseone/LICENSE; \
    test -s /usr/share/licenses/synapseone/NOTICE; \
    test -s /usr/share/licenses/synapseone/THIRD-PARTY.md; \
    test -s /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md; \
    test -s /usr/share/licenses/synapseone/licenses/THIRD-PARTY-NOTICES.txt; \
    test -s /usr/share/licenses/synapseone/licenses/THIRD-PARTY-NOTICES.generated.txt; \
    test -s /usr/share/licenses/synapseone/licenses/sbom/synapseone.cdx.json; \
    sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md; \
    cp /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md /usr/share/licenses/synapseone/SOURCE-OFFER.txt
USER pgbouncer
ENTRYPOINT ["/usr/local/bin/pgbouncer-entrypoint"]
CMD ["/usr/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
