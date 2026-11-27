# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1-bookworm AS builder
ARG TARGETARCH=amd64
# Official DuckDB 2.0.0 shared libraries (the bundled crate source is v2.0.0).
# Pinned URL + SHA256 keeps the build reproducible and avoids the multi-gigabyte
# in-container C++ compile. Update both checksums when bumping the crate.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) url="https://github.com/duckdb/duckdb/releases/download/v2.0.0/duckdb-shared-libs-linux-amd64.tar.gz"; sha="993ad89e7dfca66cd6da994c2cad090c2fc160ddf9f550498a098ab4bb13cfb1" ;; \
      arm64) url="https://github.com/duckdb/duckdb/releases/download/v2.0.0/duckdb-shared-libs-linux-arm64.tar.gz"; sha="c60eecf91143ca6bbac55c4f4d40dc22520488b0ac257c86e0fe9a2b451cf2b7" ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && mkdir -p /opt/duckdb \
    && curl -fsSL -o /tmp/duckdb.tar.gz "$url" \
    && echo "$sha  /tmp/duckdb.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/duckdb.tar.gz -C /opt/duckdb \
    && rm /tmp/duckdb.tar.gz
WORKDIR /workspace
COPY apps/warehouse-service/Cargo.toml apps/warehouse-service/Cargo.lock ./
COPY apps/warehouse-service/src ./src
ENV DUCKDB_LIB_DIR=/opt/duckdb
RUN cargo build --release --locked --no-default-features

FROM debian:bookworm-slim
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="SynapseOne Warehouse service" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseOne" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /data/warehouse \
    && chown -R app:app /data/warehouse

COPY --from=builder /workspace/target/release/synapseone-warehouse /usr/local/bin/synapseone-warehouse
COPY --from=builder /opt/duckdb/libduckdb.so /usr/local/lib/libduckdb.so
RUN ldconfig
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/licenses/synapseone/
COPY licenses /usr/share/licenses/synapseone/licenses
RUN set -eux; \
    test -s /usr/share/licenses/synapseone/LICENSE; \
    test -s /usr/share/licenses/synapseone/NOTICE; \
    test -s /usr/share/licenses/synapseone/THIRD-PARTY.md; \
    test -s /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md; \
    test -s /usr/share/licenses/synapseone/licenses/THIRD-PARTY-NOTICES.txt; \
    test -s /usr/share/licenses/synapseone/licenses/THIRD-PARTY-NOTICES.generated.txt; \
    test -s /usr/share/licenses/synapseone/licenses/MPL-2.0.txt; \
    test -s /usr/share/licenses/synapseone/licenses/MIT-DuckDB.txt; \
    test -s /usr/share/licenses/synapseone/licenses/sbom/synapseone.cdx.json; \
    sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md; \
    cp /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md /usr/share/licenses/synapseone/SOURCE-OFFER.txt

ENV PORT=4012 \
    WAREHOUSE_DATA_DIR=/data/warehouse
EXPOSE 4012
VOLUME ["/data/warehouse"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/usr/local/bin/synapseone-warehouse", "--healthcheck"]

USER app
ENTRYPOINT ["/usr/local/bin/synapseone-warehouse"]
