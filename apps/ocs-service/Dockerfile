# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && rm -f dist/*.test.js dist/*.test.d.ts \
  && npm prune --omit=dev \
  && chown -R node:node /app \
  && mkdir -p /backups && chown node:node /backups
ENV PORT=4010
EXPOSE 4010
USER node
CMD ["node", "dist/index.js"]
