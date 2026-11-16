// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SQL safety and identifier helpers for Synapse Warehouse.
 *
 * Queries run inside a per-tenant DuckDB database, so tenants cannot see each
 * other's tables. The remaining boundary is preventing a query from reading
 * files, extensions or writing to the warehouse. We only allow a single
 * SELECT/WITH statement and reject any DDL/DML or file-reading function.
 */
import { ColumnType, WarehouseColumn } from './types';

export const DATASET_ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
export const COLUMN_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const COLUMN_TYPES: ColumnType[] = ['string', 'number', 'boolean', 'timestamp', 'json'];

const FORBIDDEN_SQL = new RegExp(
  String.raw`\b(` +
    [
      'attach', 'detach', 'copy', 'install', 'load', 'pragma', 'export', 'import',
      'create', 'insert', 'update', 'delete', 'drop', 'alter', 'truncate',
      'grant', 'revoke', 'call', 'set', 'reset', 'vacuum', 'checkpoint',
      'read_csv', 'read_csv_auto', 'read_parquet', 'read_json', 'read_json_auto',
      'read_ndjson', 'read_ndjson_auto', 'sqlite_scan', 'postgres_scan',
      'mysql_scan', 'iceberg_scan', 'delta_scan', 'parquet_scan', 'csv_scan',
      'json_scan', 'ndjson_scan', 'avro_scan', 'glob', 'getenv',
      'query_table', 'query', 'duckdb_', 'sniff_csv', 'parquet_metadata', 'parquet_schema',
    ].join('|') +
    String.raw`)\b`,
  'i',
);

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function tableName(datasetId: string): string {
  // Dataset ids are lower-case slugs and cannot start with '_', so using the
  // id directly keeps SQL natural (`FROM city_incidents`) and cannot collide
  // with the `_datasets`/`_jobs` metadata tables.
  return datasetId;
}

export function duckType(type: ColumnType): string {
  switch (type) {
    case 'number': return 'DOUBLE';
    case 'boolean': return 'BOOLEAN';
    case 'timestamp': return 'TIMESTAMP';
    case 'json': return 'JSON';
    default: return 'VARCHAR';
  }
}

export function fromDuckType(type: string): ColumnType {
  const upper = String(type || '').toUpperCase();
  if (/^(DOUBLE|REAL|FLOAT|DECIMAL|NUMERIC|INTEGER|BIGINT|SMALLINT|TINYINT|HUGEINT|UBIGINT)/.test(upper)) return 'number';
  if (upper === 'BOOLEAN') return 'boolean';
  if (/TIMESTAMP|DATE|TIME/.test(upper)) return 'timestamp';
  if (upper === 'JSON') return 'json';
  return 'string';
}

export function slugifyDatasetId(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return raw;
}

export function normalizeColumns(input: unknown): WarehouseColumn[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new Error('columns must be an array of 1..64 column definitions');
  }
  const seen = new Set<string>();
  const columns: WarehouseColumn[] = [];
  for (const raw of input) {
    const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const name = String(entry.name ?? '').trim().toLowerCase();
    const type = String(entry.type ?? 'string').trim().toLowerCase() as ColumnType;
    if (!COLUMN_NAME_RE.test(name)) {
      throw new Error(`invalid column name '${name}' (lower-case letter, then letters/digits/underscore; max 63)`);
    }
    if (seen.has(name)) throw new Error(`duplicate column '${name}'`);
    if (!COLUMN_TYPES.includes(type)) {
      throw new Error(`invalid column type '${type}' (${COLUMN_TYPES.join(', ')})`);
    }
    seen.add(name);
    columns.push({ name, type });
  }
  return columns;
}

/** Blank SQL string/identifier literals so keyword checks do not reject data
 *  values such as `WHERE operation = 'delete'`. Quotes are preserved only as
 *  spaces; a mismatched quote is left for DuckDB to reject. */
function maskLiterals(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch !== "'" && ch !== '"') { out += ch; continue; }
    const quote = ch;
    out += ' ';
    i++;
    while (i < sql.length) {
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) { out += ' '; i += 2; continue; }
        out += ' '; break;
      }
      out += ' ';
      i++;
    }
  }
  return out;
}

/** Return a safe single-statement SELECT/WITH query, or throw a stable error. */
export function assertReadOnlySql(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('sql must be a string');
  const sql = raw.trim();
  if (!sql) throw new Error('sql is required');
  if (sql.length > 100_000) throw new Error('sql exceeds 100KB');
  const withoutTrailing = sql.replace(/;+\s*$/, '');
  const masked = maskLiterals(withoutTrailing);
  if (masked.includes(';')) throw new Error('only one SQL statement is allowed');
  if (withoutTrailing.includes('--') || withoutTrailing.includes('/*')) {
    throw new Error('SQL comments are not allowed');
  }
  if (!/^(select|with)\b/i.test(masked)) {
    throw new Error('only read-only SELECT/WITH queries are allowed');
  }
  const forbidden = masked.match(FORBIDDEN_SQL);
  if (forbidden) {
    throw new Error(`SQL contains a forbidden keyword: ${forbidden[1]}`);
  }
  if (/\bread_[a-z0-9_]*\s*\(/i.test(masked)) {
    throw new Error('file-reading functions are not allowed');
  }
  // Underscore-prefixed tables are service internals (dataset/job metadata and
  // usage rollups). Dataset ids cannot start with '_', so this cannot hide a
  // user-created table.
  if (/\b(?:from|join)\s+"?_[a-z0-9_]+"?/i.test(masked)) {
    throw new Error('internal warehouse tables are not queryable');
  }
  return withoutTrailing;
}

/** Limit a user query without trusting the caller's LIMIT clause. */
export function limitedSql(sql: string, limit: number): string {
  return `SELECT * FROM (${sql}) AS "__synapse_q" LIMIT ${Math.max(1, Math.min(limit + 1, 10001))}`;
}
