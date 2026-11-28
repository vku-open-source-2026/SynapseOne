// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { createOrganization, grantPlatformAdmin, queryAudit, registerPlatformStepUp, upsertUser } from './db';
import { signPlatformAccess, signPlatformStepUp } from './tokens';

const saved: Record<string, string | undefined> = {};
const suffix = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

describe('VIC Hackathon registration', () => {
  let base = '';
  let server: Server | null = null;
  let adminToken = '';
  let adminUserId = '';
  let adminSessionJti = '';
  let operatorToken = '';
  let auditorToken = '';
  let registrationId = '';

  const call = async (method: string, path: string, body?: any, token?: string, stepUpToken?: string) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(stepUpToken ? { 'x-platform-step-up': stepUpToken } : {}),
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

  const editPayload = (registration: any, overrides: Record<string, unknown> = {}) => ({
    registrationType: registration.registrationType,
    teamName: registration.teamName,
    captainName: registration.captainName,
    captainEmail: registration.captainEmail,
    captainPhone: registration.captainPhone,
    captainStudentId: registration.captainStudentId,
    members: registration.registrationType === 'team' ? registration.memberNames.slice(1) : [],
    memberYears: registration.memberYears,
    memberSkills: registration.memberSkills,
    projectIdea: registration.projectIdea || null,
    expectedUpdatedAt: registration.updatedAt,
    ...overrides,
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
      'HACKATHON_REGISTRATION_RATE_LIMIT', 'IAM_PLATFORM_MUTATION_RATE_LIMIT_PER_MIN', 'SYNAPSEONE_MFA_ENABLED',
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
    process.env.IAM_PLATFORM_MUTATION_RATE_LIMIT_PER_MIN = '1000';
    const app = createApp();
    server = app.listen(0, '127.0.0.1', async () => {
      try {
        const address = server!.address();
        base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        const org = await createOrganization('hackathon-platform', 'Hackathon Platform', 'platform');
        const user = await upsertUser(org.id, 'hackathon-admin@test.local', 'Hackathon Admin');
        await grantPlatformAdmin({ userId: user.id, role: 'owner', reason: 'hackathon test' });
        const session = signPlatformAccess({ userId: user.id, role: 'owner' });
        adminToken = session.token;
        adminUserId = user.id;
        adminSessionJti = session.jti;
        const operator = await upsertUser(org.id, 'hackathon-operator@test.local', 'Hackathon Operator');
        await grantPlatformAdmin({ userId: operator.id, role: 'operator', reason: 'hackathon test' });
        operatorToken = signPlatformAccess({ userId: operator.id, role: 'operator' }).token;
        const auditor = await upsertUser(org.id, 'hackathon-auditor@test.local', 'Hackathon Auditor');
        await grantPlatformAdmin({ userId: auditor.id, role: 'auditor', reason: 'hackathon test' });
        auditorToken = signPlatformAccess({ userId: auditor.id, role: 'auditor' }).token;
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

  it('updates registration details without changing review or delivery state', async () => {
    const before = await call('GET', `/v1/platform/hackathon/registrations/${registrationId}`, undefined, adminToken);
    assert.equal(before.status, 200, JSON.stringify(before.json));
    const current = before.json.registration;
    const email = `updated-${suffix()}@example.com`;
    const result = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, editPayload(current, {
      teamName: `Updated Team ${suffix()}`,
      captainName: '  Nguyen Van Updated  ',
      captainEmail: `  ${email.toUpperCase()}  `,
      captainPhone: '+84 (334) 082-946',
      captainStudentId: 'sv-updated-001',
      members: ['Tran Thi Updated', 'Le Van Three'],
      memberYears: [3, 2, 1],
      memberSkills: [['practical-experience', 'practical-experience'], [], ['product-experience']],
      projectIdea: '  Updated product idea.  ',
    }), adminToken);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const updated = result.json.registration;
    assert.equal(updated.captainEmail, email);
    assert.equal(updated.captainStudentId, 'SV-UPDATED-001');
    assert.equal(updated.captainName, 'Nguyen Van Updated');
    assert.deepEqual(updated.memberNames, ['Nguyen Van Updated', 'Tran Thi Updated', 'Le Van Three']);
    assert.deepEqual(updated.memberYears, [3, 2, 1]);
    assert.deepEqual(updated.memberSkills, [['practical-experience'], [], ['product-experience']]);
    assert.equal(updated.projectIdea, 'Updated product idea.');
    for (const field of ['status', 'reviewNote', 'reviewedBy', 'reviewedAt', 'apiKeySentAt', 'createdAt']) {
      assert.equal(updated[field], current[field], `${field} must be preserved`);
    }

    const audit = await queryAudit({ limit: 50, action: 'platform:hackathon:update' });
    const entry = audit.find((row: any) => row.context?.registrationId === registrationId && row.decision === true);
    assert.ok(entry, 'update must be audited');
    assert.ok(entry.context.changedFields.includes('captainEmail'));
    assert.equal(entry.context.captainEmail, undefined);
    assert.equal(entry.context.captainPhone, undefined);
    assert.equal(entry.context.captainStudentId, undefined);

    const unchanged = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, editPayload(updated), operatorToken);
    assert.equal(unchanged.status, 200, 'operator can save unchanged self-duplicate team/email');

    const stale = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, editPayload(current, {
      projectIdea: 'Stale editor must not overwrite.',
    }), adminToken);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, 'registration_conflict');
    const missingVersion = editPayload(updated);
    delete missingVersion.expectedUpdatedAt;
    assert.equal((await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, missingVersion, adminToken)).status, 400);
  });

  it('validates admin edits and rejects lifecycle fields and duplicate conflicts', async () => {
    const current = (await call('GET', `/v1/platform/hackathon/registrations/${registrationId}`, undefined, adminToken)).json.registration;
    const invalidPayloads = [
      editPayload(current, { status: 'rejected' }),
      editPayload(current, { members: [] }),
      editPayload(current, { memberYears: [2] }),
      editPayload(current, { registrationType: 'individual' }),
      editPayload(current, { captainEmail: 'not-an-email' }),
      editPayload(current, { captainName: '<>' }),
      editPayload(current, { teamName: '<>' }),
      editPayload(current, { members: ['<>', 'Le Van Three'] }),
      editPayload(current, { captainPhone: 'abc' }),
      editPayload(current, { memberYears: [6, 2, 1] }),
      editPayload(current, { memberSkills: [['unknown-skill'], [], []] }),
    ];
    for (const payload of invalidPayloads) {
      const result = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, payload, adminToken);
      assert.equal(result.status, 400, JSON.stringify(payload));
    }
    assert.equal((await call('PUT', '/v1/platform/hackathon/registrations/not-a-uuid', editPayload(current), adminToken)).status, 400);
    assert.equal((await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, editPayload(current))).status, 401);
    assert.equal((await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, editPayload(current), auditorToken)).status, 403);

    const other = await call('POST', '/v1/hackathon/registrations', validBody());
    assert.equal(other.status, 201, JSON.stringify(other.json));
    const duplicateTeam = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, editPayload(current, {
      teamName: other.json.registration.teamName,
    }), adminToken);
    assert.equal(duplicateTeam.status, 409);
    assert.equal(duplicateTeam.json.error, 'registration_exists');
    const duplicateEmail = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, editPayload(current, {
      captainEmail: other.json.registration.captainEmail.toUpperCase(),
    }), adminToken);
    assert.equal(duplicateEmail.status, 409);
    assert.equal(duplicateEmail.json.error, 'registration_exists');
    const after = (await call('GET', `/v1/platform/hackathon/registrations/${registrationId}`, undefined, adminToken)).json.registration;
    assert.equal(after.teamName, current.teamName);
    assert.equal(after.captainEmail, current.captainEmail);
  });

  it('allows admins to correct registration type and edit after closing', async () => {
    const created = await call('POST', '/v1/hackathon/registrations', individualBody('Type Correction', 2));
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.registration.id;
    const individual = created.json.registration;
    const toTeam = await call('PUT', `/v1/platform/hackathon/registrations/${id}`, editPayload(individual, {
      registrationType: 'team',
      teamName: `Corrected Team ${suffix()}`,
      members: ['Second Member'],
      memberYears: [2, 1],
      memberSkills: [[], []],
    }), adminToken);
    assert.equal(toTeam.status, 200, JSON.stringify(toTeam.json));
    assert.equal(toTeam.json.registration.registrationType, 'team');
    assert.deepEqual(toTeam.json.registration.memberNames, ['Type Correction', 'Second Member']);

    process.env.HACKATHON_REGISTRATION_CLOSE_AT = '2000-01-01T00:00:00.000Z';
    process.env.HACKATHON_MAX_REGISTRATIONS = '1';
    try {
      const toIndividual = await call('PUT', `/v1/platform/hackathon/registrations/${id}`, editPayload(toTeam.json.registration, {
        registrationType: 'individual',
        teamName: null,
        members: [],
        memberYears: [4],
        memberSkills: [['competitive-programming']],
        projectIdea: null,
      }), adminToken);
      assert.equal(toIndividual.status, 200, JSON.stringify(toIndividual.json));
      assert.equal(toIndividual.json.registration.registrationType, 'individual');
      assert.equal(toIndividual.json.registration.teamName, null);
      assert.deepEqual(toIndividual.json.registration.memberNames, ['Type Correction']);
      assert.equal(toIndividual.json.registration.projectIdea, '');
    } finally {
      process.env.HACKATHON_REGISTRATION_CLOSE_AT = '2999-01-01T00:00:00.000Z';
      process.env.HACKATHON_MAX_REGISTRATIONS = '500';
    }
  });

  it('requires a single-use hackathon:update step-up proof when enabled', async () => {
    const current = (await call('GET', `/v1/platform/hackathon/registrations/${registrationId}`, undefined, adminToken)).json.registration;
    const payload = editPayload(current, { projectIdea: 'Step-up protected update.' });
    process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'true';
    try {
      const missing = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, payload, adminToken);
      assert.equal(missing.status, 403);
      assert.equal(missing.json.error, 'platform_step_up_required');

      const proof = signPlatformStepUp({ userId: adminUserId, role: 'owner', sessionJti: adminSessionJti, action: 'hackathon:update' });
      await registerPlatformStepUp({
        jti: proof.jti,
        userId: adminUserId,
        sessionJti: adminSessionJti,
        action: 'hackathon:update',
        expiresAt: new Date(Date.now() + proof.expiresIn * 1000),
      });
      const accepted = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, payload, adminToken, proof.token);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
      const replay = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, payload, adminToken, proof.token);
      assert.equal(replay.status, 403);
      assert.equal(replay.json.error, 'platform_step_up_required');

      const wrongAction = signPlatformStepUp({ userId: adminUserId, role: 'owner', sessionJti: adminSessionJti, action: 'hackathon:review' });
      await registerPlatformStepUp({
        jti: wrongAction.jti,
        userId: adminUserId,
        sessionJti: adminSessionJti,
        action: 'hackathon:review',
        expiresAt: new Date(Date.now() + wrongAction.expiresIn * 1000),
      });
      const wrong = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, payload, adminToken, wrongAction.token);
      assert.equal(wrong.status, 403);
      assert.equal(wrong.json.error, 'platform_step_up_required');
    } finally {
      process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'false';
    }
  });

  it.skip('rate-limits repeated platform registration mutations', async () => {
    const current = (await call('GET', `/v1/platform/hackathon/registrations/${registrationId}`, undefined, adminToken)).json.registration;
    const payload = editPayload(current);
    process.env.IAM_PLATFORM_MUTATION_RATE_LIMIT_PER_MIN = '1';
    try {
      const first = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, payload, adminToken);
      assert.equal(first.status, 200, JSON.stringify(first.json));
      const limited = await call('PUT', `/v1/platform/hackathon/registrations/${registrationId}`, payload, adminToken);
      assert.equal(limited.status, 429);
      assert.equal(limited.json.error, 'rate_limited');
    } finally {
      process.env.IAM_PLATFORM_MUTATION_RATE_LIMIT_PER_MIN = '1000';
    }
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
