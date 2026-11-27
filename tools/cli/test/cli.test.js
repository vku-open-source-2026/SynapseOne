// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * CLI offline tests — no platform needed (help/version/errors only).
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'synapseone.js');

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function runEnv(env, ...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { timeout: 15000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function close(srv) {
  return new Promise((resolve) => srv.close(() => resolve()));
}

// Stub "gateway": records the last request, answers canned JSON.
let last = {};
let stubBase = '';
let stub;
before(
  () =>
    new Promise((resolve) => {
      stub = http
        .createServer((req, res) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            last = { method: req.method, path: req.url, body: body ? JSON.parse(body) : null };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          });
        })
        .listen(0, '127.0.0.1', () => {
          stubBase = `http://127.0.0.1:${stub.address().port}`;
          resolve();
        });
    }),
);
after(() => new Promise((resolve) => stub.close(() => resolve())));

describe('synapseone cli offline', () => {
  it('--version exits 0', async () => {
    const r = await run('--version');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /synapseone v\d+\.\d+\.\d+/);
  });

  it('help lists commands', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    for (const cmd of ['login', 'refresh', 'logout-all', 'verify', 'orgs', 'users', 'authz', 'workflows', 'executions', 'templates', 'audit', 'keys', 'sa', 'credentials', 'call', 'webhook', 'lds']) {
      assert.ok(r.stdout.includes(cmd), cmd);
    }
  });

  it('unknown command exits 2', async () => {
    const r = await run('nope-nope');
    assert.equal(r.code, 2);
  });

  it('missing arg exits 2', async () => {
    const r = await run('attach', 'only-one');
    assert.equal(r.code, 2);
  });

  it('workflows create without template/file explains usage', async () => {
    const r = await run('workflows', 'create');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /--template|--file/);
  });

  it('workflows create --file posts definition body', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'def.json');
    fs.writeFileSync(f, JSON.stringify({ nodes: [], connections: {} }));
    const r = await run('--base', stubBase, 'workflows', 'create', '--file', f, '--name', 'w1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/workflows');
    assert.equal(last.body.name, 'w1');
    assert.deepEqual(last.body.definition, { nodes: [], connections: {} });
  });

  it('workflows update PUTs name/definition', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'def.json');
    fs.writeFileSync(f, JSON.stringify({ nodes: [{ type: 'x' }], connections: {} }));
    const r = await run('--base', stubBase, 'workflows', 'update', 'w1', '--name', 'w2', '--file', f);
    assert.equal(r.code, 0);
    assert.equal(last.method, 'PUT');
    assert.equal(last.path, '/v1/workflows/w1');
    assert.equal(last.body.name, 'w2');
    assert.deepEqual(last.body.definition, { nodes: [{ type: 'x' }], connections: {} });
  });

  it('workflows update without flags explains usage', async () => {
    const r = await run('workflows', 'update', 'w1');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /--name|--file/);
  });

  it('workflows delete hits the workflow path', async () => {
    const r = await run('--base', stubBase, 'workflows', 'delete', 'w1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/workflows/w1');
  });

  it('detach/assign/unassign hit the right paths', async () => {
    let r = await run('--base', stubBase, 'detach', 'r1', 'p1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/roles/r1/policies/p1');
    r = await run('--base', stubBase, 'assign', 'u1', 'r1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/users/u1/assign');
    r = await run('--base', stubBase, 'unassign', 'u1', 'r1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/users/u1/roles/r1');
  });

  it('keys list hits the account keys path', async () => {
    const r = await run('--base', stubBase, 'keys', 'list', 'a1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/accounts/a1/keys');
  });

  it('users create + policies hit encoded paths', async () => {
    const r = await run('--base', stubBase, 'users', 'create', 'org1', 'a@b.c', 'A');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/orgs/org1/users');
    assert.equal(last.body.email, 'a@b.c');
    const r2 = await run('--base', stubBase, 'users', 'policies', 'u 1');
    assert.equal(r2.code, 0);
    assert.equal(last.path, '/v1/users/u%201/policies');
  });

  it('workflows test-run posts definition+input', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'def.json');
    fs.writeFileSync(f, JSON.stringify({ nodes: [], connections: {} }));
    const r = await run('--base', stubBase, 'workflows', 'test-run', '--file', f, '--input', '{"value":21}');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/workflows/test-run');
    assert.deepEqual(last.body, { definition: { nodes: [], connections: {} }, input: { value: 21 } });
  });

  it('workflows test-run without --file explains usage', async () => {
    const r = await run('workflows', 'test-run');
    assert.equal(r.code, 2);
    assert.match(r.stderr + r.stdout, /--file/);
  });

  it('workflows exec passes --data payload through', async () => {
    const r = await run('--base', stubBase, 'workflows', 'exec', 'w1', '--data', '{"value":21}');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/workflows/w1/execute');
    assert.deepEqual(last.body, { value: 21 });
  });

  it('workflows exec reads payload from --file', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'in.json');
    fs.writeFileSync(f, JSON.stringify({ value: 42 }));
    const r = await run('--base', stubBase, 'workflows', 'exec', 'w1', '--file', f);
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/workflows/w1/execute');
    assert.deepEqual(last.body, { value: 42 });
  });

  it('executions list builds the allowlisted query', async () => {
    const r = await run('--base', stubBase, 'executions', 'list', '--limit', '20', '--offset', '20', '--workflow-id', 'w1', '--status', 'success', '--include-data');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.ok(last.path.startsWith('/v1/executions?'), last.path);
    for (const q of ['limit=20', 'offset=20', 'workflowId=w1', 'status=success', 'includeData=true']) {
      assert.ok(last.path.includes(q), `${q} in ${last.path}`);
    }
  });

  it('executions <id> supports --include-data', async () => {
    const r = await run('--base', stubBase, 'executions', 'e1', '--include-data');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/executions/e1?includeData=true');
  });

  it('webhook posts to /webhook/:path', async () => {
    const r = await run('--base', stubBase, 'webhook', 'transform', '--data', '{"value":21}');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/webhook/transform');
    assert.deepEqual(last.body, { value: 21 });
  });

  it('help mentions test-run and webhook', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('test-run'), 'test-run in help');
    assert.ok(r.stdout.includes('webhook'), 'webhook in help');
  });

  it('credentials create posts name/type/secret', async () => {
    const r = await run('--base', stubBase, 'credentials', 'create', 'a1', '--name', 'stripe-live', '--type', 'bearer', '--secret', 's3cr3t');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/accounts/a1/credentials');
    assert.deepEqual(last.body, { name: 'stripe-live', type: 'bearer', secret: 's3cr3t' });
  });

  it('credentials create reads secret from file and rejects bad type', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'sec.txt');
    fs.writeFileSync(f, 'file-secret\n');
    const r = await run('--base', stubBase, 'credentials', 'create', 'a1', '--name', 'x', '--secret-file', f);
    assert.equal(r.code, 0);
    assert.equal(last.body.secret, 'file-secret');
    assert.equal(last.body.type, 'bearer');
    const bad = await run('--base', stubBase, 'credentials', 'create', 'a1', '--name', 'x', '--type', 'nope', '--secret', 's');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr + bad.stdout, /--type/);
  });

  it('credentials list/get/delete/rotate hit the right paths', async () => {
    let r = await run('--base', stubBase, 'credentials', 'list', 'a1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/accounts/a1/credentials');
    r = await run('--base', stubBase, 'credentials', 'get', 'c1');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/credentials/c1');
    r = await run('--base', stubBase, 'credentials', 'rotate', 'c1', '--secret', 'n3w');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/credentials/c1/rotate');
    assert.deepEqual(last.body, { secret: 'n3w' });
    r = await run('--base', stubBase, 'credentials', 'delete', 'c1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/credentials/c1');
  });

  it('call passes method/path/body through', async () => {
    const r = await run('--base', stubBase, 'call', 'POST', '/v1/accounts/a1/credentials', '--data', '{"name":"x"}');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/accounts/a1/credentials');
    assert.deepEqual(last.body, { name: 'x' });
    const bad = await run('--base', stubBase, 'call', 'FETCH', '/v1/x');
    assert.equal(bad.code, 1);
  });

  it('help mentions credentials and call', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('credentials'), 'credentials in help');
    assert.ok(r.stdout.includes('call'), 'call in help');
  });

  it('unreachable base exits 1 with synapseone error', async () => {
    const r = await run('--base', 'http://127.0.0.1:1', 'orgs');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /network|HTTP/);
  });

  it('follows same-origin redirects with credentials intact', async () => {
    let finalHeaders = {};
    const srv = await listen((req, res) => {
      if (req.url === '/v1/orgs') {
        res.statusCode = 302;
        res.setHeader('Location', '/v1/final');
        res.end();
        return;
      }
      finalHeaders = { ...req.headers };
      res.setHeader('Content-Type', 'application/json');
      res.end('[]');
    });
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r = await run('--base', base, '--token', 'T', '--apikey', 'K', 'orgs');
      assert.equal(r.code, 0, r.stderr);
      assert.equal(finalHeaders.authorization, 'Bearer T');
      assert.equal(finalHeaders['x-api-key'], 'K');
    } finally {
      await close(srv);
    }
  });

  it('refuses an untrusted cross-origin redirect without contacting the target', async () => {
    let hits = 0;
    const other = await listen((req, res) => {
      hits++;
      res.setHeader('Content-Type', 'application/json');
      res.end('[]');
    });
    const otherBase = `http://127.0.0.1:${other.address().port}`;
    const source = await listen((req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `${otherBase}/capture`);
      res.end();
    });
    const base = `http://127.0.0.1:${source.address().port}`;
    try {
      const r = await run('--base', base, '--token', 'T', '--apikey', 'K', 'orgs');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /cross-origin|refused|redirect/i);
      assert.equal(hits, 0);
    } finally {
      await close(source);
      await close(other);
    }
  });

  it('trusted cross-origin redirects never forward credentials', async () => {
    let hits = 0;
    let seen = {};
    const other = await listen((req, res) => {
      hits++;
      seen = { ...req.headers };
      res.setHeader('Content-Type', 'application/json');
      res.end('[]');
    });
    const otherBase = `http://127.0.0.1:${other.address().port}`;
    const source = await listen((req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `${otherBase}/capture`);
      res.end();
    });
    const base = `http://127.0.0.1:${source.address().port}`;
    try {
      const r = await run(
        '--base', base, '--token', 'T', '--apikey', 'K',
        '--trusted-redirect-origin', otherBase, 'orgs',
      );
      assert.equal(r.code, 0, r.stderr);
      assert.equal(hits, 1);
      assert.equal(seen.authorization, undefined);
      assert.equal(seen['x-api-key'], undefined);
      assert.equal(seen.cookie, undefined);
    } finally {
      await close(source);
      await close(other);
    }
  });

  it('times out a stalled response body', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok":');
      // never end the response
    });
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const started = Date.now();
      const r = await run('--base', base, '--timeout', '100', 'orgs');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /timeout/i);
      assert.ok(Date.now() - started < 3000);
    } finally {
      await close(srv);
    }
  });

  it('reports binary responses above the configured limit instead of truncating', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(100, 120));
    });
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r = await runEnv(
        { SYNAPSEONE_MAX_BINARY_BYTES: '4' },
        '--base', base, 'ocs', 'get', 'b', 'k',
      );
      assert.equal(r.code, 1);
      assert.match(r.stderr, /limit|exceeds|response/i);
    } finally {
      await close(srv);
    }
  });

  it('downloads exact binary bytes without corruption', async () => {
    const want = Buffer.from([0, 1, 2, 254, 255]);
    const srv = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(want);
    });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bin-')), 'out.bin');
    try {
      const r = await run('--base', base, 'ocs', 'get', 'b', 'k', '--output', file);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual([...fs.readFileSync(file)], [...want]);
    } finally {
      await close(srv);
    }
  });

  it('does not write a partial file for a truncated body', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '100' });
      res.write('short');
      res.socket?.destroy();
    });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bin-')), 'partial.bin');
    try {
      const r = await run('--base', base, 'ocs', 'get', 'b', 'k', '--output', file);
      assert.equal(r.code, 1);
      assert.ok(!fs.existsSync(file), 'partial download must not be written');
    } finally {
      await close(srv);
    }
  });

  it('rejects a 200 HTML SPA response instead of printing it', async () => {
    const spa = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body>console</body></html>');
    });
    await new Promise((resolve) => spa.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${spa.address().port}`;
      const r = await run('--base', base, 'orgs');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /non-JSON response/);
      assert.match(r.stderr, /api\.synapseone\.space/);
      assert.ok(!r.stdout.includes('<!doctype html>'), 'must not print the SPA');
    } finally {
      await new Promise((resolve) => spa.close(resolve));
    }
  });

  it('health --ready reports upstreams and exits 3 when degraded', async () => {
    const gw = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/ready') {
        res.statusCode = 503;
        res.end(JSON.stringify({ status: 'degraded', service: 'gateway', version: '0', upstreams: [{ name: 'base', ok: false, status: 502 }] }));
        return;
      }
      res.end(JSON.stringify({ status: 'ok', service: 'gateway', version: '0' }));
    });
    await new Promise((resolve) => gw.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${gw.address().port}`;
      const ok = await run('--base', base, 'health');
      assert.equal(ok.code, 0);
      assert.match(ok.stdout, /status: ok/);
      const degraded = await run('--base', base, 'health', '--ready');
      assert.equal(degraded.code, 3);
      assert.match(degraded.stdout, /degraded/);
      assert.match(degraded.stdout, /FAIL base/);
    } finally {
      await new Promise((resolve) => gw.close(resolve));
    }
  });
});

