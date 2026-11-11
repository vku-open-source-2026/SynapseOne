// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'http';
import { createApp } from './index';
import { warehouseStore } from './duck';

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
  ]) {
    const response = await call('POST', '/v1/warehouse/query', { sql });
    assert.equal(response.status, 400, sql);
    assert.equal(response.json.error, 'invalid_sql');
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
