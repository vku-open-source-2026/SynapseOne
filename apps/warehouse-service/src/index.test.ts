// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'http';
import { createApp } from './index';
import { warehouseStore, WarehouseStore } from './duck';

let server: Server;
let base = '';

function headers(org = 'tenant-a', sub = 'manager-1'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-synapseone-user': sub,
    'x-synapseone-org': org,
    'x-synapseone-kind': 'user',
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  h: Record<string, string> = headers(),
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

const incidents = {
  id: 'city_incidents',
  name: 'City incidents',
  columns: [
    { name: 'ts', type: 'timestamp' },
    { name: 'city', type: 'string' },
    { name: 'category', type: 'string' },
    { name: 'severity', type: 'number' },
  ],
};

before(async () => {
  process.env.WAREHOUSE_IN_MEMORY = '1';
  process.env.NODE_ENV = 'test';
  delete process.env.SYNAPSEONE_INTERNAL_SECRET;
  await warehouseStore.reset();
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => resolve());
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await warehouseStore.reset();
  delete process.env.WAREHOUSE_IN_MEMORY;
});

beforeEach(async () => {
  await warehouseStore.reset();
});

test('health is public and reports the engine', async () => {
  const response = await call('GET', '/health', undefined, {});
  assert.equal(response.status, 200);
  assert.equal(response.json.service, 'warehouse');
  assert.equal(response.json.engine, 'duckdb');
});

test('dataset create, ingest and aggregate query', async () => {
  const created = await call('POST', '/v1/warehouse/datasets', incidents);
  assert.equal(created.status, 201);
  assert.equal(created.json.id, 'city_incidents');
  assert.equal(created.json.columns.length, 4);

  const inserted = await call('POST', '/v1/warehouse/datasets/city_incidents/rows', {
    rows: [
      { ts: '2026-11-10T08:00:00Z', city: 'Hanoi', category: 'traffic', severity: 2 },
      { ts: '2026-11-10T09:00:00Z', city: 'Hanoi', category: 'flood', severity: 4 },
      { ts: '2026-11-10T10:00:00Z', city: 'Da Nang', category: 'flood', severity: 3 },
    ],
  });
  assert.equal(inserted.status, 201);
  assert.equal(inserted.json.inserted, 3);

  const query = await call('POST', '/v1/warehouse/query', {
    sql: 'SELECT city, count(*) AS incidents, avg(severity) AS avg_severity FROM city_incidents GROUP BY city ORDER BY incidents DESC',
  });
  assert.equal(query.status, 200);
  assert.equal(query.json.rowCount, 2);
  assert.equal(query.json.rows[0].city, 'Hanoi');
  assert.equal(query.json.rows[0].incidents, 2);

  const listed = await call('GET', '/v1/warehouse/datasets');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.items[0].rowCount, 3);
});

test('SQL safety rejects writes and file access', async () => {
  await call('POST', '/v1/warehouse/datasets', incidents);
  for (const sql of [
    'DROP TABLE city_incidents',
    'SELECT * FROM read_csv(\'/etc/passwd\')',
    'SELECT 1; DELETE FROM city_incidents',
    '-- comment\nSELECT 1',
    'SELECT * FROM _usage_hourly',
    'SELECT * FROM _datasets',
    "SELECT * FROM query_table('_usage_hourly')",
    "SELECT * FROM query('SELECT * FROM _datasets')",
    "SELECT * FROM sniff_csv('/etc/passwd')",
  ]) {
    const response = await call('POST', '/v1/warehouse/query', { sql });
    assert.equal(response.status, 400, sql);
    assert.equal(response.json.error, 'invalid_sql');
  }
});

test('SQL safety allows forbidden words inside literals but not as statements', async () => {
  const literal = await call('POST', '/v1/warehouse/query', {
    sql: "SELECT 'delete' AS word, 1 AS n",
  });
  assert.equal(literal.status, 200);
  assert.equal(literal.json.rows[0].word, 'delete');
  const semicolon = await call('POST', '/v1/warehouse/query', { sql: "SELECT ';' AS s" });
  assert.equal(semicolon.status, 200);
  for (const sql of ['DELETE FROM city_incidents', "SELECT 1; DROP TABLE city_incidents", "SELECT * FROM read_csv('/etc/passwd')"]) {
    const blocked = await call('POST', '/v1/warehouse/query', { sql });
    assert.equal(blocked.status, 400, sql);
  }
});

