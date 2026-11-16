// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Synapse Warehouse (Tier 1) — tenant-scoped OLAP datasets, SQL queries and
 * batch/stream ETL jobs. Batch transforms run in DuckDB; stream ETL consumes
 * SynapseStream and appends rows to a warehouse dataset.
 */
import './env-compat';

import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import morgan from 'morgan';
import { randomUUID } from 'crypto';
import { timingSafeEqual } from 'crypto';
import { WarehouseError, warehouseStore } from './duck';
import { assertReadOnlySql, DATASET_ID_RE, normalizeColumns, slugifyDatasetId } from './sql';
import { replaceUsageRollup, usageStatsSummary, usageWatermark, UsageStatsFilter } from './usage-stats';
import { EtlTemplate, JobMode, JobStatus, WarehouseColumn, WriteMode } from './types';

dotenv.config();

const PORT = Number(process.env.PORT || process.env.WAREHOUSE_PORT || 4012);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.9.0';
  } catch {
    return '0.9.0';
  }
})();

const IS_PROD = process.env.NODE_ENV === 'production';
const TOPIC_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GROUP_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export interface Principal {
  sub: string;
  org?: string;
  account?: string;
  kind?: string;
}

function header(req: Request, name: string): string {
  const legacy = name.startsWith('x-synapseone-')
    ? name.replace('x-synapseone-', 'x-synapsedx-')
    : name;
  const value = req.headers[name] ?? req.headers[legacy];
  return (Array.isArray(value) ? value[0] : value || '').trim();
}

export function resolveTenant(req: Request): string {
  const org = header(req, 'x-synapseone-org');
  const account = header(req, 'x-synapseone-account');
  const user = header(req, 'x-synapseone-user');
  if (org) return `org:${org}`.slice(0, 160);
  if (account) return `account:${account}`.slice(0, 160);
  if (user) return `user:${user}`.slice(0, 160);
  const explicit = (String(req.headers['x-synapseone-tenant'] ?? req.headers['x-synapsedx-tenant'] ?? '') || String(req.query.tenant || '')).trim();
  if (explicit && /^[A-Za-z0-9_:-]{1,128}$/.test(explicit)) return explicit;
  return 'platform';
}

function verifyInternal(req: Request): boolean {
  const secret = process.env.SYNAPSEONE_INTERNAL_SECRET;
  if (!secret) return false;
  const raw = req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal'];
  const value = (Array.isArray(raw) ? raw[0] : raw || '').trim();
  if (!value || value.length !== secret.length) return false;
  try {
    return timingSafeEqual(Buffer.from(value), Buffer.from(secret));
  } catch {
    return false;
  }
}

function requireString(value: unknown, field: string, max = 256): string {
  const text = String(value ?? '').trim();
  if (!text) throw new WarehouseError(400, 'field_required', `${field} is required`, { field });
  if (text.length > max) throw new WarehouseError(400, 'field_invalid', `${field} is too long`, { field, max });
  return text;
}

