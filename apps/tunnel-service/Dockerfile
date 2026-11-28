# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Build from the repository root:
#   docker build -f apps/tunnel-service/Dockerfile -t synapseone/tunnel-service:<tag> .
#
# The default command runs the control plane and public ingress together. The
# same image can run the outbound-only connector with:
#   docker run --rm synapseone/tunnel-service:<tag> node dist/connector.js
FROM node:20-alpine
WORKDIR /app
COPY apps/tunnel-service/package.json apps/tunnel-service/package-lock.json ./
RUN npm ci
COPY apps/tunnel-service/tsconfig.json ./
COPY apps/tunnel-service/src ./src
RUN npm run build \
  && rm -f dist/*.test.js dist/*.test.d.ts dist/*.test.js.map \
  && npm prune --omit=dev \
  && mkdir -p /app/data \
  && chown -R node:node /app
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="SynapseOne Tunnel service" \
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
    test -s /usr/share/licenses/synapseone/licenses/MPL-2.0.txt; \
    test -s /usr/share/licenses/synapseone/licenses/sbom/synapseone.cdx.json; \
    sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md; \
    cp /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md /usr/share/licenses/synapseone/SOURCE-OFFER.txt
ENV NODE_ENV=production \
    SYNAPSETUNNEL_API_PORT=4015 \
    SYNAPSETUNNEL_INGRESS_PORT=4016 \
    SYNAPSETUNNEL_DATA_FILE=/app/data/synapse-tunnel.json
EXPOSE 4015 4016
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "Promise.all([process.env.SYNAPSETUNNEL_API_PORT || 4015, process.env.SYNAPSETUNNEL_INGRESS_PORT || 4016].map(async (port) => { const response = await fetch('http://127.0.0.1:' + port + '/ready'); if (!response.ok) throw new Error('not ready'); })).catch(() => process.exit(1));"]
# Least privilege: ports are above 1024 and the data volume must be writable by
# this user. Connector-only deployments should disable the HTTP healthcheck.
USER node
CMD ["node", "dist/index.js"]
