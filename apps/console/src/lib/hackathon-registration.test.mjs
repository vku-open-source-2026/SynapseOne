// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  editFormToPayload,
  registrationToEditForm,
  validateHackathonEditForm,
} from './hackathon-registration.js';

const teamRow = {
  registrationType: 'team',
  teamName: 'VIC',
  captainName: 'Tran Van Bang',
  captainEmail: 'captain@example.com',
  captainPhone: '0334082946',
  captainStudentId: 'SV-001',
  memberNames: ['Tran Van Bang', 'Member Two', 'Member Three'],
  memberYears: [2, 1, 3],
  memberSkills: [['practical-experience'], [], ['product-experience']],
  projectIdea: 'Build with SynapseOne',
  updatedAt: '2026-11-28T15:00:00.000Z',
};

test('admin editor round-trips a team with captain-first years and skills', () => {
  const form = registrationToEditForm(teamRow);
  assert.deepEqual(form.members, [
    { name: 'Member Two', year: '1', skills: [] },
    { name: 'Member Three', year: '3', skills: ['product-experience'] },
  ]);
  assert.equal(form.captainYear, '2');
  assert.deepEqual(editFormToPayload(form), {
    registrationType: 'team',
    teamName: 'VIC',
    captainName: 'Tran Van Bang',
    captainEmail: 'captain@example.com',
    captainPhone: '0334082946',
    captainStudentId: 'SV-001',
    members: ['Member Two', 'Member Three'],
    memberYears: [2, 1, 3],
    memberSkills: [['practical-experience'], [], ['product-experience']],
    projectIdea: 'Build with SynapseOne',
    expectedUpdatedAt: '2026-11-28T15:00:00.000Z',
  });
  assert.equal(validateHackathonEditForm(form), null);
});

test('admin editor keeps individual registrations to one person and can clear the idea', () => {
  const form = registrationToEditForm({
    ...teamRow,
    registrationType: 'individual',
    teamName: null,
    memberNames: ['Solo Player'],
    memberYears: [4],
    memberSkills: [['competitive-programming']],
    projectIdea: '',
  });
  form.projectIdea = '   ';
  const payload = editFormToPayload(form);
  assert.equal(payload.registrationType, 'individual');
  assert.equal(payload.teamName, null);
  assert.deepEqual(payload.members, []);
  assert.deepEqual(payload.memberYears, [4]);
  assert.deepEqual(payload.memberSkills, [['competitive-programming']]);
  assert.equal(payload.projectIdea, null);
  assert.equal(validateHackathonEditForm(form), null);
});

test('admin editor rejects invalid team shape, contact data and member years', () => {
  let form = registrationToEditForm(teamRow);
  form.members = [];
  assert.match(validateHackathonEditForm(form), /1–2 thành viên/);
  form = registrationToEditForm(teamRow);
  form.captainEmail = 'invalid';
  assert.match(validateHackathonEditForm(form), /Email/);
  form = registrationToEditForm(teamRow);
  form.members[0].year = '6';
  assert.match(validateHackathonEditForm(form), /năm học/);
});
