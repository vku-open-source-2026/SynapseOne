# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Self-hosted SynapseFlow runner image.
#
# Build from the repository root so the shared workflow engine is included:
#   docker build -f apps/workflow-runner/Dockerfile -t synapseone-workflow-runner .
#
# The runtime image contains only the compiled engine + runner; it never needs
# DATABASE_URL, SYNAPSEONE_INTERNAL_SECRET, or a service-network address.
FROM node:20-alpine AS build
WORKDIR /app
COPY apps/workflow-service/package.json apps/workflow-service/package-lock.json* ./
RUN npm install --production=false || npm install
COPY apps/workflow-service/tsconfig.json ./
COPY apps/workflow-service/src ./src
RUN npm run build \
 && rm -f dist/*.test.js dist/*.test.d.ts

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY apps/workflow-service/package.json apps/workflow-service/package-lock.json* ./
RUN npm install --omit=dev || npm install --omit=dev \
 && chown -R node:node /app
COPY --from=build /app/dist ./dist
USER node
# No PORT/EXPOSE: the runner only makes outbound HTTPS calls to the gateway.
CMD ["node", "dist/runner.js"]
