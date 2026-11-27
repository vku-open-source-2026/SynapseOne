# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Self-hosted SynapseOne runner image — ONE image for workflow | inference |
# hybrid connectors.
#
# Inference jobs execute the real local models IN THIS IMAGE through a Python
# JSONL worker (`/app/local-inference/worker.py`).  There is no inference HTTP
# server, no provider key and no remote model API.  The Node runner remains the
# only process that talks outbound HTTPS to SynapseOne control/queue.
#
# Build from the repository root (SynapseOne):
#   docker build -f apps/workflow-runner/Dockerfile \
#     -t synapseone/workflow-runner:<tag> .
#
# Optional pins (defaults are the deployed real-model image):
#   --build-arg MODEL_STACK_IMAGE=synapseone/inference:0.9.1-20261114
#   --build-arg PYTHON_IMAGE=python:3.11-slim-bookworm
#   --build-arg NODE_IMAGE=node:20-slim
#
# The model stack stage is never used as the final image; only Python
# site-packages and the baked Hugging Face cache are copied from it.  Its
# API CMD/HEALTHCHECK/EXPOSE (4008) therefore do not leak into this image.
ARG PYTHON_IMAGE=python:3.11-slim-bookworm
ARG NODE_IMAGE=node:20-slim
ARG MODEL_STACK_IMAGE=synapseone/inference:0.9.1-20261114

# ---------------------------------------------------------------------------
# Node runner build
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS nodebuild
WORKDIR /app
COPY apps/workflow-service/package.json apps/workflow-service/package-lock.json ./
RUN npm ci --include=dev
COPY apps/workflow-service/tsconfig.json ./
COPY apps/workflow-service/src ./src
RUN npm run build \
 && rm -f dist/*.test.js dist/*.test.d.ts

FROM ${NODE_IMAGE} AS nodedeps
WORKDIR /app
COPY apps/workflow-service/package.json apps/workflow-service/package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Baked CPU model stack (ONNX MiniLM + Decision-2.0) — copy source only
# ---------------------------------------------------------------------------
FROM ${MODEL_STACK_IMAGE} AS modelstack
# Keep a CI smoke build (no local model image) able to copy an empty cache.
RUN mkdir -p /app/.cache/huggingface

# ---------------------------------------------------------------------------
# Final: clean Python base (no inherited PORT/EXPOSE/HEALTHCHECK)
# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE}
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production \
    HF_HOME=/app/.cache/huggingface \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    INFERENCE_MODEL_DOWNLOAD=false \
    INFERENCE_MOCK_MODELS=false \
    INFERENCE_DEVICE=cpu \
    EMBEDDING_BACKEND=onnx \
    DECISION_BACKEND=local \
    DECISION_ENABLED=true \
    LOCAL_INFERENCE_CAPABILITIES=embeddings,decision,route \
    LOCAL_INFERENCE_HOME=/app/local-inference

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 runner

# Python runtime + CPU wheels from the real-model image. Site-packages stay
# root-owned/read-only so the large layer is not duplicated by a chown.
COPY --from=modelstack /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
# Baked weights: MiniLM ONNX graphs + Decision-2.0 checkpoint (offline).
# --chown is applied during the copy, not with a recursive chown afterwards, so
# the ~2 GiB cache is not rewritten into an extra layer. The worker must be able
# to create Hugging Face lock files in this tree.
COPY --chown=runner:runner --from=modelstack /app/.cache/huggingface /app/.cache/huggingface

# Node 20 runtime (Debian-slim, same glibc family as the Python base).
COPY --from=nodebuild /usr/local/bin/node /usr/local/bin/node
COPY --chown=runner:runner --from=nodedeps /app/node_modules /app/node_modules
COPY --chown=runner:runner --from=nodebuild /app/dist /app/dist
COPY --chown=runner:runner apps/workflow-service/package.json /app/package.json

# Worker + safe model package. Only pure modules are copied; src.main and
# uvicorn never enter this image.
COPY --chown=runner:runner apps/workflow-runner/local-inference /app/local-inference
COPY apps/inference-service/src/config.py \
     apps/inference-service/src/model_lock.py \
     apps/inference-service/src/embedding.py \
     apps/inference-service/src/decision.py \
     apps/inference-service/src/onnx_embedding.py \
     /app/local-inference/synapse_local_models/

ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="SynapseOne self-hosted workflow runner" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseOne" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/licenses/synapseone/
COPY licenses /usr/share/licenses/synapseone/licenses

# Only the worker entrypoint needs the execute bit; do not chown -R /app.
RUN chmod 0755 /app/local-inference/worker.py \
    && set -eux; \
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

USER runner

# No PORT, no EXPOSE, no HTTP listener.  The worker reads JSONL from stdin and
# writes JSONL to stdout; the Node runner owns all outbound HTTPS traffic.
HEALTHCHECK NONE

CMD ["node", "/app/dist/runner.js"]
