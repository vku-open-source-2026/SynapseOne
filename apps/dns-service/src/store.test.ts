// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ServiceError } from './errors';
import { ZoneStore } from './store';
import type { DnsRecord } from './types';

function isError(status: number, code?: string) {
  return (error: unknown) => error instanceof ServiceError && error.status === status && (!code || error.code === code);
}

function soa(zone: { records: DnsRecord[] }): Extract<DnsRecord, { type: 'SOA' }> {
  const record = zone.records.find((candidate) => candidate.type === 'SOA');
  assert.ok(record && record.type === 'SOA');
  return record;
}

test('zone creation normalizes names and installs SOA and NS defaults', async () => {
  const store = new ZoneStore({ memory: true });
  const zone = await store.createZone({ name: 'ExAmPlE.TEST', nameservers: ['NS1.Example.Test', 'NS2.Example.NET'], ttl: 600 });
  assert.equal(zone.name, 'example.test.');
  assert.equal(zone.records.length, 3);
  assert.equal(soa(zone).primary, 'ns1.example.test.');
  assert.equal(soa(zone).admin, 'hostmaster.example.test.');
  assert.equal(soa(zone).refresh, 3600);
  assert.equal(soa(zone).minimum, 600);
  assert.deepEqual(zone.records.filter((record) => record.type === 'NS').map((record) => record.type === 'NS' && record.target), ['ns1.example.test.', 'ns2.example.net.']);
  assert.equal(store.getZone('EXAMPLE.TEST')?.name, 'example.test.');
  assert.deepEqual(store.listZones(), [{ id: zone.id, name: zone.name, createdAt: zone.createdAt, updatedAt: zone.updatedAt, recordCount: 3 }]);
  await assert.rejects(store.createZone({ name: 'example.test.' }), isError(409, 'zone_exists'));
  await assert.rejects(store.createZone({ name: 'duplicate.test', nameservers: ['ns1.duplicate.test', 'NS1.DUPLICATE.TEST'] }), isError(400));
});

test('all record types can be created and SOA serial advances on mutation', async () => {
  const store = new ZoneStore({ memory: true });
  const zone = await store.createZone({ name: 'example.test' });
  const initialSerial = soa(zone).serial;
  const inputs = [
    { type: 'A', name: 'www.example.test', address: '192.0.2.1' },
    { type: 'AAAA', name: 'www.example.test', address: '2001:db8::1' },
    { type: 'CNAME', name: 'alias.example.test', target: 'www.example.test' },
    { type: 'MX', name: 'example.test', priority: 10, target: 'mail.example.test' },
    { type: 'TXT', name: 'txt.example.test', data: ['one', 'two'] },
    { type: 'NS', name: 'sub.example.test', target: 'ns.external.test' },
    { type: 'SRV', name: '_sip._tcp.example.test', priority: 1, weight: 2, port: 5060, target: 'sip.example.test' },
    { type: 'CAA', name: 'example.test', flags: 0, tag: 'issue', value: 'letsencrypt.org' },
    { type: 'PTR', name: 'ptr.example.test', target: 'www.example.test' },
  ] as const;
  for (const input of inputs) await store.createRecord(zone.name, input as never);
  const updated = store.getZone(zone.name)!;
  assert.equal(updated.records.length, inputs.length + 3);
  assert.equal(soa(updated).serial, initialSerial + inputs.length);
  const txt = updated.records.find((record) => record.type === 'TXT');
  assert.ok(txt && txt.type === 'TXT');
  assert.deepEqual(txt.data, ['one', 'two']);
});

test('duplicate, CNAME conflict, zone escape, and required SOA/NS protections', async () => {
  const store = new ZoneStore({ memory: true });
  const zone = await store.createZone({ name: 'example.test' });
  const a = await store.createRecord(zone.name, { type: 'A', name: 'www.example.test', address: '192.0.2.1', ttl: 60 });
  await assert.rejects(store.createRecord(zone.name, { type: 'A', name: 'WWW.EXAMPLE.TEST', address: '192.0.2.1', ttl: 300 }), isError(409, 'duplicate_record'));
  await store.createRecord(zone.name, { type: 'AAAA', name: 'www.example.test', address: '2001:db8::1' });
  await assert.rejects(store.createRecord(zone.name, { type: 'AAAA', name: 'www.example.test', address: '2001:0db8:0:0:0:0:0:1' }), isError(409, 'duplicate_record'));
  await store.createRecord(zone.name, { type: 'CNAME', name: 'alias.example.test', target: 'www.example.test' });
  await assert.rejects(store.createRecord(zone.name, { type: 'A', name: 'alias.example.test', address: '192.0.2.2' }), isError(409, 'cname_conflict'));
  await assert.rejects(store.createRecord(zone.name, { type: 'A', name: 'www.other.test', address: '192.0.2.2' }), isError(400));
  await assert.rejects(store.createRecord(zone.name, {
    type: 'SOA', name: 'example.test', primary: 'ns1.example.test', admin: 'hostmaster.example.test',
    serial: 2, refresh: 1, retry: 1, expiration: 1, minimum: 1,
  }), isError(400, 'validation_error'));
  await assert.rejects(store.deleteRecord(zone.name, soa(zone).id), isError(409, 'soa_required'));

  const ns = zone.records.filter((record) => record.type === 'NS');
  await store.deleteRecord(zone.name, ns[0].id);
  await assert.rejects(store.deleteRecord(zone.name, ns[1].id), isError(409, 'ns_required'));
  await store.deleteRecord(zone.name, a.id);
  await assert.rejects(store.deleteRecord(zone.name, a.id), isError(404, 'not_found'));
});

