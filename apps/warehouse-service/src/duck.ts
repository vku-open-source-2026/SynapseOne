// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * DuckDB-backed, tenant-scoped OLAP store.
 *
 * Each tenant gets an independent DuckDB database file. Dataset metadata and
 * ETL jobs live in the same file, so there is no cross-tenant query surface.
 * The in-memory mode used by tests creates one database per tenant too.
 */
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  DatasetMeta,
  JobMeta,
  JobMode,
  JobStatus,
  QueryResult,
  WarehouseColumn,
  WriteMode,
} from './types';
import {
  assertReadOnlySql,
  duckType,
  fromDuckType,
  limitedSql,
  quoteIdent,
  tableName,
} from './sql';

export type Conn = any;

interface TenantDb {
  instance: any;
  conn: Conn;
  tail: Promise<void>;
}

const DATASET_COLUMNS = 'id, name, description, columns_json, mode, stream_topic, created_at, updated_at';
const JOB_COLUMNS = [
  'id', 'name', 'mode', 'status', 'target_dataset_id', 'sql', 'stream_topic',
  'stream_group', 'batch_size', 'interval_ms', 'write_mode', 'created_at',
  'updated_at', 'last_run_at', 'last_error',
].join(', ');

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeValue(value: any): any {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeValue(item);
    return out;
  }
  return value;
}

export async function readAll(conn: Conn, sql: string, params?: any[]): Promise<{
  columns: string[];
  types: string[];
  rows: Record<string, any>[];
}> {
  const reader = params && params.length
    ? await conn.runAndReadAll(sql, params)
    : await conn.runAndReadAll(sql);
  const rows = (reader.getRowObjectsJS ? reader.getRowObjectsJS() : reader.getRowObjects())
    .map((row: Record<string, any>) => {
      const out: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
      return out;
    });
  return {
    columns: reader.columnNames(),
    types: reader.columnTypes().map((type: any) => String(type)),
    rows,
  };
}

function toDataset(row: Record<string, any>, rowCount = 0): DatasetMeta {
  let columns: WarehouseColumn[] = [];
  try {
    columns = JSON.parse(String(row.columns_json ?? '[]'));
  } catch {
    columns = [];
  }
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    columns,
    mode: row.mode === 'stream' ? 'stream' : 'batch',
    streamTopic: row.stream_topic ? String(row.stream_topic) : null,
    rowCount,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toJob(row: Record<string, any>): JobMeta {
  return {
    id: String(row.id),
    name: String(row.name),
    mode: row.mode === 'stream' ? 'stream' : 'batch',
    status: row.status === 'paused' ? 'paused' : 'running',
    targetDatasetId: String(row.target_dataset_id),
    sql: row.sql ? String(row.sql) : null,
    streamTopic: row.stream_topic ? String(row.stream_topic) : null,
    streamGroup: row.stream_group ? String(row.stream_group) : null,
    batchSize: Number(row.batch_size ?? 100),
    intervalMs: Number(row.interval_ms ?? 1000),
    writeMode: row.write_mode === 'replace' ? 'replace' : 'append',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  };
}

export class WarehouseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WarehouseError';
  }
}

export class WarehouseStore {
  private readonly dbs = new Map<string, Promise<TenantDb>>();

  private memoryMode(): boolean {
    return process.env.WAREHOUSE_IN_MEMORY === '1'
      || process.env.WAREHOUSE_DATA_DIR === ':memory:';
  }

  private dataDir(): string {
    return process.env.WAREHOUSE_DATA_DIR || '/data/warehouse';
  }

  private rememberTenant(tenant: string): void {
    if (this.memoryMode()) return;
    const file = join(this.dataDir(), 'tenants.json');
    let tenants: string[] = [];
    try {
      if (existsSync(file)) tenants = JSON.parse(readFileSync(file, 'utf8')) as string[];
    } catch {
      tenants = [];
    }
    if (!tenants.includes(tenant)) {
      tenants.push(tenant);
      writeFileSync(file, JSON.stringify(tenants));
    }
  }

  async listTenants(): Promise<string[]> {
    if (this.memoryMode()) return [...this.dbs.keys()];
    const file = join(this.dataDir(), 'tenants.json');
    try {
      if (!existsSync(file)) return [];
      return JSON.parse(readFileSync(file, 'utf8')) as string[];
    } catch {
      return [];
    }
  }

