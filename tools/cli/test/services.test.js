// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * First-class service command tests — stub gateway, no platform needed.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'synapseone.js');

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function tmpFile(name, value) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-svc-')), name);
  fs.writeFileSync(f, value);
  return f;
}

let last = {};
let stubBase = '';
let stub;
before(
  () =>
    new Promise((resolve) => {
      stub = http
        .createServer((req, res) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const raw = Buffer.concat(chunks);
            last = {
              method: req.method,
              path: req.url,
              headers: req.headers,
              body: raw.length ? (() => { try { return JSON.parse(raw.toString('utf8')); } catch { return raw.toString('utf8'); } })() : null,
              raw: raw.toString('utf8'),
            };
            res.setHeader('Content-Type', 'application/json');
            canned(req, res);
          });
        })
        .listen(0, '127.0.0.1', () => {
          stubBase = `http://127.0.0.1:${stub.address().port}`;
          resolve();
        });
    }),
);
after(() => new Promise((resolve) => stub.close(() => resolve())));

function canned(req, res) {
  const p = String(req.url).split('?')[0];
  const method = req.method;
  if (method === 'GET' && p === '/v1/inference/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: 'model says hi' } }] }));
  if (method === 'POST' && p === '/v1/inference/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: 'model says hi' } }] }));
  if (method === 'POST' && p === '/v1/queue/queues/emails/messages') {
    res.statusCode = 201;
    return res.end(JSON.stringify({ ok: true, id: 'm1', duplicate: false }));
  }
  if (method === 'POST' && p === '/v1/queue/queues/emails/consume') {
    return res.end(JSON.stringify({ messages: [{ id: 'm1', receipt: 'r1', attempts: 0, state: 'ready' }] }));
  }
  if (method === 'POST' && p === '/v1/stream/topics/telemetry/events') {
    return res.end(JSON.stringify({ event: { id: '1-0', payload: { value: 25 } } }));
  }
  if (method === 'POST' && p === '/v1/ocs/buckets') {
    res.statusCode = 201;
    return res.end(JSON.stringify({ bucket: { name: 'city-assets' } }));
  }
  if (p === '/v1/ocs/buckets/city-assets/objects/a.txt') {
    if (method === 'PUT') {
      res.statusCode = 201;
      return res.end(JSON.stringify({ bucket: 'city-assets', object: { key: 'a.txt' } }));
    }
    if (method === 'GET') {
      res.setHeader('Content-Type', 'text/plain');
      return res.end('file-content');
    }
  }
  if (method === 'POST' && p === '/v1/notifications') {
    res.statusCode = 202;
    return res.end(JSON.stringify({ notifications: [{ id: 'n1', channel: 'email', status: 'queued' }] }));
  }
  if (method === 'POST' && p === '/v1/search') {
    return res.end(JSON.stringify({ items: [{ documentId: 'd1', title: 'Doc', collectionId: 'kb', score: 1 }], total: 1, nextCursor: null }));
  }
  if (method === 'POST' && p === '/v1/secrets') {
    res.statusCode = 201;
    return res.end(JSON.stringify({ secret: { name: 'stripe', version: 1 } }));
  }
  if (method === 'POST' && p === '/v1/secrets/stripe/read') {
    return res.end(JSON.stringify({ name: 'stripe', version: 1, value: 's3cr3t' }));
  }
  if (method === 'POST' && p === '/v1/warehouse/query') {
    return res.end(JSON.stringify({ columns: ['id', 'name'], rows: [{ id: 1, name: 'x' }], rowCount: 1, truncated: false, durationMs: 1 }));
  }
  if (method === 'POST' && p === '/v1/human-tasks') {
    res.statusCode = 201;
    return res.end(JSON.stringify({ task: { id: 't1', title: 'Approve', status: 'pending' } }));
  }
  if (method === 'GET' && p === '/v1/human-tasks') {
    return res.end(JSON.stringify({ items: [{ id: 't1', title: 'Approve', status: 'pending' }], total: 1 }));
  }
  if (method === 'GET' && p === '/v1/usage/summary') {
    return res.end(JSON.stringify({ totals: { requests: 1 } }));
  }
  if (method === 'POST' && p === '/v1/scim/tokens') {
    res.statusCode = 201;
    return res.end(JSON.stringify({ id: 's1', token: 'scim_secret', scopes: ['scim:read'] }));
  }
  if (method === 'PUT' && p === '/v1/faststore/keys/cache:demo') {
    return res.end(JSON.stringify({ ok: true, key: 'cache:demo', created: true }));
  }
  if (method === 'PUT' && p === '/v1/faststore/hashes/session/u1') {
    return res.end(JSON.stringify({ ok: true, key: 'session', field: 'u1' }));
  }
  if (method === 'POST' && p === '/v1/ocs/buckets') return res.end(JSON.stringify({}));
  res.end(JSON.stringify({ ok: true }));
}

describe('synapseone first-class service commands', () => {
  it('help lists data-plane commands', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    for (const cmd of ['faststore', 'queue', 'stream', 'ocs', 'notifications', 'search', 'secrets', 'inference', 'warehouse', 'human-tasks', 'usage', 'scim']) {
      assert.ok(r.stdout.includes(cmd), cmd);
    }
  });

  it('faststore set maps --value/--ttl to the KV endpoint', async () => {
    const r = await run('--base', stubBase, 'faststore', 'set', 'cache:demo', '--value', '{"ok":true}', '--ttl', '300');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'PUT');
    assert.equal(last.path, '/v1/faststore/keys/cache%3Ademo');
    assert.deepEqual(last.body, { value: { ok: true }, ttlSeconds: 300 });
  });

  it('faststore hashes set posts a field value', async () => {
    const r = await run('--base', stubBase, 'faststore', 'hashes', 'set', 'session', 'u1', '--value', 'alice');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/faststore/hashes/session/u1');
    assert.deepEqual(last.body, { value: 'alice' });
  });

  it('faststore sets add splits comma-separated members', async () => {
    const r = await run('--base', stubBase, 'faststore', 'sets', 'add', 'tags', '--members', 'a,b');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/faststore/sets/tags/add');
    assert.deepEqual(last.body, { members: ['a', 'b'] });
  });

  it('queue send posts payload and delivery options', async () => {
    const r = await run('--base', stubBase, 'queue', 'send', 'emails', '--payload', '{"to":"a@b.c"}', '--delay', '5', '--dedupe-key', 'k1');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/queue/queues/emails/messages');
    assert.deepEqual(last.body, { payload: { to: 'a@b.c' }, delaySeconds: 5, dedupeKey: 'k1' });
  });

  it('queue consume prints usable receipts', async () => {
    const r = await run('--base', stubBase, 'queue', 'consume', 'emails');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /m1\tr1\t0\tready\t/);
  });

  it('stream group create targets the consumer-group endpoint', async () => {
    const r = await run('--base', stubBase, 'stream', 'group', 'create', 'telemetry', 'workers', '--start-id', '0-0');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'PUT');
    assert.equal(last.path, '/v1/stream/topics/telemetry/groups/workers');
    assert.deepEqual(last.body, { startId: '0-0' });
  });

  it('stream publish posts payload and key', async () => {
    const r = await run('--base', stubBase, 'stream', 'publish', 'telemetry', '--payload', '{"value":25}', '--key', 'sensor-1');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/stream/topics/telemetry/events');
    assert.deepEqual(last.body, { payload: { value: 25 }, key: 'sensor-1' });
  });

  it('ocs bucket create and put/get move bytes', async () => {
    let r = await run('--base', stubBase, 'ocs', 'bucket', 'create', 'city-assets');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/ocs/buckets');
    assert.deepEqual(last.body, { name: 'city-assets' });

    const f = tmpFile('a.txt', 'file-content');
    r = await run('--base', stubBase, 'ocs', 'put', 'city-assets', 'a.txt', '--file', f);
    assert.equal(r.code, 0);
    assert.equal(last.method, 'PUT');
    assert.equal(last.path, '/v1/ocs/buckets/city-assets/objects/a.txt');
    assert.equal(last.raw, 'file-content');

    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ocs-')), 'out.txt');
    r = await run('--base', stubBase, 'ocs', 'get', 'city-assets', 'a.txt', '--output', out);
    assert.equal(r.code, 0);
    assert.equal(fs.readFileSync(out, 'utf8'), 'file-content');
  });

  it('notifications send builds the channel recipient', async () => {
    const r = await run('--base', stubBase, 'notifications', 'send', 'a@b.c', '--channel', 'email', '--subject', 'Hi', '--body', 'Hello');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/notifications');
    assert.deepEqual(last.body, { channel: 'email', recipient: { email: 'a@b.c' }, subject: 'Hi', body: 'Hello' });
  });

  it('search posts query, mode, collections and filters', async () => {
    const r = await run('--base', stubBase, 'search', 'auth guide', '--mode', 'hybrid', '--collection', 'kb', '--filter', 'status=published');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/search');
    assert.equal(last.body.query, 'auth guide');
    assert.equal(last.body.mode, 'hybrid');
    assert.equal(last.body.collection, 'kb');
    assert.deepEqual(last.body.filters, { status: 'published' });
  });

  it('secrets create/read keep the value literal', async () => {
    let r = await run('--base', stubBase, 'secrets', 'create', 'stripe', '--value', 's3cr3t');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/secrets');
    assert.deepEqual(last.body, { name: 'stripe', value: 's3cr3t', description: '', scope: 'tenant' });

    r = await run('--base', stubBase, 'secrets', 'read', 'stripe');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/secrets/stripe/read');
    assert.equal(r.stdout.trim(), 's3cr3t');
  });

  it('inference chat prints only the assistant content by default', async () => {
    const r = await run('--base', stubBase, 'inference', 'chat', 'hello');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/inference/chat/completions');
    assert.deepEqual(last.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(r.stdout.trim(), 'model says hi');
  });

  it('warehouse query renders columns', async () => {
    const r = await run('--base', stubBase, 'warehouse', 'query', '--sql', 'SELECT 1');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/warehouse/query');
    assert.match(r.stdout, /id\tname/);
    assert.match(r.stdout, /1\tx/);
  });

  it('warehouse dataset create accepts positional name and typed columns', async () => {
    const r = await run('--base', stubBase, 'warehouse', 'dataset', 'create', 'incidents', '--column', 'id:string', '--column', 'severity:string');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/warehouse/datasets');
    assert.deepEqual(last.body, { name: 'incidents', columns: [{ name: 'id', type: 'string' }, { name: 'severity', type: 'string' }] });
  });

  it('human-tasks create and list use the workflow endpoints', async () => {
    let r = await run('--base', stubBase, 'human-tasks', 'create', 'Approve deploy', '--assignee', 'u1');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/human-tasks');
    assert.deepEqual(last.body, { title: 'Approve deploy', assignee: 'u1' });

    r = await run('--base', stubBase, 'human-tasks', 'list', '--status', 'pending');
    assert.equal(r.code, 0);
    assert.match(last.path, /^\/v1\/human-tasks\?.*status=pending/);
  });

  it('usage summary forwards the time window and feature', async () => {
    const r = await run('--base', stubBase, 'usage', 'summary', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z', '--feature', 'base');
    assert.equal(r.code, 0);
    assert.match(last.path, /\/v1\/usage\/summary\?/);
    assert.match(last.path, /feature=base/);
    assert.match(r.stdout, /totals:.*requests/);
  });

  it('scim token create prints the one-time secret', async () => {
    const r = await run('--base', stubBase, 'scim', 'token', 'create', '--description', 'okta');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/scim/tokens');
    assert.deepEqual(last.body, { scopes: ['scim:read', 'scim:write'], description: 'okta' });
    assert.match(r.stdout, /scim_secret/);
  });
});
