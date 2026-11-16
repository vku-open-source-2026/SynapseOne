// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Tenant secret vault (#47): metadata-only lists, encrypted values, rotation
 * with grace, revocation, deletion and cross-tenant denial.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { __clearSecrets } from './store';

const INTERNAL = 'test-secret-123';
const USER = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-user': 'owner@example.com',
  'x-synapseone-org': 'org-a',
  'x-synapseone-account': 'acct-a',
  'x-synapseone-kind': 'user',
};
const OTHER = { ...USER, 'x-synapseone-user': 'other@example.com', 'x-synapseone-org': 'org-b', 'x-synapseone-account': 'acct-b' };

describe('tenant secret vault (#47)', () => {
  let base = '';
  let server: Server | null = null;

  before(async () => {
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    __clearSecrets();
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  beforeEach(() => __clearSecrets());

  async function create(name = 'database-url', value = 'postgres://user:pass@db/app') {
    const r = await fetch(`${base}/v1/secrets`, {
      method: 'POST', headers: USER, body: JSON.stringify({ name, value, description: 'Primary database' }),
    });
    assert.equal(r.status, 201);
    return (await r.json()).secret;
  }

  it('creates a secret and never exposes values in list/read metadata', async () => {
    const secret = await create();
    assert.equal(secret.name, 'database-url');
    assert.equal(secret.currentVersion, 1);
    assert.equal('value' in secret, false);
    assert.equal('valueEnc' in secret, false);

    const list = await fetch(`${base}/v1/secrets`, { headers: USER });
    assert.equal(list.status, 200);
    const body: any = await list.json();
    assert.equal(body.items.length, 1);
    assert.equal(JSON.stringify(body).includes('postgres://user:pass'), false);

    const meta = await fetch(`${base}/v1/secrets/database-url`, { headers: USER });
    assert.equal(meta.status, 200);
    const metaBody: any = await meta.json();
    assert.equal(metaBody.versions[0].status, 'active');
    assert.equal(JSON.stringify(metaBody).includes('postgres://user:pass'), false);

    const read = await fetch(`${base}/v1/secrets/database-url/read`, { method: 'POST', headers: USER, body: '{}' });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).value, 'postgres://user:pass@db/app');
  });

  it('rotates with a bounded grace period and revokes old versions', async () => {
    await create();
    const rotated = await fetch(`${base}/v1/secrets/database-url/rotate`, {
      method: 'POST', headers: USER, body: JSON.stringify({ value: 'postgres://new:pass@db/app', graceSeconds: 3600 }),
    });
    assert.equal(rotated.status, 200);
    const body: any = await rotated.json();
    assert.equal(body.secret.currentVersion, 2);
    assert.equal(body.graceSeconds, 3600);

    const current = await fetch(`${base}/v1/secrets/database-url/read`, { method: 'POST', headers: USER, body: '{}' });
    assert.equal((await current.json()).value, 'postgres://new:pass@db/app');
    const previous = await fetch(`${base}/v1/secrets/database-url/read`, {
      method: 'POST', headers: USER, body: JSON.stringify({ version: 1 }),
    });
    assert.equal(previous.status, 200);
    assert.equal((await previous.json()).value, 'postgres://user:pass@db/app');

    const revoke = await fetch(`${base}/v1/secrets/database-url/revoke`, {
      method: 'POST', headers: USER, body: JSON.stringify({ version: 1 }),
    });
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).revoked, 1);
    const revoked = await fetch(`${base}/v1/secrets/database-url/read`, {
      method: 'POST', headers: USER, body: JSON.stringify({ version: 1 }),
    });
    assert.equal(revoked.status, 410);
    assert.equal((await revoked.json()).error, 'version_revoked');
  });

  it('denies cross-tenant access without leaking existence', async () => {
    await create();
    for (const [method, path, body] of [
      ['GET', '/v1/secrets/database-url', undefined],
      ['POST', '/v1/secrets/database-url/read', '{}'],
      ['POST', '/v1/secrets/database-url/rotate', JSON.stringify({ value: 'x' })],
      ['DELETE', '/v1/secrets/database-url', undefined],
    ] as const) {
      const r = await fetch(`${base}${path}`, { method, headers: OTHER, body });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    const otherList = await fetch(`${base}/v1/secrets`, { headers: OTHER });
    assert.deepEqual((await otherList.json()).items, []);
  });

  it('deletes secrets and blocks duplicate creation', async () => {
    await create();
    const duplicate = await fetch(`${base}/v1/secrets`, {
      method: 'POST', headers: USER, body: JSON.stringify({ name: 'database-url', value: 'another' }),
    });
    assert.equal(duplicate.status, 409);
    const del = await fetch(`${base}/v1/secrets/database-url`, { method: 'DELETE', headers: USER });
    assert.equal(del.status, 200);
    const list = await fetch(`${base}/v1/secrets`, { headers: USER });
    assert.deepEqual((await list.json()).items, []);
    const gone = await fetch(`${base}/v1/secrets/database-url/read`, { method: 'POST', headers: USER, body: '{}' });
    assert.equal(gone.status, 404);
  });

  it('authenticates the rotation webhook with a shared token', async () => {
    await create();
    process.env.SECRET_ROTATION_WEBHOOK_SECRET = 'rotation-test-token';
    const denied = await fetch(`${base}/v1/secrets/rotation-webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: 'org-a', name: 'database-url', value: 'x' }),
    });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${base}/v1/secrets/rotation-webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rotation-token': 'rotation-test-token' },
      body: JSON.stringify({ orgId: 'org-a', name: 'database-url', value: 'webhook-rotated', graceSeconds: 0 }),
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).secret.currentVersion, 2);
    delete process.env.SECRET_ROTATION_WEBHOOK_SECRET;
  });

  it('requires an organization claim', async () => {
    const r = await fetch(`${base}/v1/secrets`, {
      headers: { ...USER, 'x-synapseone-org': '' },
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'org_required');
  });
});