test('record patches preserve identity, validate the merged record, and support SOA edits', async () => {
  const store = new ZoneStore({ memory: true });
  const zone = await store.createZone({ name: 'example.test' });
  const a = await store.createRecord(zone.name, { type: 'A', name: 'www.example.test', address: '192.0.2.1' });
  const serialBefore = soa(store.getZone(zone.name)!).serial;
  const patched = await store.patchRecord(zone.name, a.id, { address: '192.0.2.2', ttl: 120 });
  assert.equal(patched.id, a.id);
  assert.equal(patched.createdAt, a.createdAt);
  assert.equal(patched.type, 'A');
  assert.equal(patched.type === 'A' && patched.address, '192.0.2.2');
  assert.equal(patched.ttl, 120);
  assert.equal(soa(store.getZone(zone.name)!).serial, serialBefore + 1);
  await assert.rejects(store.patchRecord(zone.name, a.id, { name: 'www.other.test' }), isError(400));
  await assert.rejects(store.patchRecord(zone.name, a.id, { priority: 10 }), isError(400));

  const current = soa(store.getZone(zone.name)!);
  const soaPatched = await store.patchRecord(zone.name, current.id, { serial: 42, refresh: 1800 });
  assert.equal(soaPatched.type === 'SOA' && soaPatched.serial, 42);
  assert.equal(soa(store.getZone(zone.name)!).serial, 42);
});

test('concurrent mutations are serialized without losing zones', async () => {
  const store = new ZoneStore({ memory: true });
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.createZone({ name: `zone-${index}.test` })));
  assert.equal(store.listZones().length, 20);
});

test('persistent store survives restart and leaves no temporary files', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.test-data-'));
  const file = join(directory, 'nested', 'synapsedns.json');
  try {
    const first = new ZoneStore({ filePath: file });
    await first.initialize();
    const zone = await first.createZone({ name: 'Example.Test' });
    await first.createRecord(zone.name, { type: 'A', name: 'www.example.test', address: '192.0.2.1' });
    await first.createRecord(zone.name, { type: 'TXT', name: 'txt.example.test', data: ['persisted'] });
    await first.close();

    const second = new ZoneStore({ filePath: file });
    const restored = second.getZone('example.test')!;
    assert.equal(restored.id, zone.id);
    assert.equal(restored.records.length, 5);
    assert.equal(restored.records.find((record) => record.type === 'A')?.name, 'www.example.test.');
    assert.deepEqual((await readFile(file, 'utf8')).includes('"version": 1'), true);
    assert.deepEqual(await readdir(join(directory, 'nested')), ['synapsedns.json']);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await second.deleteZone('example.test');
    assert.equal(new ZoneStore({ filePath: file }).listZones().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistence failures return 503 and make the store unready', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.test-data-'));
  const parent = join(directory, 'data');
  const file = join(parent, 'synapsedns.json');
  try {
    const store = new ZoneStore({ filePath: file });
    await store.initialize();
    await rm(parent, { recursive: true, force: true });
    await writeFile(parent, 'not-a-directory', 'utf8');
    await assert.rejects(store.createZone({ name: 'example.test' }), isError(503, 'store_unavailable'));
    assert.equal(store.isHealthy, false);
    await assert.rejects(store.createZone({ name: 'another.test' }), isError(503, 'store_unavailable'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt persistent state fails closed', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.test-data-'));
  const file = join(directory, 'synapsedns.json');
  try {
    await writeFile(file, '{"version":1,"zones":[{"name":"bad"}]}', 'utf8');
    assert.throws(() => new ZoneStore({ filePath: file }), isError(503, 'store_unavailable'));
    await writeFile(file, '{not json', 'utf8');
    assert.throws(() => new ZoneStore({ filePath: file }), isError(503, 'store_unavailable'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
