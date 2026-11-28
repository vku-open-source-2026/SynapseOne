// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import WebSocket from 'ws';
import type { ServerConfig } from './config';
import { startTunnelService, type TunnelService } from './server';

const ADMIN_TOKEN = 'integration-admin-token-not-for-production';
const SERVICE_ROOT = resolve(__dirname, '..');
let temporaryCounter = 0;

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    mode: 'combined', isProduction: false, host: '127.0.0.1', apiPort: 0, ingressPort: 0,
    adminToken: ADMIN_TOKEN, allowInsecure: false, dataFile: null,
    wsPath: '/_synapse/tunnel/connect', wsMaxPayloadBytes: 1048576,
    maxRequestBytes: 1048576, maxResponseBytes: 1048576, requestTimeoutMs: 2000,
    maxConcurrentRequests: 100, defaultRateLimitPerMinute: 0,
    heartbeatIntervalMs: 1000, maxBufferedAmount: 4194304,
    trustProxy: false, publicScheme: 'http', logLevel: 'error',
    ...overrides,
  };
}

async function tempDirectory(t: TestContext): Promise<string> {
  const root = join(SERVICE_ROOT, '.test-tmp');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(root, { recursive: true }));
  const directory = await mkdtemp(join(root, `run-${process.pid}-${temporaryCounter++}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startService(t: TestContext, overrides: Partial<ServerConfig> = {}): Promise<TunnelService> {
  const service = await startTunnelService(config(overrides));
  t.after(async () => { await service.close(); });
  return service;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for condition');
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

interface UpstreamState {
  active: number;
  maxActive: number;
  releaseStream?: () => void;
  releaseSse?: () => void;
  streamStarted?: () => void;
  sseStarted?: () => void;
}

async function startUpstream(t: TestContext): Promise<{ server: Server; url: string; state: UpstreamState }> {
  const state: UpstreamState = { active: 0, maxActive: 0 };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://upstream');
      if (url.pathname === '/concurrent') {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await delay(Number(url.searchParams.get('ms') ?? 50));
        state.active -= 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ index: url.searchParams.get('index'), active: state.active }));
        return;
      }
      if (url.pathname === '/slow') {
        await delay(500);
        res.end('slow response');
        return;
      }
      if (url.pathname === '/stream') {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-stream': 'yes' });
        res.write('first-');
        state.streamStarted?.();
        await new Promise<void>((resolveStream) => { state.releaseStream = resolveStream; });
        res.end('second');
        return;
      }
      if (url.pathname === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: first\n\n');
        state.sseStarted?.();
        await new Promise<void>((resolveSse) => { state.releaseSse = resolveSse; });
        res.end('data: second\n\n');
        return;
      }
      if (url.pathname === '/large') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(4096, 120));
        return;
      }
      if (url.pathname === '/headers') {
        res.writeHead(201, {
          'content-type': 'text/plain', 'x-upstream': 'preserved',
          'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
          connection: 'x-hop-response', 'x-hop-response': 'remove',
        });
        res.end('headers');
        return;
      }
      if (url.pathname === '/status') {
        res.writeHead(418, { 'content-type': 'text/plain' });
        res.end('teapot');
        return;
      }
      const body = await bodyOf(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body.toString('base64'),
      }));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert(address && typeof address !== 'string');
  t.after(() => { state.releaseStream?.(); state.releaseSse?.(); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });
  return { server, url: `http://127.0.0.1:${address.port}`, state };
}

async function admin(service: TunnelService, path: string, init: RequestInit = {}, token: string | null = ADMIN_TOKEN): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(`${service.apiUrl}${path}`, { ...init, headers });
}

