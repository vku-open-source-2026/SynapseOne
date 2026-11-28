// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { decodeBody, encodeBody } = require('../lib/tunnel/protocol');

const BIN = path.join(__dirname, '..', 'bin', 'synapseone.js');
const TOKEN = `st_${'z'.repeat(43)}`;
const WRONG_TOKEN = `st_${'y'.repeat(43)}`;
const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111';
const ACTUAL_ID = '22222222-2222-4222-8222-222222222222';
const WS_PATH = '/custom/tunnel/connect';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeHttp(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => socket.once('close', resolve));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
    socket.on('error', () => undefined);
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate, milliseconds = 4000, label = 'connector message') {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return withTimeout(new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const position = this.waiters.indexOf(waiter);
        if (position >= 0) this.waiters.splice(position, 1);
        reject(new Error(`Timed out waiting for ${label}`));
      }, milliseconds);
      this.waiters.push(waiter);
    }), milliseconds + 250, label);
  }

  waitForClose(milliseconds = 4000) {
    return withTimeout(this.closed, milliseconds, 'websocket close');
  }
}

function runCli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 5000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe('tunnel command offline validation', () => {
  it('documents the first-class command without requiring a token', async () => {
    const result = await runCli('tunnel', 'run', '--help');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /outbound-only/);
    assert.match(result.stdout, /--token-file/);
    assert.match(result.stdout, /SYNAPSETUNNEL_WS_PATH/);
    const global = await runCli('help');
    assert.equal(global.code, 0);
    assert.match(global.stdout, /tunnel run \[connector-id\]/);
  });

  it('fails before connecting when token, URL, or display id is invalid', async () => {
    const env = { ...process.env, SYNAPSETUNNEL_CONNECTOR_TOKEN: '', SYNAPSETUNNEL_TOKEN: '' };
    const missing = await new Promise((resolve) => {
      execFile(process.execPath, [BIN, 'tunnel', 'run'], { timeout: 5000, env }, (error, stdout, stderr) => {
        resolve({ code: error ? error.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /valid connector token/);

    const badUrl = await runCli('tunnel', 'run', '--token', TOKEN, '--server-url', 'file:///tmp/token');
    assert.equal(badUrl.code, 1);
    assert.match(badUrl.stderr, /Invalid connector server URL/);
    assert.equal(badUrl.stderr.includes(TOKEN), false);

    const badId = await runCli('tunnel', 'run', 'not-a-uuid', '--token', TOKEN);
    assert.equal(badId.code, 1);
    assert.match(badId.stderr, /Invalid connector id/);
    const unknown = await runCli('tunnel', 'run', '--bogus', '--token', TOKEN);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown tunnel option/);
  });
});

describe('tunnel real websocket integration', { timeout: 25000 }, () => {
  it('forwards, streams SSE, enforces limits, aborts, reconnects, and stops cleanly', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-integration-'));
    const tokenFile = path.join(directory, 'connector.token');
    fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    const upstreamRequests = [];
    const streams = new Map();
    let sseRelease;
    let sseEnded = false;
    let sseAborted = false;
    let sseTimeoutClosed;
    let holdSequence = 0;
    const holdClosed = new Map();

    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        upstreamRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url.startsWith('/prefix/sse')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.once('close', () => { if (!sseEnded) sseAborted = true; });
          res.write('data: first\n\n');
          if (req.url === '/prefix/sse') {
            sseRelease = () => {
              sseEnded = true;
              res.end('data: second\n\n');
            };
          }
          if (req.url === '/prefix/sse-timeout') {
            sseTimeoutClosed = new Promise((resolve) => res.once('close', resolve));
          }
          return;
        }
        if (req.url.startsWith('/prefix/hold')) {
          const key = req.url;
          holdClosed.set(key, new Promise((resolve) => res.on('close', resolve)));
          holdSequence += 1;
          streams.set(`hold-${holdSequence}`, key);
          return;
        }
        if (req.url === '/prefix/large') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.alloc(2048, 120));
          return;
        }
        if (req.url === '/prefix/redirect') {
          res.writeHead(302, { Location: 'http://127.0.0.1:1/never-follow' });
          res.end();
          return;
        }
        res.writeHead(201, {
          'Content-Type': 'application/octet-stream',
          'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'],
          Connection: 'x-hop',
          'X-Hop': 'remove',
          'X-Upstream': 'preserved',
        });
        res.end(body);
      });
    });
    const upstreamPort = await listen(upstream);

    const ingress = http.createServer((_req, res) => res.end('not a websocket'));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    const peers = [];
    const handshakes = [];
    ingress.on('upgrade', (req, socket, head) => {
      if (req.url !== WS_PATH || req.headers.authorization !== `Bearer ${TOKEN}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      handshakes.push({ path: req.url, authorization: req.headers.authorization });
      wss.handleUpgrade(req, socket, head, (ws) => {
        const peer = new Peer(ws);
        peers.push(peer);
        peer.send({
          type: 'welcome',
          protocolVersion: 1,
          connector: { id: ACTUAL_ID, name: 'stub', upstreamUrl: `http://127.0.0.1:${upstreamPort}/prefix` },
          limits: { maxRequestBytes: 1048576, maxResponseBytes: 1048576, maxConcurrentRequests: 1 },
        });
      });
    });
    const ingressPort = await listen(ingress);

    const childArgs = [
      BIN,
      'tunnel',
      'run',
      CONNECTOR_ID,
      '--token-file', tokenFile,
      '--server-url', `http://127.0.0.1:${ingressPort}`,
      '--reconnect-delay-ms', '100',
    ];
    const childEnv = {
      ...process.env,
      SYNAPSETUNNEL_CONNECTOR_TOKEN: WRONG_TOKEN,
      SYNAPSETUNNEL_SERVER_URL: 'http://127.0.0.1:1',
      SYNAPSETUNNEL_WS_PATH: WS_PATH,
      SYNAPSETUNNEL_LOG_LEVEL: 'info',
    };
    const spawnConnector = () => spawn(process.execPath, childArgs, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = spawnConnector();
    let logs = '';
    let interruptChild;
    let interruptLogs = '';
    child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
    child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    const stopChild = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const result = await withTimeout(exited, 3500, 'connector process exit');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return result;
    };

    try {
      await withTimeout((async () => {
        while (peers.length < 1) await delay(10);
      })(), 4000, 'first websocket welcome');
      const first = peers[0];
      assert.deepEqual(handshakes[0], { path: WS_PATH, authorization: `Bearer ${TOKEN}` });

      const startRequest = (peer, requestPath, options = {}) => {
        const requestId = randomUUID();
        const body = options.body || Buffer.alloc(0);
        const method = options.method || (body.length ? 'POST' : 'GET');
        peer.send({
          type: 'request',
          requestId,
          method,
          path: requestPath,
          headers: options.headers || {},
          bodyLength: body.length,
          timeoutMs: options.timeoutMs || 5000,
          maxResponseBytes: options.maxResponseBytes || 1048576,
        });
        for (let offset = 0; offset < body.length; offset += 65536) {
          peer.send({
            type: 'request_body',
            requestId,
            data: encodeBody(body.subarray(offset, offset + 65536)),
            final: offset + 65536 >= body.length,
          });
        }
        return requestId;
      };
      const responseFor = (peer, id) => peer.waitFor((message) => message.requestId === id && message.type === 'response', 4000, `response ${id}`);
      const errorFor = (peer, id) => peer.waitFor((message) => message.requestId === id && message.type === 'response_error', 4000, `response error ${id}`);
      const chunksFor = async (peer, id) => {
        const chunks = [];
        for (;;) {
          const message = await peer.waitFor((item) => item.requestId === id && item.type === 'response_chunk', 4000, `response chunk ${id}`);
          if (message.data) chunks.push(decodeBody(message.data));
          if (message.final) return { body: Buffer.concat(chunks), error: message.error };
        }
      };

      // Binary request bodies span multiple protocol chunks; framing, hop, and
      // spoofed tenant headers must not reach the local upstream.
      const binary = Buffer.alloc(150000);
      for (let index = 0; index < binary.length; index += 1) binary[index] = index % 256;
      const postId = startRequest(first, '/echo?x=1&y=two', {
        body: binary,
        headers: {
          'content-type': ['application/octet-stream'],
          'content-length': [String(binary.length)],
          host: ['spoof.invalid'],
          connection: ['x-hop'],
          'x-hop': ['remove'],
          'x-synapseone-account': ['spoof'],
          'x-end-to-end': ['keep'],
          'accept-encoding': ['gzip'],
        },
      });
      const postResponse = await responseFor(first, postId);
      const postResult = await chunksFor(first, postId);
      assert.equal(postResponse.status, 201);
      assert.deepEqual(postResult.body, binary);
      assert.equal(postResult.error, undefined);
      assert.deepEqual(postResponse.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
      assert.deepEqual(postResponse.headers['x-upstream'], ['preserved']);
      assert.equal(postResponse.headers['x-hop'], undefined);
      assert.equal(postResponse.headers['content-length'], undefined);
      const seen = upstreamRequests.find((item) => item.url === '/prefix/echo?x=1&y=two');
      assert.equal(seen.method, 'POST');
      assert.deepEqual(seen.body, binary);
      assert.equal(seen.headers.host, `127.0.0.1:${upstreamPort}`);
      assert.equal(seen.headers['accept-encoding'], 'identity');
      assert.equal(seen.headers['x-end-to-end'], 'keep');
      assert.equal(seen.headers['x-hop'], undefined);
      assert.equal(seen.headers['x-synapseone-account'], undefined);

      // The first SSE event must arrive while the upstream is still open.
      const sseId = startRequest(first, '/sse', { timeoutMs: 1000 });
      const sseResponse = await responseFor(first, sseId);
      assert.equal(sseResponse.headers['content-type'][0], 'text/event-stream');
      const sseFirst = await first.waitFor((message) => message.requestId === sseId && message.type === 'response_chunk');
      assert.equal(decodeBody(sseFirst.data).toString(), 'data: first\n\n');
      assert.equal(sseFirst.final, false);
      assert.equal(sseEnded, false);
      await delay(1200);
      assert.equal(sseAborted, false, 'stream must continue after the upstream-header timeout');
      sseRelease();
      const sseRest = await chunksFor(first, sseId);
      assert.equal(sseRest.body.toString(), 'data: second\n\n');
      assert.equal(sseRest.error, undefined);

      // Redirects remain visible to the public client rather than being followed.
      const redirectId = startRequest(first, '/redirect');
      assert.equal((await responseFor(first, redirectId)).status, 302);
      assert.equal((await chunksFor(first, redirectId)).body.length, 0);

      // Abort a started upstream request and keep the multiplex usable.
      const abortId = startRequest(first, '/hold?abort');
      await withTimeout((async () => {
        while (!upstreamRequests.some((item) => item.url === '/prefix/hold?abort')) await delay(10);
      })(), 3000, 'aborted upstream start');
      first.send({ type: 'request_abort', requestId: abortId });
      await withTimeout(holdClosed.get('/prefix/hold?abort'), 3000, 'aborted upstream close');
      await assert.rejects(() => first.waitFor((message) => message.requestId === abortId, 150, 'late aborted response'), /Timed out/);
      const afterAbort = startRequest(first, '/echo');
      assert.equal((await responseFor(first, afterAbort)).status, 201);
      await chunksFor(first, afterAbort);

      // Concurrency is bounded by welcome.limits, even for a second empty body.
      const busyHold = startRequest(first, '/hold?busy');
      await withTimeout((async () => {
        while (!upstreamRequests.some((item) => item.url === '/prefix/hold?busy')) await delay(10);
      })(), 3000, 'busy upstream start');
      const busyId = startRequest(first, '/echo');
      assert.deepEqual(await errorFor(first, busyId), { type: 'response_error', requestId: busyId, status: 503, code: 'connector_busy' });
      first.send({ type: 'request_abort', requestId: busyHold });
      await withTimeout(holdClosed.get('/prefix/hold?busy'), 3000, 'busy upstream close');

      // The route timeout covers connection + response headers. An established
      // SSE stream stays open until the client aborts, even after that deadline.
      const streamTimeoutId = startRequest(first, '/sse-timeout', { timeoutMs: 150 });
      await responseFor(first, streamTimeoutId);
      const streamFirst = await first.waitFor((message) => message.requestId === streamTimeoutId && message.type === 'response_chunk');
      assert.equal(decodeBody(streamFirst.data).toString(), 'data: first\n\n');
      await delay(250);
      await assert.rejects(() => first.waitFor((message) => message.requestId === streamTimeoutId && message.type === 'response_chunk' && message.final, 150, 'late stream final'), /Timed out/);
      first.send({ type: 'request_abort', requestId: streamTimeoutId });
      await withTimeout(sseTimeoutClosed, 3000, 'aborted SSE upstream close');

      const timeoutId = startRequest(first, '/hold?timeout', { timeoutMs: 100 });
      const timeoutError = await errorFor(first, timeoutId);
      assert.equal(timeoutError.status, 504);
      assert.equal(timeoutError.code, 'upstream_timeout');

      // A route response limit ends only that response with an explicit error.
      const largeId = startRequest(first, '/large', { maxResponseBytes: 1024 });
      await responseFor(first, largeId);
      const largeResult = await chunksFor(first, largeId);
      assert.equal(largeResult.error, 'response_too_large');
      assert.ok(largeResult.body.length <= 1024);

      // A server-side disconnect triggers authenticated exponential-backoff
      // reconnect; the next connection can immediately forward again.
      first.socket.close(1001, 'test reconnect');
      await first.waitForClose();
      await withTimeout((async () => {
        while (peers.length < 2) await delay(10);
      })(), 4000, 'reconnect');
      const second = peers[1];
      assert.equal(handshakes.length, 2);
      assert.equal(handshakes[1].authorization, `Bearer ${TOKEN}`);
      const reconnectId = startRequest(second, '/echo?reconnected=yes');
      assert.equal((await responseFor(second, reconnectId)).status, 201);
      assert.equal((await chunksFor(second, reconnectId)).body.length, 0);

      // A body chunk larger than its declared length is a protocol violation,
      // not a partially forwarded upstream request.
      const oversizedId = randomUUID();
      second.send({
        type: 'request', requestId: oversizedId, method: 'POST', path: '/echo', headers: {},
        bodyLength: 10, timeoutMs: 5000, maxResponseBytes: 1048576,
      });
      second.send({ type: 'request_body', requestId: oversizedId, data: encodeBody(Buffer.alloc(20)), final: true });
      assert.equal(await second.waitForClose(), 1008);
      await withTimeout((async () => {
        while (peers.length < 3) await delay(10);
      })(), 4000, 'protocol-error reconnect');
      const third = peers[2];
      assert.equal(handshakes.length, 3);

      // Abort while receiving a body: no upstream request may be started.
      const pendingId = randomUUID();
      third.send({
        type: 'request', requestId: pendingId, method: 'POST', path: '/hold?never-started', headers: {},
        bodyLength: 10, timeoutMs: 5000, maxResponseBytes: 1048576,
      });
      third.send({ type: 'request_body', requestId: pendingId, data: encodeBody(Buffer.from('abc')), final: false });
      third.send({ type: 'request_abort', requestId: pendingId });
      const afterPendingAbort = startRequest(third, '/echo');
      assert.equal((await responseFor(third, afterPendingAbort)).status, 201);
      await chunksFor(third, afterPendingAbort);
      assert.equal(upstreamRequests.some((item) => item.url === '/prefix/hold?never-started'), false);

      const result = await stopChild();
      assert.deepEqual(result, { code: 0, signal: null });
      await third.waitForClose(3000);
      assert.equal(logs.includes(TOKEN), false);
      assert.equal(logs.includes(WRONG_TOKEN), false);
      assert.equal(logs.includes(CONNECTOR_ID), true, 'display id should be logged');
      assert.equal(logs.includes(ACTUAL_ID), true, 'server connector id should be logged');
      assert.equal(logs.includes('tunnel_stopped'), true);
      assert.ok(streams.size >= 3);

      // SIGINT uses the same clean shutdown path as SIGTERM.
      interruptChild = spawnConnector();
      interruptChild.stdout.on('data', (chunk) => { interruptLogs += chunk.toString(); });
      interruptChild.stderr.on('data', (chunk) => { interruptLogs += chunk.toString(); });
      const interruptExit = new Promise((resolve) => interruptChild.once('exit', (code, signal) => resolve({ code, signal })));
      await withTimeout((async () => {
        while (peers.length < 4) await delay(10);
      })(), 4000, 'SIGINT connector welcome');
      interruptChild.kill('SIGINT');
      assert.deepEqual(await withTimeout(interruptExit, 3500, 'SIGINT connector exit'), { code: 0, signal: null });
      await peers[3].waitForClose(3000);
      assert.equal(interruptLogs.includes(TOKEN), false);
      assert.equal(interruptLogs.includes('tunnel_stopped'), true);
    } catch (error) {
      const safeLogs = `${logs}\n${interruptLogs}`.replaceAll(TOKEN, '[redacted]').replaceAll(WRONG_TOKEN, '[redacted]');
      process.stderr.write(`${safeLogs}\n`);
      throw error;
    } finally {
      await stopChild();
      if (interruptChild && interruptChild.exitCode === null && interruptChild.signalCode === null) {
        interruptChild.kill('SIGKILL');
      }
      for (const peer of peers) peer.socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await closeHttp(ingress);
      await closeHttp(upstream);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
