// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseQueue API tests: boot the real Express app on the in-memory backend
 * and cover publish, delay, dedupe, consume/ack, visibility + heartbeat,
 * nack/retry/dead-letter/replay, batch, queues, tenancy and validation.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import { createApp } from './index';
import { __clearQueueMem } from './store';
import { __auditEvents, __clearAudit } from './audit';

let server: Server;
let base = '';

function headers(org = 'tenant-a', sub = 'user-1'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-synapseone-user': sub, 'x-synapseone-org': org, 'x-synapseone-kind': 'user' };
}

async function call(method: string, path: string, body?: any, h: Record<string, string> = headers()): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => __clearQueueMem());

async function createQueue(extra: any = {}): Promise<any> {
  const r = await call('PUT', '/v1/queue/queues/jobs', { maxAttempts: 3, visibilityTimeoutSeconds: 30, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

test('health and metrics are served', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.service, 'queue');
  assert.equal(health.json.backend, 'memory');
  const metrics = await fetch(`${base}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /synapseone_queue_up 1/);
});

test('receipts are opaque capability tokens, not derivable from the message id', async () => {
  await createQueue();
  const pub = await call('POST', '/v1/queue/queues/jobs/messages', { payload: { n: 1 } });
  const id = pub.json.message.id;
  const first = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  const receipt = first.json.messages[0].receipt;
  assert.ok(receipt);
  assert.ok(!receipt.includes(id), 'receipt must not embed the public message id');
  assert.doesNotMatch(receipt, /:\d+$/, 'receipt must not end with a sequence number');
  assert.match(receipt, /^rcpt_[A-Za-z0-9_-]{20,}$/);
  // A guessed id:seq receipt must never ack somebody else's lease.
  const forged = await call('POST', '/v1/queue/queues/jobs/ack', { receipt: `${id}:1` });
  assert.equal(forged.status, 404);
  // Two consumes of different messages produce unrelated receipts.
  await call('POST', '/v1/queue/queues/jobs/messages', { payload: { n: 2 } });
  const again = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.notEqual(again.json.messages[0].receipt, receipt);
  const ok = await call('POST', '/v1/queue/queues/jobs/ack', { receipt });
  assert.equal(ok.status, 200);
});

test('publish, peek, consume and ack', async () => {
  await createQueue();
  const first = await call('POST', '/v1/queue/queues/jobs/messages', {
    payload: { task: 'send-email', to: 'a@example.com' }, headers: { trace: 't1' },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.duplicate, false);
  assert.equal(first.json.message.payload.task, 'send-email');
  assert.deepEqual(first.json.message.headers, { trace: 't1' });

  const second = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 2 });
  assert.equal(second.status, 201);

  const peek = await call('GET', '/v1/queue/queues/jobs/messages?ready=true');
  assert.equal(peek.json.count, 2);

  const stats = await call('GET', '/v1/queue/queues/jobs/stats');
  assert.equal(stats.json.pending, 2);
  assert.equal(stats.json.inflight, 0);
  assert.equal(stats.json.published, 2);

  const consumed = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.equal(consumed.status, 200);
  assert.equal(consumed.json.count, 1);
  assert.equal(consumed.json.messages[0].attempts, 1);
  assert.ok(consumed.json.messages[0].receipt);
  assert.ok(consumed.json.messages[0].leaseExpiresAt);

  const during = await call('GET', '/v1/queue/queues/jobs/stats');
  assert.equal(during.json.pending, 1);
  assert.equal(during.json.inflight, 1);

  const ack = await call('POST', '/v1/queue/queues/jobs/ack', { receipt: consumed.json.messages[0].receipt });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.ok, true);
  const afterAck = await call('GET', '/v1/queue/queues/jobs/stats');
  assert.equal(afterAck.json.acked, 1);
  assert.equal(afterAck.json.inflight, 0);

  const last = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 10 });
  assert.equal(last.json.count, 1);
  await call('POST', '/v1/queue/queues/jobs/ack', { receipt: last.json.messages[0].receipt });
});

test('delayed delivery and dedupe keys', async () => {
  await createQueue();

  const delayed = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 'later', delaySeconds: 1 });
  assert.equal(delayed.status, 201);
  const peek = await call('GET', '/v1/queue/queues/jobs/messages?ready=true');
  assert.equal(peek.json.count, 0);
  const notYet = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 5 });
  assert.equal(notYet.json.count, 0);
  await new Promise((r) => setTimeout(r, 1100));
  const ready = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 5 });
  assert.equal(ready.json.count, 1);
  assert.equal(ready.json.messages[0].payload, 'later');
  await call('POST', '/v1/queue/queues/jobs/ack', { receipt: ready.json.messages[0].receipt });

  const one = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 'once', dedupeKey: 'order-1' });
  assert.equal(one.status, 201);
  const two = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 'once', dedupeKey: 'order-1' });
  assert.equal(two.status, 200);
  assert.equal(two.json.duplicate, true);
  assert.equal(two.json.id, one.json.id);

  const got = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  await call('POST', '/v1/queue/queues/jobs/ack', { receipt: got.json.messages[0].receipt });
  const three = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 'once', dedupeKey: 'order-1' });
  assert.equal(three.json.duplicate, false);
  assert.notEqual(three.json.id, one.json.id);
});

test('nack, retries, dead letters and replay', async () => {
  await createQueue({ maxAttempts: 2 });
  const published = await call('POST', '/v1/queue/queues/jobs/messages', { payload: { n: 1 } });
  const id = published.json.id;

  const first = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.equal(first.json.messages[0].attempts, 1);
  const retry = await call('POST', '/v1/queue/queues/jobs/nack', {
    receipt: first.json.messages[0].receipt, error: 'boom',
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.state, 'retry');
  assert.equal(retry.json.attempts, 1);
  const retried = await call('GET', '/v1/queue/queues/jobs/stats');
  assert.equal(retried.json.retried, 1);
  assert.equal(retried.json.pending, 1);

  const second = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.equal(second.json.messages[0].attempts, 2);
  const dead = await call('POST', '/v1/queue/queues/jobs/nack', { receipt: second.json.messages[0].receipt, error: 'still failing' });
  assert.equal(dead.json.state, 'dead');
  assert.equal(dead.json.attempts, 2);

  const stats = await call('GET', '/v1/queue/queues/jobs/stats');
  assert.equal(stats.json.dead, 1);
  assert.equal(stats.json.inflight, 0);

  const deadList = await call('GET', '/v1/queue/queues/jobs/dead');
  assert.equal(deadList.json.count, 1);
  assert.equal(deadList.json.messages[0].id, id);
  assert.equal(deadList.json.messages[0].dead, true);
  assert.equal(deadList.json.messages[0].lastError, 'still failing');

  const replay = await call('POST', `/v1/queue/queues/jobs/dead/${id}/replay`, { resetAttempts: true });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.message.attempts, 0);
  const afterReplay = await call('GET', '/v1/queue/queues/jobs/stats');
  assert.equal(afterReplay.json.dead, 0);
  assert.equal(afterReplay.json.pending, 1);
  assert.equal(afterReplay.json.replayed, 1);

  const third = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.equal(third.json.messages[0].attempts, 1);
  await call('POST', '/v1/queue/queues/jobs/ack', { receipt: third.json.messages[0].receipt });

  const noRequeue = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 'drop' });
  const ran = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.equal(ran.json.count, 1);
  const dropped = await call('POST', '/v1/queue/queues/jobs/nack', {
    receipt: ran.json.messages[0].receipt, requeue: false,
  });
  assert.equal(dropped.json.state, 'dead');
  assert.ok(noRequeue.json.id);
});

test('visibility timeout, heartbeat and redelivery', async () => {
  await createQueue();
  const published = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 'lease' });
  assert.equal(published.status, 201);

  const first = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1, visibilityTimeoutSeconds: 1 });
  assert.equal(first.json.count, 1);
  const receipt = first.json.messages[0].receipt;

  const beat = await call('POST', '/v1/queue/queues/jobs/heartbeat', { receipt, visibilityTimeoutSeconds: 2 });
  assert.equal(beat.status, 200);
  assert.ok(beat.json.leaseExpiresAt);

  await new Promise((r) => setTimeout(r, 1100));
  const blocked = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.equal(blocked.json.count, 0);

  await new Promise((r) => setTimeout(r, 1100));
  const redelivered = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.equal(redelivered.json.count, 1);
  assert.equal(redelivered.json.messages[0].attempts, 2);
  await call('POST', '/v1/queue/queues/jobs/ack', { receipt: redelivered.json.messages[0].receipt });
});

test('long-poll consume returns as soon as work arrives', async () => {
  await createQueue();
  const started = Date.now();
  const waiting = call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1, waitSeconds: 5 });
  // Publish while the request is parked: the waiter must wake immediately
  // instead of sleeping out the whole wait.
  await new Promise((r) => setTimeout(r, 120));
  await call('POST', '/v1/queue/queues/jobs/messages', { payload: { hello: 'world' } });
  const startedAt = Date.now();
  const got = await waiting;
  const elapsed = Date.now() - startedAt;
  assert.equal(got.status, 200);
  assert.equal(got.json.count, 1);
  assert.equal(got.json.messages[0].payload.hello, 'world');
  assert.equal(got.json.waitSeconds, 5);
  assert.ok(got.json.waitedMs >= 100, `waitedMs=${got.json.waitedMs}`);
  assert.ok(elapsed < 2000, `wake-up took ${elapsed}ms`);
  assert.ok(Date.now() - started < 5000, 'must not sleep out the full wait');
  await call('POST', '/v1/queue/queues/jobs/ack', { receipt: got.json.messages[0].receipt });
});

test('long-poll consume honours the wait budget and delayed messages', async () => {
  await createQueue();
  const empty = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1, waitSeconds: 1 });
  assert.equal(empty.json.count, 0);
  assert.ok(empty.json.waitedMs >= 900, `waitedMs=${empty.json.waitedMs}`);
  assert.ok(empty.json.waitedMs < 2500, `waitedMs=${empty.json.waitedMs}`);

  // A delayed message is not announced over pub/sub; the waiter must compute
  // the next availability time and pick it up without a scan loop.
  const started = Date.now();
  const delayed = call('POST', '/v1/queue/queues/jobs/messages', { payload: 'later', delaySeconds: 1 });
  const got = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1, waitSeconds: 3 });
  await delayed;
  const elapsed = Date.now() - started;
  assert.equal(got.json.count, 1);
  assert.equal(got.json.messages[0].payload, 'later');
  assert.ok(elapsed >= 900 && elapsed < 2500, `delayed pickup took ${elapsed}ms`);
  await call('POST', '/v1/queue/queues/jobs/ack', { receipt: got.json.messages[0].receipt });
});

test('waitSeconds is validated and bounded', async () => {
  await createQueue();
  const tooLong = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1, waitSeconds: 21 });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error, 'invalid_request');
  const negative = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1, waitSeconds: -1 });
  assert.equal(negative.status, 400);
  // waitSeconds=0 keeps the old immediate-return contract.
  const immediate = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 1 });
  assert.equal(immediate.status, 200);
  assert.equal(immediate.json.count, 0);
  assert.ok(immediate.json.waitedMs < 500, `waitedMs=${immediate.json.waitedMs}`);
  assert.equal(immediate.json.waitSeconds, undefined);
});

test('batch publish and tenant isolation', async () => {
  await createQueue();
  const batch = await call('POST', '/v1/queue/queues/jobs/messages:batch', {
    messages: [
      { payload: 1 },
      { payload: 2, id: 'custom-id' },
      { headers: { only: true } },
    ],
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.json.results.length, 3);
  assert.equal(batch.json.results[0].ok, true);
  assert.equal(batch.json.results[1].id, 'custom-id');
  assert.equal(batch.json.results[2].ok, false);
  assert.equal(batch.json.ok, false);

  const stats = await call('GET', '/v1/queue/queues/jobs/stats');
  assert.equal(stats.json.pending, 2);

  const foreign = await call('GET', '/v1/queue/queues/jobs/messages', undefined, headers('tenant-b'));
  assert.equal(foreign.status, 404);
  const foreignStats = await call('GET', '/v1/queue/queues/jobs/stats', undefined, headers('tenant-b'));
  assert.equal(foreignStats.status, 404);
});

test('API-key headers without a user are account-scoped, never platform (#17)', async () => {
  const keyH = { 'content-type': 'application/json', 'x-synapseone-kind': 'apikey', 'x-synapseone-account': 'acc-9' };
  // A queue owned by the org tenant stays invisible, and the key cannot
  // hijack the platform `?tenant=` namespace.
  await createQueue();
  assert.equal((await call('GET', '/v1/queue/queues/jobs/stats', undefined, keyH)).status, 404);
  assert.deepEqual((await call('GET', '/v1/queue/queues', undefined, keyH)).json, []);

  const made = await call('PUT', '/v1/queue/queues/jobs', { maxAttempts: 3, visibilityTimeoutSeconds: 30 }, keyH);
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await call('POST', '/v1/queue/queues/jobs/messages?tenant=admin', { payload: 1 }, keyH)).status, 201);
  assert.equal((await call('GET', '/v1/queue/queues/jobs/stats', undefined, keyH)).json.pending, 1);

  // platform (tenant:admin) sees a different namespace
  const platformH = { 'content-type': 'application/json', 'x-synapseone-tenant': 'admin' };
  assert.equal((await call('GET', '/v1/queue/queues/jobs/stats', undefined, platformH)).status, 404);
});

test('queue configuration, listing, purge and delete', async () => {
  const empty = await call('GET', '/v1/queue/queues');
  assert.deepEqual(empty.json, []);

  const created = await createQueue({ maxAttempts: 4, visibilityTimeoutSeconds: 10 });
  assert.equal(created.name, 'jobs');
  assert.equal(created.maxAttempts, 4);
  assert.equal(created.visibilityTimeoutSeconds, 10);

  const listed = await call('GET', '/v1/queue/queues');
  assert.equal(listed.json.length, 1);
  assert.equal(listed.json[0].name, 'jobs');

  const one = await call('GET', '/v1/queue/queues/jobs');
  assert.equal(one.status, 200);
  assert.equal(one.json.stats.pending, 0);

  await call('POST', '/v1/queue/queues/jobs/messages', { payload: 'x' });
  await call('POST', '/v1/queue/queues/jobs/messages', { payload: 'y' });
  const purged = await call('POST', '/v1/queue/queues/jobs/purge');
  assert.equal(purged.status, 200);
  assert.equal((await call('GET', '/v1/queue/queues/jobs/stats')).json.pending, 0);

  const updated = await call('PUT', '/v1/queue/queues/jobs', { maxAttempts: 7 });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.maxAttempts, 7);

  const deleted = await call('DELETE', '/v1/queue/queues/jobs');
  assert.equal(deleted.json.deleted, true);
  assert.equal((await call('GET', '/v1/queue/queues/jobs')).status, 404);
});

test('authentication and validation', async () => {
  const anon = await call('GET', '/v1/queue/queues', undefined, { 'x-synapseone-anon': '1' } as any);
  assert.equal(anon.status, 401);

  const platformMissing = await call('GET', '/v1/queue/queues', undefined, {} as any);
  assert.equal(platformMissing.status, 400);
  assert.equal(platformMissing.json.error, 'tenant_required');

  const platformOk = await call('GET', '/v1/queue/queues', undefined, { 'x-synapseone-tenant': 'admin' } as any);
  assert.equal(platformOk.status, 200);

  const badQueue = await call('GET', '/v1/queue/queues/1bad');
  assert.equal(badQueue.status, 400);

  const missingPayload = await call('POST', '/v1/queue/queues/jobs/messages', { headers: { a: 1 } });
  assert.equal(missingPayload.status, 400);
  assert.equal(missingPayload.json.error, 'invalid_payload');

  const badDelay = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 1, delaySeconds: -1 });
  assert.equal(badDelay.status, 400);

  const badConsume = await call('POST', '/v1/queue/queues/jobs/consume', { maxMessages: 0 });
  assert.equal(badConsume.status, 400);

  await createQueue();
  const unknownAck = await call('POST', '/v1/queue/queues/jobs/ack', { receipt: 'nope:1' });
  assert.equal(unknownAck.status, 404);
  const unknownBeat = await call('POST', '/v1/queue/queues/jobs/heartbeat', { receipt: 'nope:1' });
  assert.equal(unknownBeat.status, 404);
  const unknownReplay = await call('POST', '/v1/queue/queues/jobs/dead/nope/replay', {});
  assert.equal(unknownReplay.status, 404);

  const badBatch = await call('POST', '/v1/queue/queues/jobs/messages:batch', { messages: [] });
  assert.equal(badBatch.status, 400);

  const badId = await call('POST', '/v1/queue/queues/jobs/messages', { payload: 1, id: 'bad/id' });
  assert.equal(badId.status, 400);
});

test('mutation audit records actor, tenant, action and result (#32)', async () => {
  __clearAudit();
  await createQueue();
  const pub = await call('POST', '/v1/queue/queues/jobs/messages', { payload: { secret: 'super-secret-value' } });
  assert.equal(pub.status, 201);
  await new Promise((r) => setImmediate(r));

  const event = __auditEvents().find((e) => e.action === 'queue:queues.messages:create');
  assert.ok(event, JSON.stringify(__auditEvents()));
  assert.equal(event.actorType, 'user');
  assert.equal(event.actorId, 'user-1');
  assert.equal(event.orgId, 'tenant-a');
  assert.equal(event.result, 'allowed');
  assert.equal(event.statusCode, 201);
  assert.ok(!JSON.stringify(__auditEvents()).includes('super-secret-value'), 'message payloads must never enter the audit trail');

  const denied = await call('POST', '/v1/queue/queues/missing/purge', {});
  assert.equal(denied.status, 404);
  await new Promise((r) => setImmediate(r));
  const failed = __auditEvents().find((e) => e.action === 'queue:queues:purge' && e.result === 'denied');
  assert.ok(failed, JSON.stringify(__auditEvents()));
  assert.equal(failed.statusCode, 404);

  const before = __auditEvents().length;
  await call('GET', '/v1/queue/queues/jobs/stats');
  await new Promise((r) => setImmediate(r));
  assert.equal(__auditEvents().length, before, 'reads must not add mutation events');
});
