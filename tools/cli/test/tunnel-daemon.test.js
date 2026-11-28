// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { normalizeUpstreamInput, isProcessRunning } = require('../lib/tunnel/daemon');

const BIN = path.join(__dirname, '..', 'bin', 'synapseone.js');
const TOKEN = `st_${'d'.repeat(43)}`;
const CONNECTOR_ID = '33333333-3333-4333-8333-333333333333';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function runCli(env, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      timeout: 15000,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe('tunnel daemon and ngrok quick workflow', { timeout: 25000 }, () => {
  it('normalizes local port and host inputs into upstream URLs', () => {
    assert.equal(normalizeUpstreamInput('3000'), 'http://127.0.0.1:3000/');
    assert.equal(normalizeUpstreamInput(':8080'), 'http://127.0.0.1:8080/');
    assert.equal(normalizeUpstreamInput('localhost:5173'), 'http://localhost:5173/');
    assert.equal(normalizeUpstreamInput('https://127.0.0.1:8443/app'), 'https://127.0.0.1:8443/app');
    assert.throws(() => normalizeUpstreamInput('0'), /Invalid local port/);
    assert.throws(() => normalizeUpstreamInput('70000'), /Invalid local port/);
  });

  it('provisions via tunnel http -d, runs in background, inspects status/logs, and stops cleanly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-daemon-'));
    const tunnelStateDir = path.join(tmpDir, 'tunnels');
    const env = { SYNAPSEONE_TUNNEL_DIR: tunnelStateDir };
    const connections = [];

    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('daemon-ok');
    });
    const upstreamPort = await listen(upstream);

    const ingress = http.createServer((_req, res) => res.end('ingress'));
    const wss = new WebSocketServer({ noServer: true });
    ingress.on('upgrade', (req, socket, head) => {
      if (req.url !== '/_synapse/tunnel/connect' || req.headers.authorization !== `Bearer ${TOKEN}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        connections.push(ws);
        ws.send(JSON.stringify({
          type: 'welcome',
          protocolVersion: 1,
          connector: { id: CONNECTOR_ID, name: 'myapp', upstreamUrl: `http://127.0.0.1:${upstreamPort}/` },
          limits: { maxRequestBytes: 1048576, maxResponseBytes: 1048576, maxConcurrentRequests: 10 },
        }));
      });
    });
    const ingressPort = await listen(ingress);
    const ingressOrigin = `http://127.0.0.1:${ingressPort}`;

    const apiRequests = [];
    const gateway = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        apiRequests.push({ method: req.method, url: req.url, body });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/v1/tunnel/v1/quick') {
          res.statusCode = 201;
          res.end(JSON.stringify({
            connector: { id: CONNECTOR_ID, name: 'myapp', upstreamUrl: body.upstreamUrl, orgId: 'org-1', enabled: true },
            route: { id: ROUTE_ID, name: 'myapp', hostname: 'myapp.synapsetunnel.site', pathPrefix: '', connectorId: CONNECTOR_ID, enabled: true },
            token: TOKEN,
            publicUrl: 'https://myapp.synapsetunnel.site',
            serverUrl: ingressOrigin,
            baseDomain: 'synapsetunnel.site',
            reused: false,
            quota: { orgId: 'org-1', baseDomain: 'synapsetunnel.site', usedDomains: 1, maxDomains: 5, remainingDomains: 4, unlimited: false, domains: ['myapp.synapsetunnel.site'] },
          }));
          return;
        }
        if (req.method === 'GET' && req.url === '/v1/tunnel/v1/quota') {
          res.end(JSON.stringify({ orgId: 'org-1', baseDomain: 'synapsetunnel.site', usedDomains: 1, maxDomains: 5, remainingDomains: 4, unlimited: false, domains: ['myapp.synapsetunnel.site'] }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not_found' }));
      });
    });
    const gatewayPort = await listen(gateway);
    const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

    let daemonPid = null;
    try {
      const started = await runCli(
        env,
        '--base', gatewayOrigin,
        '--apikey', 'synapseone_test',
        '--json',
        'tunnel', 'http', String(upstreamPort),
        '--subdomain', 'myapp',
        '--name', 'myapp',
        '-d',
      );
      assert.equal(started.code, 0, started.stderr);
      const parsed = JSON.parse(started.stdout);
      assert.equal(parsed.name, 'myapp');
      assert.equal(parsed.publicUrl, 'https://myapp.synapsetunnel.site');
      assert.equal(parsed.running, true);
      assert.ok(Number.isInteger(parsed.pid) && parsed.pid > 0);
      daemonPid = parsed.pid;
      assert.equal(isProcessRunning(daemonPid), true);
      assert.equal(apiRequests[0].url, '/v1/tunnel/v1/quick');
      assert.equal(apiRequests[0].body.subdomain, 'myapp');
      assert.equal(apiRequests[0].body.upstreamUrl, `http://127.0.0.1:${upstreamPort}/`);

      // Wait briefly for WebSocket connection to register on mock ingress
      for (let attempt = 0; attempt < 40 && connections.length === 0; attempt += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(connections.length >= 1, 'background daemon should connect to ingress');

      const status = await runCli(env, '--json', 'tunnel', 'status', 'myapp');
      assert.equal(status.code, 0, status.stderr);
      const statusJson = JSON.parse(status.stdout);
      assert.equal(statusJson.tunnels.length, 1);
      assert.equal(statusJson.tunnels[0].status, 'running');
      assert.equal(statusJson.tunnels[0].pid, daemonPid);

      const logs = await runCli(env, 'tunnel', 'logs', 'myapp', '--lines', '20');
      assert.equal(logs.code, 0, logs.stderr);
      assert.match(logs.stdout, /tunnel_ready/);

      const quota = await runCli(env, '--base', gatewayOrigin, '--apikey', 'synapseone_test', 'tunnel', 'quota');
      assert.equal(quota.code, 0, quota.stderr);
      assert.match(quota.stdout, /1\/5 domains used/);

      const stopped = await runCli(env, 'tunnel', 'stop', 'myapp');
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.match(stopped.stdout, /stopped/);
      assert.equal(isProcessRunning(daemonPid), false);
      daemonPid = null;

      // Also test `tunnel start <name> --token ...` directly with a token
      const tokenStart = await runCli(
        env,
        '--json',
        'tunnel', 'start', 'direct-token',
        '--token', TOKEN,
        '--server-url', ingressOrigin,
      );
      assert.equal(tokenStart.code, 0, tokenStart.stderr);
      const tokenParsed = JSON.parse(tokenStart.stdout);
      assert.equal(tokenParsed.name, 'direct-token');
      assert.equal(tokenParsed.running, true);
      daemonPid = tokenParsed.pid;
      assert.equal(isProcessRunning(daemonPid), true);

      const stopAll = await runCli(env, 'tunnel', 'stop', '--all');
      assert.equal(stopAll.code, 0, stopAll.stderr);
      assert.equal(isProcessRunning(daemonPid), false);
      daemonPid = null;
    } finally {
      if (daemonPid && isProcessRunning(daemonPid)) {
        try { process.kill(daemonPid, 'SIGKILL'); } catch { /* ignore */ }
      }
      for (const ws of connections) ws.terminate();
      await new Promise((r) => wss.close(r));
      await closeServer(gateway);
      await closeServer(ingress);
      await closeServer(upstream);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