  private async open(tenant: string): Promise<TenantDb> {
    let path = ':memory:';
    if (!this.memoryMode()) {
      mkdirSync(this.dataDir(), { recursive: true });
      const hash = createHash('sha256').update(tenant).digest('hex').slice(0, 32);
      path = join(this.dataDir(), `${hash}.duckdb`);
    }
    this.rememberTenant(tenant);
    // Lazy import keeps the native module out of unit tests that only assert
    // request validation (and matches the service's startup budget).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DuckDBInstance } = require('@duckdb/node-api');
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    const threads = Math.max(1, Math.min(Number(process.env.WAREHOUSE_THREADS || 2), 16));
    await conn.run(`SET threads=${threads}`);
    await conn.run(`CREATE TABLE IF NOT EXISTS _datasets (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      description VARCHAR,
      columns_json VARCHAR NOT NULL,
      mode VARCHAR NOT NULL,
      stream_topic VARCHAR,
      created_at VARCHAR NOT NULL,
      updated_at VARCHAR NOT NULL
    )`);
    await conn.run(`CREATE TABLE IF NOT EXISTS _ingest_events (
      event_id VARCHAR NOT NULL,
      dataset_id VARCHAR NOT NULL,
      job_id VARCHAR,
      applied_at VARCHAR NOT NULL,
      PRIMARY KEY (event_id, dataset_id)
    )`);
    await conn.run(`CREATE TABLE IF NOT EXISTS _jobs (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      mode VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      target_dataset_id VARCHAR NOT NULL,
      sql VARCHAR,
      stream_topic VARCHAR,
      stream_group VARCHAR,
      batch_size INTEGER,
      interval_ms INTEGER,
      write_mode VARCHAR,
      created_at VARCHAR NOT NULL,
      updated_at VARCHAR NOT NULL,
      last_run_at VARCHAR,
      last_error VARCHAR
    )`);
    return { instance, conn, tail: Promise.resolve() };
  }

  async db(tenant: string): Promise<TenantDb> {
    let existing = this.dbs.get(tenant);
    if (!existing) {
      existing = this.open(tenant);
      this.dbs.set(tenant, existing);
    }
    return existing;
  }