async function createConnector(service: TunnelService, upstreamUrl: string): Promise<{ id: string; token: string }> {
  const response = await admin(service, '/v1/connectors', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test connector', upstreamUrl }),
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as { connector: { id: string }; token: string };
  assert.match(payload.token, /^st_[A-Za-z0-9_-]{43}$/);
  return { id: payload.connector.id, token: payload.token };
}

async function createRoute(service: TunnelService, connectorId: string, hostname: string, pathPrefix = '', extra: Record<string, unknown> = {}): Promise<string> {
  const response = await admin(service, '/v1/routes', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname, pathPrefix, connectorId, ...extra }),
  });
  if (response.status !== 201) throw new Error(`Route creation failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { route: { id: string } };
  return payload.route.id;
}

function ingressUrl(service: TunnelService, hostname: string, path: string): string {
  return `${service.ingressUrl}${path}`;
}

function ingressFetch(service: TunnelService, hostname: string, path: string, init: RequestInit = {}): Promise<Response> {
  return new Promise<Response>((resolveFetch, rejectFetch) => {
    const url = new URL(ingressUrl(service, hostname, path));
    const headers = new Headers(init.headers);
    headers.set('host', hostname);
    const request = httpRequest(url, { method: init.method ?? 'GET', headers: Object.fromEntries(headers.entries()) }, (response) => {
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      const noBody = init.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304;
      resolveFetch(new Response(noBody ? null : Readable.toWeb(response) as unknown as BodyInit, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.once('error', rejectFetch);
    if (init.signal) init.signal.addEventListener('abort', () => request.destroy(), { once: true });
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') request.write(init.body);
      else if (init.body instanceof Uint8Array) request.write(init.body);
      else if (init.body instanceof ArrayBuffer) request.write(Buffer.from(init.body));
      else throw new Error('Unsupported test request body');
    }
    request.end();
  });
}

interface RunningConnector {
  child: ChildProcess;
  readonly logs: string;
  stop: () => Promise<void>;
}

async function startConnector(t: TestContext, service: TunnelService, token: string): Promise<RunningConnector> {
  const child = spawn(process.execPath, [join(__dirname, 'connector.js')], {
    cwd: SERVICE_ROOT,
    env: {
      ...process.env,
      SYNAPSETUNNEL_CONNECTOR_TOKEN: token,
      SYNAPSETUNNEL_SERVER_URL: service.ingressUrl,
      SYNAPSETUNNEL_LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([exited, delay(3000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); })]);
  };
  t.after(stop);
  return { child, stop, get logs() { return output; } };
}

async function websocketRejection(service: TunnelService, token: string | null): Promise<number> {
  const url = `${service.ingressUrl!.replace('http:', 'ws:')}/_synapse/tunnel/connect`;
  const socket = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return new Promise<number>((resolveStatus, rejectStatus) => {
    const timer = setTimeout(() => { socket.terminate(); rejectStatus(new Error('WebSocket status timed out')); }, 3000);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    socket.once('open', () => { clearTimeout(timer); socket.terminate(); rejectStatus(new Error('WebSocket unexpectedly accepted')); });
    socket.once('error', () => undefined);
  });
}

async function firstWebSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => rejectMessage(new Error('WebSocket message timed out')), 3000);
    socket.once('message', (data) => { clearTimeout(timer); resolveMessage(JSON.parse(data.toString())); });
    socket.once('error', (error) => { clearTimeout(timer); rejectMessage(error); });
  });
}

test('management API enforces auth, validates CRUD, and persists only token hashes', async (t) => {
  const directory = await tempDirectory(t);
  const dataFile = join(directory, 'nested', 'tunnel.json');
  let service = await startService(t, { mode: 'api', dataFile, publicOrigin: 'https://tunnel.example.com' });

  assert.equal((await fetch(`${service.apiUrl}/health`)).status, 200);
  assert.equal((await fetch(`${service.apiUrl}/ready`)).status, 200);
  assert.equal((await admin(service, '/v1/connectors', {}, null)).status, 503);
  assert.equal((await admin(service, '/v1/config', {}, null)).status, 503);
  const advertised = await (await admin(service, '/v1/config')).json() as Record<string, unknown>;
  assert.equal(advertised.publicOrigin, 'https://tunnel.example.com');
  assert.equal(advertised.connectorPath, '/_synapse/tunnel/connect');
  assert.equal(advertised.protocolVersion, 1);
  assert.equal((await admin(service, '/v1/connectors', {}, 'wrong-token')).status, 503);
  assert.equal((await admin(service, '/v1/connectors', { method: 'POST', body: '{}' })).status, 400);

  const invalidUpstream = await admin(service, '/v1/connectors', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bad', upstreamUrl: 'file:///etc/passwd' }),
  });
  assert.equal(invalidUpstream.status, 400);

  const created = await createConnector(service, 'http://127.0.0.1:3000');
  const token = created.token;
  const read = await admin(service, `/v1/connectors/${created.id}`);
  const readPayload = await read.json() as { connector: Record<string, unknown> };
  assert.equal(read.status, 200);
  assert.equal(readPayload.connector.token, undefined);
  assert.equal(readPayload.connector.tokenHash, undefined);
  assert.equal(readPayload.connector.connected, false);
  const listText = await (await admin(service, '/v1/connectors')).text();
  assert.equal(listText.includes(token), false);
  assert.equal(listText.includes('tokenHash'), false);

  const routeResponse = await admin(service, '/v1/routes', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: 'App.Example.com.', pathPrefix: '/api/', connectorId: created.id, rateLimitPerMinute: 10 }),
  });
  assert.equal(routeResponse.status, 201);
  const routePayload = await routeResponse.json() as { route: { id: string; hostname: string; pathPrefix: string } };
  assert.equal(routePayload.route.hostname, 'app.example.com');
  assert.equal(routePayload.route.pathPrefix, '/api');
  assert.equal((await admin(service, '/v1/routes', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: 'app.example.com', pathPrefix: '/api', connectorId: created.id }),
  })).status, 409);
  assert.equal((await admin(service, `/v1/routes/${routePayload.route.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'updated route' }),
  })).status, 200);
  assert.equal((await admin(service, `/v1/connectors/${created.id}`, { method: 'DELETE' })).status, 409);

  const disk = await readFile(dataFile, 'utf8');
  assert.equal(disk.includes(token), false);
  assert.match(disk, /"tokenHash": "[a-f0-9]{64}"/);
  assert.equal((await readdir(join(directory, 'nested'))).some((name) => name.endsWith('.tmp')), false);

  await service.close();
  service = await startService(t, { mode: 'api', dataFile });
  const persisted = await (await admin(service, '/v1/connectors')).json() as { connectors: Array<{ id: string }> };
  assert.equal(persisted.connectors.some((connector) => connector.id === created.id), true);
  const persistedRoutes = await (await admin(service, '/v1/routes')).json() as { routes: Array<{ id: string; name: string }> };
  assert.equal(persistedRoutes.routes.find((route) => route.id === routePayload.route.id)?.name, 'updated route');
  assert.equal((await admin(service, `/v1/routes/${routePayload.route.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await admin(service, `/v1/connectors/${created.id}`, { method: 'DELETE' })).status, 204);
});

test('real connector multiplexes HTTP through ingress with auth, streaming, and limits', async (t) => {
  const upstream = await startUpstream(t);
  const service = await startService(t);
  const connector = await createConnector(service, upstream.url);
  const routeId = await createRoute(service, connector.id, 'demo.test', '/api');
  await createRoute(service, connector.id, 'slow.test', '', { timeoutMs: 100 });
  await createRoute(service, connector.id, 'rate.test', '', { rateLimitPerMinute: 2 });
  await createRoute(service, connector.id, 'large.test', '', { maxResponseBytes: 1024 });
  await createRoute(service, connector.id, 'path.test', '');

  assert.equal((await ingressFetch(service, 'unknown.test', '/api/echo')).status, 404);
  assert.equal((await ingressFetch(service, 'demo.test', '/api/echo')).status, 502);
  assert.equal(await websocketRejection(service, null), 401);
  assert.equal(await websocketRejection(service, `st_${'b'.repeat(43)}`), 401);

  const rawUrl = `${service.ingressUrl!.replace('http:', 'ws:')}/_synapse/tunnel/connect`;
  const rawSocket = new WebSocket(rawUrl, { headers: { Authorization: `Bearer ${connector.token}` } });
  const welcome = await firstWebSocketMessage(rawSocket);
  assert.equal(welcome.type, 'welcome');
  assert.deepEqual((welcome.connector as Record<string, unknown>).upstreamUrl, `${upstream.url}/`);
  assert.equal(JSON.stringify(welcome).includes(connector.token), false);
  rawSocket.close();
  await waitFor(async () => {
    const payload = await (await admin(service, `/v1/connectors/${connector.id}`)).json() as { connector: { connected: boolean } };
    return !payload.connector.connected;
  });

  const running = await startConnector(t, service, connector.token);
  await waitFor(async () => {
    const payload = await (await admin(service, `/v1/connectors/${connector.id}`)).json() as { connector: { connected: boolean } };
    return payload.connector.connected;
  });

  await t.test('forwards method, stripped prefix, query, headers, and binary body', async () => {
    const body = Buffer.alloc(150000);
    for (let index = 0; index < body.length; index += 1) body[index] = index % 256;
    const response = await ingressFetch(service, 'demo.test:4016', '/api/echo?x=1&y=two', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream', 'x-end-to-end': 'preserved',
        authorization: 'Bearer public-user-token', cookie: 'session=value',
        connection: 'x-secret-hop', 'x-secret-hop': 'remove', 'x-synapseone-account': 'spoof',
      },
      body,
    });
    assert.equal(response.status, 200);
    const echoed = await response.json() as { method: string; url: string; headers: Record<string, string>; body: string };
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.url, '/echo?x=1&y=two');
    assert.equal(echoed.headers['x-end-to-end'], 'preserved');
    assert.equal(echoed.headers.authorization, 'Bearer public-user-token');
    assert.equal(echoed.headers.cookie, 'session=value');
    assert.equal(echoed.headers['x-secret-hop'], undefined);
    assert.equal(echoed.headers['x-synapseone-account'], undefined);
    assert.equal(echoed.headers['x-forwarded-host'], 'demo.test:4016');
    assert.match(echoed.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.deepEqual(Buffer.from(echoed.body, 'base64'), body);
  });

  await t.test('does not let a scheme-relative path change the upstream host', async () => {
    const response = await ingressFetch(service, 'path.test', '//evil.invalid/echo?fixed=host');
    assert.equal(response.status, 200);
    const echoed = await response.json() as { url: string };
    assert.equal(echoed.url, '//evil.invalid/echo?fixed=host');
  });

  await t.test('preserves status and end-to-end response headers including set-cookie', async () => {
    const response = await ingressFetch(service, 'demo.test', '/api/headers');
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-upstream'), 'preserved');
    assert.equal(response.headers.get('x-hop-response'), null);
    assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
    assert.equal(await response.text(), 'headers');
    assert.equal((await ingressFetch(service, 'demo.test', '/api/status')).status, 418);
  });

  await t.test('multiplexes concurrent requests', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => ingressFetch(service, 'demo.test', `/api/concurrent?ms=80&index=${index}`)));
    const payloads = await Promise.all(responses.map(async (response) => {
      assert.equal(response.status, 200);
      return response.json() as Promise<{ index: string }>;
    }));
    assert.deepEqual(payloads.map((payload) => payload.index).sort(), Array.from({ length: 12 }, (_, index) => String(index)).sort());
    assert(upstream.state.maxActive >= 2, `expected concurrent upstream activity, got ${upstream.state.maxActive}`);
  });

  await t.test('streams a response before the upstream finishes', async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolveStart) => { started = resolveStart; });
    upstream.state.streamStarted = started;
    const response = await ingressFetch(service, 'demo.test', '/api/stream');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-stream'), 'yes');
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value!).toString(), 'first-');
    await didStart;
    upstream.state.releaseStream?.();
    const second = await reader.read();
    assert.equal(Buffer.from(second.value!).toString(), 'second');
    assert.equal((await reader.read()).done, true);
  });

  await t.test('streams server-sent events without buffering', async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolveStart) => { started = resolveStart; });
    upstream.state.sseStarted = started;
    const response = await ingressFetch(service, 'demo.test', '/api/sse');
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value!).toString(), 'data: first\n\n');
    await didStart;
    upstream.state.releaseSse?.();
    const chunks: Buffer[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(Buffer.from(result.value));
    }
    assert.equal(Buffer.concat(chunks).toString(), 'data: second\n\n');
  });

  await t.test('returns 504 on timeout and remains usable', async () => {
    const response = await ingressFetch(service, 'slow.test', '/slow');
    assert.equal(response.status, 504);
    assert.equal((await response.json() as { error: string }).error, 'request_timeout');
    assert.equal((await ingressFetch(service, 'demo.test', '/api/echo')).status, 200);
  });

  await t.test('enforces per-route rate limits', async () => {
    assert.equal((await ingressFetch(service, 'rate.test', '/echo')).status, 200);
    assert.equal((await ingressFetch(service, 'rate.test', '/echo')).status, 200);
    const limited = await ingressFetch(service, 'rate.test', '/echo');
    assert.equal(limited.status, 429);
    assert(Number(limited.headers.get('retry-after')) >= 1);
  });

  await t.test('enforces response size limits without killing the multiplex', async () => {
    const response = await ingressFetch(service, 'large.test', '/large');
    assert.equal(response.status, 200);
    await assert.rejects(() => response.text());
    assert.equal((await ingressFetch(service, 'demo.test', '/api/echo')).status, 200);
  });

  await t.test('disconnect and offline transitions return 502', async () => {
    assert.equal((await admin(service, `/v1/connectors/${connector.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    })).status, 200);
    assert.equal((await ingressFetch(service, 'demo.test', '/api/echo')).status, 502);
    assert.equal((await admin(service, `/v1/connectors/${connector.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    })).status, 200);
    await waitFor(async () => {
      const payload = await (await admin(service, `/v1/connectors/${connector.id}`)).json() as { connector: { connected: boolean } };
      return payload.connector.connected;
    });
    await running.stop();
    assert.equal((await ingressFetch(service, 'demo.test', '/api/echo')).status, 502);
    assert.equal(running.logs.includes(connector.token), false);
    assert.equal(running.logs.includes(ADMIN_TOKEN), false);
    assert(routeId);
  });
});

test('WebSocket message size and protocol violations close only the offending socket', async (t) => {
  const service = await startService(t, { wsMaxPayloadBytes: 65536 });
  const connector = await createConnector(service, 'http://127.0.0.1:3000');
  const url = `${service.ingressUrl!.replace('http:', 'ws:')}/_synapse/tunnel/connect`;
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connector.token}` } });
  await firstWebSocketMessage(socket);
  const closed = new Promise<number>((resolveClose) => socket.once('close', resolveClose));
  socket.send('x'.repeat(70000));
  assert.equal(await closed, 1009);
  assert.equal((await ingressFetch(service, 'unknown.test', '/')).status, 404);
});
