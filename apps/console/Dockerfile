# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-alpine AS build
WORKDIR /app
COPY apps/console/package.json apps/console/package-lock.json ./
RUN npm ci
COPY apps/console ./
RUN npm run build

FROM nginx:alpine
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="SynapseOne Console" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseOne" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY apps/console/docker-entrypoint.sh /docker-entrypoint.sh
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/licenses/synapseone/
COPY licenses /usr/share/licenses/synapseone/licenses
# Also expose the notices to browser users of the console (Font Awesome
# attribution and third-party inventory).
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/nginx/html/
COPY licenses /usr/share/nginx/html/licenses
RUN chmod +x /docker-entrypoint.sh \
    && set -eux; \
    test -s /usr/share/licenses/synapseone/LICENSE; \
    test -s /usr/share/licenses/synapseone/NOTICE; \
    test -s /usr/share/licenses/synapseone/THIRD-PARTY.md; \
    test -s /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md; \
    test -s /usr/share/licenses/synapseone/licenses/THIRD-PARTY-NOTICES.txt; \
    test -s /usr/share/licenses/synapseone/licenses/THIRD-PARTY-NOTICES.generated.txt; \
    test -s /usr/share/licenses/synapseone/licenses/CC-BY-4.0.txt; \
    test -s /usr/share/licenses/synapseone/licenses/sbom/synapseone.cdx.json; \
    grep -qs "Font Awesome" /usr/share/licenses/synapseone/licenses/THIRD-PARTY-NOTICES.txt; \
    sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md; \
    cp /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md /usr/share/licenses/synapseone/SOURCE-OFFER.txt; \
    cp /usr/share/licenses/synapseone/licenses/SOURCE-OFFER.md /usr/share/nginx/html/licenses/SOURCE-OFFER.txt
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
