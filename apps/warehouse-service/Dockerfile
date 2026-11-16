# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1-bookworm AS builder
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /data/warehouse \
    && chown -R app:app /data/warehouse

COPY --from=builder /workspace/target/release/synapseone-warehouse /usr/local/bin/synapseone-warehouse

ENV PORT=4012 \
    WAREHOUSE_DATA_DIR=/data/warehouse
EXPOSE 4012
VOLUME ["/data/warehouse"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/usr/local/bin/synapseone-warehouse", "--healthcheck"]

USER app
ENTRYPOINT ["/usr/local/bin/synapseone-warehouse"]
