# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=4013

WORKDIR /app
COPY apps/lakehouse-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin app

COPY apps/lakehouse-service/src ./src
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="SynapseOne Lakehouse service" \
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
USER app
EXPOSE 4013
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4013/health', timeout=3)"
ENTRYPOINT ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4013"]
