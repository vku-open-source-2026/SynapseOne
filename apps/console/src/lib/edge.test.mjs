// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absoluteRecordName, addressRecordConflict, buildRecordInput, connectorScript,
  edgePath, normalizeHostname, publicHostname, recordValue, shellQuote, zoneForHostname,
} from './edge.js';
import { EDGE_COPY } from './edge-i18n.js';

function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
  return typeof value;
}

test('edge management paths stay inside the platform namespace', () => {
  assert.equal(edgePath('dns', '/v1/zones'), '/v1/platform/edge/dns/v1/zones');
  assert.equal(edgePath('tunnel', 'v1/routes'), '/v1/platform/edge/tunnel/v1/routes');
  assert.throws(() => edgePath('iam'), /Unknown edge service/);
});

test('hostnames and zones normalize safely and choose the longest matching zone', () => {
  assert.equal(normalizeHostname(' App.Example.COM. '), 'app.example.com');
  assert.throws(() => normalizeHostname('https://app.example.com'), /fully-qualified/);
  assert.throws(() => normalizeHostname('*.example.com'), /fully-qualified/);
  const zones = [{ name: 'com.' }, { name: 'example.com.' }, { name: 'city.example.com.' }];
  assert.equal(zoneForHostname('APP.CITY.EXAMPLE.COM', zones), 'city.example.com');
  assert.equal(zoneForHostname('other.test', zones), null);
  assert.equal(publicHostname('https://tunnel.example.com:443/'), 'tunnel.example.com');
  assert.equal(publicHostname('not a url'), '');
});

test('record names become canonical FQDNs without escaping the selected zone', () => {
  assert.equal(absoluteRecordName('@', 'example.com.'), 'example.com.');
  assert.equal(absoluteRecordName('www', 'example.com.'), 'www.example.com.');
  assert.equal(absoluteRecordName('API.example.com.', 'example.com.'), 'api.example.com.');
});

test('record inputs cover address, alias, mail, text and service records', () => {
  assert.deepEqual(buildRecordInput({ type: 'A', name: 'www', value: '192.0.2.10', ttl: '60' }, 'example.com'), {
    type: 'A', name: 'www.example.com.', ttl: 60, address: '192.0.2.10',
  });
  assert.deepEqual(buildRecordInput({ type: 'CNAME', name: '@', value: 'edge.example.net', ttl: '' }, 'example.com'), {
    type: 'CNAME', name: 'example.com.', ttl: 300, target: 'edge.example.net',
  });
  assert.deepEqual(buildRecordInput({ type: 'MX', name: '@', value: '10 mail.example.com', ttl: '300' }, 'example.com'), {
    type: 'MX', name: 'example.com.', ttl: 300, priority: 10, target: 'mail.example.com',
  });
  assert.deepEqual(buildRecordInput({ type: 'TXT', name: '@', value: 'one\ntwo', ttl: '300' }, 'example.com').data, ['one', 'two']);
  assert.deepEqual(buildRecordInput({ type: 'SRV', name: '_https._tcp', value: '10 5 443 app.example.com', ttl: '300' }, 'example.com'), {
    type: 'SRV', name: '_https._tcp.example.com.', ttl: 300, priority: 10, weight: 5, port: 443, target: 'app.example.com',
  });
  assert.throws(() => buildRecordInput({ type: 'A', name: '@', value: '', ttl: '300' }, 'example.com'), /required/);
});

test('address conflicts are idempotent only for the same type and target', () => {
  const records = [{ type: 'CNAME', name: 'app.example.com.', target: 'Edge.Example.net.' }];
  assert.equal(addressRecordConflict(records, 'APP.EXAMPLE.COM.', 'CNAME', 'edge.example.net'), 'same');
  assert.equal(addressRecordConflict(records, 'app.example.com.', 'CNAME', 'other.example.net'), 'conflict');
  assert.equal(addressRecordConflict(records, 'app.example.com.', 'A', '192.0.2.10'), 'conflict');
  assert.equal(addressRecordConflict(records, 'new.example.com.', 'A', '192.0.2.10'), null);
});

test('record rendering and shell quoting do not expose malformed control data', () => {
  assert.equal(recordValue({ type: 'MX', priority: 10, target: 'mail.example.com' }), '10 mail.example.com');
  assert.equal(recordValue({ type: 'TXT', data: ['one', 'two'] }), 'one\ntwo');
  assert.equal(shellQuote('safe-value'), 'safe-value');
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  const script = connectorScript('123e4567-e89b-12d3-a456-426614174000', 'https://tunnel.example.com/');
  assert.match(script, /synapseone tunnel run 123e4567-e89b-12d3-a456-426614174000 --server-url https:\/\/tunnel\.example\.com/);
  assert.match(script, /read -rsp/);
  assert.doesNotMatch(script, /st_[A-Za-z0-9_-]/);
  assert.throws(() => connectorScript('bad', 'https://tunnel.example.com'), /Invalid connector/);
  assert.throws(() => connectorScript('123e4567-e89b-12d3-a456-426614174000', 'https://user:pass@example.com'), /public ingress/);
});

test('edge UI copy keeps English and Vietnamese key parity', () => {
  assert.deepEqual(shape(EDGE_COPY.en), shape(EDGE_COPY.vi));
});
