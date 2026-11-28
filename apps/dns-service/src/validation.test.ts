// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from './errors';
import type { DnsRecord } from './types';
import {
  assertRecordSetValid,
  normalizeDnsName,
  normalizeZoneName,
  parseCreateZoneInput,
  parseRecordInput,
  parseRecordPatch,
} from './validation';

function expectError(fn: () => unknown, status: number, code?: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

function record(input: unknown, id = '00000000-0000-4000-8000-000000000001'): DnsRecord {
  return {
    ...parseRecordInput(input, 'example.test.'),
    ttl: 300,
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as DnsRecord;
}

test('DNS names are absolute, lower-case, and length limited', () => {
  assert.equal(normalizeZoneName('ExAmPlE.TEST'), 'example.test.');
  assert.equal(normalizeDnsName('_sip._TCP.Example.Test', { underscores: true }), '_sip._tcp.example.test.');
  assert.equal(normalizeDnsName('*.Example.Test', { wildcard: true, underscores: true }), '*.example.test.');
  assert.equal(normalizeDnsName('.', { root: true }), '.');
  expectError(() => normalizeZoneName('localhost'), 400);
  expectError(() => normalizeZoneName('*.example.test'), 400);
  expectError(() => normalizeDnsName('bad..example.test'), 400);
  expectError(() => normalizeDnsName('-bad.example.test'), 400);
  expectError(() => normalizeDnsName('bad-.example.test'), 400);
  expectError(() => normalizeDnsName('bad_name.example.test'), 400);
  expectError(() => normalizeDnsName('x.*.example.test', { wildcard: true }), 400);
  expectError(() => normalizeDnsName(`${'a'.repeat(64)}.example.test`), 400);
  expectError(() => normalizeDnsName(`${Array.from({ length: 4 }, () => 'a'.repeat(63)).join('.')}.example.test`), 400);
});

test('zone creation validates nameservers and TTL', () => {
  assert.deepEqual(parseCreateZoneInput({ name: 'Example.Test', nameservers: ['NS1.Example.Test'] }), {
    name: 'example.test.', nameservers: ['ns1.example.test.'], ttl: undefined,
  });
  expectError(() => parseCreateZoneInput({ name: 'example.test', ttl: -1 }), 400);
  expectError(() => parseCreateZoneInput({ name: 'example.test', ttl: 0x80000000 }), 400);
  expectError(() => parseCreateZoneInput({ name: 'example.test', nameservers: [] }), 400);
  expectError(() => parseCreateZoneInput({ name: 'example.test', extra: true }), 400);
});

test('all supported record types normalize and validate their RDATA', () => {
  assert.equal(parseRecordInput({ type: 'A', name: 'WWW.Example.Test', address: '192.0.2.1' }, 'example.test.').name, 'www.example.test.');
  assert.equal((parseRecordInput({ type: 'AAAA', name: 'www.example.test', address: '2001:DB8::1' }, 'example.test.') as { address: string }).address, '2001:db8::1');
  assert.equal((parseRecordInput({ type: 'AAAA', name: 'www.example.test', address: '2001:0db8:0:0:0:0:0:1' }, 'example.test.') as { address: string }).address, '2001:db8::1');
  assert.equal((parseRecordInput({ type: 'MX', name: 'example.test', priority: 10, target: 'MAIL.Example.Test' }, 'example.test.') as { target: string }).target, 'mail.example.test.');
  assert.equal((parseRecordInput({ type: 'SRV', name: '_sip._tcp.example.test', priority: 1, weight: 2, port: 5060, target: '.' }, 'example.test.') as { target: string }).target, '.');
  assert.deepEqual((parseRecordInput({ type: 'TXT', name: 'txt.example.test', data: 'hello' }, 'example.test.') as { data: string[] }).data, ['hello']);
  assert.equal((parseRecordInput({ type: 'CAA', name: 'example.test', flags: 0, tag: 'ISSUE', value: 'letsencrypt.org' }, 'example.test.') as { tag: string }).tag, 'issue');
  assert.equal(parseRecordInput({ type: 'PTR', name: 'ptr.example.test', target: 'www.example.test' }, 'example.test.').type, 'PTR');

  expectError(() => parseRecordInput({ type: 'A', name: 'www.example.test', address: '999.1.1.1' }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'AAAA', name: 'www.example.test', address: '192.0.2.1' }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'MX', name: 'example.test', priority: 65536, target: 'mail.example.test' }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'TXT', name: 'txt.example.test', data: ['x'.repeat(256)] }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'TXT', name: 'txt.example.test', data: ['bad\u0000text'] }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'CAA', name: 'example.test', flags: 0, tag: 'bad_tag', value: 'x' }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'CAA', name: 'example.test', flags: 0, tag: 'issue', value: 'é'.repeat(128) }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'SOA', name: 'www.example.test', primary: 'ns1.example.test', admin: 'hostmaster.example.test', serial: 1, refresh: 1, retry: 1, expiration: 1, minimum: 1 }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'HTTPS', name: 'www.example.test' }, 'example.test.'), 400);
});

test('record owners cannot escape their zone and patches cannot be empty', () => {
  expectError(() => parseRecordInput({ type: 'A', name: 'www.other.test', address: '192.0.2.1' }, 'example.test.'), 400);
  expectError(() => parseRecordInput({ type: 'A', name: 'badexample.test', address: '192.0.2.1' }, 'example.test.'), 400);
  expectError(() => parseRecordPatch({}), 400);
  expectError(() => parseRecordPatch({ type: 'A', address: '192.0.2.1' }), 400);
  expectError(() => parseRecordPatch({ ttl: 1.5 }), 400);
});

test('duplicate and CNAME conflict checks are case-normalized and ignore TTL', () => {
  const a = record({ type: 'A', name: 'www.example.test', address: '192.0.2.1', ttl: 60 });
  const duplicate = record({ type: 'A', name: 'WWW.EXAMPLE.TEST', address: '192.0.2.1', ttl: 300 }, '00000000-0000-4000-8000-000000000002');
  expectError(() => assertRecordSetValid('example.test.', [a, duplicate]), 409, 'duplicate_record');
  const cname = record({ type: 'CNAME', name: 'www.example.test', target: 'other.example.test' }, '00000000-0000-4000-8000-000000000003');
  expectError(() => assertRecordSetValid('example.test.', [a, cname]), 409, 'cname_conflict');
});

test('CNAME loops are rejected while external targets are allowed', () => {
  const a = record({ type: 'CNAME', name: 'a.example.test', target: 'b.example.test' });
  const b = record({ type: 'CNAME', name: 'b.example.test', target: 'a.example.test' }, '00000000-0000-4000-8000-000000000002');
  expectError(() => assertRecordSetValid('example.test.', [a, b]), 409, 'cname_loop');
  const external = record({ type: 'CNAME', name: 'a.example.test', target: 'www.external.test' });
  assert.doesNotThrow(() => assertRecordSetValid('example.test.', [external]));
});
