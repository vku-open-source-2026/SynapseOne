// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Synapse Lakehouse client: tenant-scoped Apache Iceberg namespaces, tables,
 * snapshots (time travel), schema evolution and bounded scans.
 */

import { HttpClient } from './_http';

const P = '/v1/lakehouse';

export type LakehouseColumnType =
  | 'string'
  | 'long'
  | 'double'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'date'
  | 'json';

export interface LakehouseColumn {
  name: string;
  type: LakehouseColumnType;
  required?: boolean;
}

export interface LakehouseTable {
  namespace: string;
  name: string;
  location: string;
  formatVersion: number;
  schema: Array<{ id: number; name: string; type: string; required: boolean }>;
  currentSnapshotId: string | null;
  snapshotCount: number;
  properties: Record<string, string>;
}

export interface LakehouseSnapshot {
  snapshotId: string;
  parentSnapshotId: string | null;
  timestampMs: number;
  operation: string;
  summary: Record<string, string>;
}

export interface LakehouseQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  limit: number;
  snapshotId: string | null;
  columns: string[];
}

export interface LakehouseUsage {
  namespaces: number;
  tables: number;
  maxNamespaces: number;
  maxTablesPerNamespace: number;
  maxRowsPerAppend: number;
  bytesQuotaEnforced: boolean;
}

export class LakehouseService {
  constructor(private http: HttpClient) {}

  usage() {
    return this.http.req<LakehouseUsage>(`${P}/usage`);
  }
  namespaces() {
    return this.http.req<{ items: string[] }>(`${P}/namespaces`);
  }
  createNamespace(name: string) {
    return this.http.req(`${P}/namespaces`, { method: 'POST', body: JSON.stringify({ name }) });
  }
  deleteNamespace(namespace: string) {
    return this.http.req(`${P}/namespaces/${encodeURIComponent(namespace)}`, { method: 'DELETE' });
  }
  tables(namespace: string) {
    return this.http.req<{ items: string[] }>(
      `${P}/namespaces/${encodeURIComponent(namespace)}/tables`,
    );
  }
  createTable(namespace: string, input: { name: string; schema: LakehouseColumn[] }) {
    return this.http.req<LakehouseTable>(
      `${P}/namespaces/${encodeURIComponent(namespace)}/tables`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }
  table(namespace: string, table: string) {
    return this.http.req<LakehouseTable>(
      `${P}/namespaces/${encodeURIComponent(namespace)}/tables/${encodeURIComponent(table)}`,
    );
  }
  deleteTable(namespace: string, table: string) {
    return this.http.req<{ deleted: boolean; dataFilesRetained: boolean }>(
      `${P}/namespaces/${encodeURIComponent(namespace)}/tables/${encodeURIComponent(table)}`,
      { method: 'DELETE' },
    );
  }
  append(
    namespace: string,
    table: string,
    rows: Array<Record<string, unknown>>,
    idempotencyKey?: string,
  ) {
    return this.http.req<{ ok: boolean; duplicate: boolean; snapshotId: string; rows: number }>(
      `${P}/namespaces/${encodeURIComponent(namespace)}/tables/${encodeURIComponent(table)}/rows`,
      {
        method: 'POST',
        body: JSON.stringify({ rows, ...(idempotencyKey ? { idempotencyKey } : {}) }),
      },
    );
  }
  query(
    namespace: string,
    table: string,
    options: { limit?: number; snapshotId?: string } = {},
  ) {
    return this.http.req<LakehouseQueryResult>(
      `${P}/namespaces/${encodeURIComponent(namespace)}/tables/${encodeURIComponent(table)}/query`,
      { method: 'POST', body: JSON.stringify(options) },
    );
  }
  snapshots(namespace: string, table: string) {
    return this.http.req<{ items: LakehouseSnapshot[] }>(
      `${P}/namespaces/${encodeURIComponent(namespace)}/tables/${encodeURIComponent(table)}/snapshots`,
    );
  }
  evolve(namespace: string, table: string, add: LakehouseColumn[]) {
    return this.http.req<LakehouseTable>(
      `${P}/namespaces/${encodeURIComponent(namespace)}/tables/${encodeURIComponent(table)}/schema`,
      { method: 'POST', body: JSON.stringify({ add }) },
    );
  }
}
