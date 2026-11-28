// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import test from 'node:test';
import { createApp } from './api';
import { loadConfig } from './config';
import { JsonLogger, silentLogger } from './logger';
import { ZoneStore } from './store';

const TOKEN = 'unit-test-admin-token';

interface RunningApi {
  base: string;
  server: Server;
  store: ZoneStore;
}

async function startApi(options: {
  token?: string | null;
  insecure?: boolean;
  ready?: boolean;
  logLines?: string[];
} = {}): Promise<RunningApi> {
  const config = loadConfig({
    NODE_ENV: 'test',
    SYNAPSEDNS_DATA_FILE: ':memory:',
    ...(options.token === null ? {} : { SYNAPSEDNS_ADMIN_TOKEN: options.token ?? TOKEN }),
    ...(options.insecure ? { SYNAPSEDNS_ALLOW_INSECURE: 'true' } : {}),
  });
  const store = new ZoneStore({ memory: true });
  const logger = options.logLines ? new JsonLogger((line) => options.logLines!.push(line)) : silentLogger;
  const app = createApp({ store, config, logger, isReady: () => options.ready ?? true });
  const server = await new Promise<Server>((resolveListening) => {
    const instance = app.listen(0, '127.0.0.1', () => resolveListening(instance));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}`, server, store };
}

async function stopApi(api: RunningApi): Promise<void> {
  await new Promise<void>((resolveClosed) => {
    api.server.close(() => resolveClosed());
    api.server.closeAllConnections();
  });
  await api.store.close();
}

async function request(
  api: RunningApi,
  path: string,
  options: { method?: string; body?: unknown; rawBody?: string; token?: string | null; requestId?: string } = {},
): Promise<{ response: Response; body: any }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined || options.rawBody !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.requestId) headers['x-request-id'] = options.requestId;
  const response = await fetch(`${api.base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test('health and readiness are public; admin routes require a timing-safe bearer token', async (t) => {
  const api = await startApi();
  t.after(() => stopApi(api));
  assert.equal((await request(api, '/health', { token: null })).response.status, 200);
  assert.equal((await request(api, '/ready', { token: null })).response.status, 200);
  assert.equal((await request(api, '/v1/zones', { token: null })).response.status, 401);
  assert.equal((await request(api, '/v1/zones', { token: 'wrong' })).response.status, 401);
  const denied = await request(api, '/v1/zones', { token: 'wrong' });
  assert.equal(denied.body.error, 'unauthorized');
  assert.equal(denied.response.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await request(api, '/v1/zones')).response.status, 200);
});

test('readiness reports 503 while dependencies are not ready', async (t) => {
  const api = await startApi({ ready: false });
  t.after(() => stopApi(api));
  const result = await request(api, '/ready', { token: null });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.status, 'not_ready');
  assert.equal((await request(api, '/health', { token: null })).response.status, 200);
});

test('zone and record CRUD is normalized, persistent in memory, and conflict-aware', async (t) => {
  const api = await startApi();
  t.after(() => stopApi(api));
  const created = await request(api, '/v1/zones', {
    method: 'POST', body: { name: 'ExAmPlE.TEST', nameservers: ['NS1.Example.Test'], ttl: 600 },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.name, 'example.test.');
  assert.equal(created.body.records.length, 2);
  assert.equal(created.body.records[0].type, 'SOA');
  assert.equal(created.body.records[1].type, 'NS');
  assert.equal(created.response.headers.get('location'), '/v1/zones/example.test.');
  assert.equal((await request(api, '/v1/zones/EXAMPLE.TEST')).body.name, 'example.test.');
  assert.equal((await request(api, '/v1/zones')).body.zones[0].recordCount, 2);
  assert.equal((await request(api, '/v1/zones', { method: 'POST', body: { name: 'example.test.' } })).response.status, 409);

  const record = await request(api, '/v1/zones/example.test/records', {
    method: 'POST', body: { type: 'A', name: 'WWW.Example.Test', address: '192.0.2.1', ttl: 60 },
  });
  assert.equal(record.response.status, 201);
  assert.equal(record.body.name, 'www.example.test.');
  assert.equal((await request(api, '/v1/zones/example.test/records')).body.records.length, 3);
  const duplicate = await request(api, '/v1/zones/example.test/records', {
    method: 'POST', body: { type: 'A', name: 'www.example.test', address: '192.0.2.1', ttl: 300 },
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error, 'duplicate_record');

  const patched = await request(api, `/v1/zones/example.test/records/${record.body.id}`, {
    method: 'PATCH', body: { address: '192.0.2.2', ttl: 120 },
  });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.id, record.body.id);
  assert.equal(patched.body.address, '192.0.2.2');
  assert.equal(patched.body.ttl, 120);
  assert.equal((await request(api, `/v1/zones/example.test/records/${record.body.id}`, { method: 'PATCH', body: {} })).response.status, 400);
  assert.equal((await request(api, '/v1/zones/example.test/records/not-a-uuid', { method: 'DELETE' })).response.status, 400);

  assert.equal((await request(api, `/v1/zones/example.test/records/${record.body.id}`, { method: 'DELETE' })).response.status, 204);
  assert.equal((await request(api, '/v1/zones/example.test/records')).body.records.length, 2);
  assert.equal((await request(api, '/v1/zones/example.test', { method: 'DELETE' })).response.status, 204);
  assert.equal((await request(api, '/v1/zones/example.test')).response.status, 404);
  assert.equal((await request(api, '/v1/zones')).body.zones.length, 0);
});

test('management API accepts every supported record type', async (t) => {
  const api = await startApi();
  t.after(() => stopApi(api));
  await request(api, '/v1/zones', { method: 'POST', body: { name: 'example.test' } });
  const records = [
    { type: 'A', name: 'www.example.test', address: '192.0.2.1' },
    { type: 'AAAA', name: 'www.example.test', address: '2001:db8::1' },
    { type: 'CNAME', name: 'alias.example.test', target: 'www.example.test' },
    { type: 'MX', name: 'example.test', priority: 10, target: 'mail.example.test' },
    { type: 'TXT', name: 'txt.example.test', data: ['v=spf1 -all', 'dkim'] },
    { type: 'NS', name: 'sub.example.test', target: 'ns.external.test' },
    { type: 'SRV', name: '_sip._tcp.example.test', priority: 1, weight: 2, port: 5060, target: 'sip.example.test' },
    { type: 'CAA', name: 'example.test', flags: 0, tag: 'issue', value: 'letsencrypt.org' },
    { type: 'PTR', name: 'ptr.example.test', target: 'www.example.test' },
  ];
  for (const input of records) {
    const result = await request(api, '/v1/zones/example.test/records', { method: 'POST', body: input });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.type, input.type);
  }
  const conflict = await request(api, '/v1/zones/example.test/records', {
    method: 'POST', body: { type: 'A', name: 'alias.example.test', address: '192.0.2.9' },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error, 'cname_conflict');
});

test('API rejects invalid records, zone escapes, malformed JSON, and oversized bodies', async (t) => {
  const api = await startApi();
  t.after(() => stopApi(api));
  await request(api, '/v1/zones', { method: 'POST', body: { name: 'example.test' } });
  const invalidInputs = [
    { type: 'A', name: 'www.example.test', address: '999.1.1.1' },
    { type: 'AAAA', name: 'www.example.test', address: '192.0.2.1' },
    { type: 'A', name: 'www.example.test', address: '192.0.2.1', ttl: -1 },
    { type: 'MX', name: 'example.test', priority: 65536, target: 'mail.example.test' },
    { type: 'TXT', name: 'txt.example.test', data: ['x'.repeat(256)] },
    { type: 'A', name: 'www.other.test', address: '192.0.2.1' },
    { type: 'UNKNOWN', name: 'www.example.test' },
  ];
  for (const input of invalidInputs) {
    const result = await request(api, '/v1/zones/example.test/records', { method: 'POST', body: input });
    assert.equal(result.response.status, 400, JSON.stringify(input));
    assert.equal(result.body.error, 'validation_error');
  }
  assert.equal((await request(api, '/v1/zones', { method: 'POST', rawBody: '{' })).response.status, 400);
  assert.equal((await request(api, '/v1/zones', { method: 'POST', body: { name: 'large.test', padding: 'x'.repeat(33_000) } })).response.status, 413);
  assert.equal((await request(api, '/v1/zones', { method: 'POST', body: ['example.test'] })).response.status, 400);
});

test('explicit insecure mode works only without a configured token and never logs credentials', async (t) => {
  const lines: string[] = [];
  const insecure = await startApi({ token: null, insecure: true, logLines: lines });
  t.after(() => stopApi(insecure));
  assert.equal((await request(insecure, '/v1/zones', { token: null })).response.status, 200);
  assert.equal((await request(insecure, '/v1/zones', { method: 'POST', body: { name: 'insecure.test' }, token: null })).response.status, 201);

  const secured = await startApi({ insecure: true, logLines: lines });
  t.after(() => stopApi(secured));
  assert.equal((await request(secured, '/v1/zones', { token: null })).response.status, 401);
  assert.equal((await request(secured, '/v1/zones', { token: TOKEN })).response.status, 200);
  assert.equal(lines.some((line) => line.includes(TOKEN)), false);
  assert.equal(lines.some((line) => line.includes('authorization')), false);
});

test('request IDs are sanitized and included in errors', async (t) => {
  const api = await startApi();
  t.after(() => stopApi(api));
  const supplied = await request(api, '/v1/zones', { requestId: 'request-123' });
  assert.equal(supplied.response.headers.get('x-request-id'), 'request-123');
  const generated = await request(api, '/missing', { requestId: 'bad id', token: null });
  assert.notEqual(generated.response.headers.get('x-request-id'), 'bad id');
  assert.equal(generated.body.requestId, generated.response.headers.get('x-request-id'));
  assert.equal(generated.response.headers.get('cache-control'), 'no-store');
  assert.equal(generated.response.headers.get('x-content-type-options'), 'nosniff');
});
