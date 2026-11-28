// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { createOrganization, grantPlatformAdmin, queryAudit, upsertUser } from './db';
import { signPlatformAccess } from './tokens';

const saved: Record<string, string | undefined> = {};
const suffix = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

describe('VIC Hackathon registration', () => {
  let base = '';
  let server: Server | null = null;
  let adminToken = '';
  let registrationId = '';

  const call = async (method: string, path: string, body?: any, token?: string) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json };
  };

  const validBody = () => ({
    registrationType: 'team',
    teamName: `Synapse Team ${suffix()}`,
    captainName: 'Nguyen Van A',
    captainEmail: `captain-${suffix()}@example.com`,
    captainPhone: '0912345678',
    captainStudentId: '123456789',
    members: ['Tran Thi B'],
    memberYears: [2, 1],
    memberSkills: [[], []],
    projectIdea: 'Xây dựng sản phẩm sử dụng SynapseOne.',
    acceptedRules: true,
    website: '',
  });

  const individualBody = (name: string, year: number, skills: string[] = []) => ({
    registrationType: 'individual',
    captainName: name,
    captainEmail: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix()}@example.com`,
    captainPhone: '0912345678',
    captainStudentId: `sv-${suffix()}`,
    members: [],
    memberYears: [year],
    memberSkills: [skills],
    projectIdea: '',
    acceptedRules: true,
    website: '',
  });

  before(() => new Promise<void>((resolve, reject) => {
    for (const key of [
      'NODE_ENV', 'DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET', 'IAM_ALLOW_DEV_LOGIN',
      'PLATFORM_ADMIN_ENABLED', 'PLATFORM_ADMIN_REQUIRE_MFA', 'PLATFORM_ADMIN_REQUIRE_STEP_UP',
      'PLATFORM_ORG_SLUG', 'HACKATHON_REGISTRATION_CLOSE_AT', 'HACKATHON_MAX_REGISTRATIONS',
      'HACKATHON_REGISTRATION_RATE_LIMIT', 'SYNAPSEONE_MFA_ENABLED',
    ]) saved[key] = process.env[key];
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    process.env.IAM_ALLOW_DEV_LOGIN = 'true';
    process.env.PLATFORM_ADMIN_ENABLED = 'true';
    process.env.SYNAPSEONE_MFA_ENABLED = 'true';
    process.env.PLATFORM_ADMIN_REQUIRE_MFA = 'false';
    process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'false';
    process.env.PLATFORM_ORG_SLUG = 'hackathon-platform';
    process.env.HACKATHON_REGISTRATION_CLOSE_AT = '2999-01-01T00:00:00.000Z';
    process.env.HACKATHON_MAX_REGISTRATIONS = '500';
    process.env.HACKATHON_REGISTRATION_RATE_LIMIT = '1000';
    const app = createApp();
    server = app.listen(0, '127.0.0.1', async () => {
      try {
        const address = server!.address();
        base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        const org = await createOrganization('hackathon-platform', 'Hackathon Platform', 'platform');
        const user = await upsertUser(org.id, 'hackathon-admin@test.local', 'Hackathon Admin');
        await grantPlatformAdmin({ userId: user.id, role: 'owner', reason: 'hackathon test' });
        adminToken = signPlatformAccess({ userId: user.id, role: 'owner' }).token;
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }));

  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('accepts an anonymous 2–3 member team registration', async () => {
    const body = validBody();
    const result = await call('POST', '/v1/hackathon/registrations', body);
    assert.equal(result.status, 201, JSON.stringify(result.json));
    assert.equal(result.json.registration.status, 'pending');
    assert.deepEqual(result.json.registration.memberNames, [body.captainName, body.members[0]]);
    assert.deepEqual(result.json.registration.memberYears, body.memberYears);
    assert.deepEqual(result.json.registration.memberSkills, body.memberSkills);
    assert.equal(result.json.registration.captainEmail, body.captainEmail);
    registrationId = result.json.registration.id;
  });

  it('rejects invalid team size, contact data and missing rules consent', async () => {
    const noMembers = validBody();
    noMembers.members = [];
    assert.equal((await call('POST', '/v1/hackathon/registrations', noMembers)).status, 400);

    const badPhone = validBody();
    badPhone.captainPhone = 'abc';
    assert.equal((await call('POST', '/v1/hackathon/registrations', badPhone)).status, 400);

    const noConsent = validBody();
    (noConsent as any).acceptedRules = false;
    assert.equal((await call('POST', '/v1/hackathon/registrations', noConsent)).status, 400);
  });

  it('rejects duplicate team names and captain emails', async () => {
    const body = validBody();
    assert.equal((await call('POST', '/v1/hackathon/registrations', body)).status, 201);
    assert.equal((await call('POST', '/v1/hackathon/registrations', body)).status, 409);
    const sameEmail = validBody();
    sameEmail.captainEmail = body.captainEmail;
    assert.equal((await call('POST', '/v1/hackathon/registrations', sameEmail)).status, 409);
  });

  it('suggests individual teams with a year-2 or skilled anchor', async () => {
    for (const body of [
      individualBody('Second Year', 2),
      individualBody('First One', 1),
      individualBody('First Two', 1),
    ]) assert.equal((await call('POST', '/v1/hackathon/registrations', body)).status, 201);
    for (const body of [
      individualBody('Skilled First', 1, ['product-experience']),
      individualBody('First Three', 1),
      individualBody('First Four', 1),
    ]) assert.equal((await call('POST', '/v1/hackathon/registrations', body)).status, 201);

    const result = await call('GET', '/v1/platform/hackathon/match-suggestions', undefined, adminToken);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.ok(result.json.suggestions.length >= 2);
    assert.deepEqual(result.json.suggestions[0].members.map((member: any) => member.year), [2, 1, 1]);
    assert.match(result.json.suggestions[1].pattern, /kỹ năng nâng cao/);
    assert.equal(result.json.suggestions[1].members[0].name, 'Skilled First');
  });

  it('accepts an individual registration without a team', async () => {
    const body = individualBody('Solo Player', 3, ['practical-experience']);
    const result = await call('POST', '/v1/hackathon/registrations', body);
    assert.equal(result.status, 201, JSON.stringify(result.json));
    assert.equal(result.json.registration.registrationType, 'individual');
    assert.equal(result.json.registration.teamName, null);
    assert.deepEqual(result.json.registration.memberNames, ['Solo Player']);
    assert.deepEqual(result.json.registration.memberYears, [3]);
    assert.deepEqual(result.json.registration.memberSkills, [['practical-experience']]);

    const invalid = individualBody('Invalid Solo', 2);
    (invalid as any).teamName = 'Should not be here';
    assert.equal((await call('POST', '/v1/hackathon/registrations', invalid)).status, 400);
  });

  it('rejects new teams when the configured capacity is reached', async () => {
    process.env.HACKATHON_MAX_REGISTRATIONS = '1';
    try {
      const result = await call('POST', '/v1/hackathon/registrations', validBody());
      assert.equal(result.status, 409);
      assert.equal(result.json.error, 'registration_full');
    } finally {
      process.env.HACKATHON_MAX_REGISTRATIONS = '500';
    }
  });

  it('closes registration after the configured deadline', async () => {
    process.env.HACKATHON_REGISTRATION_CLOSE_AT = '2000-01-01T00:00:00.000Z';
    try {
      const result = await call('POST', '/v1/hackathon/registrations', validBody());
      assert.equal(result.status, 410);
      assert.equal(result.json.error, 'registration_closed');
    } finally {
      process.env.HACKATHON_REGISTRATION_CLOSE_AT = '2999-01-01T00:00:00.000Z';
    }
  });

  it('requires platform admin for review and list endpoints', async () => {
    assert.equal((await call('GET', '/v1/platform/hackathon/registrations')).status, 401);
    assert.equal((await call('GET', '/v1/platform/hackathon/registrations', undefined, 'invalid')).status, 401);
  });

  it('lists, reviews and tracks manual API-key delivery', async () => {
    const list = await call('GET', '/v1/platform/hackathon/registrations?status=pending&limit=50', undefined, adminToken);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.ok(list.json.total >= 1);
    assert.equal(list.json.counts.pending >= 1, true);

    const earlySend = await call('POST', `/v1/platform/hackathon/registrations/${registrationId}/api-key-sent`, {}, adminToken);
    assert.equal(earlySend.status, 409);

    const review = await call('PATCH', `/v1/platform/hackathon/registrations/${registrationId}`, {
      status: 'approved',
      reviewNote: 'Đủ điều kiện tham gia.',
    }, adminToken);
    assert.equal(review.status, 200, JSON.stringify(review.json));
    assert.equal(review.json.registration.status, 'approved');

    const sent = await call('POST', `/v1/platform/hackathon/registrations/${registrationId}/api-key-sent`, {}, adminToken);
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(typeof sent.json.registration.apiKeySentAt, 'string');
    assert.equal((sent.json.registration as any).apiKey, undefined);
    const sentAgain = await call('POST', `/v1/platform/hackathon/registrations/${registrationId}/api-key-sent`, {}, adminToken);
    assert.equal(sentAgain.status, 200);
    assert.equal(sentAgain.json.registration.apiKeySentAt, sent.json.registration.apiKeySentAt);

    const audit = await queryAudit({ limit: 50, action: 'platform:hackathon:review' });
    assert.ok(audit.some((row: any) => row.context?.registrationId === registrationId && row.decision === true));
  });

  it('requires step-up for review when enabled', async () => {
    process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'true';
    try {
      const result = await call('PATCH', `/v1/platform/hackathon/registrations/${registrationId}`, {
        status: 'approved',
      }, adminToken);
      assert.equal(result.status, 403);
      assert.equal(result.json.error, 'platform_step_up_required');
    } finally {
      process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'false';
    }
  });
});
