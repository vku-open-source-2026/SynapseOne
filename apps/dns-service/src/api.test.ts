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
const INTERNAL_SECRET = 'unit-test-internal-secret';

interface RunningApi {
  base: string;
  server: Server;
  store: ZoneStore;
}

async function startApi(options: {
  token?: string | null;
  internalSecret?: string | null;
  insecure?: boolean;
  ready?: boolean;
  logLines?: string[];
} = {}): Promise<RunningApi> {
  const config = loadConfig({
    NODE_ENV: 'test',
    SYNAPSEDNS_DATA_FILE: ':memory:',
    ...(options.token === null ? {} : { SYNAPSEDNS_ADMIN_TOKEN: options.token ?? TOKEN }),
    ...(options.internalSecret === null ? {} : { SYNAPSEONE_INTERNAL_SECRET: options.internalSecret ?? INTERNAL_SECRET }),
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
  options: { method?: string; body?: unknown; rawBody?: string; token?: string | null; requestId?: string; headers?: Record<string, string> } = {},
): Promise<{ response: Response; body: any }> {
  const headers: Record<string, string> = { ...options.headers };
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

function tenantHeaders(orgId = 'org-a', overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'x-synapseone-internal': INTERNAL_SECRET,
    'x-synapseone-org': orgId,
    'x-synapseone-user': 'user-123',
    'x-synapseone-kind': 'tenant',
    'x-synapseone-scopes': 'dns:read,dns:write',
    ...overrides,
  };
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

test('gateway tenant authentication fails closed without internal configuration', async (t) => {
  const api = await startApi({ internalSecret: null });
  t.after(() => stopApi(api));
  for (const headers of [tenantHeaders(), { 'x-synapseone-org': 'org-a' }, { 'x-synapseone-owner-org': 'owner-org' }]) {
    const result = await request(api, '/v1/zones', { token: null, headers });
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error, 'internal_auth_unavailable');
  }
  assert.equal((await request(api, '/v1/zones', { token: null })).response.status, 401);
  assert.equal((await request(api, '/health', { token: null, headers: tenantHeaders() })).response.status, 200);
  assert.equal((await request(api, '/ready', { token: null, headers: tenantHeaders() })).response.status, 200);
});

test('gateway credentials require a timing-safe secret and a valid organization', async (t) => {
  const api = await startApi();
  t.after(() => stopApi(api));
  const missingSecret = await request(api, '/v1/zones', {
    token: null,
    headers: { 'x-synapseone-org': 'org-a' },
  });
  assert.equal(missingSecret.response.status, 401);
  assert.equal(missingSecret.body.error, 'unauthorized');
  const wrongSecret = await request(api, '/v1/zones', {
    token: null,
    headers: tenantHeaders('org-a', { 'x-synapseone-internal': 'wrong-secret' }),
  });
  assert.equal(wrongSecret.response.status, 401);
  assert.equal(wrongSecret.body.error, 'unauthorized');
  const ownerWithoutSecret = await request(api, '/v1/zones', {
    token: null,
    headers: { 'x-synapseone-owner-org': 'owner-org' },
  });
  assert.equal(ownerWithoutSecret.response.status, 401);
  for (const orgId of ['', 'bad_org', 'bad/org', 'a'.repeat(65)]) {
    const result = await request(api, '/v1/zones', { token: null, headers: tenantHeaders(orgId) });
    assert.equal(result.response.status, 403, JSON.stringify(orgId));
    assert.equal(result.body.error, 'forbidden');
  }
  const missingOrg = await request(api, '/v1/zones', {
    token: null,
    headers: { 'x-synapseone-internal': INTERNAL_SECRET },
  });
  assert.equal(missingOrg.response.status, 403);
  const invalidOwner = await request(api, '/v1/zones', {
    token: null,
    headers: { 'x-synapseone-internal': INTERNAL_SECRET, 'x-synapseone-owner-org': 'bad_owner' },
  });
  assert.equal(invalidOwner.response.status, 403);
  assert.equal((await request(api, '/v1/zones', { token: null, headers: tenantHeaders() })).response.status, 200);
});

test('service-account owner-org is a fallback and primary org takes precedence', async (t) => {
  const api = await startApi();
  t.after(() => stopApi(api));
  const serviceAccount = await request(api, '/v1/zones', {
    method: 'POST',
    token: null,
    headers: {
      'x-synapseone-internal': INTERNAL_SECRET,
      'x-synapseone-user': 'service-account-123',
      'x-synapseone-kind': 'service_account',
      'x-synapseone-scopes': 'dns:write',
      'x-synapseone-owner-org': 'owner-org',
    },
    body: { name: 'service.test' },
  });
  assert.equal(serviceAccount.response.status, 201, JSON.stringify(serviceAccount.body));
  assert.equal(serviceAccount.body.orgId, 'owner-org');

  const primary = await request(api, '/v1/zones', {
    token: null,
    headers: tenantHeaders('primary-org', { 'x-synapseone-owner-org': 'fallback-org' }),
  });
  assert.deepEqual(primary.body.zones.map((zone: any) => zone.name), []);
  const fallback = await request(api, '/v1/zones', {
    token: null,
    headers: tenantHeaders('owner-org', { 'x-synapseone-owner-org': 'fallback-org' }),
  });
  assert.deepEqual(fallback.body.zones.map((zone: any) => zone.name), ['service.test.']);
  const emptyPrimary = await request(api, '/v1/zones', {
    token: null,
    headers: tenantHeaders('', { 'x-synapseone-owner-org': 'owner-org' }),
  });
  assert.deepEqual(emptyPrimary.body.zones.map((zone: any) => zone.name), ['service.test.']);
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

test('tenant zones are isolated and cross-organization operations return 404', async (t) => {
  const api = await startApi();
  t.after(() => stopApi(api));
  const orgA = tenantHeaders('org-a');
  const orgB = tenantHeaders('org-b');

  const createdA = await request(api, '/v1/zones', {
    method: 'POST', token: null, headers: orgA,
    body: { name: 'a.test', orgId: 'org-b' },
  });
  assert.equal(createdA.response.status, 201, JSON.stringify(createdA.body));
  assert.equal(createdA.body.orgId, 'org-a');
  const createdB = await request(api, '/v1/zones', {
    method: 'POST', token: null, headers: orgB, body: { name: 'b.test' },
  });
  assert.equal(createdB.body.orgId, 'org-b');
  const createdPlatform = await request(api, '/v1/zones', {
    method: 'POST', body: { name: 'platform.test', orgId: 'org-a' },
  });
  assert.equal(createdPlatform.body.orgId, null);

  assert.deepEqual((await request(api, '/v1/zones', { token: null, headers: orgA })).body.zones.map((zone: any) => zone.name), ['a.test.']);
  assert.deepEqual((await request(api, '/v1/zones', { token: null, headers: orgB })).body.zones.map((zone: any) => zone.name), ['b.test.']);
  assert.deepEqual((await request(api, '/v1/zones')).body.zones.map((zone: any) => zone.name), ['a.test.', 'b.test.', 'platform.test.']);
  const platformWithSpoofedHeaders = await request(api, '/v1/zones', {
    headers: tenantHeaders('org-a', { 'x-synapseone-internal': 'wrong', 'x-synapseone-org': 'bad_org' }),
  });
  assert.equal(platformWithSpoofedHeaders.response.status, 200);
  assert.equal(platformWithSpoofedHeaders.body.zones.length, 3);

  for (const path of ['/v1/zones/b.test', '/v1/zones/b.test/records']) {
    const result = await request(api, path, { token: null, headers: orgA });
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error, 'not_found');
  }
  assert.equal((await request(api, '/v1/zones/b.test', { method: 'DELETE', token: null, headers: orgA })).response.status, 404);
  assert.equal((await request(api, '/v1/zones/a.test', { token: null, headers: orgB })).response.status, 404);

  const record = await request(api, '/v1/zones/a.test/records', {
    method: 'POST', token: null, headers: orgA,
    body: { type: 'A', name: 'www.a.test', address: '192.0.2.10' },
  });
  assert.equal(record.response.status, 201);
  const crossOrgMutations = [
    request(api, '/v1/zones/a.test/records', {
      method: 'POST', token: null, headers: orgB,
      body: { type: 'A', name: 'new.a.test', address: '192.0.2.11' },
    }),
    request(api, `/v1/zones/a.test/records/${record.body.id}`, {
      method: 'PATCH', token: null, headers: orgB, body: { address: '192.0.2.12' },
    }),
    request(api, `/v1/zones/a.test/records/${record.body.id}`, {
      method: 'PATCH', token: null, headers: orgB, body: {},
    }),
    request(api, `/v1/zones/a.test/records/${record.body.id}`, {
      method: 'DELETE', token: null, headers: orgB,
    }),
  ];
  for (const result of await Promise.all(crossOrgMutations)) {
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error, 'not_found');
  }
  const unchanged = await request(api, '/v1/zones/a.test/records', { token: null, headers: orgA });
  assert.equal(unchanged.body.records.length, 4);
  assert.equal(unchanged.body.records.find((candidate: any) => candidate.id === record.body.id).address, '192.0.2.10');

  const patched = await request(api, `/v1/zones/a.test/records/${record.body.id}`, {
    method: 'PATCH', token: null, headers: orgA, body: { address: '192.0.2.20' },
  });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.address, '192.0.2.20');
  assert.equal((await request(api, `/v1/zones/a.test/records/${record.body.id}`, { method: 'DELETE', token: null, headers: orgA })).response.status, 204);

  // The direct platform administrator retains full access across every owner.
  assert.equal((await request(api, '/v1/zones/a.test')).response.status, 200);
  const platformPatched = await request(api, `/v1/zones/b.test/records/${createdB.body.records[0].id}`, {
    method: 'PATCH', body: { serial: 42 },
  });
  assert.equal(platformPatched.response.status, 200);
  assert.equal(platformPatched.body.serial, 42);
  assert.equal((await request(api, '/v1/zones/b.test', { method: 'DELETE' })).response.status, 204);
  assert.deepEqual((await request(api, '/v1/zones', { token: null, headers: orgB })).body.zones, []);
  assert.equal((await request(api, '/v1/zones/a.test', { method: 'DELETE', token: null, headers: orgA })).response.status, 204);
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