test('batch ETL replaces a target dataset and refreshes its schema', async () => {
  await call('POST', '/v1/warehouse/datasets', incidents);
  await call('POST', '/v1/warehouse/datasets/city_incidents/rows', {
    rows: [
      { ts: '2026-11-10T08:00:00Z', city: 'Hanoi', category: 'traffic', severity: 2 },
      { ts: '2026-11-10T09:00:00Z', city: 'Hanoi', category: 'flood', severity: 4 },
      { ts: '2026-11-11T09:00:00Z', city: 'Hanoi', category: 'flood', severity: 3 },
    ],
  });
  await call('POST', '/v1/warehouse/datasets', {
    id: 'city_daily',
    name: 'City daily',
    columns: [
      { name: 'day', type: 'timestamp' },
      { name: 'category', type: 'string' },
      { name: 'events', type: 'number' },
    ],
  });

  const job = await call('POST', '/v1/warehouse/jobs', {
    name: 'Daily incident rollup',
    mode: 'batch',
    targetDatasetId: 'city_daily',
    writeMode: 'replace',
    sql: "SELECT date_trunc('day', ts) AS day, category, count(*) AS events FROM city_incidents GROUP BY 1, 2 ORDER BY 1",
  });
  assert.equal(job.status, 201);
  assert.equal(job.json.mode, 'batch');

  const run = await call('POST', `/v1/warehouse/jobs/${job.json.id}/run`);
  assert.equal(run.status, 200);
  assert.equal(run.json.ok, true);

  const query = await call('POST', '/v1/warehouse/query', {
    sql: 'SELECT * FROM city_daily ORDER BY day',
  });
  assert.equal(query.status, 200);
  assert.equal(query.json.rowCount, 3);
});

test('templates include batch and stream recipes', async () => {
  const response = await call('GET', '/v1/warehouse/templates');
  assert.equal(response.status, 200);
  const modes = new Set(response.json.items.map((item: any) => item.mode));
  assert.ok(modes.has('batch'));
  assert.ok(modes.has('stream'));
});

test('stream job lifecycle validates and pauses', async () => {
  await call('POST', '/v1/warehouse/datasets', {
    id: 'sensor_readings',
    name: 'Sensor readings',
    mode: 'stream',
    streamTopic: 'iot-sensors',
    columns: [
      { name: 'ts', type: 'timestamp' },
      { name: 'device_id', type: 'string' },
      { name: 'value', type: 'number' },
    ],
  });
  process.env.STREAM_SERVICE_URL = 'http://127.0.0.1:9';
  const job = await call('POST', '/v1/warehouse/jobs', {
    name: 'Sensor ingest',
    mode: 'stream',
    targetDatasetId: 'sensor_readings',
    streamTopic: 'iot-sensors',
    batchSize: 10,
    intervalMs: 100,
  });
  assert.equal(job.status, 201);
  assert.equal(job.json.mode, 'stream');
  const paused = await call('POST', `/v1/warehouse/jobs/${job.json.id}/pause`);
  assert.equal(paused.status, 200);
  assert.equal(paused.json.status, 'paused');
  const deleted = await call('DELETE', `/v1/warehouse/jobs/${job.json.id}`);
  assert.equal(deleted.status, 200);
});

test('tenants cannot see each other datasets', async () => {
  await call('POST', '/v1/warehouse/datasets', incidents, headers('tenant-a'));
  const created = await call('POST', '/v1/warehouse/datasets', {
    ...incidents,
    id: 'other_data',
  }, headers('tenant-b'));
  assert.equal(created.status, 201);

  const listB = await call('GET', '/v1/warehouse/datasets', undefined, headers('tenant-b'));
  assert.deepEqual(listB.json.items.map((item: any) => item.id), ['other_data']);

  const crossQuery = await call('POST', '/v1/warehouse/query', {
    sql: 'SELECT * FROM city_incidents',
  }, headers('tenant-b'));
  assert.equal(crossQuery.status, 400);
});

