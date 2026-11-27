// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';
import type { Server } from 'node:http';
import { fetchWithPinnedAddress, runWorkflow } from './engine';

function httpDefinition(url: string) {
  return {
    nodes: [
      { name: 'Start', type: 'manualTrigger', parameters: {} },
      { name: 'HTTP', type: 'httpRequest', parameters: { url, method: 'GET', timeoutMs: 1500 } },
    ],
    connections: { Start: { main: [[{ node: 'HTTP' }]] } },
  } as any;
}
function agentDefinition(baseUrl: string) {
  return {
    nodes: [
      { name: 'Start', type: 'manualTrigger', parameters: {} },
      { name: 'Agent', type: 'synapseflow.aiAgent', parameters: { core: 'openai-compatible', baseUrl, userPrompt: 'hello', maxSteps: 1 } },
    ],
    connections: { Start: { main: [[{ node: 'Agent' }]] } },
  } as any;
}

describe('pinned upstream transport and byte caps', () => {
  let server: Server;
  let base = '';
  let internalHits = 0;
  let largeRequestAborted = false;
  let finalHits = 0;
  let seenHost = '';
  const savedSelf = process.env.SYNAPSEONE_SELF_BASE_URLS;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/internal') {
        internalHits++;
        res.end('internal-reached');
        return;
      }
      if (req.url === '/large' || req.url === '/chat/completions') {
        res.setHeader('content-type', req.url === '/large' ? 'text/plain' : 'application/json');
        let aborted = false;
        res.on('close', () => { if (!res.writableEnded) { aborted = true; largeRequestAborted = true; } });
        const prefix = req.url === '/large' ? 'x' : '{"choices":[{"message":{"content":"';
        res.write(prefix);
        const timer = setInterval(() => {
          if (!aborted) res.write('x'.repeat(64 * 1024));
        }, 5);
        res.on('close', () => { clearInterval(timer); if (!res.writableEnded) { aborted = true; largeRequestAborted = true; } });
        return;
      }
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('location', '/final');
        res.write('x'.repeat(64 * 1024));
        res.write('x'.repeat(64 * 1024));
        res.end();
        return;
      }
      if (req.url === '/final') {
        finalHits++;
        res.end('should-not-follow');
        return;
      }
      seenHost = String(req.headers.host || '');
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    base = `http://localhost:${port}`;
    process.env.SYNAPSEONE_SELF_BASE_URLS = base;
  });
  beforeEach(() => { internalHits = 0; largeRequestAborted = false; finalHits = 0; seenHost = ''; });
  after(async () => {
    if (savedSelf === undefined) delete process.env.SYNAPSEONE_SELF_BASE_URLS;
    else process.env.SYNAPSEONE_SELF_BASE_URLS = savedSelf;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('pins a validated address while preserving the original Host header', async () => {
    let resolutions = 0;
    const result = await runWorkflow(httpDefinition(`${base}/host`), {}, {
      hostResolver: async (host) => { assert.equal(host, 'localhost'); resolutions++; return ['127.0.0.1']; },
    });
    assert.equal(result.status, 'success', String(result.error));
    assert.equal(resolutions, 1);
    assert.match(seenHost, /^localhost:\d+$/);
  });

  it('preserves TLS SNI as the original hostname while pinning the socket address', async () => {
    let sni = '';
    const tlsServer = createTlsServer({
      SNICallback: (servername, callback) => {
        sni = servername;
        callback(new Error('SNI captured; stop the test handshake'));
      },
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    const port = (tlsServer.address() as any).port;
    try {
      await assert.rejects(
        fetchWithPinnedAddress(`https://localhost:${port}/`, ['127.0.0.1'], {}, { rejectUnauthorized: false }),
      );
      assert.equal(sni, 'localhost');
    } finally {
      await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    }
  });

  it('never connects to an alternating-DNS internal answer', async () => {
    const port = (server.address() as any).port;
    let resolutions = 0;
    const result = await runWorkflow(httpDefinition(`http://localhost.localdomain:${port}/internal`), {}, {
      timeoutMs: 4000,
      hostResolver: async () => [++resolutions === 1 ? '93.184.216.34' : '127.0.0.1'],
    });
    assert.equal(result.status, 'error');
    assert.equal(resolutions, 1, 'transport must not resolve the hostname a second time');
    assert.equal(internalHits, 0, 'internal alternating-DNS answer must never be connected');
  });

  it('aborts a chunked HTTP response at the byte cap', async () => {
    const result = await runWorkflow(httpDefinition(`${base}/large`), {}, {});
    assert.equal(result.status, 'error');
    assert.match(String(result.error), /response exceeds/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(largeRequestAborted, true, 'oversize upstream request must be aborted');
  });

  it('aborts a chunked AI-agent response at the byte cap', async () => {
    const result = await runWorkflow(agentDefinition(base), {}, {});
    assert.equal(result.status, 'error');
    assert.match(String(result.error), /AI Agent LLM.*response exceeds/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(largeRequestAborted, true, 'oversize AI upstream request must be aborted');
  });

  it('bounds redirect-body drains and does not follow an oversized redirect body', async () => {
    const result = await runWorkflow(httpDefinition(`${base}/redirect`), {}, {});
    assert.equal(result.status, 'error');
    assert.match(String(result.error), /redirect body.*response exceeds/);
    assert.equal(finalHits, 0);
  });
});
