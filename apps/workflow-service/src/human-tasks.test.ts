// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Durable human tasks (#44): create, claim, complete, reject, expire,
 * tenant isolation and exactly-once workflow resume.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp, reclaimWorkflowStateOnce } from './index';
import { __clearMem, createExecutionRec, createHumanTaskRec, transitionHumanTaskRec } from './store';

const INTERNAL = 'test-secret-123';
const USER = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-user': 'operator@example.com',
  'x-synapseone-org': 'org-a',
  'x-synapseone-account': 'acct-a',
  'x-synapseone-kind': 'user',
  'x-synapseone-roles': 'duty-manager',
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

  async function createPaused(override?: any): Promise<{ executionId: string; taskId: string; workflowId: string }> {
    const created = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ name: `human-${Math.random().toString(36).slice(2)}`, definition: override ?? definition() }),
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
    return { executionId: paused.executionId, taskId: paused.taskId, workflowId: wf.id };
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

  it('fails closed for legacy paused runs without a checkpoint binding', async () => {
    const execution = await createExecutionRec({
      workflow_id: 'legacy-unbound',
      workflow_name: 'legacy-unbound',
      status: 'paused',
      input: {},
      output: { humanTask: { id: 'synthetic' } },
      node_runs: [],
      triggered_by: 'manual',
      principal: { sub: 'operator@example.com', org: 'org-a', account: 'acct-a', kind: 'user' },
      startedAt: new Date().toISOString(),
    });
    const task = await createHumanTaskRec({
      execution_id: execution.id,
      workflow_id: null,
      node_name: 'Apply',
      title: 'Legacy approval',
      assignee: 'operator@example.com',
      org_id: 'org-a',
      account_id: 'acct-a',
    });
    const denied = await fetch(`${base}/v1/human-tasks/${task.id}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, 'not_pause_checkpoint');
    const after = await fetch(`${base}/v1/executions/${execution.id}`, { headers: USER });
    assert.equal((await after.json()).status, 'paused');
  });

  it('refuses to fabricate a second approval for a paused execution', async () => {
    const { executionId, taskId } = await createPaused();
    const forged = await fetch(`${base}/v1/human-tasks`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({
        executionId,
        node: 'Apply',
        title: 'Bypass approval',
        assignee: 'operator@example.com',
        decision: { approved: true },
      }),
    });
    assert.equal(forged.status, 409);
    assert.equal((await forged.json()).error, 'pause_checkpoint_exists');

    // The original checkpoint remains the only way to resume the execution.
    const done = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).resumed.status, 'success');
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

  it('enforces candidate roles on unassigned tasks', async () => {
    const { taskId } = await createPaused();
    const noRole = { ...USER, 'x-synapseone-user': 'member@example.com', 'x-synapseone-roles': 'viewer' };
    const denied = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: noRole, body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'not_assignee');

    const allowed = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(allowed.status, 200);
  });

  it('binds a second pause to its own task and node', async () => {
    const twoStep = {
      nodes: [
        { name: 'Start', type: 'manualTrigger', parameters: {} },
        { name: 'First approval', type: 'humanTask', parameters: { title: 'First approval', candidateRoles: ['duty-manager'] } },
        { name: 'Second approval', type: 'humanTask', parameters: { title: 'Second approval', candidateRoles: ['duty-manager'] } },
        { name: 'Apply', type: 'set', parameters: { values: { done: true } } },
      ],
      connections: {
        Start: { main: [[{ node: 'First approval' }]] },
        'First approval': { main: [[{ node: 'Second approval' }]] },
        'Second approval': { main: [[{ node: 'Apply' }]] },
      },
    };
    const created = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ name: `bind-${Date.now().toString(36)}`, definition: twoStep }),
    });
    assert.equal(created.status, 201);
    const wf: any = await created.json();
    const run: any = await (await fetch(`${base}/v1/workflows/${wf.id}/execute`, {
      method: 'POST', headers: USER, body: JSON.stringify({ incident: 'INC-3' }),
    })).json();
    assert.equal(run.status, 'paused');
    const first: any = await (await fetch(`${base}/v1/human-tasks/${run.taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    })).json();
    assert.equal(first.resumed.status, 'paused');
    assert.ok(first.resumed.taskId);

    // The old (first) task may not be replayed against the second pause.
    const replay = await fetch(`${base}/v1/human-tasks/${run.taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(replay.status, 409);

    const second: any = await (await fetch(`${base}/v1/human-tasks/${first.resumed.taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    })).json();
    assert.equal(second.resumed.status, 'success');
    assert.equal(second.resumed.output.done, true);
  });

  it('keeps a second human-task step durable after an inline resume', async () => {
    const twoStep = {
      nodes: [
        { name: 'Start', type: 'manualTrigger', parameters: {} },
        { name: 'First approval', type: 'humanTask', parameters: { title: 'First approval', candidateRoles: ['duty-manager'] } },
        { name: 'Second approval', type: 'humanTask', parameters: { title: 'Second approval', candidateRoles: ['duty-manager'] } },
        { name: 'Apply', type: 'set', parameters: { values: { done: true } } },
      ],
      connections: {
        Start: { main: [[{ node: 'First approval' }]] },
        'First approval': { main: [[{ node: 'Second approval' }]] },
        'Second approval': { main: [[{ node: 'Apply' }]] },
      },
    };
    const created = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ name: `two-step-${Date.now().toString(36)}`, definition: twoStep }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const wf: any = JSON.parse(createdText);
    const run: any = await (await fetch(`${base}/v1/workflows/${wf.id}/execute`, {
      method: 'POST', headers: USER, body: JSON.stringify({ incident: 'INC-2' }),
    })).json();
    assert.equal(run.status, 'paused');
    const first = await fetch(`${base}/v1/human-tasks/${run.taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    const firstText = await first.text();
    assert.equal(first.status, 200, firstText);
    const firstBody: any = JSON.parse(firstText);
    assert.equal(firstBody.resumed.status, 'paused');
    assert.ok(firstBody.resumed.taskId);

    const second = await fetch(`${base}/v1/human-tasks/${firstBody.resumed.taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    const secondText = await second.text();
    assert.equal(second.status, 200, secondText);
    const secondBody: any = JSON.parse(secondText);
    assert.equal(secondBody.resumed.status, 'success');
    assert.equal(secondBody.resumed.output.done, true);
    const exec: any = await (await fetch(`${base}/v1/executions/${run.executionId}?includeData=true`, { headers: USER })).json();
    assert.equal(exec.status, 'success');
    assert.equal(exec.nodeRuns.filter((n: any) => n.node === 'Apply').length, 1);
  });

  it('cancels a paused execution and closes its checkpoint task', async () => {
    const { executionId, taskId } = await createPaused();
    const cancelled = await fetch(`${base}/v1/executions/${executionId}/cancel`, {
      method: 'POST', headers: USER, body: JSON.stringify({ reason: 'operator cancelled' }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).status, 'cancelled');
    const task: any = await (await fetch(`${base}/v1/human-tasks/${taskId}`, { headers: USER })).json();
    assert.equal(task.task.status, 'cancelled');
    const approve = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(approve.status, 409);
  });

  it('expires an overdue task and terminates its paused execution', async () => {
    const { executionId, taskId } = await createPaused();
    const expired = await fetch(`${base}/v1/human-tasks/${taskId}/expire`, {
      method: 'POST', headers: USER, body: JSON.stringify({ force: true }),
    });
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).task.status, 'expired');
    const exec: any = await (await fetch(`${base}/v1/executions/${executionId}?includeData=true`, { headers: USER })).json();
    assert.equal(exec.status, 'error');
    assert.match(exec.error, /expired/);
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
  it('reconciles a decision stuck between reservation and dispatch', async () => {
    const { executionId, taskId } = await createPaused();
    const reserved = await transitionHumanTaskRec(taskId, ['pending'], {
      status: 'resuming',
      decision: { approved: true },
    });
    assert.ok(reserved);
    await new Promise((r) => setTimeout(r, 5));
    const reconciled = await reclaimWorkflowStateOnce({ resumeStaleMs: 0 });
    assert.ok(reconciled.reconciledTasks >= 1, JSON.stringify(reconciled));
    const task: any = await (await fetch(`${base}/v1/human-tasks/${taskId}`, { headers: USER })).json();
    assert.equal(task.task.status, 'pending');
    const approved = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    assert.equal(approved.status, 200, await approved.text());
    const exec: any = await (await fetch(`${base}/v1/executions/${executionId}?includeData=true`, { headers: USER })).json();
    assert.equal(exec.status, 'success');
  });

  it('refuses an inline resume after the workflow revision changed', async () => {
    const { executionId, taskId, workflowId } = await createPaused();
    const changed = definition();
    (changed.nodes[2] as any).parameters.values.dispatched = '={{ $json.approved }}-v2';
    const edited = await fetch(`${base}/v1/workflows/${workflowId}`, {
      method: 'PUT', headers: USER,
      body: JSON.stringify({ definition: changed }),
    });
    assert.equal(edited.status, 200, await edited.text());
    const approved = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    const revisionText = await approved.text();
    assert.equal(approved.status, 409, revisionText);
    assert.equal(JSON.parse(revisionText).error, 'workflow_revision_conflict');
    const exec: any = await (await fetch(`${base}/v1/executions/${executionId}?includeData=true`, { headers: USER })).json();
    assert.equal(exec.status, 'paused');
  });

  it('terminates a paused execution when a late approval hits its deadline', async () => {
    const late = definition();
    const taskNode: any = late.nodes.find((node: any) => node.type === 'humanTask');
    delete taskNode.parameters.deadlineMinutes;
    taskNode.parameters.deadlineAt = new Date(Date.now() - 60_000).toISOString();
    const { executionId, taskId } = await createPaused(late);
    const approved = await fetch(`${base}/v1/human-tasks/${taskId}/complete`, {
      method: 'POST', headers: USER, body: JSON.stringify({ decision: { approved: true } }),
    });
    const lateText = await approved.text();
    assert.equal(approved.status, 409, lateText);
    assert.equal(JSON.parse(lateText).error, 'task_expired');
    const exec: any = await (await fetch(`${base}/v1/executions/${executionId}?includeData=true`, { headers: USER })).json();
    assert.equal(exec.status, 'error');
    assert.match(exec.error, /expired/);
  });

  it('refuses to delete a workflow with an active execution', async () => {
    const { workflowId } = await createPaused();
    const deleted = await fetch(`${base}/v1/workflows/${workflowId}`, { method: 'DELETE', headers: USER });
    const deletedText = await deleted.text();
    assert.equal(deleted.status, 409, deletedText);
    assert.equal(JSON.parse(deletedText).error, 'workflow_has_active_executions');
  });

});
