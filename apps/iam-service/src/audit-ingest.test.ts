// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * Data-plane mutation audit ingest (#32): internal producers post events that
 * become tenant-scoped audit_log rows queryable through GET /v1/audit.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from './index';

let base = '';
let server: Server | null = null;
let token = '';
let orgId = '';
let accountId = '';
let userId = '';
let otherOrg = '';

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

describe('data-plane audit ingest (#32)', () => {
  it('bootstraps a caller + account', async () => {
    const login = await call('POST', '/v1/auth/login', { email: 'audit-ingest@acme.local', orgSlug: 'acme' });
    assert.equal(login.status, 200);
    token = login.data.accessToken;
    userId = login.data.user.id;
    const orgs = await call('GET', '/v1/orgs', undefined, { Authorization: `Bearer ${token}` });
    orgId = orgs.data[0].id;
    const accs = await call('GET', `/v1/orgs/${orgId}/accounts`, undefined, { Authorization: `Bearer ${token}` });
    accountId = accs.data[0].id;
    otherOrg = '00000000-0000-4000-8000-000000000001';
    assert.ok(orgId && accountId && userId);
  });

  it('rejects malformed batches', async () => {
    const missing = await call('POST', '/v1/audit/ingest', { events: [{ action: 'x' }] });
    assert.equal(missing.status, 400);
    const empty = await call('POST', '/v1/audit/ingest', { events: [] });
    assert.equal(empty.status, 400);
    const badResult = await call('POST', '/v1/audit/ingest', {
      events: [{
        actorType: 'user', actorId: userId, orgId, action: 'base:x:create',
        resource: '/v1/base/x', result: 'maybe', statusCode: 200,
      }],
    });
    assert.equal(badResult.status, 400);
  });

  it('ingests actor/tenant/action/result and serves it through GET /v1/audit', async () => {
    const ingest = await call('POST', '/v1/audit/ingest', {
      events: [{
        actorType: 'user',
        actorId: userId,
        orgId,
        accountId,
        action: 'base:collections:create',
        resource: 'base:/v1/base/collections',
        result: 'allowed',
        statusCode: 201,
        requestId: 'req-base-1',
        context: {
          service: 'base',
          method: 'POST',
          route: '/v1/base/collections',
          params: { collection: 'assets', token: 'should-not-be-stored' },
          password: 'also-secret',
        },
      }, {
        actorType: 'apikey',
        actorId: `apikey:${accountId}`,
        orgId,
        accountId,
        action: 'queue:queues.messages:create',
        resource: 'queue:/v1/queue/queues/:queue/messages',
        result: 'denied',
        statusCode: 403,
        requestId: 'req-queue-1',
        context: { service: 'queue', method: 'POST' },
      }],
    });
    assert.equal(ingest.status, 202);
    assert.equal(ingest.data.accepted, 2);

    const allowed = await call('GET', '/v1/audit?action=base%3Acollections%3Acreate&limit=10', undefined, {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.length, 1);
    const row = allowed.data[0];
    assert.equal(row.actor_type, 'user');
    assert.equal(row.actor_id, userId);
    assert.equal(row.action, 'base:collections:create');
    assert.equal(row.resource, 'base:/v1/base/collections');
    assert.equal(row.decision, true);
    assert.equal(row.context.org, orgId);
    assert.equal(row.context.account, accountId);
    assert.equal(row.context.result, 'allowed');
    assert.equal(row.context.requestId, 'req-base-1');
    assert.equal(row.context.params.collection, 'assets');
    assert.equal(row.context.params.token, '***', 'secret-looking params are masked');
    assert.equal(row.context.password, '***', 'secret-looking context keys are masked');
    assert.ok(!JSON.stringify(row).includes('should-not-be-stored'));

    const denied = await call('GET', '/v1/audit?action=queue%3Aqueues.messages%3Acreate', undefined, {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(denied.data.length, 1);
    assert.equal(denied.data[0].decision, false);
    assert.equal(denied.data[0].context.result, 'denied');
    assert.equal(denied.data[0].actor_type, 'apikey');
  });

  it('cannot inject another org or hide the real tenant through context', async () => {
    const ingest = await call('POST', '/v1/audit/ingest', {
      events: [{
        actorType: 'user',
        actorId: userId,
        orgId,
        action: 'faststore:keys:update',
        resource: 'faststore:/v1/faststore/keys/:key',
        result: 'allowed',
        statusCode: 200,
        context: { org: otherOrg, callerOrg: otherOrg, service: 'faststore' },
      }, {
        actorType: 'user',
        actorId: userId,
        orgId: otherOrg,
        action: 'stream:topics:create',
        resource: 'stream:/v1/stream/topics/:topic',
        result: 'allowed',
        statusCode: 201,
      }],
    });
    assert.equal(ingest.status, 202);

    const mine = await call('GET', '/v1/audit?action=faststore%3Akeys%3Aupdate', undefined, {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(mine.data.length, 1);
    assert.equal(mine.data[0].context.org, orgId, 'reserved context keys must not override the event tenant');
    assert.equal(mine.data[0].context.callerOrg, undefined);

    // A row for another org is invisible to this caller.
    const foreign = await call('GET', '/v1/audit?action=stream%3Atopics%3Acreate', undefined, {
      Authorization: `Bearer ${token}`,
    });
    assert.deepEqual(foreign.data, []);
  });
});


describe('signed audit export (#45)', () => {
  it('streams tenant-scoped NDJSON with an HMAC digest', async () => {
    const response = await fetch(`${base}/v1/audit/export?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /application\/x-ndjson/);
    const body = await response.text();
    const digest = response.headers.get('x-audit-digest') || '';
    assert.match(digest, /^hmac-sha256=[0-9a-f]{64}$/);
    const secret = process.env.AUDIT_EXPORT_SECRET || process.env.SYNAPSEONE_INTERNAL_SECRET || 'dev-audit-export-secret';
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(digest, `hmac-sha256=${expected}`);
    assert.ok(Number(response.headers.get('x-audit-count')) >= 0);
    for (const line of body.trim().split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      assert.ok(row.id);
      assert.ok(row.action);
    }
  });
});
