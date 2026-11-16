// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseNotifications tests: templates, webhook delivery, retries/DLQ,
 * preferences, tenant isolation and production guards.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import { createApp, processDueOnce, assertProductionConfig } from './index';
import { __clearNotificationMem, getNotification, updateNotification } from './db';

let server: Server;
let sink: Server;
let base = '';
let sinkBase = '';
let failNext = 0;
const received: any[] = [];

before(async () => {
  sink = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (failNext > 0) {
        failNext--;
        res.statusCode = 500;
        res.end('fail');
        return;
      }
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const sa = sink.address();
  sinkBase = `http://127.0.0.1:${typeof sa === 'object' && sa ? sa.port : 0}`;
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => sink.close(() => resolve()));
});

beforeEach(() => { __clearNotificationMem(); received.length = 0; failNext = 0; });

function headers(org = 'org-a'): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-synapseone-org': org, 'x-synapseone-user': 'user-1' };
}

async function call(method: string, path: string, body?: any, h: Record<string, string> = headers()) {
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
}

// Offline test sink lives on 127.0.0.1; the SSRF guard is bypassed only
// outside production for this suite.
process.env.NOTIFICATIONS_WEBHOOK_ALLOW_PRIVATE = 'true';

test('health and validation', async () => {
  const health = await call('GET', '/health', undefined, {});
  assert.equal(health.status, 200);
  assert.equal(health.json.service, 'notifications');
  assert.equal(health.json.store, 'memory');
  assert.equal((await call('POST', '/v1/notifications', { recipient: {}, body: '' })).status, 400);
  assert.equal((await call('POST', '/v1/notifications', { recipient: { email: 'a@b.c' }, body: 'x', channel: 'pigeon' })).status, 400);
});

test('delivers a templated webhook and records the attempt', async () => {
  const send = await call('POST', '/v1/notifications', {
    channel: 'webhook',
    recipient: { url: `${sinkBase}/hook` },
    subject: 'Alert for {{city}}',
    body: 'Flood level {{level}}m in {{city}}',
    data: { city: 'Hanoi', level: 2.5 },
  });
  assert.equal(send.status, 202, JSON.stringify(send.json));
  const n = send.json.notifications[0];
  assert.equal(n.status, 'queued');
  await processDueOnce();
  const after = await call('GET', `/v1/notifications/${n.id}`);
  assert.equal(after.json.status, 'delivered');
  assert.equal(after.json.attempts.length, 1);
  assert.equal(after.json.attempts[0].ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].subject, 'Alert for Hanoi');
  assert.equal(received[0].body, 'Flood level 2.5m in Hanoi');
});

test('retries with backoff and dead-letters after max attempts', async () => {
  failNext = 100;
  const send = await call('POST', '/v1/notifications', {
    channel: 'webhook',
    recipient: { url: `${sinkBase}/fail` },
    body: 'nope',
  });
  const id = send.json.notifications[0].id;
  for (let i = 0; i < 6; i++) {
    await processDueOnce();
    const n = await getNotification('org:org-a', id);
    if (n?.status === 'dead') break;
    // Make the row due immediately (backoff would otherwise wait).
    if (n && n.nextAttemptAt > new Date().toISOString()) {
      await updateNotification(id, { nextAttemptAt: new Date(Date.now() - 1000).toISOString(), status: 'failed' });
    }
  }
  const dead = await call('GET', `/v1/notifications/${id}`);
  assert.equal(dead.json.status, 'dead');
  assert.ok(dead.json.attempts.length >= 2);
  assert.ok(dead.json.deadReason);
});

test('honours unsubscribe preferences and tenant isolation', async () => {
  const pref = await call('PUT', '/v1/notifications/preferences/user%3Au1', { unsubscribed: true });
  assert.equal(pref.status, 200);
  const send = await call('POST', '/v1/notifications', {
    channel: 'webhook', recipient: { userId: 'u1', url: `${sinkBase}/hook` }, body: 'should not send',
  });
  const id = send.json.notifications[0].id;
  await processDueOnce();
  const n = await call('GET', `/v1/notifications/${id}`);
  assert.equal(n.json.status, 'cancelled');
  assert.equal(received.length, 0);

  // Another tenant cannot read the row.
  const other = await call('GET', `/v1/notifications/${id}`, undefined, headers('org-b'));
  assert.equal(other.status, 404);
  const list = await call('GET', '/v1/notifications', undefined, headers('org-b'));
  assert.deepEqual(list.json, []);
});

test('supports idempotency keys and cancellation', async () => {
  const first = await call('POST', '/v1/notifications', {
    channel: 'log', recipient: { userId: 'u2' }, body: 'one', idempotencyKey: 'key-1',
  });
  const second = await call('POST', '/v1/notifications', {
    channel: 'log', recipient: { userId: 'u2' }, body: 'one', idempotencyKey: 'key-1',
  });
  assert.equal(first.json.notifications[0].id, second.json.notifications[0].id);
  const cancel = await call('POST', `/v1/notifications/${first.json.notifications[0].id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.status, 'cancelled');
  assert.equal((await call('POST', `/v1/notifications/${first.json.notifications[0].id}/cancel`)).status, 409);
});

test('production fails closed without secret/db/cors', () => {
  assert.throws(() => assertProductionConfig({ NODE_ENV: 'production' }), /SYNAPSEONE_INTERNAL_SECRET/);
  assert.throws(
    () => assertProductionConfig({ NODE_ENV: 'production', SYNAPSEONE_INTERNAL_SECRET: 's' }),
    /DATABASE_URL/,
  );
  assert.throws(
    () => assertProductionConfig({ NODE_ENV: 'production', SYNAPSEONE_INTERNAL_SECRET: 's', DATABASE_URL: 'postgres://x' }),
    /CORS_ORIGIN/,
  );
});
