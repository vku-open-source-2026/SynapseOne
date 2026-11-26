// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * Default/fallback behavior for the optional IAM audit read path.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditQuery } from './db';

type DbModule = typeof import('./db');
let db: DbModule;
const saved: Record<string, string | undefined> = {};
const orgA = '00000000-0000-4000-8000-000000000001';
const orgB = '00000000-0000-4000-8000-000000000002';
const actor = '00000000-0000-4000-8000-000000000003';

before(async () => {
  for (const key of ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'DATABASE_READ_URL']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  db = await import('./db');
  (db.__mem as any).audit = [
    {
      id: 'audit-a', created_at: '2026-01-02T00:00:00.000Z', org_id: orgA,
      actor_type: 'user', actor_id: actor, action: 'iam:role:create',
      resource: 'role:a', decision: true, context: { org: orgA },
    },
    {
      id: 'audit-b', created_at: '2026-01-03T00:00:00.000Z', org_id: null,
      actor_type: 'user', actor_id: actor, action: 'iam:role:create',
      resource: 'role:b', decision: false, context: { callerOrg: orgA },
    },
    {
      id: 'audit-c', created_at: '2026-01-02T12:00:00.000Z', org_id: orgB,
      actor_type: 'user', actor_id: actor, action: 'iam:role:create',
      resource: 'role:c', decision: true, context: { org: orgB },
    },
    {
      id: 'audit-d', created_at: '2026-01-04T00:00:00.000Z', org_id: orgA,
      actor_type: 'user', actor_id: actor, action: 'iam:role:delete',
      resource: 'role:d', decision: true, context: { org: orgA },
    },
  ];
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('optional audit read path fallback', () => {
  it('uses the unchanged primary/memory behavior when DATABASE_READ_URL is empty', async () => {
    const filter: AuditQuery = {
      orgId: orgA,
      actor,
      allowed: true,
      action: 'iam:role:create',
      resource: 'role:a',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-01-05T00:00:00.000Z'),
      limit: 20,
      offset: 0,
    };
    assert.deepEqual(await db.queryAuditRead(filter), await db.queryAudit(filter));
    assert.equal(await db.countAuditRead(filter), await db.countAudit(filter));
    assert.deepEqual((await db.queryAuditRead(filter)).map((row: any) => row.id), ['audit-a']);
    assert.equal(await db.countAuditRead(filter), 1);
  });

  it('preserves the legacy context tenant fallback and pagination', async () => {
    const filter: AuditQuery = {
      orgId: orgA,
      action: 'iam:role:create',
      from: new Date('2026-01-02T00:00:00.000Z'),
      to: new Date('2026-01-03T00:00:00.000Z'),
      limit: 1,
      offset: 1,
    };
    assert.deepEqual(await db.queryAuditRead(filter), await db.queryAudit(filter));
    assert.deepEqual((await db.queryAuditRead(filter)).map((row: any) => row.id), ['audit-a']);
    assert.equal(await db.countAuditRead({ ...filter, limit: undefined, offset: undefined }), 2);
    assert.deepEqual((await db.queryAuditRead({ ...filter, offset: 0 })).map((row: any) => row.id), ['audit-b']);
  });

  it('never includes another tenant through matching non-tenant filters', async () => {
    const filter: AuditQuery = { orgId: orgA, actor, allowed: true, action: 'iam:role:create' };
    assert.deepEqual((await db.queryAuditRead(filter)).map((row: any) => row.id), ['audit-a']);
    assert.equal(await db.countAuditRead(filter), 1);
  });
});
