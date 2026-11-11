// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Synapse Warehouse client: tenant-scoped OLAP datasets, read-only SQL,
 * batch/stream ETL jobs and built-in ETL templates.
 */

import { HttpClient } from './_http';

const P = '/v1/warehouse';

export type WarehouseColumnType = 'string' | 'number' | 'boolean' | 'timestamp' | 'json';

export interface WarehouseColumn {
  name: string;
  type: WarehouseColumnType;
}

export interface WarehouseDataset {
  id: string;
  name: string;
  description?: string;
  columns: WarehouseColumn[];
  mode: 'batch' | 'stream';
  streamTopic?: string | null;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseQueryResult {
  columns: string[];
  types: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface WarehouseJob {
  id: string;
  name: string;
  mode: 'batch' | 'stream';
  status: 'running' | 'paused';
  targetDatasetId: string;
  sql?: string | null;
  streamTopic?: string | null;
  batchSize: number;
  intervalMs: number;
  writeMode: 'append' | 'replace';
  lastRunAt?: string | null;
  lastError?: string | null;
}

export interface WarehouseTemplate {
  id: string;
  name: string;
  mode: 'batch' | 'stream';
  description: string;
  sqlTemplate?: string;
  targetColumns?: WarehouseColumn[];
  streamTopicHint?: string;
  writeMode?: 'append' | 'replace';
}

export interface WarehouseDatasetInput {
  id?: string;
  name: string;
  description?: string;
  columns: WarehouseColumn[];
  mode?: 'batch' | 'stream';
  streamTopic?: string;
}

export interface WarehouseBatchJobInput {
  name?: string;
  targetDatasetId: string;
  sql: string;
  writeMode?: 'append' | 'replace';
}

export interface WarehouseStreamJobInput {
  name?: string;
  targetDatasetId: string;
  streamTopic: string;
  streamGroup?: string;
  batchSize?: number;
  intervalMs?: number;
}

export class WarehouseService {
  constructor(private readonly http: HttpClient) {}

  listDatasets() {
    return this.http.req<{ items: WarehouseDataset[] }>(`${P}/datasets`);
  }

  getDataset(id: string) {
    return this.http.req<WarehouseDataset>(`${P}/datasets/${encodeURIComponent(id)}`);
  }

  createDataset(input: WarehouseDatasetInput) {
    return this.http.req<WarehouseDataset>(`${P}/datasets`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  deleteDataset(id: string) {
    return this.http.req<{ ok: boolean; deleted: boolean }>(`${P}/datasets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  ingest(id: string, rows: Array<Record<string, unknown>>) {
    return this.http.req<{ ok: boolean; inserted: number }>(`${P}/datasets/${encodeURIComponent(id)}/rows`, {
      method: 'POST',
      body: JSON.stringify({ rows }),
    });
  }

  query(sql: string, opts: { limit?: number } = {}) {
    return this.http.req<WarehouseQueryResult>(`${P}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, limit: opts.limit }),
    });
  }

  templates() {
    return this.http.req<{ items: WarehouseTemplate[] }>(`${P}/templates`);
  }

  listJobs() {
    return this.http.req<{ items: WarehouseJob[] }>(`${P}/jobs`);
  }

  getJob(id: string) {
    return this.http.req<WarehouseJob>(`${P}/jobs/${encodeURIComponent(id)}`);
  }

  createJob(input: WarehouseBatchJobInput | WarehouseStreamJobInput) {
    return this.http.req<WarehouseJob>(`${P}/jobs`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  runBatch(input: WarehouseBatchJobInput) {
    return this.http.req<{ ok: boolean; rows: number; durationMs: number }>(`${P}/etl/batch`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  ensureStream(input: WarehouseStreamJobInput) {
    return this.http.req<{ ok: boolean; created: boolean; job: WarehouseJob }>(`${P}/etl/stream`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  runJob(id: string) {
    return this.http.req<{ ok: boolean; rows: number; durationMs: number }>(`${P}/jobs/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    });
  }

  pauseJob(id: string) {
    return this.http.req<WarehouseJob>(`${P}/jobs/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  }

  resumeJob(id: string) {
    return this.http.req<WarehouseJob>(`${P}/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  }

  deleteJob(id: string) {
    return this.http.req<{ ok: boolean; deleted: boolean }>(`${P}/jobs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
}
