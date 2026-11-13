// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Self-contained OLTP → OLAP E2E:
 * SynapseBase (memory) -> transactional outbox -> SynapseStream (memory)
 * -> Synapse Warehouse (DuckDB memory) -> read-only SQL.
 *
 * Requires `make build` first, then:
 *   node tests/e2e/data-platform-e2e.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
process.env.NODE_ENV = 'test';
process.env.WAREHOUSE_IN_MEMORY = '1';
process.env.DATABASE_URL = '';
process.env.SYNAPSEONE_INTERNAL_SECRET = '';
delete process.env.STREAM_ENGINE;

const baseMod = require(path.join(root, 'apps/base-service/dist/index.js'));
const whMod = require(path.join(root, 'apps/warehouse-service/dist/index.js'));
const whStore = require(path.join(root, 'apps/warehouse-service/dist/duck.js'));
const streamMod = require(path.join(root, 'apps/stream-service/dist/index.js'));

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});
const url = (server) => `http://127.0.0.1:${server.address().port}`;
const headers = (org = 'e2e-org') => ({
  'content-type': 'application/json',
  'x-synapseone-org': org,
  'x-synapseone-user': `u-${org}`,
  'x-synapseone-kind': 'user',
});
async function call(base, method, route, body, h = headers()) {
  const response = await fetch(base + route, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };

const baseServer = await listen(baseMod.createApp());
const warehouseServer = await listen(whMod.createApp());
const streamServer = await listen(streamMod.createApp());
const B = url(baseServer);
const W = url(warehouseServer);
const S = url(streamServer);
process.env.STREAM_SERVICE_URL = S;

try {
  let r = await call(B, 'POST', '/v1/base/collections', { name: 'incidents' });
  assert(r.status === 201, `collection create: ${r.status}`);
  r = await call(B, 'POST', '/v1/base/collections/incidents/documents', { id: 'd1', data: { severity: 1, city: 'Hanoi' } });
  assert(r.status === 201, `document create: ${r.status}`);
  r = await call(B, 'PUT', '/v1/base/collections/incidents/documents/d1', { data: { severity: 2, city: 'Hanoi' } });
  assert(r.status === 200, `document update: ${r.status}`);
  r = await call(B, 'DELETE', '/v1/base/collections/incidents/documents/d1');
  assert(r.status === 200, `document delete: ${r.status}`);

  const changes = await call(B, 'GET', `/v1/base/collections/incidents/changes?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}&limit=100`);
  assert(changes.status === 200, 'change feed');
  assert(changes.json.changes.length === 3, `expected 3 committed changes, got ${changes.json.changes.length}`);
  assert(changes.json.changes.map((c) => c.operation).join(',') === 'create,update,delete', 'operations');
  assert(changes.json.changes[2].deleted === true, 'delete tombstone');

  const relayed = await baseMod.relayOutboxOnce();
  assert(relayed === 3, `relay published ${relayed}`);
  assert((await baseMod.relayOutboxOnce()) === 0, 'outbox must not publish twice');

  r = await call(W, 'POST', '/v1/warehouse/datasets', {
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
  assert(r.status === 201, `dataset create: ${r.status}`);
  r = await call(W, 'POST', '/v1/warehouse/jobs', {
    name: 'base-changes-ingest',
    mode: 'stream',
    targetDatasetId: 'base_changes',
    streamTopic: 'base-changes',
    streamGroup: `g-${Date.now()}`,
    batchSize: 100,
    intervalMs: 100,
  });
  assert(r.status === 201, `stream job create: ${r.status}`);
  const jobId = r.json.id;

  await sleep(1500);
  let q = await call(W, 'POST', '/v1/warehouse/query', { sql: 'SELECT count(*) AS n FROM base_changes' });
  assert(q.json.rows[0].n === 3, `warehouse count ${q.json.rows[0].n}`);

  // Republish one event: durable event_id marker must absorb the duplicate.
  const first = changes.json.changes[0];
  const payload = {
    event_id: first.eventId,
    schema_version: 1,
    source: 'synapsebase',
    resource_type: 'document',
    organization_id: 'e2e-org',
    account_id: null,
    collection_id: 'incidents',
    collection_name: 'incidents',
    document_id: first.id,
    operation: first.operation,
    version: first.version,
    occurred_at: first.updatedAt,
    data: first.data,
  };
  const published = await fetch(`${S}/v1/stream/topics/base-changes/events`, {
    method: 'POST',
    headers: { ...headers(), 'x-synapseone-tenant': 'org:e2e-org' },
    body: JSON.stringify({ payload }),
  });
  assert(published.ok, `duplicate publish ${published.status}`);
  await sleep(1200);
  q = await call(W, 'POST', '/v1/warehouse/query', { sql: 'SELECT count(*) AS n FROM base_changes' });
  assert(q.json.rows[0].n === 3, `duplicate materialized: ${q.json.rows[0].n}`);

  await call(W, 'POST', `/v1/warehouse/jobs/${jobId}/pause`);
  await call(W, 'POST', `/v1/warehouse/jobs/${jobId}/resume`);
  await sleep(800);
  q = await call(W, 'POST', '/v1/warehouse/query', { sql: 'SELECT count(*) AS n FROM base_changes' });
  assert(q.json.rows[0].n === 3, 'worker restart changed durable state');

  const other = await call(W, 'POST', '/v1/warehouse/datasets', {
    id: 'base_changes', name: 'Other', columns: [{ name: 'event_id', type: 'string' }],
  }, headers('other-org'));
  assert(other.status === 201, 'other tenant dataset');
  const otherQ = await call(W, 'POST', '/v1/warehouse/query', { sql: 'SELECT count(*) AS n FROM base_changes' }, headers('other-org'));
  assert(otherQ.json.rows[0].n === 0, 'cross-tenant leak');

  const status = await call(W, 'GET', '/v1/warehouse/pipeline/status');
  assert(status.status === 200 && status.json.jobs >= 1, 'pipeline status');
  console.log('PASS data-platform E2E: base -> outbox -> stream -> warehouse, dedup/restart/isolation');
} finally {
  await new Promise((resolve) => baseServer.close(() => resolve()));
  await new Promise((resolve) => warehouseServer.close(() => resolve()));
  await new Promise((resolve) => streamServer.close(() => resolve()));
  await whStore.warehouseStore.reset();
}
