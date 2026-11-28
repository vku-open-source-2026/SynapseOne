// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  BODY_CHUNK_BYTES,
  ProtocolError,
  decodeBody,
  encodeBody,
  parseServerMessage,
} = require('../lib/tunnel/protocol');
const {
  normalizeUpstreamUrl,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  upstreamTarget,
} = require('../lib/tunnel/validation');
const { requestHeaders, responseHeaders } = require('../lib/tunnel/http');

const ID = '11111111-1111-4111-8111-111111111111';

function welcome(extra = {}) {
  return {
    type: 'welcome',
    protocolVersion: 1,
    connector: { id: ID, name: 'local', upstreamUrl: 'http://127.0.0.1:3000/base' },
    limits: { maxRequestBytes: 10485760, maxResponseBytes: 16777216, maxConcurrentRequests: 10 },
    ...extra,
  };
}

function request(extra = {}) {
  return {
    type: 'request',
    requestId: ID,
    method: 'POST',
    path: '/echo?x=1',
    headers: { 'content-type': ['application/octet-stream'] },
    bodyLength: 3,
    timeoutMs: 1000,
    maxResponseBytes: 4096,
    ...extra,
  };
}

function parse(value) {
  return parseServerMessage(JSON.stringify(value));
}

describe('tunnel protocol v1', () => {
  it('parses welcome, request, body chunks, and abort messages', () => {
    assert.equal(parse(welcome()).protocolVersion, 1);
    assert.equal(parse(request()).requestId, ID);
    assert.deepEqual(decodeBody(parse({ type: 'request_body', requestId: ID, data: encodeBody(Buffer.from('abc')), final: true }).data), Buffer.from('abc'));
    assert.equal(parse({ type: 'request_abort', requestId: ID }).type, 'request_abort');
  });

  it('round-trips binary bodies with canonical base64url and fixed-size chunks', () => {
    const bytes = Buffer.alloc(BODY_CHUNK_BYTES + 17);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const encoded = [];
    for (let offset = 0; offset < bytes.length; offset += BODY_CHUNK_BYTES) {
      const chunk = encodeBody(bytes.subarray(offset, offset + BODY_CHUNK_BYTES));
      assert.ok(chunk.length <= 87400);
      assert.match(chunk, /^[A-Za-z0-9_-]+$/);
      encoded.push(decodeBody(chunk));
    }
    assert.deepEqual(Buffer.concat(encoded), bytes);
    assert.deepEqual(decodeBody(''), Buffer.alloc(0));
    for (const invalid of ['A', 'abc=', 'a+b', 'ab\n', 'Zh']) {
      assert.throws(() => decodeBody(invalid), ProtocolError, invalid);
    }
  });

  it('rejects malformed JSON, binary-era text, unknown types, and extra fields', () => {
    assert.throws(() => parseServerMessage('{'), ProtocolError);
    assert.throws(() => parse({ type: 'unknown' }), ProtocolError);
    assert.throws(() => parse(welcome({ extra: true })), ProtocolError);
    assert.throws(() => parse(request({ extra: true })), ProtocolError);
    assert.throws(() => parse({ type: 'request_abort', requestId: ID, extra: true }), ProtocolError);
    assert.throws(() => parse({ type: 'request_body', requestId: ID, data: '', final: true, extra: true }), ProtocolError);
  });

  it('strictly validates welcome versions, upstream URLs, and limits', () => {
    assert.throws(() => parse(welcome({ protocolVersion: 2 })), /Unsupported protocol version/);
    assert.throws(() => parse(welcome({ connector: { id: ID, name: 'x', upstreamUrl: 'file:///etc/passwd' } })), /Invalid upstream URL/);
    assert.throws(() => parse(welcome({ limits: { maxRequestBytes: 1, maxResponseBytes: 1024, maxConcurrentRequests: 1 } })), /Invalid welcome limits/);
    assert.throws(() => parse(welcome({ connector: { ...welcome().connector, id: 'bad' } })), /Invalid welcome/);
  });

  it('validates request identity, method, path, body, timeout, and response limit', () => {
    for (const extra of [
      { requestId: 'bad' },
      { method: 'connect' },
      { method: 'CONNECT' },
      { method: 'GET TOO LONG FOR A METHOD' },
      { path: 'relative' },
      { path: '/bad\r\npath' },
      { bodyLength: -1 },
      { timeoutMs: 99 },
      { maxResponseBytes: 1023 },
    ]) {
      assert.throws(() => parse(request(extra)), ProtocolError, JSON.stringify(extra));
    }
    assert.throws(() => parse(request({ bodyLength: 0, headers: { Host: ['x'] } })), /Invalid headers/);
  });

  it('enforces the header count, value count, and aggregate byte budgets', () => {
    const tooManyValues = { x: Array.from({ length: 33 }, () => 'v') };
    assert.throws(() => parse(request({ headers: tooManyValues })), /Invalid headers/);
    const tooManyHeaders = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`x-${index}`, ['v']]));
    assert.throws(() => parse(request({ headers: tooManyHeaders })), /Too many headers/);
    const tooLarge = { x: ['x'.repeat(16385)] };
    assert.throws(() => parse(request({ headers: tooLarge })), /Invalid headers/);
    const aggregate = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`x-${index}`, ['x'.repeat(16384)]]));
    assert.throws(() => parse(request({ headers: aggregate })), /Headers too large/);
    assert.throws(() => parse(request({ headers: { x: ['bad\nvalue'] } })), /Invalid headers/);
  });
});

