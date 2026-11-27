# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-alpine
WORKDIR /app
COPY apps/workflow-service/package.json apps/workflow-service/package-lock.json ./
RUN npm ci
COPY apps/workflow-service/tsconfig.json ./
COPY apps/workflow-service/src ./src
COPY apps/workflow-service/drizzle ./drizzle
RUN npm run build \
 && rm -f dist/*.test.js dist/*.test.d.ts \
 && npm prune --omit=dev \
 && chown -R node:node /app
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="SynapseOne Workflow service" \
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
ENV PORT=4002
EXPOSE 4002
# Least privilege: never run as root (ports >1024, no need for root).
USER node
CMD ["node", "dist/index.js"]
