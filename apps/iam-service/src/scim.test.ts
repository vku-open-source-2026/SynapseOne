// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * SCIM 2.0 provisioning (#48): scoped tokens, Users/Groups CRUD, filters,
 * deprovisioning and group-to-role mapping.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { getOrgBySlug, createOrganization, listAccounts, rolesForUser, upsertUser } from './db';
import { createScimToken } from './scim';
import { signAccess, newRefreshToken, storeRefresh, consumeRefresh } from './tokens';

let server: Server;
let base = '';
let orgId = '';
let scimToken = '';
let adminToken = '';
let adminUserId = '';

const auth = () => ({ 'content-type': 'application/json', authorization: `Bearer ${scimToken}` });

async function scim(method: string, path: string, body?: any, token = scimToken): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

before(async () => {
  process.env.SYNAPSEONE_INTERNAL_SECRET = 'scim-test-secret';
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const org = (await getOrgBySlug('acme'))!;
  orgId = org.id;
  scimToken = (await createScimToken({ orgId, description: 'test' })).token;
  const admin = await upsertUser(orgId, 'scim-admin@example.com', 'SCIM Admin');
  adminUserId = admin.id;
  adminToken = signAccess({ sub: admin.id, email: admin.email, org: orgId }).token;
});

after(async () => {
  delete process.env.SYNAPSEONE_INTERNAL_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('SCIM 2.0 (#48)', () => {
  let createdUserId = '';

  it('creates, filters and pages users', async () => {
    const created = await scim('POST', '/scim/v2/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'alice@example.com',
      externalId: 'hr-1001',
      displayName: 'Alice Nguyen',
      active: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.userName, 'alice@example.com');
    assert.equal(created.json.externalId, 'hr-1001');
    assert.equal(created.json.active, true);
    createdUserId = created.json.id;

    const duplicate = await scim('POST', '/scim/v2/Users', { userName: 'alice@example.com' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.scimType, 'uniqueness');

    const byName = await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "alice@example.com"'));
    assert.equal(byName.status, 200);
    assert.equal(byName.json.totalResults, 1);
    assert.equal(byName.json.Resources[0].id, createdUserId);

    const byExternal = await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('externalId eq "hr-1001"'));
    assert.equal(byExternal.json.totalResults, 1);

    const page = await scim('GET', '/scim/v2/Users?startIndex=1&count=1');
    assert.equal(page.json.itemsPerPage, 1);
    assert.ok(page.json.totalResults >= 2);

    const invalidFilter = await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName pr "x"'));
    assert.equal(invalidFilter.status, 400);
  });

  it('patches and replaces users; rejects invalid paths', async () => {
    const patched = await scim('PATCH', `/scim/v2/Users/${createdUserId}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'replace', path: 'displayName', value: 'Alice Tran' },
        { op: 'replace', path: 'active', value: true },
      ],
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.displayName, 'Alice Tran');

    const invalid = await scim('PATCH', `/scim/v2/Users/${createdUserId}`, {
      Operations: [{ op: 'replace', path: 'password', value: 'x' }],
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.scimType, 'invalidPath');

    const replaced = await scim('PUT', `/scim/v2/Users/${createdUserId}`, {
      userName: 'alice@example.com', displayName: 'Alice Final', active: true,
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    assert.equal(replaced.json.displayName, 'Alice Final');

    const rename = await scim('PUT', `/scim/v2/Users/${createdUserId}`, { userName: 'other@example.com' });
    assert.equal(rename.status, 409);
  });

  it('deactivation revokes refresh tokens and API-key credentials', async () => {
    const rt = newRefreshToken();
    await storeRefresh(createdUserId, rt.hash, new Date(Date.now() + 60_000));
    const deleted = await scim('DELETE', `/scim/v2/Users/${createdUserId}`);
    assert.equal(deleted.status, 204);
    assert.equal(await consumeRefresh(rt.value), null);
    const read = await scim('GET', `/scim/v2/Users/${createdUserId}`);
    assert.equal(read.status, 200);
    assert.equal(read.json.active, false);
  });

  it('enforces tenant isolation for users and groups', async () => {
    const other = await createOrganization('scim-other', 'SCIM Other');
    const otherToken = (await createScimToken({ orgId: other.id })).token;
    const read = await scim('GET', `/scim/v2/Users/${createdUserId}`, undefined, otherToken);
    assert.equal(read.status, 404);
    const list = await scim('GET', '/scim/v2/Users', undefined, otherToken);
    assert.equal(list.json.totalResults, 0);
    const group = await scim('GET', '/scim/v2/Groups/not-a-uuid', undefined, otherToken);
    assert.equal(group.status, 404);
  });

  it('creates groups, maps roles and manages members', async () => {
    const accounts = await listAccounts(orgId);
    assert.ok(accounts.length > 0);
    const member = await upsertUser(orgId, 'group-member@example.com', 'Group Member');
    const group = await scim('POST', '/scim/v2/Groups', {
      displayName: 'SCIM Moderators',
      accountId: accounts[0].id,
      roles: ['admin'],
      members: [{ value: member.id }],
    });
    assert.equal(group.status, 201, JSON.stringify(group.json));
    assert.equal(group.json.displayName, 'SCIM Moderators');
    const groupId = group.json.id;
    let roles = await rolesForUser(member.id);
    assert.ok(roles.some((r) => r.slug === 'admin'));

    const patched = await scim('PATCH', `/scim/v2/Groups/${groupId}`, {
      Operations: [{ op: 'remove', path: 'members', value: { value: member.id } }],
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.members.length, 0);
    roles = await rolesForUser(member.id);
    assert.equal(roles.some((r) => r.slug === 'admin'), false);

    const listed = await scim('GET', '/scim/v2/Groups?filter=' + encodeURIComponent('displayName eq "SCIM Moderators"'));
    assert.equal(listed.json.totalResults, 1);
    const deleted = await scim('DELETE', `/scim/v2/Groups/${groupId}`);
    assert.equal(deleted.status, 204);
    const gone = await scim('GET', `/scim/v2/Groups/${groupId}`);
    assert.equal(gone.status, 404);
  });

  it('issues and revokes scoped SCIM bearer tokens', async () => {
    const created = await fetch(`${base}/v1/scim/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-synapseone-internal': 'scim-test-secret',
        authorization: `Bearer ${adminToken}`,
        'x-synapseone-org': orgId,
        'x-synapseone-user': adminUserId,
      },
      body: JSON.stringify({ description: 'IdP sync', scopes: ['scim:read'] }),
    });
    assert.equal(created.status, 201);
    const body: any = await created.json();
    assert.match(body.token, /^scim_/);
    assert.deepEqual(body.scopes, ['scim:read']);

    const writeDenied = await scim('POST', '/scim/v2/Users', { userName: 'denied@example.com' }, body.token);
    assert.equal(writeDenied.status, 403);

    const revoked = await fetch(`${base}/v1/scim/tokens/${body.id}`, {
      method: 'DELETE',
      headers: {
        'x-synapseone-internal': 'scim-test-secret',
        authorization: `Bearer ${adminToken}`,
        'x-synapseone-org': orgId,
        'x-synapseone-user': adminUserId,
      },
    });
    assert.equal(revoked.status, 200, await revoked.text());
    const after = await scim('GET', '/scim/v2/Users', undefined, body.token);
    assert.equal(after.status, 401);
  });

  it('rejects SCIM requests without a token or with a user JWT', async () => {
    const missing = await fetch(`${base}/scim/v2/Users`);
    assert.equal(missing.status, 401);
    const userJwt = await scim('GET', '/scim/v2/Users', undefined, adminToken);
    assert.equal(userJwt.status, 401);
  });
});