describe('tunnel HTTP validation and header handling', () => {
  it('allows only credential-free HTTP(S) upstream URLs', () => {
    assert.equal(normalizeUpstreamUrl('https://example.test/base'), 'https://example.test/base');
    for (const value of ['file:///etc/passwd', 'https://u:p@example.test', 'http://bad_host', 'https://example.test/?q=x', 'https://example.test/#x', 'https://example.test/%0a']) {
      assert.throws(() => normalizeUpstreamUrl(value), /Invalid upstream URL/, value);
    }
  });

  it('joins upstream prefixes without allowing scheme-relative host changes', () => {
    assert.equal(upstreamTarget('http://127.0.0.1:3000/base/', '/echo?x=1'), 'http://127.0.0.1:3000/base/echo?x=1');
    assert.equal(upstreamTarget('http://127.0.0.1:3000/', '//evil.invalid/path'), 'http://127.0.0.1:3000//evil.invalid/path');
  });

  it('strips hop-by-hop, connection-nominated, framing, and spoofed tenant headers', () => {
    const input = {
      host: ['evil.test'],
      'content-length': ['999'],
      connection: ['x-hop, x-synapseone-account'],
      'x-hop': ['remove'],
      'x-synapseone-account': ['spoof'],
      'x-synapsedx-org': ['spoof'],
      'x-forwarded-host': ['public.test'],
      'x-end-to-end': ['keep'],
      'x-multi': ['a', 'b'],
    };
    assert.deepEqual(sanitizeRequestHeaders(input, true), {
      'x-forwarded-host': ['public.test'],
      'x-end-to-end': ['keep'],
      'x-multi': ['a', 'b'],
    });
    assert.deepEqual(sanitizeRequestHeaders(input, false), {
      'x-end-to-end': ['keep'],
      'x-multi': ['a', 'b'],
    });
  });

  it('removes stale response framing/encoding and connection-nominated headers', () => {
    assert.deepEqual(sanitizeResponseHeaders({
      'content-length': ['10'],
      'content-encoding': ['gzip'],
      connection: ['x-hop'],
      'x-hop': ['remove'],
      'set-cookie': ['a=1', 'b=2'],
      'x-end-to-end': ['keep'],
    }), {
      'set-cookie': ['a=1', 'b=2'],
      'x-end-to-end': ['keep'],
    });
  });

  it('builds fetch headers with the real upstream host and identity encoding', () => {
    const headers = requestHeaders({ host: ['spoof'], 'accept-encoding': ['gzip'], 'x-test': ['yes'] }, new URL('http://127.0.0.1:3000'));
    assert.equal(headers.get('host'), '127.0.0.1:3000');
    assert.equal(headers.get('accept-encoding'), 'identity');
    assert.equal(headers.get('x-test'), 'yes');
  });

  it('preserves multiple Set-Cookie values from Node fetch headers', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    headers.set('content-length', '4');
    assert.deepEqual(responseHeaders(headers), { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
  });
});