  /** Serialise every statement per tenant (DuckDB connections are not concurrent-safe). */
  async run<T>(tenant: string, fn: (conn: Conn) => Promise<T>): Promise<T> {
    const db = await this.db(tenant);
    const next = db.tail.then(() => fn(db.conn));
    db.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  async listDatasets(tenant: string): Promise<DatasetMeta[]> {
    return this.run(tenant, async (conn) => {
      const result = await readAll(conn, `SELECT ${DATASET_COLUMNS} FROM _datasets ORDER BY created_at`);
      const out: DatasetMeta[] = [];
      for (const row of result.rows) {
        const count = await readAll(conn, `SELECT count(*) AS n FROM ${quoteIdent(tableName(String(row.id)))}`);
        out.push(toDataset(row, Number(count.rows[0]?.n ?? 0)));
      }
      return out;
    });
  }

  async getDataset(tenant: string, id: string): Promise<DatasetMeta | null> {
    return this.run(tenant, async (conn) => {
      const result = await readAll(conn, `SELECT ${DATASET_COLUMNS} FROM _datasets WHERE id = ?`, [id]);
      if (!result.rows.length) return null;
      const count = await readAll(conn, `SELECT count(*) AS n FROM ${quoteIdent(tableName(id))}`);
      return toDataset(result.rows[0], Number(count.rows[0]?.n ?? 0));
    });
  }

  async createDataset(tenant: string, input: {
    id: string;
    name: string;
    description?: string;
    columns: WarehouseColumn[];
    mode?: 'batch' | 'stream';
    streamTopic?: string | null;
  }): Promise<DatasetMeta> {
    const now = nowIso();
    return this.run(tenant, async (conn) => {
      const existing = await readAll(conn, 'SELECT id FROM _datasets WHERE id = ?', [input.id]);
      if (existing.rows.length) {
        throw new WarehouseError(409, 'dataset_exists', `dataset '${input.id}' already exists`);
      }
      const defs = input.columns
        .map((column) => `${quoteIdent(column.name)} ${duckType(column.type)}`)
        .join(', ');
      await conn.run(`CREATE TABLE ${quoteIdent(tableName(input.id))} (${defs})`);
      await conn.run(
        `INSERT INTO _datasets (${DATASET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.name,
          input.description ?? '',
          JSON.stringify(input.columns),
          input.mode ?? 'batch',
          input.streamTopic ?? null,
          now,
          now,
        ],
      );
      return {
        id: input.id,
        name: input.name,
        description: input.description ?? '',
        columns: input.columns,
        mode: input.mode ?? 'batch',
        streamTopic: input.streamTopic ?? null,
        rowCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  async deleteDataset(tenant: string, id: string): Promise<boolean> {
    return this.run(tenant, async (conn) => {
      const existing = await readAll(conn, 'SELECT id FROM _datasets WHERE id = ?', [id]);
      if (!existing.rows.length) return false;
      await conn.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName(id))}`);
      await conn.run('DELETE FROM _jobs WHERE target_dataset_id = ?', [id]);
      await conn.run('DELETE FROM _ingest_events WHERE dataset_id = ?', [id]);
      await conn.run('DELETE FROM _datasets WHERE id = ?', [id]);
      return true;
    });
  }

  private async insertRowsOnConn(conn: Conn, dataset: DatasetMeta, rows: unknown[]): Promise<number> {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000) {
      throw new WarehouseError(400, 'invalid_rows', 'rows must be an array of 1..5000 objects');
    }
    const columns = dataset.columns;
    const tuples: string[] = [];
    const values: any[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new WarehouseError(400, 'invalid_rows', 'every row must be a JSON object');
      }
      const row = raw as Record<string, unknown>;
      const placeholders: string[] = [];
      for (const column of columns) {
        const cast = column.type === 'json'
          ? '?::JSON'
          : column.type === 'timestamp'
            ? '?::TIMESTAMP'
            : '?';
        placeholders.push(cast);
        let value = row[column.name];
        if (value === undefined) value = null;
        if (value !== null) {
          if (column.type === 'json') value = typeof value === 'string' ? value : JSON.stringify(value);
          else if (column.type === 'timestamp') value = value instanceof Date ? value.toISOString() : String(value);
          else if (column.type === 'boolean') value = Boolean(value);
          else if (column.type === 'number') {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) {
              throw new WarehouseError(400, 'invalid_rows', `column '${column.name}' must be numeric`);
            }
            value = numeric;
          } else if (typeof value === 'object') {
            value = JSON.stringify(value);
          }
        }
        values.push(value);
      }
      tuples.push(`(${placeholders.join(', ')})`);
    }
    await conn.run(
      `INSERT INTO ${quoteIdent(tableName(dataset.id))} VALUES ${tuples.join(', ')}`,
      values,
    );
    await conn.run('UPDATE _datasets SET updated_at = ? WHERE id = ?', [nowIso(), dataset.id]);
    return rows.length;
  }

  async insertRows(tenant: string, dataset: DatasetMeta, rows: unknown[]): Promise<number> {
    return this.run(tenant, (conn) => this.insertRowsOnConn(conn, dataset, rows));
  }

  /** Durable stream materialization: rows + event-id marker commit together.
   *  A crash before ack leaves the marker, so redelivery is a no-op. */
  async ingestStreamEvents(
    tenant: string,
    dataset: DatasetMeta,
    jobId: string,
    events: Array<{ eventId: string; rows: Array<Record<string, unknown>> }>,
  ): Promise<{ inserted: number; duplicates: number }> {
    if (!events.length) return { inserted: 0, duplicates: 0 };
    return this.run(tenant, async (conn) => {
      let inserted = 0;
      let duplicates = 0;
      await conn.run('BEGIN');
      try {
        for (const event of events) {
          const existing = await readAll(conn, 'SELECT event_id FROM _ingest_events WHERE event_id = ? AND dataset_id = ?', [event.eventId, dataset.id]);
          if (existing.rows.length) { duplicates += 1; continue; }
          if (event.rows.length) inserted += await this.insertRowsOnConn(conn, dataset, event.rows);
          await conn.run(
            'INSERT INTO _ingest_events (event_id, dataset_id, job_id, applied_at) VALUES (?, ?, ?, ?)',
            [event.eventId, dataset.id, jobId, nowIso()],
          );
        }
        await conn.run('COMMIT');
      } catch (error) {
        await conn.run('ROLLBACK').catch(() => undefined);
        throw error;
      }
      return { inserted, duplicates };
    });
  }

  async query(tenant: string, rawSql: unknown, limit = 200): Promise<QueryResult> {
    const sql = assertReadOnlySql(rawSql);
    const bounded = Math.max(1, Math.min(Number(limit) || 200, 5000));
    const started = Date.now();
    return this.run(tenant, async (conn) => {
      let result: { columns: string[]; types: string[]; rows: Record<string, any>[] };
      const timeoutMs = Math.min(Math.max(Number(process.env.WAREHOUSE_QUERY_TIMEOUT_MS) || 15000, 1000), 120000);
      const timer = setTimeout(() => { try { conn.interrupt?.(); } catch { /* best effort */ } }, timeoutMs);
      try {
        result = await readAll(conn, limitedSql(sql, bounded));
      } catch (error) {
        const message = String((error as Error)?.message || error).slice(0, 500);
        if (/interrupt|cancel/i.test(message)) {
          throw new WarehouseError(408, 'query_timeout', `query exceeded ${timeoutMs}ms`);
        }
        throw new WarehouseError(400, 'query_failed', message);
      } finally {
        clearTimeout(timer);
      }
      const truncated = result.rows.length > bounded;
      const rows = truncated ? result.rows.slice(0, bounded) : result.rows;
      const payload = JSON.stringify(rows);
      if (payload.length > 5 * 1024 * 1024) {
        throw new WarehouseError(413, 'result_too_large', 'query result exceeds 5MB; add filters or aggregates');
      }
      return {
        columns: result.columns,
        types: result.types,
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - started,
      };
    });
  }

  async listJobs(tenant: string): Promise<JobMeta[]> {
    return this.run(tenant, async (conn) => {
      const result = await readAll(conn, `SELECT ${JOB_COLUMNS} FROM _jobs ORDER BY created_at`);
      return result.rows.map(toJob);
    });
  }

  async getJob(tenant: string, id: string): Promise<JobMeta | null> {
    return this.run(tenant, async (conn) => {
      const result = await readAll(conn, `SELECT ${JOB_COLUMNS} FROM _jobs WHERE id = ?`, [id]);
      return result.rows.length ? toJob(result.rows[0]) : null;
    });
  }

  async findJobByName(tenant: string, name: string): Promise<JobMeta | null> {
    return this.run(tenant, async (conn) => {
      const result = await readAll(
        conn,
        `SELECT ${JOB_COLUMNS} FROM _jobs WHERE name = ? ORDER BY created_at DESC LIMIT 1`,
        [name],
      );
      return result.rows.length ? toJob(result.rows[0]) : null;
    });
  }

  async createJob(tenant: string, input: {
    name: string;
    mode: JobMode;
    targetDatasetId: string;
    sql?: string | null;
    streamTopic?: string | null;
    streamGroup?: string | null;
    batchSize?: number;
    intervalMs?: number;
    writeMode?: WriteMode;
  }): Promise<JobMeta> {
    const now = nowIso();
    const id = randomUUID();
    return this.run(tenant, async (conn) => {
      await conn.run(
        `INSERT INTO _jobs (${JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.mode,
          'running',
          input.targetDatasetId,
          input.sql ?? null,
          input.streamTopic ?? null,
          input.streamGroup ?? null,
          input.batchSize ?? 100,
          input.intervalMs ?? 1000,
          input.writeMode ?? 'append',
          now,
          now,
          null,
          null,
        ],
      );
      return {
        id,
        name: input.name,
        mode: input.mode,
        status: 'running',
        targetDatasetId: input.targetDatasetId,
        sql: input.sql ?? null,
        streamTopic: input.streamTopic ?? null,
        streamGroup: input.streamGroup ?? null,
        batchSize: input.batchSize ?? 100,
        intervalMs: input.intervalMs ?? 1000,
        writeMode: input.writeMode ?? 'append',
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastError: null,
      };
    });
  }

  async setJobStatus(tenant: string, id: string, status: JobStatus): Promise<JobMeta | null> {
    return this.run(tenant, async (conn) => {
      await conn.run('UPDATE _jobs SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
      const result = await readAll(conn, `SELECT ${JOB_COLUMNS} FROM _jobs WHERE id = ?`, [id]);
      return result.rows.length ? toJob(result.rows[0]) : null;
    });
  }

  async recordJobRun(tenant: string, id: string, rows: number): Promise<void> {
    await this.run(tenant, async (conn) => {
      await conn.run(
        'UPDATE _jobs SET last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?',
        [nowIso(), nowIso(), id],
      );
      // Keep a bounded run log in the same row's last_error-free metadata only;
      // detailed run history is intentionally left to Tier-2 reports/audit.
      void rows;
    });
  }

  async recordJobError(tenant: string, id: string, error: unknown): Promise<void> {
    const message = String((error as Error)?.message || error).slice(0, 1000);
    await this.run(tenant, async (conn) => {
      await conn.run(
        'UPDATE _jobs SET last_error = ?, updated_at = ? WHERE id = ?',
        [message, nowIso(), id],
      );
    });
  }

  async deleteJob(tenant: string, id: string): Promise<boolean> {
    return this.run(tenant, async (conn) => {
      const existing = await readAll(conn, 'SELECT id FROM _jobs WHERE id = ?', [id]);
      if (!existing.rows.length) return false;
      await conn.run('DELETE FROM _jobs WHERE id = ?', [id]);
      return true;
    });
  }

  async runningStreamJobs(): Promise<Array<{ tenant: string; job: JobMeta }>> {
    const tenants = await this.listTenants();
    const out: Array<{ tenant: string; job: JobMeta }> = [];
    for (const tenant of tenants) {
      const jobs = await this.listJobs(tenant);
      for (const job of jobs) {
        if (job.mode === 'stream' && job.status === 'running' && job.streamTopic) {
          out.push({ tenant, job });
        }
      }
    }
    return out;
  }

  /** Apply a batch ETL query to the target dataset (append or replace). */
  async runBatchJob(tenant: string, job: JobMeta): Promise<{ rows: number; durationMs: number }> {
    if (!job.sql) throw new WarehouseError(400, 'invalid_job', 'batch jobs require sql');
    const sql = assertReadOnlySql(job.sql);
    const started = Date.now();
    return this.run(tenant, async (conn) => {
      const target = await readAll(conn, 'SELECT id FROM _datasets WHERE id = ?', [job.targetDatasetId]);
      if (!target.rows.length) {
        throw new WarehouseError(404, 'dataset_not_found', `target dataset '${job.targetDatasetId}' not found`);
      }
      const targetTable = quoteIdent(tableName(job.targetDatasetId));
      try {
        if (job.writeMode === 'replace') {
          await conn.run(`CREATE OR REPLACE TABLE ${targetTable} AS ${sql}`);
          const described = await readAll(conn, `DESCRIBE ${targetTable}`);
          const columns: WarehouseColumn[] = described.rows.map((row) => ({
            name: String(row.column_name),
            type: fromDuckType(String(row.column_type)),
          }));
          await conn.run(
            'UPDATE _datasets SET columns_json = ?, updated_at = ? WHERE id = ?',
            [JSON.stringify(columns), nowIso(), job.targetDatasetId],
          );
        } else {
          await conn.run(`INSERT INTO ${targetTable} ${sql}`);
        }
        const counted = await readAll(conn, `SELECT count(*) AS n FROM ${targetTable}`);
        await conn.run(
          'UPDATE _jobs SET last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?',
          [nowIso(), nowIso(), job.id],
        );
        return {
          rows: Number(counted.rows[0]?.n ?? 0),
          durationMs: Date.now() - started,
        };
      } catch (error) {
        if (error instanceof WarehouseError) throw error;
        throw new WarehouseError(400, 'etl_failed', String((error as Error)?.message || error).slice(0, 500));
      }
    });
  }

  /** Tenant-scoped operational snapshot for the pipeline status API. */
  async pipelineStatus(tenant: string): Promise<any> {
    return this.run(tenant, async (conn) => {
      const datasets = await readAll(conn, 'SELECT count(*) AS n FROM _datasets');
      const jobs = await readAll(conn, `SELECT status, count(*) AS n FROM _jobs GROUP BY status`);
      const last = await readAll(conn, `SELECT max(last_run_at) AS last_run, max(updated_at) AS updated, max(last_error) AS last_error FROM _jobs`);
      const applied = await readAll(conn, 'SELECT count(*) AS n FROM _ingest_events e JOIN _datasets d ON d.id = e.dataset_id');
      const rows = jobs.rows as Array<{ status: string; n: number }>;
      return {
        datasets: Number(datasets.rows[0]?.n) || 0,
        jobs: Number(rows.reduce((sum, row) => sum + Number(row.n || 0), 0)),
        running: Number(rows.find((row) => row.status === 'running')?.n || 0),
        paused: Number(rows.find((row) => row.status === 'paused')?.n || 0),
        appliedEvents: Number(applied.rows[0]?.n) || 0,
        lastRunAt: last.rows[0]?.last_run ? String(last.rows[0].last_run) : null,
        updatedAt: last.rows[0]?.updated ? String(last.rows[0].updated) : null,
        lastError: last.rows[0]?.last_error ? String(last.rows[0].last_error) : null,
      };
    });
  }

  async reset(): Promise<void> {
    for (const pending of this.dbs.values()) {
      try {
        const db = await pending;
        db.instance.closeSync();
      } catch {
        // best-effort test cleanup
      }
    }
    this.dbs.clear();
  }
}

export const warehouseStore = new WarehouseStore();
