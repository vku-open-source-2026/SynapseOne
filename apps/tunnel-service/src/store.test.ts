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
import { JsonStore } from './store';

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
  const first = await writer.createConnector({ name: 'first', upstreamUrl: 'http://localhost:3000' }, firstToken);
  assert.equal((await reader.findByToken(firstToken))?.id, first.id);
  assert.equal(await reader.findByToken(token()), null);
  await writer.createRoute({
    name: 'app', hostname: 'app.example.com', pathPrefix: '/api', connectorId: first.id,
    enabled: true, rateLimitPerMinute: 60,
  });
  assert.equal((await reader.matchRoute('app.example.com', '/api/items'))?.connectorId, first.id);

  await Promise.all(Array.from({ length: 20 }, (_, index) => writer.createConnector({
    name: `connector-${index}`, upstreamUrl: 'http://127.0.0.1:3000',
  }, token())));
  assert.equal((await reader.listConnectors()).length, 21);
  const raw = await readFile(file, 'utf8');
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
  const created = await memory.createConnector({ name: 'memory', upstreamUrl: 'http://127.0.0.1:3000' }, token());
  assert.equal((await memory.getConnector(created.id))?.name, 'memory');
  await memory.close();
  assert.equal(memory.ready, false);
});
