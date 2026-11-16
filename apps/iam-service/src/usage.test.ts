// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Usage analytics HTTP tests — memory backend, real Express app.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createApp } from './index';

let base = '';
let server: Server | null = null;
let token = '';
let orgId = '';
let accountId = '';
let userId = '';

before(
  () =>
    new Promise<void>((resolve) => {
      const app = createApp();
      server = app.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    }),
);

after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function call(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

function rangeQs(extra = ''): string {
  const to = new Date(Date.now() + 60_000).toISOString();
  const from = new Date(Date.now() - 60 * 60_000).toISOString();
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`;
}

describe('usage analytics', () => {
  it('bootstraps a caller + account', async () => {
    const login = await call('POST', '/v1/auth/login', { email: 'usage@acme.local', orgSlug: 'acme' });
    assert.equal(login.status, 200);
    token = login.data.accessToken;
    userId = login.data.user.id;
    const orgs = await call('GET', '/v1/orgs', undefined, { Authorization: `Bearer ${token}` });
    orgId = orgs.data[0].id;
    const accs = await call('GET', `/v1/orgs/${orgId}/accounts`, undefined, { Authorization: `Bearer ${token}` });
    accountId = accs.data[0].id;
    assert.ok(orgId && accountId && userId);
  });

  it('rejects malformed ingest batches', async () => {
    const bad = await call('POST', '/v1/usage/ingest', {
      events: [{ feature: 'workflows', route: '/v1/workflows', method: 'GET', status: 999, durationMs: 1 }],
    });
    assert.equal(bad.status, 400);
    const empty = await call('POST', '/v1/usage/ingest', { events: [] });
    assert.equal(empty.status, 400);
  });

  it('ingests events and builds a tenant-scoped summary', async () => {
    const ingest = await call('POST', '/v1/usage/ingest', {
      events: [
        {
          createdAt: new Date().toISOString(),
          requestId: 'req-1',
          feature: 'workflows',
          route: '/v1/workflows',
          method: 'GET',
          path: '/v1/workflows',
          status: 200,
          durationMs: 10,
          authKind: 'user',
          orgId,
          accountId,
          userId,
        },
        {
          createdAt: new Date().toISOString(),
          requestId: 'req-2',
          feature: 'workflows',
          route: '/v1/executions',
          method: 'POST',
          path: '/v1/executions',
          status: 500,
          durationMs: 30,
          authKind: 'user',
          orgId,
          userId,
          error: 'upstream_unavailable',
        },
        {
          createdAt: new Date().toISOString(),
          requestId: 'req-3',
          feature: 'base',
          route: '/v1/base',
          method: 'PUT',
          path: '/v1/base/collections/orders',
          status: 404,
          durationMs: 5,
          authKind: 'apikey',
          // No org claim: IAM must resolve it from the account row.
          accountId,
        },
      ],
    });
    assert.equal(ingest.status, 202);
    assert.equal(ingest.data.accepted, 3);

    const summary = await call(
      'GET',
      `/v1/usage/summary?${rangeQs()}`,
      undefined,
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(summary.status, 200);
    assert.equal(summary.data.totals.requests, 3);
    assert.equal(summary.data.totals.success, 1);
    assert.equal(summary.data.totals.clientErrors, 1);
    assert.equal(summary.data.totals.serverErrors, 1);
    assert.equal(summary.data.totals.uniqueUsers, 1);
    assert.equal(summary.data.totals.uniqueAccounts, 1);
    assert.equal(summary.data.features.length, 2);
    const workflows = summary.data.features.find((f: any) => f.feature === 'workflows');
    assert.equal(workflows.requests, 2);
    assert.equal(workflows.errorRate, 50);
    assert.equal(summary.data.topRoutes.length, 3);
    assert.ok(Array.isArray(summary.data.series) && summary.data.series.length > 0);

    const events = await call(
      'GET',
      `/v1/usage/events?${rangeQs('&feature=workflows&limit=1')}`,
      undefined,
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(events.status, 200);
    assert.equal(events.data.total, 2);
    assert.equal(events.data.items.length, 1);
    assert.equal(events.data.items[0].feature, 'workflows');

    const search = await call(
      'GET',
      `/v1/usage/events?${rangeQs('&q=orders')}`,
      undefined,
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(search.status, 200);
    assert.equal(search.data.total, 1);
    assert.equal(search.data.items[0].feature, 'base');
  });

  it('does not leak another tenant usage', async () => {
    const other = await call('POST', '/v1/auth/login', { email: 'iso@other.local', orgSlug: 'usage-other' });
    assert.equal(other.status, 200);
    const summary = await call(
      'GET',
      `/v1/usage/summary?${rangeQs()}`,
      undefined,
      { Authorization: `Bearer ${other.data.accessToken}` },
    );
    assert.equal(summary.status, 200);
    assert.equal(summary.data.totals.requests, 0);
    assert.deepEqual(summary.data.features, []);
  });

  it('validates query parameters', async () => {
    const h = { Authorization: `Bearer ${token}` };
    assert.equal((await call('GET', '/v1/usage/summary?from=nope&to=nope', undefined, h)).status, 400);
    assert.equal((await call('GET', '/v1/usage/summary?statusClass=9xx', undefined, h)).status, 400);
    assert.equal((await call('GET', '/v1/usage/events?limit=999', undefined, h)).status, 400);
    assert.equal((await call('GET', '/v1/usage/events?accountId=other', undefined, h)).status, 400);
  });
});

describe('inference token metering (#26)', () => {
  it('records prompt/completion tokens per model and exposes them in the summary', async () => {
    const ingest = await call('POST', '/v1/usage/ingest', {
      events: [
        {
          feature: 'inference', route: '/v1/inference', method: 'POST', path: '/v1/inference/chat/completions',
          status: 200, durationMs: 1200, authKind: 'user', orgId, accountId, userId,
          promptTokens: 12, completionTokens: 30, totalTokens: 42, model: 'test/model-a',
        },
        {
          feature: 'inference', route: '/v1/inference', method: 'POST', path: '/v1/inference/chat/completions',
          status: 200, durationMs: 800, authKind: 'user', orgId, accountId, userId,
          promptTokens: 5, completionTokens: 10, totalTokens: 15, model: 'test/model-b',
        },
      ],
    });
    assert.equal(ingest.status, 202, JSON.stringify(ingest.data));

    const summary = await call('GET', `/v1/usage/summary?${rangeQs('&feature=inference')}`, undefined, { Authorization: `Bearer ${token}` });
    assert.equal(summary.status, 200);
    assert.equal(summary.data.totals.promptTokens, 17);
    assert.equal(summary.data.totals.completionTokens, 40);
    assert.equal(summary.data.totals.totalTokens, 57);
    const models = summary.data.models;
    assert.equal(models.length, 2);
    assert.equal(models[0].model, 'test/model-a');
    assert.equal(models[0].totalTokens, 42);

    const events = await call('GET', `/v1/usage/events?${rangeQs('&feature=inference')}`, undefined, { Authorization: `Bearer ${token}` });
    assert.ok(events.data.items.some((e: any) => e.model === 'test/model-a' && e.totalTokens === 42));
  });
});

describe('warehouse-backed usage summary', () => {
  it('merges hourly rollups with the live Postgres tail', async () => {
    // Leave a two-hour raw tail so the events ingested below are not inside
    // the rollup-covered window (they are intentionally absent from the fake).
    const coveredUntil = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000).toISOString();
    const minBucket = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const wh = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/internal/usage/watermark') {
        res.end(JSON.stringify({ ok: true, minBucket, maxBucket: coveredUntil, coveredUntil }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/usage/summary') {
        res.end(JSON.stringify({
          from: minBucket,
          to: coveredUntil,
          minBucket,
          coverageEnd: coveredUntil,
          totals: {
            requests: 100, success: 100, clientErrors: 0, serverErrors: 0,
            durationSum: 1000, promptTokens: 0, completionTokens: 0, totalTokens: 0,
            lastRequestAt: coveredUntil,
            latency: [0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0],
            userIds: ['wh-user'], accountIds: [accountId],
          },
          features: [{
            feature: 'warehouse', requests: 100, success: 100, clientErrors: 0, serverErrors: 0,
            durationSum: 1000, promptTokens: 0, completionTokens: 0, totalTokens: 0,
            lastRequestAt: coveredUntil,
            latency: [0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0],
          }],
          series: [{ ts: coveredUntil, requests: 100, errors: 0, durationSum: 1000 }],
          statusClasses: [{ class: '2xx', count: 100 }],
          authKinds: [{ kind: 'user', requests: 100 }],
          topRoutes: [],
          models: [],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise<void>((resolve) => wh.listen(0, '127.0.0.1', () => resolve()));
    const a = wh.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    const previous = process.env.WAREHOUSE_SERVICE_URL;
    process.env.WAREHOUSE_SERVICE_URL = `http://127.0.0.1:${port}`;
    try {
      const now = Date.now();
      const ingest = await call('POST', '/v1/usage/ingest', {
        events: [
          {
            feature: 'warehouse', route: '/v1/warehouse', method: 'GET', path: '/v1/warehouse/datasets',
            status: 200, durationMs: 30, authKind: 'user', orgId, accountId, userId,
            createdAt: new Date(now - 10 * 60_000).toISOString(),
          },
          {
            feature: 'warehouse', route: '/v1/warehouse', method: 'GET', path: '/v1/warehouse/jobs',
            status: 200, durationMs: 60, authKind: 'user', orgId, accountId, userId,
            createdAt: new Date(now - 20 * 60_000).toISOString(),
          },
        ],
      });
      assert.equal(ingest.status, 202, JSON.stringify(ingest.data));

      const from = new Date(now - 24 * 3_600_000).toISOString();
      const to = new Date(now + 60_000).toISOString();
      const summary = await call(
        'GET',
        `/v1/usage/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&feature=warehouse`,
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      assert.equal(summary.status, 200, JSON.stringify(summary.data));
      assert.equal(summary.data.totals.requests, 102);
      assert.equal(summary.data.totals.success, 102);
      assert.equal(summary.data.totals.uniqueUsers, 2);
      assert.equal(summary.data.totals.uniqueAccounts, 1);
      assert.equal(summary.data.features.length, 1);
      assert.equal(summary.data.features[0].feature, 'warehouse');
      assert.equal(summary.data.features[0].requests, 102);
      const seriesTotal = summary.data.series.reduce((n: number, p: any) => n + p.requests, 0);
      assert.equal(seriesTotal, 102);
      assert.ok(summary.data.totals.p95Ms > 0);
    } finally {
      if (previous === undefined) delete process.env.WAREHOUSE_SERVICE_URL;
      else process.env.WAREHOUSE_SERVICE_URL = previous;
      await new Promise<void>((resolve) => wh.close(() => resolve()));
    }
  });
});
