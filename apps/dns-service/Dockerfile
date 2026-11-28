# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-alpine
WORKDIR /app
COPY apps/dns-service/package.json apps/dns-service/package-lock.json ./
RUN npm ci
COPY apps/dns-service/tsconfig.json ./
COPY apps/dns-service/src ./src
RUN npm run build \
  && rm -f dist/*.test.js dist/*.test.d.ts \
  && npm prune --omit=dev \
  && chown -R node:node /app

# Allow the non-root runtime to bind the default DNS port. Kubernetes/container
# runtimes must retain CAP_NET_BIND_SERVICE or SYNAPSEDNS_DNS_PORT must be >1024.
RUN apk add --no-cache libcap \
  && setcap 'cap_net_bind_service=+ep' /usr/local/bin/node \
  && apk del libcap \
  && mkdir -p /app/data \
  && chown node:node /app/data

ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="SynapseDNS service" \
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
    SYNAPSEDNS_DNS_HOST=0.0.0.0 \
    SYNAPSEDNS_DNS_PORT=53 \
    SYNAPSEDNS_API_HOST=0.0.0.0 \
    SYNAPSEDNS_API_PORT=4014 \
    SYNAPSEDNS_DATA_FILE=/app/data/synapsedns.json
EXPOSE 53/udp
EXPOSE 53/tcp
EXPOSE 4014/tcp
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SYNAPSEDNS_API_PORT||'4014')+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
USER node
CMD ["node", "dist/index.js"]
