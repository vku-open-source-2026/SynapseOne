# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1-bookworm AS builder
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
COPY --from=builder /workspace/target/release/synapseone-ai /usr/local/bin/synapseone-ai

ENV PORT=4003
EXPOSE 4003
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/synapseone-ai", "--healthcheck"]

USER app
ENTRYPOINT ["/usr/local/bin/synapseone-ai"]
