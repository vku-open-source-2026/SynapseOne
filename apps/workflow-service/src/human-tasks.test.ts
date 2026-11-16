// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Durable human tasks (#44): create, claim, complete, reject, expire,
 * tenant isolation and exactly-once workflow resume.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { __clearMem } from './store';

const INTERNAL = 'test-secret-123';
const USER = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-user': 'operator@example.com',
  'x-synapseone-org': 'org-a',
  'x-synapseone-account': 'acct-a',
  'x-synapseone-kind': 'user',
};
const OTHER = { ...USER, 'x-synapseone-user': 'other@example.com', 'x-synapseone-org': 'org-b', 'x-synapseone-account': 'acct-b' };
const ADMIN = { ...USER, 'x-synapseone-user': 'admin@example.com' };

function definition() {
  return {
    nodes: [
      { name: 'Start', type: 'manualTrigger', parameters: {} },
      {
        name: 'Approve dispatch',
        type: 'humanTask',
        parameters: {
          title: 'Approve dispatch',
          description: 'Duty manager sign-off',
          candidateRoles: ['duty-manager'],
          deadlineMinutes: 30,
          decisionSchema: { type: 'object', required: ['approved'] },
        },
      },
      { name: 'Apply', type: 'set', parameters: { values: { dispatched: '={{ $json.approved }}' } } },
    ],
    connections: {
      Start: { main: [[{ node: 'Approve dispatch' }]] },
      'Approve dispatch': { main: [[{ node: 'Apply' }]] },
    },
  };
}

describe('durable human tasks (#44)', () => {
  let base = '';
  let server: Server | null = null;

  before(async () => {
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    __clearMem();
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

  async function createPaused(): Promise<{ executionId: string; taskId: string }> {
    const created = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ name: `human-${Math.random().toString(36).slice(2)}`, definition: definition() }),
    });
    assert.equal(created.status, 201);
    const wf: any = await created.json();
    const run = await fetch(`${base}/v1/workflows/${wf.id}/execute`, {
      method: 'POST', headers: USER, body: JSON.stringify({ incident: 'INC-1' }),
    });
    assert.equal(run.status, 202);
    const paused: any = await run.json();
    assert.equal(paused.status, 'paused');
    assert.equal(paused.paused, true);
    assert.ok(paused.taskId);
    return { executionId: paused.executionId, taskId: paused.taskId };
  }

  it('pauses at a human task without running downstream nodes', async () => {
    const { executionId, taskId } = await createPaused();
    const exec = await fetch(`${base}/v1/executions/${executionId}?includeData=true`, { headers: USER });
    assert.equal(exec.status, 200);
    const body: any = await exec.json();
    assert.equal(body.status, 'paused');
    assert.equal(body.nodeRuns.some((n: any) => n.node === 'Apply'), false);

    const task = await fetch(`${base}/v1/human-tasks/${taskId}`, { headers: USER });
    assert.equal(task.status, 200);
    const t: any = await task.json();
    assert.equal(t.task.status, 'pending');
    assert.equal(t.task.assignee, null);
    assert.deepEqual(t.task.candidateRoles, ['duty-manager']);
  });

  it('claims, completes and resumes exactly once', async () => {
    const { executionId, taskId } = await createPaused();
    const claim = await fetch(`${base}/v1/human-tasks/${taskId}/claim`, { method: 'POST', headers: USER, body: '{}' });
    assert.equal(claim.status, 200);
    assert.equal((await claim.json()).task.claimedBy, 'operator@example.com');

    const done = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true }, note: 'approved for dispatch' }),
    });
    assert.equal(done.status, 200);
    const result: any = await done.json();
    assert.equal(result.task.status, 'completed');
    assert.equal(result.resumed.executionId, executionId);
    assert.equal(result.resumed.status, 'success');
    assert.equal(result.resumed.output.dispatched, true);

    const exec = await fetch(`${base}/v1/executions/${executionId}?includeData=true`, { headers: USER });
    const body: any = await exec.json();
    assert.equal(body.status, 'success');
    assert.equal(body.nodeRuns.filter((n: any) => n.node === 'Approve dispatch').length, 1);
    assert.equal(body.nodeRuns.filter((n: any) => n.node === 'Apply').length, 1);

    const again = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, 'already_decided');
  });

  it('rejects with a required note and resumes the rejection branch', async () => {
    const { executionId, taskId } = await createPaused();
    const missing = await fetch(`${base}/v1/human-tasks/${taskId}/reject`, {
      method: 'POST', headers: USER, body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'note_required');

    const rejected = await fetch(`${base}/v1/human-tasks/${taskId}/reject`, {
      method: 'POST', headers: USER, body: JSON.stringify({ note: 'no capacity' }),
    });
    assert.equal(rejected.status, 200);
    const result: any = await rejected.json();
    assert.equal(result.task.status, 'rejected');
    assert.equal(result.resumed.output.dispatched, false);
    const exec = await fetch(`${base}/v1/executions/${executionId}?includeData=true`, { headers: USER });
    assert.equal((await exec.json()).status, 'success');
  });

  it('denies cross-tenant reads and claims without leaking existence', async () => {
    const { taskId } = await createPaused();
    const read = await fetch(`${base}/v1/human-tasks/${taskId}`, { headers: OTHER });
    assert.equal(read.status, 404);
    const claim = await fetch(`${base}/v1/human-tasks/${taskId}/claim`, { method: 'POST', headers: OTHER, body: '{}' });
    assert.equal(claim.status, 404);
    const list = await fetch(`${base}/v1/human-tasks`, { headers: OTHER });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).items, []);
  });

  it('enforces an assignee and expires overdue tasks', async () => {
    const created = await fetch(`${base}/v1/human-tasks`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({
        title: 'Assigned approval', assignee: 'owner@example.com',
        deadline: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    assert.equal(created.status, 201);
    const task: any = (await created.json()).task;
    const wrong = await fetch(`${base}/v1/human-tasks/${task.id}/claim`, { method: 'POST', headers: USER, body: '{}' });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).error, 'not_assignee');

    const own = await fetch(`${base}/v1/human-tasks/${task.id}`, { headers: { ...USER, 'x-synapseone-user': 'owner@example.com' } });
    assert.equal(own.status, 200);
    const expired = await fetch(`${base}/v1/human-tasks/${task.id}/complete`, {
      method: 'POST', headers: { ...USER, 'x-synapseone-user': 'owner@example.com' },
      body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).error, 'task_expired');
  });

  it('lists tasks by tenant and status and audits mutations', async () => {
    const { taskId } = await createPaused();
    const list = await fetch(`${base}/v1/human-tasks?status=pending`, { headers: USER });
    assert.equal(list.status, 200);
    const items: any[] = (await list.json()).items;
    assert.ok(items.some((t) => t.id === taskId));
    assert.ok(items.every((t) => t.orgId === 'org-a'));

    const adminRead = await fetch(`${base}/v1/human-tasks/${taskId}`, { headers: ADMIN });
    assert.equal(adminRead.status, 200);
  });
});
