// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export type ColumnType = 'string' | 'number' | 'boolean' | 'timestamp' | 'json';

export interface WarehouseColumn {
  name: string;
  type: ColumnType;
}

export type DatasetMode = 'batch' | 'stream';

export interface DatasetMeta {
  id: string;
  name: string;
  description: string;
  columns: WarehouseColumn[];
  mode: DatasetMode;
  streamTopic: string | null;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
}

export type JobMode = 'batch' | 'stream';
export type JobStatus = 'running' | 'paused';
export type WriteMode = 'append' | 'replace';

export interface JobMeta {
  id: string;
  name: string;
  mode: JobMode;
  status: JobStatus;
  targetDatasetId: string;
  sql: string | null;
  streamTopic: string | null;
  streamGroup: string | null;
  batchSize: number;
  intervalMs: number;
  writeMode: WriteMode;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface QueryResult {
  columns: string[];
  types: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface EtlTemplate {
  id: string;
  name: string;
  mode: JobMode;
  description: string;
  sqlTemplate?: string;
  targetColumns?: WarehouseColumn[];
  streamTopicHint?: string;
  writeMode?: WriteMode;
}
