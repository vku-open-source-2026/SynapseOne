// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Postgres reservation transaction tests. Opt in only against a disposable DB:
 * WORKFLOW_TEST_DATABASE_URL=postgresql://... node --test dist/reservations-postgres.test.js
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const TEST_URL = String(process.env.WORKFLOW_TEST_DATABASE_URL || '').trim();
let store: typeof import('./store');

before(async () => {
  if (!TEST_URL) return;
  process.env.DATABASE_URL = TEST_URL;
  process.env.DATABASE_DIRECT_URL = TEST_URL;
  store = await import('./store');
  await store.ensureTables();
});

function definition(kind: 'webhook' | 'mcp', name: string) {
  return {
    nodes: [
      kind === 'webhook'
        ? { name: 'Hook', type: 'webhook', parameters: { path: name, httpMethod: 'POST' } }
        : { name: 'Tool', type: 'mcpTrigger', parameters: { toolName: name, public: true, readOnly: true } },
      { name: 'Done', type: 'noOp', parameters: {} },
    ],
    connections: kind === 'webhook'
      ? { Hook: { main: [[{ node: 'Done' }]] } }
      : { Tool: { main: [[{ node: 'Done' }]] } },
  };
}

describe('global active workflow reservations (Postgres)', { skip: TEST_URL ? false : 'WORKFLOW_TEST_DATABASE_URL not set' }, () => {
  let sequence = 0;
  const suffix = () => `${Date.now().toString(36)}-${process.pid}-${++sequence}`;
  async function create(kind: 'webhook' | 'mcp', name: string, org: string, account: string) {
    const def = definition(kind, name);
    return store.createWorkflowRec({ name, nodes: def.nodes, connections: def.connections, org_id: org, account_id: account });
  }

  it('rejects a cross-tenant active definition update without changing the graph', async () => {
    const path = `victim-${suffix()}`;
    const victim = await create('webhook', path, 'org-a', 'acc-a');
    const attackerPath = `attacker-${suffix()}`;
    const attacker = await create('webhook', attackerPath, 'org-b', 'acc-b');
    try {
      assert.ok(await store.updateWorkflowRec(victim.id, { active: true }));
      assert.ok(await store.updateWorkflowRec(attacker.id, { active: true }));
      const def = definition('webhook', path);
      await assert.rejects(
        () => store.updateWorkflowRec(attacker.id, { nodes: def.nodes, connections: def.connections }),
        (error: any) => error?.status === 409 && error?.code === 'webhook_path_conflict',
      );
      assert.equal((await store.getWorkflowRec(attacker.id))?.nodes[0].parameters.path, attackerPath);
    } finally {
      await store.deleteWorkflowRec(victim.id);
      await store.deleteWorkflowRec(attacker.id);
    }
  });

  it('allows one winner under concurrent cross-tenant webhook activations', async () => {
    const path = `race-${suffix()}`;
    const a = await create('webhook', path, 'org-a', 'acc-a');
    const b = await create('webhook', path, 'org-b', 'acc-b');
    try {
      const results = await Promise.allSettled([
        store.updateWorkflowRec(a.id, { active: true }),
        store.updateWorkflowRec(b.id, { active: true }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const denied = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      assert.equal(denied?.reason?.code, 'webhook_path_conflict');
      const winner = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
      assert.equal((await store.findActiveWebhookWorkflow(path))?.id, winner.value.id);
    } finally {
      await store.deleteWorkflowRec(a.id);
      await store.deleteWorkflowRec(b.id);
    }
  });

  it('allows one winner under concurrent cross-tenant public MCP activations', async () => {
    const toolName = `race_${suffix().replace(/\W/g, '_')}`;
    const a = await create('mcp', toolName, 'org-a', 'acc-a');
    const b = await create('mcp', toolName, 'org-b', 'acc-b');
    try {
      const results = await Promise.allSettled([
        store.updateWorkflowRec(a.id, { active: true }),
        store.updateWorkflowRec(b.id, { active: true }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const denied = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      assert.equal(denied?.reason?.code, 'mcp_tool_conflict');
    } finally {
      await store.deleteWorkflowRec(a.id);
      await store.deleteWorkflowRec(b.id);
    }
  });

  it('fails closed when the reservation table cannot be updated', async () => {
    const workflow = await create('webhook', `failure-${suffix()}`, 'org-a', 'acc-a');
    const pool = new Pool({ connectionString: TEST_URL });
    try {
      await pool.query('alter table synapseone_workflow_reservations rename to synapseone_workflow_reservations_unavailable');
      await assert.rejects(() => store.updateWorkflowRec(workflow.id, { active: true }), /synapseone_workflow_reservations/);
      assert.equal((await store.getWorkflowRec(workflow.id))?.active, false, 'failed reservation write must roll back activation');
    } finally {
      await pool.query('alter table synapseone_workflow_reservations_unavailable rename to synapseone_workflow_reservations').catch(() => undefined);
      await pool.end();
      await store.deleteWorkflowRec(workflow.id);
    }
  });
});