function optionalString(value: unknown, max = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().slice(0, max);
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function topicName(value: unknown): string {
  const topic = String(value ?? '').trim();
  if (!TOPIC_RE.test(topic)) {
    throw new WarehouseError(400, 'invalid_topic', 'streamTopic must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$');
  }
  return topic;
}

function groupName(value: unknown): string {
  const group = String(value ?? '').trim();
  if (!GROUP_RE.test(group)) {
    throw new WarehouseError(400, 'invalid_group', 'streamGroup is invalid');
  }
  return group;
}

export function etlTemplates(): EtlTemplate[] {
  return [
    {
      id: 'batch-daily-rollup',
      name: 'Daily rollup',
      mode: 'batch',
      description: 'Aggregate a timestamped dataset into one row per day and category, then replace the target dataset.',
      writeMode: 'replace',
      sqlTemplate:
        "SELECT date_trunc('day', occurred_at) AS day, category, count(*) AS events, avg(severity) AS avg_severity\n" +
        'FROM city_incidents\n' +
        'GROUP BY 1, 2\n' +
        'ORDER BY 1 DESC',
      targetColumns: [
        { name: 'day', type: 'timestamp' },
        { name: 'category', type: 'string' },
        { name: 'events', type: 'number' },
        { name: 'avg_severity', type: 'number' },
      ],
    },
    {
      id: 'batch-top-n',
      name: 'Top-N leaderboard',
      mode: 'batch',
      description: 'Rank a metric per group; useful for dashboards and published open-data snapshots.',
      writeMode: 'replace',
      sqlTemplate:
        'SELECT city, count(*) AS incidents, max(severity) AS worst_severity\n' +
        'FROM city_incidents\n' +
        'GROUP BY city\n' +
        'ORDER BY incidents DESC\n' +
        'LIMIT 20',
      targetColumns: [
        { name: 'city', type: 'string' },
        { name: 'incidents', type: 'number' },
        { name: 'worst_severity', type: 'number' },
      ],
    },
    {
      id: 'batch-window-compare',
      name: 'Period-over-period',
      mode: 'batch',
      description: 'Compare the last 7 days with the previous 7 days per category.',
      writeMode: 'replace',
      sqlTemplate:
        'WITH daily AS (\n' +
        "  SELECT date_trunc('day', occurred_at) AS day, category, count(*) AS events\n" +
        '  FROM city_incidents GROUP BY 1, 2\n' +
        '), totals AS (\n' +
        "  SELECT category, sum(CASE WHEN day >= current_date - INTERVAL 7 DAY THEN events ELSE 0 END) AS last_7d,\n" +
        "         sum(CASE WHEN day < current_date - INTERVAL 7 DAY AND day >= current_date - INTERVAL 14 DAY THEN events ELSE 0 END) AS prev_7d\n" +
        '  FROM daily GROUP BY category\n' +
        ')\n' +
        'SELECT category, last_7d, prev_7d, last_7d - prev_7d AS delta FROM totals ORDER BY delta ASC',
      targetColumns: [
        { name: 'category', type: 'string' },
        { name: 'last_7d', type: 'number' },
        { name: 'prev_7d', type: 'number' },
        { name: 'delta', type: 'number' },
      ],
    },
    {
      id: 'stream-sensor-ingest',
      name: 'Sensor stream ingest',
      mode: 'stream',
      description: 'Consume a SynapseStream topic and append each event payload to a sensor_readings dataset.',
      targetColumns: [
        { name: 'ts', type: 'timestamp' },
        { name: 'device_id', type: 'string' },
        { name: 'metric', type: 'string' },
        { name: 'value', type: 'number' },
      ],
      streamTopicHint: 'iot-sensors',
    },
    {
      id: 'stream-incident-ingest',
      name: 'Incident stream ingest',
      mode: 'stream',
      description: 'Consume incident events from SynapseStream and append them to a warehouse table.',
      targetColumns: [
        { name: 'ts', type: 'timestamp' },
        { name: 'category', type: 'string' },
        { name: 'severity', type: 'number' },
        { name: 'description', type: 'string' },
      ],
      streamTopicHint: 'city-incidents',
    },
  ];
}

// ---- stream ETL workers ----
const workers = new Map<string, { stop: boolean }>();

function streamBase(): string {
  return (process.env.STREAM_SERVICE_URL || 'http://stream:4009').replace(/\/$/, '');
}

async function streamCall(
  method: string,
  path: string,
  tenant: string,
  body?: unknown,
  allowConflict = false,
): Promise<any> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-synapseone-tenant': tenant,
  };
  const secret = process.env.SYNAPSEONE_INTERNAL_SECRET;
  if (secret) headers['x-synapseone-internal'] = secret;
  const response = await fetch(`${streamBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!response.ok && !(allowConflict && response.status === 409)) {
    const message = parsed?.message || parsed?.error || text.slice(0, 200);
    throw new Error(`SynapseStream ${method} ${path} -> ${response.status}: ${message}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(50, ms)));
}

function payloadRows(payload: unknown): Array<Record<string, unknown>> {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* keep string */ }
  }
  if (Array.isArray(value)) {
    return value.map((item) => (
      item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : { value: item }
    ));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return [value as Record<string, unknown>];
  }
  return [{ value }];
}

