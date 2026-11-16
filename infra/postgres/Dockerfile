# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Postgres 16 with pgvector (vector search) and PostGIS (geospatial queries).
FROM pgvector/pgvector:pg16
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-postgis-3 \
 && rm -rf /var/lib/apt/lists/*
