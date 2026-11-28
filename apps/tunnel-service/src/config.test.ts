// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { loadConnectorConfig, loadServerConfig } from './config';
import { connectorCreateSchema, routeCreateSchema, sanitizeRequestHeaders, sanitizeResponseHeaders } from './validation';

const TOKEN = `st_${'a'.repeat(43)}`;

test('server configuration fails closed and applies documented defaults', () => {
  assert.throws(() => loadServerConfig('combined', {}), /ADMIN_TOKEN/);
  assert.throws(() => loadServerConfig('combined', { NODE_ENV: 'production' }), /ADMIN_TOKEN/);
  assert.throws(() => loadServerConfig('combined', { NODE_ENV: 'production', SYNAPSETUNNEL_ALLOW_INSECURE: 'true' }), /forbidden/);
  assert.throws(() => loadServerConfig('combined', { NODE_ENV: 'production', SYNAPSETUNNEL_ADMIN_TOKEN: 'short' }), /32 characters/);
  assert.throws(() => loadServerConfig('combined', { NODE_ENV: 'production', SYNAPSETUNNEL_ADMIN_TOKEN: 'x'.repeat(32), SYNAPSETUNNEL_DATA_FILE: 'memory' }), /Persistent/);

  const insecure = loadServerConfig('combined', { SYNAPSETUNNEL_ALLOW_INSECURE: 'true' });
  assert.equal(insecure.allowInsecure, true);
  assert.equal(insecure.adminToken, undefined);

  const defaults = loadServerConfig('combined', { SYNAPSETUNNEL_ADMIN_TOKEN: 'test-token' });
  assert.equal(defaults.apiPort, 4015);
  assert.equal(defaults.ingressPort, 4016);
  assert.equal(defaults.dataFile, resolve('./data/synapse-tunnel.json'));
  assert.equal(defaults.requestTimeoutMs, 30000);
  assert.equal(defaults.maxRequestBytes, 10485760);
  assert.equal(defaults.maxResponseBytes, 16777216);
});

test('hostname, route, and upstream validation reject unsafe input', () => {
  assert.equal(connectorCreateSchema.parse({ name: 'local', upstreamUrl: 'http://localhost:3000/base' }).upstreamUrl, 'http://localhost:3000/base');
  assert.equal(routeCreateSchema.parse({ hostname: 'App.Example.com.', pathPrefix: '/api/', connectorId: randomUUID() }).hostname, 'app.example.com');
  assert.equal(routeCreateSchema.parse({ hostname: 'app.example.com', pathPrefix: '/', connectorId: randomUUID() }).pathPrefix, '');

  for (const upstreamUrl of ['ftp://example.com', 'http://user:pass@example.com', 'http://example.com/?token=x', 'http://example.com/#x', 'not a url']) {
    assert.equal(connectorCreateSchema.safeParse({ name: 'bad', upstreamUrl }).success, false);
  }
  for (const hostname of ['bad host', 'user@example.com', 'example.com:4016', '*.example.com', '-bad.example.com']) {
    assert.equal(routeCreateSchema.safeParse({ hostname, connectorId: randomUUID() }).success, false);
  }
  for (const pathPrefix of ['api', '/bad?x', '/../admin', '/bad\\path']) {
    assert.equal(routeCreateSchema.safeParse({ hostname: 'app.example.com', pathPrefix, connectorId: randomUUID() }).success, false);
  }
});

test('header sanitizers strip hop-by-hop, nominated, and spoofable headers', () => {
  const request = sanitizeRequestHeaders({
    host: 'app.example.com',
    connection: 'x-hop, x-synapseone-account',
    'x-hop': 'remove',
    'keep-alive': 'timeout=5',
    'content-length': '10',
    'x-synapseone-account': 'spoof',
    'x-forwarded-for': 'spoof',
    'x-real-ip': 'spoof',
    'x-request-id': 'spoof',
    authorization: 'Bearer public-user-token',
    cookie: 'session=value',
    'x-end-to-end': 'keep',
  });
  assert.deepEqual(request, { authorization: ['Bearer public-user-token'], cookie: ['session=value'], 'x-end-to-end': ['keep'] });

  const response = sanitizeResponseHeaders({
    connection: ['x-hop-response'],
    'x-hop-response': ['remove'],
    'transfer-encoding': ['chunked'],
    'content-length': ['100'],
    'content-encoding': ['gzip'],
    'content-type': ['text/event-stream'],
    'set-cookie': ['a=1', 'b=2'],
  });
  assert.deepEqual(response, { 'content-type': ['text/event-stream'], 'set-cookie': ['a=1', 'b=2'] });
});

test('connector CLI configuration validates its token and server URL', () => {
  const config = loadConnectorConfig({ SYNAPSETUNNEL_CONNECTOR_TOKEN: TOKEN, SYNAPSETUNNEL_SERVER_URL: 'https://tunnel.example.com/base' }, []);
  assert.equal(config.token, TOKEN);
  assert.equal(config.serverUrl, 'https://tunnel.example.com/base');
  assert.throws(() => loadConnectorConfig({}, []), /token/);
  assert.throws(() => loadConnectorConfig({ SYNAPSETUNNEL_CONNECTOR_TOKEN: TOKEN, SYNAPSETUNNEL_SERVER_URL: 'file:///tmp/x' }, []), /server URL/);
});