describe('synapseone cli mfa', () => {
  it('mfa subcommands hit the MFA routes', async () => {
    const cases = [
      [['mfa'], 'GET', '/v1/auth/mfa', null],
      [['mfa', 'setup'], 'POST', '/v1/auth/mfa/totp/setup', {}],
      [['mfa', 'enable', '111111', '--json'], 'POST', '/v1/auth/mfa/totp/enable', { code: '111111' }],
      [['mfa', 'recovery-codes', '222222'], 'POST', '/v1/auth/mfa/recovery-codes', { code: '222222' }],
      [['mfa', 'disable', '--recovery-code', 'abcd-efgh'], 'POST', '/v1/auth/mfa/disable', { recoveryCode: 'abcd-efgh' }],
      [['mfa', 'reset', 'u1'], 'DELETE', '/v1/users/u1/mfa', null],
      [['mfa', 'unlock', 'u1'], 'POST', '/v1/users/u1/unlock', {}],
    ];
    for (const [args, method, p, body] of cases) {
      const r = await run('--base', stubBase, '--token', 'T', ...args);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.deepEqual([last.method, last.path, last.body], [method, p, body], args.join(' '));
    }
    const bad = await run('--base', stubBase, '--token', 'T', 'mfa', 'disable');
    assert.notEqual(bad.code, 0, 'disable needs a code');
  });

  it('login finishes the MFA step with --code', async () => {
    const calls = [];
    const gw = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push({ path: req.url, body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/auth/login') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'mfa_required', mfaToken: 'challenge-1' }));
        } else {
          res.end(JSON.stringify({ accessToken: 'A', refreshToken: 'R', user: { email: 'a@b.c' } }));
        }
      });
    });
    await new Promise((resolve) => gw.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${gw.address().port}`;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-home-'));
    const runHome = (...args) =>
      new Promise((resolve) => {
        execFile(process.execPath, [BIN, ...args], { timeout: 15000, env: { ...process.env, HOME: home, USERPROFILE: home } }, (err, stdout, stderr) => {
          resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
        });
      });
    try {
      const noCode = await runHome('--base', base, 'login', '--email', 'a@b.c', '--password', 'pw');
      assert.notEqual(noCode.code, 0);
      assert.match(noCode.stderr, /uses MFA/);

      const ok = await runHome('--base', base, 'login', '--email', 'a@b.c', '--password', 'pw', '--code', '123456');
      assert.equal(ok.code, 0, ok.stderr);
      assert.deepEqual(calls[calls.length - 1], { path: '/v1/auth/mfa/verify', body: { mfaToken: 'challenge-1', code: '123456' } });
      assert.equal(calls[calls.length - 2].body.password, 'pw');
      const saved = JSON.parse(fs.readFileSync(path.join(home, '.synapseone', 'config.json'), 'utf8'));
      assert.equal(saved.token, 'A');
    } finally {
      await new Promise((resolve) => gw.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
