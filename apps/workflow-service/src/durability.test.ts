// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Durable execution semantics: graph-only revisions, expired-lease reclaim,
 * human-task deadlines and per-tenant admission accounting.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __clearMem, createWorkflowRec, getWorkflowRec, updateWorkflowRec, createExecutionRec,
  claimExecutionRec, listExpiredRunningExecutions, reclaimExpiredExecution,
  createHumanTaskRec, listOverdueHumanTasks, transitionHumanTaskRec,
  countActiveExecutionsForTenant,
} from './store';

const TENANT = { sub: 'user-1', org: 'org-durable', account: 'acc-durable', kind: 'user' };

describe('durable workflow state', () => {
  beforeEach(() => __clearMem());

  async function workflow(name = 'revision-flow') {
    return createWorkflowRec({
      name,
      nodes: [{ name: 'Start', type: 'manualTrigger', parameters: {} }],
      connections: {},
      settings: { execution: { mode: 'system' } },
      org_id: 'org-durable',
      account_id: 'acc-durable',
    } as any);
  }

  it('bumps revision only when the executable graph changes', async () => {
    const wf = await workflow();
    assert.equal(wf.revision, 1);
    const renamed = await updateWorkflowRec(wf.id, { name: 'renamed' });
    assert.equal(renamed!.revision, 1);
    const activated = await updateWorkflowRec(wf.id, { active: true });
    assert.equal(activated!.revision, 1);
    const edited = await updateWorkflowRec(wf.id, {
      nodes: [...wf.nodes, { name: 'Extra', type: 'noOp', parameters: {} }],
    });
    assert.equal(edited!.revision, 2);
    const again = await updateWorkflowRec(wf.id, { name: 'renamed twice' });
    assert.equal(again!.revision, 2);
    assert.equal((await getWorkflowRec(wf.id))!.revision, 2);
  });

  it('reclaims expired running leases and keeps queued rows claimable', async () => {
    const wf = await workflow('lease-flow');
    const started = new Date(Date.now() - 600_000).toISOString();
    const exec = await createExecutionRec({
      workflow_id: wf.id,
      workflow_name: wf.name,
      status: 'running',
      input: {},
      output: null,
      node_runs: [],
      triggered_by: 'manual',
      principal: TENANT,
      startedAt: started,
      queue_name: 'synapseone-wf-system',
      runner: 'system',
      worker_id: 'dead-runner',
      runner_instance_id: 'dead-instance',
      attempt: 1,
      lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const expired = await listExpiredRunningExecutions(10);
    assert.ok(expired.some((e) => e.id === exec.id));
    const reclaimed = await reclaimExpiredExecution(exec.id);
    assert.equal(reclaimed!.status, 'queued');
    assert.equal(reclaimed!.worker_id, null);
    const claimed = await claimExecutionRec(exec.id, { workerId: 'live-runner', instanceId: 'live-instance', leaseSeconds: 60 });
    assert.equal(claimed!.status, 'running');
    assert.equal(claimed!.attempt, 2);
  });

  it('lists overdue human tasks and counts per-tenant active work', async () => {
    const wf = await workflow('task-flow');
    const exec = await createExecutionRec({
      workflow_id: wf.id, workflow_name: wf.name, status: 'paused', input: {}, output: null,
      node_runs: [], triggered_by: 'manual', principal: TENANT, startedAt: new Date().toISOString(),
      runner: 'inline',
    });
    const task = await createHumanTaskRec({
      execution_id: exec.id, workflow_id: wf.id, title: 'Overdue', candidate_roles: ['duty-manager'],
      deadline: new Date(Date.now() - 1000).toISOString(), org_id: TENANT.org, account_id: TENANT.account,
    });
    const overdue = await listOverdueHumanTasks(10);
    assert.ok(overdue.some((t) => t.id === task.id));
    const expired = await transitionHumanTaskRec(task.id, ['pending', 'claimed'], {
      status: 'expired', escalated_at: new Date().toISOString(),
    });
    assert.equal(expired!.status, 'expired');
    // Paused work is not part of the queued+running admission budget.
    assert.equal(await countActiveExecutionsForTenant('org:org-durable'), 0);
    await createExecutionRec({
      workflow_id: wf.id, workflow_name: wf.name, status: 'queued', input: {}, output: null,
      node_runs: [], triggered_by: 'manual', principal: TENANT, startedAt: new Date().toISOString(),
      runner: 'system', queue_name: 'synapseone-wf-system',
    });
    assert.equal(await countActiveExecutionsForTenant('org:org-durable'), 1);
  });
});
