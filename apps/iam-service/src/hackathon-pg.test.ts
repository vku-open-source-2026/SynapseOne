// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * PostgreSQL-only hackathon edit tests. Run explicitly against a disposable DB:
 *   IAM_TEST_DATABASE_URL=1 DATABASE_URL=postgres://... \
 *     node --test dist/hackathon-pg.test.js
 * The default in-memory suite skips this file.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ensureTables, getDb, withTransaction } from './db';
import {
  createHackathonRegistration,
  getHackathonRegistration,
  markHackathonApiKeySent,
  reviewHackathonRegistration,
  updateHackathonRegistration,
  type HackathonRegistrationInput,
} from './hackathon';

const enabled = process.env.IAM_TEST_DATABASE_URL === '1' && !!process.env.DATABASE_URL;
const suffix = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function input(overrides: Partial<HackathonRegistrationInput> = {}): HackathonRegistrationInput {
  const id = suffix();
  return {
    registrationType: 'team',
    teamName: `PG Team ${id}`,
    captainName: 'Captain Original',
    captainEmail: `captain-${id}@example.test`,
    captainPhone: '0912345678',
    captainStudentId: `sv-${id}`,
    members: ['Member Two'],
    memberYears: [2, 1],
    memberSkills: [[], []],
    projectIdea: 'Original idea',
    ...overrides,
  };
}

describe('VIC Hackathon registration edits on PostgreSQL', { skip: !enabled }, () => {
  before(async () => { await ensureTables(); });

  it('persists normalized edits while preserving approved/reviewed/delivery metadata', async () => {
    const created = await createHackathonRegistration(input());
    await reviewHackathonRegistration({ id: created.id, status: 'approved', reviewNote: 'Eligible', reviewedBy: 'pg-reviewer' });
    const delivered = await markHackathonApiKeySent(created.id);
    assert.ok(delivered?.apiKeySentAt);
    const updated = await updateHackathonRegistration(created.id, input({
      teamName: created.teamName || '',
      captainName: '  Captain Updated  ',
      captainEmail: created.captainEmail.toUpperCase(),
      captainPhone: '+84 (334) 082-946',
      captainStudentId: 'sv-updated-001',
      members: ['Member Updated', 'Member Three'],
      memberYears: [3, 2, 1],
      memberSkills: [['practical-experience', 'practical-experience'], [], ['product-experience']],
      projectIdea: '  Updated idea  ',
    }), delivered.updatedAt || undefined);
    assert.ok(updated);
    assert.equal(updated.captainName, 'Captain Updated');
    assert.equal(updated.captainEmail, created.captainEmail);
    assert.equal(updated.captainStudentId, 'SV-UPDATED-001');
    assert.deepEqual(updated.memberNames, ['Captain Updated', 'Member Updated', 'Member Three']);
    assert.deepEqual(updated.memberYears, [3, 2, 1]);
    assert.deepEqual(updated.memberSkills, [['practical-experience'], [], ['product-experience']]);
    assert.equal(updated.projectIdea, 'Updated idea');
    assert.equal(updated.status, 'approved');
    assert.equal(updated.reviewNote, 'Eligible');
    assert.equal(updated.reviewedBy, 'pg-reviewer');
    assert.ok(updated.reviewedAt);
    assert.equal(updated.apiKeySentAt, delivered.apiKeySentAt);
    assert.equal(updated.createdAt, created.createdAt);
    const stored = await getHackathonRegistration(created.id);
    assert.deepEqual(stored, updated);
  });

  it('rejects case-insensitive duplicate team/email edits without partial writes', async () => {
    const first = await createHackathonRegistration(input());
    const second = await createHackathonRegistration(input());
    const before = await getHackathonRegistration(second.id);
    await assert.rejects(
      updateHackathonRegistration(second.id, input({ teamName: (first.teamName || '').toUpperCase(), captainEmail: second.captainEmail })),
      (error: any) => error?.code === '23505' || error?.cause?.code === '23505',
    );
    await assert.rejects(
      updateHackathonRegistration(second.id, input({ teamName: second.teamName || '', captainEmail: first.captainEmail.toUpperCase() })),
      (error: any) => error?.code === '23505' || error?.cause?.code === '23505',
    );
    assert.deepEqual(await getHackathonRegistration(second.id), before);
  });

  it('allows exactly one winner when concurrent edits claim the same unique values', async () => {
    const first = await createHackathonRegistration(input());
    const second = await createHackathonRegistration(input());
    const sharedTeam = `Shared PG Team ${suffix()}`;
    const sharedEmail = `shared-${suffix()}@example.test`;
    const results = await Promise.allSettled([
      updateHackathonRegistration(first.id, input({ teamName: sharedTeam, captainEmail: sharedEmail })),
      updateHackathonRegistration(second.id, input({ teamName: sharedTeam, captainEmail: sharedEmail })),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  });

  it('rejects stale millisecond versions and supports team/individual conversion', async () => {
    const created = await createHackathonRegistration(input());
    const first = await updateHackathonRegistration(created.id, input({
      teamName: created.teamName || '',
      captainEmail: created.captainEmail,
      projectIdea: 'First edit',
    }), created.updatedAt || undefined);
    assert.ok(first);
    await assert.rejects(
      updateHackathonRegistration(created.id, input({
        teamName: created.teamName || '',
        captainEmail: created.captainEmail,
        projectIdea: 'Stale edit',
      }), created.updatedAt || undefined),
      (error: any) => error?.code === 'hackathon_conflict',
    );
    const individual = await updateHackathonRegistration(created.id, input({
      registrationType: 'individual',
      teamName: '',
      captainEmail: created.captainEmail,
      members: [],
      memberYears: [5],
      memberSkills: [['competitive-programming']],
      projectIdea: null,
    }), first.updatedAt || undefined);
    assert.ok(individual);
    assert.equal(individual.registrationType, 'individual');
    assert.equal(individual.teamName, null);
    assert.deepEqual(individual.memberNames, [individual.captainName]);
    assert.deepEqual(individual.memberYears, [5]);
    assert.equal(individual.projectIdea, '');
  });

  it('rolls back an edit when the surrounding transaction fails', async () => {
    const created = await createHackathonRegistration(input());
    const before = await getHackathonRegistration(created.id);
    await assert.rejects(withTransaction(async () => {
      await updateHackathonRegistration(created.id, input({
        teamName: created.teamName || '',
        captainEmail: created.captainEmail,
        projectIdea: 'Must roll back',
      }));
      throw new Error('forced rollback');
    }), /forced rollback/);
    assert.deepEqual(await getHackathonRegistration(created.id), before);
    assert.ok(getDb(), 'PostgreSQL test requires a database');
  });
});