test('stream ETL consumes SynapseStream, inserts rows and acks', async () => {
  let reads = 0;
  const fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'PUT') {
        res.statusCode = 201;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url?.includes('/read')) {
        reads += 1;
        const events = reads === 1
          ? [{ id: '1-0', payload: { ts: '2026-11-11T10:00:00Z', device_id: 'sensor-01', value: 24.5 } }]
          : [];
        res.end(JSON.stringify({ events, count: events.length }));
        return;
      }
      if (req.url?.includes('/ack')) {
        res.end(JSON.stringify({ acked: 1 }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
  const address = fake.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.STREAM_SERVICE_URL = `http://127.0.0.1:${port}`;
  try {
    await call('POST', '/v1/warehouse/datasets', {
      id: 'sensor_readings',
      name: 'Sensor readings',
      mode: 'stream',
      streamTopic: 'iot-sensors',
      columns: [
        { name: 'ts', type: 'timestamp' },
        { name: 'device_id', type: 'string' },
        { name: 'value', type: 'number' },
      ],
    });
    const job = await call('POST', '/v1/warehouse/jobs', {
      name: 'Sensor ingest',
      mode: 'stream',
      targetDatasetId: 'sensor_readings',
      streamTopic: 'iot-sensors',
      batchSize: 10,
      intervalMs: 100,
    });
    assert.equal(job.status, 201);

    let dataset: any = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await call('GET', '/v1/warehouse/datasets/sensor_readings');
      dataset = current.json;
      if (Number(dataset?.rowCount) >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(dataset.rowCount, 1);

    const query = await call('POST', '/v1/warehouse/query', {
      sql: 'SELECT device_id, value FROM sensor_readings',
    });
    assert.equal(query.status, 200);
    assert.equal(query.json.rows[0].device_id, 'sensor-01');
    assert.equal(query.json.rows[0].value, 24.5);

    await call('POST', `/v1/warehouse/jobs/${job.json.id}/pause`);
    await call('DELETE', `/v1/warehouse/jobs/${job.json.id}`);
  } finally {
    delete process.env.STREAM_SERVICE_URL;
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});

test('stream materialization deduplicates redelivery and persists tombstones', async () => {
  const created = await call('POST', '/v1/warehouse/datasets', {
    id: 'base_changes',
    name: 'Base changes',
    columns: [
      { name: 'event_id', type: 'string' },
      { name: 'op', type: 'string' },
      { name: 'document_id', type: 'string' },
      { name: 'version', type: 'number' },
      { name: 'occurred_at', type: 'timestamp' },
      { name: 'data', type: 'json' },
    ],
  });
  assert.equal(created.status, 201);
  const dataset = await warehouseStore.getDataset('org:tenant-a', 'base_changes');
  assert.ok(dataset);

  const first = await warehouseStore.ingestStreamEvents('org:tenant-a', dataset!, 'job-1', [
    { eventId: 'evt-1', rows: [{ event_id: 'evt-1', op: 'create', document_id: 'doc-1', version: 1, occurred_at: '2026-11-12T10:00:00Z', data: { x: 1 } }] },
    { eventId: 'evt-1', rows: [{ event_id: 'evt-1', op: 'create', document_id: 'doc-1', version: 1, occurred_at: '2026-11-12T10:00:00Z', data: { x: 1 } }] },
  ]);
  assert.deepEqual(first, { inserted: 1, duplicates: 1 });

  const replay = await warehouseStore.ingestStreamEvents('org:tenant-a', dataset!, 'job-1', [
    { eventId: 'evt-1', rows: [{ event_id: 'evt-1', op: 'create', document_id: 'doc-1', version: 1, occurred_at: '2026-11-12T10:00:00Z', data: { x: 1 } }] },
    { eventId: 'evt-2', rows: [{ event_id: 'evt-2', op: 'delete', document_id: 'doc-1', version: 2, occurred_at: '2026-11-12T10:01:00Z', data: null }] },
  ]);
  assert.deepEqual(replay, { inserted: 1, duplicates: 1 });

  const all = await call('POST', '/v1/warehouse/query', {
    sql: 'SELECT count(*) AS n FROM base_changes',
  });
  assert.equal(all.status, 200);
  assert.equal(all.json.rows[0].n, 2);
  const current = await call('POST', '/v1/warehouse/query', {
    sql: "SELECT count(*) AS n FROM base_changes WHERE event_id = 'evt-1'",
  });
  assert.equal(current.json.rows[0].n, 1);
});

test('1,000-event durable correctness across restart, duplicates and tenant isolation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-wh-'));
  const prevDir = process.env.WAREHOUSE_DATA_DIR;
  const prevMemory = process.env.WAREHOUSE_IN_MEMORY;
  delete process.env.WAREHOUSE_IN_MEMORY;
  process.env.WAREHOUSE_DATA_DIR = dir;
  const store = new WarehouseStore();
  try {
    const ds = await store.createDataset('org:exact-a', {
      id: 'exact_events',
      name: 'Exact events',
      columns: [
        { name: 'event_id', type: 'string' },
        { name: 'value', type: 'number' },
        { name: 'tenant', type: 'string' },
      ],
    });
    const make = (i: number) => ({
      eventId: `evt-${i}`,
      rows: [{ event_id: `evt-${i}`, value: i, tenant: 'exact-a' }],
    });
    for (let i = 1; i <= 500; i++) {
      await store.ingestStreamEvents('org:exact-a', ds, 'job', [make(i)]);
    }
    // Simulate process restart: close and reopen the same DuckDB file.
    await store.reset();
    const reopened = await store.getDataset('org:exact-a', 'exact_events');
    assert.ok(reopened);
    for (let i = 1; i <= 1000; i++) {
      // First 100 are intentionally redelivered; the rest are new.
      await store.ingestStreamEvents('org:exact-a', reopened!, 'job', [make(i)]);
    }
    const count = await store.query('org:exact-a', 'SELECT count(*) AS n, sum(value) AS total FROM exact_events');
    assert.equal(count.rows[0].n, 1000);
    assert.equal(count.rows[0].total, 500500);
    // Tenant isolation: same dataset id in another tenant's file is empty.
    const other = await store.createDataset('org:exact-b', {
      id: 'exact_events', name: 'Other', columns: [{ name: 'event_id', type: 'string' }],
    });
    assert.ok(other);
    const otherCount = await store.query('org:exact-b', 'SELECT count(*) AS n FROM exact_events');
    assert.equal(otherCount.rows[0].n, 0);
  } finally {
    await store.reset();
    if (prevDir === undefined) delete process.env.WAREHOUSE_DATA_DIR;
    else process.env.WAREHOUSE_DATA_DIR = prevDir;
    if (prevMemory === undefined) delete process.env.WAREHOUSE_IN_MEMORY;
    else process.env.WAREHOUSE_IN_MEMORY = prevMemory;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('internal usage rollups replace idempotently and summarize by hour', async () => {
  const rollup = {
    from: '2026-11-12T10:00:00.000Z',
    to: '2026-11-12T12:00:00.000Z',
    hourly: [
      {
        bucket: '2026-11-12T10:00:00.000Z', feature: 'warehouse', route: '/v1/warehouse', method: 'GET',
        statusClass: 2, authKind: 'user', accountId: 'acc-1', model: null,
        requests: 8, success: 8, clientErrors: 0, serverErrors: 0,
        durationSum: 80, durationMax: 20, latency: [2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        promptTokens: 0, completionTokens: 0, totalTokens: 0, lastRequestAt: '2026-11-12T10:55:00.000Z',
      },
      {
        bucket: '2026-11-12T11:00:00.000Z', feature: 'base', route: '/v1/base', method: 'POST',
        statusClass: 5, authKind: 'apikey', accountId: 'acc-2', model: null,
        requests: 2, success: 0, clientErrors: 0, serverErrors: 2,
        durationSum: 400, durationMax: 200, latency: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0],
        promptTokens: 0, completionTokens: 0, totalTokens: 0, lastRequestAt: '2026-11-12T11:10:00.000Z',
      },
    ],
    users: [
      {
        bucket: '2026-11-12T10:00:00.000Z', feature: 'warehouse', method: 'GET', statusClass: 2,
        accountId: 'acc-1', userId: 'u-1', requests: 5, firstSeen: '2026-11-12T10:01:00.000Z',
        lastSeen: '2026-11-12T10:50:00.000Z',
      },
      {
        bucket: '2026-11-12T10:00:00.000Z', feature: 'warehouse', method: 'GET', statusClass: 2,
        accountId: 'acc-1', userId: 'u-2', requests: 3, firstSeen: '2026-11-12T10:02:00.000Z',
        lastSeen: '2026-11-12T10:52:00.000Z',
      },
    ],
  };
  const wrapped = await call('POST', '/internal/usage/rollup', rollup);
  assert.equal(wrapped.status, 201);
  assert.equal(wrapped.json.hourly, 2);

  const summary = await call('POST', '/internal/usage/summary', {
    from: '2026-11-12T10:00:00.000Z',
    to: '2026-11-12T12:00:00.000Z',
  });
  assert.equal(summary.status, 200);
  assert.equal(summary.json.totals.requests, 10);
  assert.equal(summary.json.totals.success, 8);
  assert.equal(summary.json.totals.serverErrors, 2);
  assert.equal(summary.json.totals.userIds.length, 2);
  assert.equal(summary.json.totals.accountIds.length, 2);
  assert.equal(summary.json.coverageEnd, '2026-11-12T12:00:00.000Z');
  assert.equal(summary.json.minBucket, '2026-11-12T10:00:00.000Z');
  assert.equal(summary.json.features.length, 2);
  assert.equal(summary.json.series.length, 2);

  const watermark = await call('GET', '/internal/usage/watermark', undefined);
  assert.equal(watermark.status, 200);
  assert.equal(watermark.json.coveredUntil, '2026-11-12T12:00:00.000Z');

  // Idempotent replacement: same window, one hour, new counters.
  const replaced = await call('POST', '/internal/usage/rollup', {
    from: '2026-11-12T10:00:00.000Z',
    to: '2026-11-12T11:00:00.000Z',
    hourly: [{
      bucket: '2026-11-12T10:00:00.000Z', feature: 'warehouse', route: '/v1/warehouse', method: 'GET',
      statusClass: 2, authKind: 'user', accountId: 'acc-1', model: null,
      requests: 3, success: 3, clientErrors: 0, serverErrors: 0,
      durationSum: 9, durationMax: 3, latency: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      promptTokens: 0, completionTokens: 0, totalTokens: 0, lastRequestAt: '2026-11-12T10:30:00.000Z',
    }],
    users: [],
  });
  assert.equal(replaced.status, 201);
  const after = await call('POST', '/internal/usage/summary', {
    from: '2026-11-12T10:00:00.000Z',
    to: '2026-11-12T12:00:00.000Z',
  });
  assert.equal(after.json.totals.requests, 5);
  assert.equal(after.json.totals.userIds.length, 0);

  // Empty completed hours still advance coverage.
  const quiet = await call('POST', '/internal/usage/rollup', {
    from: '2026-11-12T12:00:00.000Z',
    to: '2026-11-12T13:00:00.000Z',
    hourly: [],
    users: [],
  });
  assert.equal(quiet.status, 201);
  const advanced = await call('GET', '/internal/usage/watermark', undefined);
  assert.equal(advanced.json.coveredUntil, '2026-11-12T13:00:00.000Z');

  // Tenant isolation: another tenant sees no rollups.
  const other = await call('POST', '/internal/usage/summary', {
    from: '2026-11-12T10:00:00.000Z',
    to: '2026-11-12T12:00:00.000Z',
  }, headers('tenant-b'));
  assert.equal(other.status, 200);
  assert.equal(other.json.totals.requests, 0);
  assert.equal(other.json.coverageEnd, null);
});
