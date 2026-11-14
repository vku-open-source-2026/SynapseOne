// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/* Copyright 2026 SynapseOne Contributors. Licensed under Apache-2.0. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { runWorkflow } from './engine';

describe('HTTP workflow identity and redirect boundary', () => {
  const oldAllowlist = process.env.SYNAPSEONE_SELF_BASE_URLS;
  const oldSecret = process.env.SYNAPSEONE_INTERNAL_SECRET;
  let first: Server;
  let second: Server;
  let firstBase: string;
  let secondBase: string;
  let observed: IncomingHttpHeaders[];
  before(async () => {
    observed = [];
    second = createServer((req, res) => {
      observed.push(req.headers);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve));
    secondBase = `http://127.0.0.1:${(second.address() as any).port}`;
    first = createServer((req, res) => {
      observed.push(req.headers);
      if (req.url === '/redirect') {
        res.writeHead(307, { location: `${secondBase}/target` });
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => first.listen(0, '127.0.0.1', resolve));
    firstBase = `http://127.0.0.1:${(first.address() as any).port}`;
    // Both origins are explicitly allowed local test fakes, never deployment URLs.
    process.env.SYNAPSEONE_SELF_BASE_URLS = `${firstBase},${secondBase}`;
    process.env.SYNAPSEONE_INTERNAL_SECRET = 'test-http-identity-internal';
  });
  after(async () => {
    if (oldAllowlist === undefined) delete process.env.SYNAPSEONE_SELF_BASE_URLS;
    else process.env.SYNAPSEONE_SELF_BASE_URLS = oldAllowlist;
    if (oldSecret === undefined) delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    else process.env.SYNAPSEONE_INTERNAL_SECRET = oldSecret;
    await Promise.all([first, second].map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  });
  async function run(path: string, principal: any, auth = false) {
    observed = [];
    return runWorkflow({ nodes: [
      { name: 'Start', type: 'manualTrigger', parameters: {} },
      { name: 'Request', type: 'httpRequest', parameters: { url: `${firstBase}${path}`, method: 'POST', body: { test: true },
        headers: { 'X-SynapseOne-User': 'forged-admin', 'x-synapsedx-org': 'foreign-org',
          'x-synapseone-tenant': 'foreign-tenant', 'X-SynapseOne-Kind': 'apikey', 'X-SynapseOne-Internal': 'forged-internal',
          ...(auth ? { Authorization: 'Bearer test-http-only-bearer' } : {}) },
        ...(auth ? { auth: { credentialId: 'connector-test', header: 'X-Custom-Connector-Key', allowedOrigins: [firstBase, secondBase] } } : {}) } },
    ], connections: { Start: { main: [[{ node: 'Request' }]] } } }, {}, {
      principal,
      credentialResolver: async () => ({ kind: 'api-key', secret: 'test-http-only-connector' }),
    });
  }
  it('overwrites workflow-supplied platform headers with the actual run identity', async () => {
    const result = await run('/direct', { sub: 'actual-user', org: 'actual-org', kind: 'user' });
    assert.equal(result.status, 'success');
    assert.equal(observed[0]['x-synapseone-user'], 'actual-user');
    assert.equal(observed[0]['x-synapseone-org'], 'actual-org');
    assert.equal(observed[0]['x-synapseone-kind'], 'user');
    assert.equal(observed[0]['x-synapseone-internal'], 'test-http-identity-internal');
    assert.equal(observed[0]['x-synapsedx-org'], undefined);
    assert.equal(observed[0]['x-synapseone-tenant'], undefined);
  });
  it('does not give a principal-free run a platform identity or the internal secret', async () => {
    assert.equal((await run('/direct', null)).status, 'success');
    assert.equal(observed[0]['x-synapseone-anon'], '1');
    assert.equal(observed[0]['x-synapseone-user'], undefined);
    assert.equal(observed[0]['x-synapseone-internal'], undefined);
  });
  it('strips platform, bearer and custom credential headers when following a cross-origin redirect', async () => {
    assert.equal((await run('/redirect', { sub: 'actual-user', org: 'actual-org', kind: 'user' }, true)).status, 'success');
    assert.equal(observed.length, 2);
    assert.equal(observed[0]['x-custom-connector-key'], 'test-http-only-connector');
    assert.equal(observed[0].authorization, 'Bearer test-http-only-bearer');
    for (const key of Object.keys(observed[1])) {
      assert.equal(key.startsWith('x-synapseone-') || key.startsWith('x-synapsedx-'), false);
    }
    assert.equal(observed[1].authorization, undefined);
    assert.equal(observed[1]['x-custom-connector-key'], undefined);
  });
});
