# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && rm -f dist/*.test.js dist/*.test.d.ts \
  && npm prune --omit=dev \
  && mkdir -p /data/warehouse \
  && chown -R node:node /app /data/warehouse
ENV PORT=4012 \
    WAREHOUSE_DATA_DIR=/data/warehouse
EXPOSE 4012
VOLUME ["/data/warehouse"]
USER node
CMD ["node", "dist/index.js"]