async function runStreamWorker(tenant: string, jobId: string): Promise<void> {
  if (workers.has(jobId)) return;
  const state = { stop: false };
  workers.set(jobId, state);
  let backoff = 1000;
  try {
    while (!state.stop) {
      const job = await warehouseStore.getJob(tenant, jobId);
      if (!job || job.mode !== 'stream' || job.status !== 'running' || !job.streamTopic) break;
      const dataset = await warehouseStore.getDataset(tenant, job.targetDatasetId);
      if (!dataset) {
        await warehouseStore.recordJobError(tenant, jobId, `target dataset '${job.targetDatasetId}' not found`);
        break;
      }
      const group = job.streamGroup || `warehouse_${job.id}`;
      try {
        await streamCall('PUT', `/v1/stream/topics/${encodeURIComponent(job.streamTopic)}`, tenant, {}, true);
        await streamCall('PUT', `/v1/stream/topics/${encodeURIComponent(job.streamTopic)}/groups/${encodeURIComponent(group)}`, tenant, { startId: '0' }, true);
        const read = await streamCall('POST', `/v1/stream/topics/${encodeURIComponent(job.streamTopic)}/groups/${encodeURIComponent(group)}/read`, tenant, {
          consumer: `warehouse-${job.id}`,
          count: Math.max(1, Math.min(job.batchSize || 100, 100)),
          blockMs: 500,
        });
        const events: Array<{ id: string; payload: unknown }> = Array.isArray(read?.events) ? read.events : [];
        if (!events.length) {
          await sleep(job.intervalMs || 1000);
          backoff = 1000;
          continue;
        }
        const materialized: Array<{ eventId: string; rows: Array<Record<string, unknown>> }> = [];
        for (const event of events) {
          const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
          const eventId = typeof payload.event_id === 'string' && payload.event_id
            ? payload.event_id
            : event.id;
          const rows = payloadRows(event.payload).map((row) => {
            const copy = { ...row };
            if (dataset.columns.some((column) => column.name === 'event_id') && copy.event_id === undefined) {
              copy.event_id = eventId;
            }
            return copy;
          });
          materialized.push({ eventId, rows });
        }
        await warehouseStore.ingestStreamEvents(tenant, dataset, job.id, materialized);
        await streamCall('POST', `/v1/stream/topics/${encodeURIComponent(job.streamTopic)}/groups/${encodeURIComponent(group)}/ack`, tenant, {
          ids: events.map((event) => event.id),
        });
        await warehouseStore.recordJobRun(tenant, job.id, events.length);
        backoff = 1000;
      } catch (error) {
        await warehouseStore.recordJobError(tenant, job.id, error);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  } finally {
    workers.delete(jobId);
  }
}

export async function startStreamWorkers(): Promise<void> {
  const jobs = await warehouseStore.runningStreamJobs();
  for (const { tenant, job } of jobs) void runStreamWorker(tenant, job.id);
}

function stopWorker(jobId: string): void {
  const state = workers.get(jobId);
  if (state) state.stop = true;
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: true }));
  app.use(morgan(process.env.NODE_ENV === 'test' ? 'tiny' : 'combined'));
  app.use(express.json({ limit: process.env.WAREHOUSE_MAX_BODY || '8mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'warehouse',
      version: VERSION,
      engine: 'duckdb',
      persistence: process.env.WAREHOUSE_IN_MEMORY === '1' ? 'memory' : 'file',
      time: new Date().toISOString(),
    });
  });
  app.get('/ready', (_req, res) => res.json({ status: 'ok', service: 'warehouse' }));

  app.use((req, res, next) => {
    if (!req.path.startsWith('/v1/')) return next();
    const secret = process.env.SYNAPSEONE_INTERNAL_SECRET;
    if (!secret) {
      if (IS_PROD) {
        return res.status(500).json({ error: 'misconfigured', message: 'SYNAPSEONE_INTERNAL_SECRET is required in production' });
      }
      return next();
    }
    if (!verifyInternal(req)) {
      return res.status(401).json({ error: 'unauthorized', message: 'missing or invalid internal credential' });
    }
    next();
  });

  // Internal telemetry rollups. There is deliberately no gateway route for
  // /internal/*; IAM calls these service-to-service with the shared secret.
  app.use('/internal/', (req, res, next) => {
    const secret = process.env.SYNAPSEONE_INTERNAL_SECRET;
    if (!secret) {
      if (IS_PROD) {
        return res.status(500).json({ error: 'misconfigured', message: 'SYNAPSEONE_INTERNAL_SECRET is required in production' });
      }
      return next();
    }
    if (!verifyInternal(req)) {
      return res.status(401).json({ error: 'unauthorized', message: 'missing or invalid internal credential' });
    }
    next();
  });

  app.post('/internal/usage/rollup', async (req, res, next) => {
    try {
      const result = await replaceUsageRollup(resolveTenant(req), req.body || {});
      res.status(201).json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.get('/internal/usage/watermark', async (req, res, next) => {
    try {
      res.json({ ok: true, ...(await usageWatermark(resolveTenant(req))) });
    } catch (error) { next(error); }
  });

  app.post('/internal/usage/summary', async (req, res, next) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const filter: UsageStatsFilter = {
        from: String(body.from ?? ''),
        to: String(body.to ?? ''),
        ...(body.feature ? { feature: String(body.feature) } : {}),
        ...(body.accountId ? { accountId: String(body.accountId) } : {}),
        ...(body.method ? { method: String(body.method) } : {}),
        ...(body.statusClass ? { statusClass: Number(body.statusClass) } : {}),
      };
      res.json(await usageStatsSummary(resolveTenant(req), filter));
    } catch (error) { next(error); }
  });

  app.get('/v1/warehouse/pipeline/status', async (req, res, next) => {
    try {
      res.json({ ok: true, ...(await warehouseStore.pipelineStatus(resolveTenant(req))) });
    } catch (error) { next(error); }
  });

  app.get('/metrics', async (_req, res) => {
    try {
      const tenants = await warehouseStore.listTenants();
      let datasets = 0; let jobs = 0; let applied = 0; let running = 0;
      for (const tenant of tenants) {
        const s = await warehouseStore.pipelineStatus(tenant);
        datasets += s.datasets; jobs += s.jobs; applied += s.appliedEvents; running += s.running;
      }
      res.type('text/plain').send([
        '# HELP synapseone_warehouse_up Warehouse service availability',
        '# TYPE synapseone_warehouse_up gauge',
        'synapseone_warehouse_up 1',
        '# HELP synapseone_warehouse_datasets Tenant datasets',
        '# TYPE synapseone_warehouse_datasets gauge',
        `synapseone_warehouse_datasets ${datasets}`,
        '# HELP synapseone_warehouse_jobs ETL jobs',
        '# TYPE synapseone_warehouse_jobs gauge',
        `synapseone_warehouse_jobs ${jobs}`,
        '# HELP synapseone_warehouse_running_stream_jobs Running stream jobs',
        '# TYPE synapseone_warehouse_running_stream_jobs gauge',
        `synapseone_warehouse_running_stream_jobs ${running}`,
        '# HELP synapseone_warehouse_applied_events Durable stream event markers',
        '# TYPE synapseone_warehouse_applied_events gauge',
        `synapseone_warehouse_applied_events ${applied}`,
      ].join('\n') + '\n');
    } catch {
      res.type('text/plain').status(200).send('synapseone_warehouse_up 0\n');
    }
  });

  // ---- datasets ----
  app.get('/v1/warehouse/datasets', async (req, res, next) => {
    try {
      res.json({ items: await warehouseStore.listDatasets(resolveTenant(req)) });
    } catch (error) { next(error); }
  });

  app.post('/v1/warehouse/datasets', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const name = requireString(body.name, 'name', 120);
      const id = slugifyDatasetId(body.id ?? name);
      if (!DATASET_ID_RE.test(id)) {
        throw new WarehouseError(400, 'invalid_id', 'id must be a lower-case slug of 2..41 characters');
      }
      let columns: WarehouseColumn[];
      try { columns = normalizeColumns(body.columns); }
      catch (error) { throw new WarehouseError(400, 'invalid_columns', (error as Error).message); }
      const mode = body.mode === 'stream' ? 'stream' : 'batch';
      const streamTopic = mode === 'stream' ? topicName(body.streamTopic) : null;
      const dataset = await warehouseStore.createDataset(tenant, {
        id,
        name,
        description: optionalString(body.description, 500) ?? '',
        columns,
        mode,
        streamTopic,
      });
      res.status(201).json(dataset);
    } catch (error) { next(error); }
  });

  app.get('/v1/warehouse/datasets/:id', async (req, res, next) => {
    try {
      const dataset = await warehouseStore.getDataset(resolveTenant(req), req.params.id);
      if (!dataset) throw new WarehouseError(404, 'dataset_not_found', 'dataset not found');
      res.json(dataset);
    } catch (error) { next(error); }
  });

  app.delete('/v1/warehouse/datasets/:id', async (req, res, next) => {
    try {
      const deleted = await warehouseStore.deleteDataset(resolveTenant(req), req.params.id);
      if (!deleted) throw new WarehouseError(404, 'dataset_not_found', 'dataset not found');
      res.json({ ok: true, deleted: true });
    } catch (error) { next(error); }
  });

  app.post('/v1/warehouse/datasets/:id/rows', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      const dataset = await warehouseStore.getDataset(tenant, req.params.id);
      if (!dataset) throw new WarehouseError(404, 'dataset_not_found', 'dataset not found');
      const body = (req.body || {}) as Record<string, unknown>;
      const rows = Array.isArray(body.rows) ? body.rows : (Array.isArray(req.body) ? req.body : null);
      if (!rows) throw new WarehouseError(400, 'invalid_rows', 'body must be { rows: [...] }');
      const inserted = await warehouseStore.insertRows(tenant, dataset, rows);
      res.status(201).json({ ok: true, inserted });
    } catch (error) { next(error); }
  });

  app.post('/v1/warehouse/query', async (req, res, next) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      let sql: string;
      try { sql = assertReadOnlySql(body.sql); }
      catch (error) { throw new WarehouseError(400, 'invalid_sql', (error as Error).message); }
      const result = await warehouseStore.query(resolveTenant(req), sql, positiveInt(body.limit, 200, 1, 5000));
      res.json(result);
    } catch (error) { next(error); }
  });

  // One-shot batch ETL used by SynapseFlow templates: create an auditable job
  // and run it immediately.
  app.post('/v1/warehouse/etl/batch', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const targetDatasetId = requireString(body.targetDatasetId, 'targetDatasetId', 64);
      const target = await warehouseStore.getDataset(tenant, targetDatasetId);
      if (!target) throw new WarehouseError(404, 'dataset_not_found', 'target dataset not found');
      let sql: string;
      try { sql = assertReadOnlySql(body.sql); }
      catch (error) { throw new WarehouseError(400, 'invalid_sql', (error as Error).message); }
      const job = await warehouseStore.createJob(tenant, {
        name: requireString(body.name ?? `adhoc-${targetDatasetId}`, 'name', 120),
        mode: 'batch',
        targetDatasetId,
        sql,
        writeMode: body.writeMode === 'replace' ? 'replace' : 'append',
      });
      const result = await warehouseStore.runBatchJob(tenant, job);
      res.status(201).json({ ok: true, job, ...result });
    } catch (error) { next(error); }
  });

  // Idempotent stream job bootstrap for SynapseFlow templates.
  app.post('/v1/warehouse/etl/stream', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const targetDatasetId = requireString(body.targetDatasetId, 'targetDatasetId', 64);
      const target = await warehouseStore.getDataset(tenant, targetDatasetId);
      if (!target) throw new WarehouseError(404, 'dataset_not_found', 'target dataset not found');
      const streamTopic = topicName(body.streamTopic);
      const name = requireString(body.name ?? `stream-${targetDatasetId}`, 'name', 120);
      const existing = await warehouseStore.findJobByName(tenant, name);
      if (existing) {
        res.json({ ok: true, created: false, job: existing });
        return;
      }
      const job = await warehouseStore.createJob(tenant, {
        name,
        mode: 'stream',
        targetDatasetId,
        streamTopic,
        streamGroup: groupName(body.streamGroup ?? `warehouse_${randomUUID()}`),
        batchSize: positiveInt(body.batchSize, 100, 1, 100),
        intervalMs: positiveInt(body.intervalMs, 1000, 100, 60000),
      });
      void runStreamWorker(tenant, job.id);
      res.status(201).json({ ok: true, created: true, job });
    } catch (error) { next(error); }
  });

  // ---- ETL templates and jobs ----
  app.get('/v1/warehouse/templates', (_req, res) => {
    res.json({ items: etlTemplates() });
  });

  app.get('/v1/warehouse/jobs', async (req, res, next) => {
    try { res.json({ items: await warehouseStore.listJobs(resolveTenant(req)) }); }
    catch (error) { next(error); }
  });

  app.post('/v1/warehouse/jobs', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const mode = String(body.mode ?? 'batch') as JobMode;
      if (mode !== 'batch' && mode !== 'stream') {
        throw new WarehouseError(400, 'invalid_mode', "mode must be 'batch' or 'stream'");
      }
      const targetDatasetId = requireString(body.targetDatasetId, 'targetDatasetId', 64);
      const target = await warehouseStore.getDataset(tenant, targetDatasetId);
      if (!target) throw new WarehouseError(404, 'dataset_not_found', 'target dataset not found');
      let sql: string | null = null;
      let streamTopic: string | null = null;
      let streamGroup: string | null = null;
      if (mode === 'batch') {
        sql = assertReadOnlySql(body.sql);
      } else {
        streamTopic = topicName(body.streamTopic);
        streamGroup = groupName(body.streamGroup ?? `warehouse_${randomUUID()}`);
      }
      const writeMode: WriteMode = body.writeMode === 'replace' ? 'replace' : 'append';
      const job = await warehouseStore.createJob(tenant, {
        name: requireString(body.name ?? `${mode}-${targetDatasetId}`, 'name', 120),
        mode,
        targetDatasetId,
        sql,
        streamTopic,
        streamGroup,
        batchSize: positiveInt(body.batchSize, 100, 1, 100),
        intervalMs: positiveInt(body.intervalMs, 1000, 100, 60000),
        writeMode,
      });
      if (mode === 'stream') void runStreamWorker(tenant, job.id);
      res.status(201).json(job);
    } catch (error) { next(error); }
  });

  app.get('/v1/warehouse/jobs/:id', async (req, res, next) => {
    try {
      const job = await warehouseStore.getJob(resolveTenant(req), req.params.id);
      if (!job) throw new WarehouseError(404, 'job_not_found', 'job not found');
      res.json(job);
    } catch (error) { next(error); }
  });

  app.post('/v1/warehouse/jobs/:id/run', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      const job = await warehouseStore.getJob(tenant, req.params.id);
      if (!job) throw new WarehouseError(404, 'job_not_found', 'job not found');
      if (job.mode !== 'batch') throw new WarehouseError(400, 'invalid_job', 'only batch jobs can be run manually');
      const result = await warehouseStore.runBatchJob(tenant, job);
      res.json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.post('/v1/warehouse/jobs/:id/pause', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      const job = await warehouseStore.setJobStatus(tenant, req.params.id, 'paused' as JobStatus);
      if (!job) throw new WarehouseError(404, 'job_not_found', 'job not found');
      stopWorker(job.id);
      res.json(job);
    } catch (error) { next(error); }
  });

  app.post('/v1/warehouse/jobs/:id/resume', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      const job = await warehouseStore.setJobStatus(tenant, req.params.id, 'running' as JobStatus);
      if (!job) throw new WarehouseError(404, 'job_not_found', 'job not found');
      if (job.mode === 'stream') void runStreamWorker(tenant, job.id);
      res.json(job);
    } catch (error) { next(error); }
  });

  app.delete('/v1/warehouse/jobs/:id', async (req, res, next) => {
    try {
      const tenant = resolveTenant(req);
      stopWorker(req.params.id);
      const deleted = await warehouseStore.deleteJob(tenant, req.params.id);
      if (!deleted) throw new WarehouseError(404, 'job_not_found', 'job not found');
      res.json({ ok: true, deleted: true });
    } catch (error) { next(error); }
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'route not found' }));
  app.use((error: any, _req: Request, res: Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof WarehouseError) {
      return res.status(error.status).json({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid_json', message: 'request body is not valid JSON' });
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'request body is too large' });
    }
    console.error('[warehouse] unhandled:', error?.message || error);
    return res.status(500).json({ error: 'internal_error', message: 'internal error' });
  });

  return app;
}

if (require.main === module) {
  if (IS_PROD && !process.env.SYNAPSEONE_INTERNAL_SECRET) {
    console.error('[warehouse] SYNAPSEONE_INTERNAL_SECRET is required in production');
    process.exit(1);
  }
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[warehouse] Synapse Warehouse v${VERSION} listening on port ${PORT}`);
    void startStreamWorkers().catch((error) => {
      console.error('[warehouse] stream worker startup failed:', error?.message || error);
    });
  });
}
