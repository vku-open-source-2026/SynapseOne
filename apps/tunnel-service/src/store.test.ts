// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hashConnectorToken, JsonStore } from './store';

async function directory(t: TestContext): Promise<string> {
  const root = join(resolve(__dirname, '..'), '.test-tmp');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, `store-${process.pid}-`));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function token(): string { return `st_${randomBytes(32).toString('base64url')}`; }

test('JSON store writes atomically, serializes mutations, and refreshes standalone readers', async (t) => {
  const root = await directory(t);
  const file = join(root, 'nested', 'tunnel.json');
  const writer = await JsonStore.open(file, false);
  const reader = await JsonStore.open(file, true);
  t.after(async () => { await reader.close(); await writer.close(); });

  const firstToken = token();
  const first = await writer.createConnector({ name: 'first', upstreamUrl: 'http://localhost:3000', orgId: 'org-a' }, firstToken);
  assert.equal((await reader.findByToken(firstToken))?.id, first.id);
  assert.equal(await reader.findByToken(token()), null);
  await writer.createRoute({
    name: 'app', hostname: 'app.example.com', pathPrefix: '/api', connectorId: first.id,
    enabled: true, rateLimitPerMinute: 60,
  });
  assert.equal((await reader.matchRoute('app.example.com', '/api/items'))?.connectorId, first.id);

  await Promise.all(Array.from({ length: 20 }, (_, index) => writer.createConnector({
    name: `connector-${index}`, upstreamUrl: 'http://127.0.0.1:3000', orgId: null,
  }, token())));
  assert.equal((await reader.listConnectors()).length, 21);
  const raw = await readFile(file, 'utf8');
  assert.equal((JSON.parse(raw) as { version: number }).version, 2);
  assert.equal((await reader.getConnector(first.id))?.orgId, 'org-a');
  assert.equal(raw.includes(firstToken), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readdir(join(root, 'nested'))).some((name) => name.endsWith('.tmp')), false);
});

test('JSON store fails closed on corrupt data and supports an explicit memory fallback', async (t) => {
  const root = await directory(t);
  const file = join(root, 'tunnel.json');
  await writeFile(file, '{not-json', 'utf8');
  await assert.rejects(() => JsonStore.open(file), /invalid JSON/);

  const memory = await JsonStore.open(null);
  assert.equal(memory.persistent, false);
  const created = await memory.createConnector({ name: 'memory', upstreamUrl: 'http://127.0.0.1:3000', orgId: 'org-memory' }, token());
  assert.equal((await memory.getConnector(created.id))?.name, 'memory');
  assert.equal((await memory.getConnector(created.id))?.orgId, 'org-memory');
  await assert.rejects(() => memory.createConnector({
    name: 'bad owner', upstreamUrl: 'http://127.0.0.1:3000', orgId: 'bad_org',
  }, token()), /Invalid connector organization ID/);
  await memory.close();
  assert.equal(memory.ready, false);
});

test('JSON store migrates v1 connectors to platform ownership and atomically persists v2', async (t) => {
  const root = await directory(t);
  const file = join(root, 'tunnel.json');
  const legacyToken = token();
  const legacyConnector = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'legacy',
    upstreamUrl: 'http://127.0.0.1:3000',
    tokenHash: hashConnectorToken(legacyToken),
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const legacyRoutes = [{
    id: '00000000-0000-4000-8000-000000000002',
    name: 'legacy route',
    hostname: 'legacy.example.com',
    pathPrefix: '/api',
    connectorId: legacyConnector.id,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  await writeFile(file, JSON.stringify({ version: 1, connectors: [legacyConnector], routes: legacyRoutes }), 'utf8');

  const store = await JsonStore.open(file);
  t.after(() => store.close());
  const connector = await store.getConnectorRecord(legacyConnector.id);
  assert.equal(connector?.orgId, null);
  assert.equal(connector?.tokenHash, legacyConnector.tokenHash);
  assert.equal((await store.findByToken(legacyToken))?.id, legacyConnector.id);
  assert.deepEqual(await store.getRoute(legacyRoutes[0].id), legacyRoutes[0]);

  const persisted = JSON.parse(await readFile(file, 'utf8')) as {
    version: number;
    connectors: Array<Record<string, unknown>>;
    routes: unknown[];
  };
  assert.equal(persisted.version, 2);
  assert.equal(persisted.connectors[0].orgId, null);
  assert.equal(persisted.connectors[0].tokenHash, legacyConnector.tokenHash);
  assert.deepEqual(persisted.routes, legacyRoutes);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false);

  await store.close();
  const reopened = await JsonStore.open(file, false);
  assert.equal((await reopened.getConnector(legacyConnector.id))?.orgId, null);
  assert.equal((await reopened.findByToken(legacyToken))?.id, legacyConnector.id);
  await reopened.close();
});

test('JSON store does not silently treat malformed v2 data as legacy', async (t) => {
  const root = await directory(t);
  const file = join(root, 'tunnel.json');
  await writeFile(file, JSON.stringify({
    version: 2,
    connectors: [{
      id: '00000000-0000-4000-8000-000000000003',
      name: 'missing owner',
      upstreamUrl: 'http://127.0.0.1:3000',
      tokenHash: 'a'.repeat(64),
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    routes: [],
  }), 'utf8');
  await assert.rejects(() => JsonStore.open(file), /invalid schema/);
});
