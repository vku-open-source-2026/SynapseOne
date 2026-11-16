// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __clearMem, createExecutionRec, getExecutionRec, claimExecutionRec,
  heartbeatExecutionRec, releaseExecutionRec, pauseExecutionRec, finishExecutionRec,
  createInferenceJobRec, getInferenceJobRec, claimInferenceJobRec,
  heartbeatInferenceJobRec, releaseInferenceJobRec, finishInferenceJobRec,
} from './store';

const runner = 'registration';
async function execution(extra: Record<string, any> = {}) {
  return createExecutionRec({workflow_id: 'test-workflow', status: 'queued', input: {}, output: null,
    node_runs: [], triggered_by: 'test', startedAt: new Date().toISOString(), ...extra});
}
const finish = {status: 'success' as const, output: {ok: true}, node_runs: [], finishedAt: new Date().toISOString()};

describe('runner lease fencing', () => {
  beforeEach(() => __clearMem());
  it('rejects omitted/wrong instance and stale attempt even on the same connector', async () => {
    const rec = await execution();
    const first = await claimExecutionRec(rec.id, {workerId: runner, instanceId: 'A', leaseSeconds: 60});
    assert.equal(first?.attempt, 1);
    assert.ok(await releaseExecutionRec(rec.id, {workerId: runner, instanceId: 'A', attempt: 1}));
    const current = await claimExecutionRec(rec.id, {workerId: runner, instanceId: 'A', leaseSeconds: 60});
    assert.equal(current?.attempt, 2);
    for (const fence of [{}, {instanceId: 'A'}, {attempt: 2}, {instanceId: 'B', attempt: 2}, {instanceId: 'A', attempt: 1}]) {
      assert.equal(await heartbeatExecutionRec(rec.id, {workerId: runner, leaseSeconds: 60, ...fence}), null);
      assert.equal(await releaseExecutionRec(rec.id, {workerId: runner, ...fence}), null);
      assert.equal(await pauseExecutionRec(rec.id, {workerId: runner, output: {}, node_runs: [], ...fence}), null);
      assert.equal(await finishExecutionRec(rec.id, {...finish, workerId: runner, ...fence}), null);
    }
    assert.equal((await getExecutionRec(rec.id))?.status, 'running');
    assert.ok(await finishExecutionRec(rec.id, {...finish, workerId: runner, instanceId: 'A', attempt: 2}));
  });
  it('cannot revive, release or complete an expired lease before or after reassignment', async () => {
    const rec = await execution({status: 'running', worker_id: runner, runner_instance_id: 'A', attempt: 4, lease_expires_at: new Date(Date.now() - 1000).toISOString()});
    const stale = {workerId: runner, instanceId: 'A', attempt: 4};
    assert.equal(await heartbeatExecutionRec(rec.id, {...stale, leaseSeconds: 60}), null);
    assert.equal(await releaseExecutionRec(rec.id, stale), null);
    assert.equal(await finishExecutionRec(rec.id, {...finish, ...stale}), null);
    assert.equal(await pauseExecutionRec(rec.id, {...stale, output: {}, node_runs: []}), null);
    const current = await claimExecutionRec(rec.id, {workerId: runner, instanceId: 'B', leaseSeconds: 60});
    assert.equal(current?.attempt, 5);
    assert.equal(await finishExecutionRec(rec.id, {...finish, ...stale}), null);
    const live = {workerId: runner, instanceId: 'B', attempt: 5};
    assert.ok(await heartbeatExecutionRec(rec.id, {...live, leaseSeconds: 60}));
    const paused = await pauseExecutionRec(rec.id, {...live, output: {}, node_runs: []});
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.runner_instance_id, null);
    assert.ok(await finishExecutionRec(rec.id, finish));
  });
  it('fences inference mutations on instance, attempt and live lease', async () => {
    const rec = await createInferenceJobRec({queue_name: 'synapseone-inference-system', type: 'embeddings', request: {input: 'test'}});
    const first = await claimInferenceJobRec(rec.id, {runnerId: runner, instanceId: 'A', leaseSeconds: 60});
    assert.equal(first?.attempt, 1);
    assert.ok(await releaseInferenceJobRec(rec.id, {runnerId: runner, instanceId: 'A', attempt: 1}));
    const current = await claimInferenceJobRec(rec.id, {runnerId: runner, instanceId: 'B', leaseSeconds: 60});
    assert.equal(current?.attempt, 2);
    for (const fence of [{}, {instanceId: 'B'}, {attempt: 2}, {instanceId: 'A', attempt: 1}, {instanceId: 'B', attempt: 1}]) {
      assert.equal(await heartbeatInferenceJobRec(rec.id, {runnerId: runner, leaseSeconds: 60, ...fence}), null);
      assert.equal(await releaseInferenceJobRec(rec.id, {runnerId: runner, ...fence}), null);
      assert.equal(await finishInferenceJobRec(rec.id, {runnerId: runner, status: 'success', result: {}, ...fence}), null);
    }
    assert.equal((await getInferenceJobRec(rec.id))?.status, 'running');
    assert.ok(await finishInferenceJobRec(rec.id, {runnerId: runner, instanceId: 'B', attempt: 2, status: 'success', result: {real: true}}));
  });
  it('does not let a different registration claim a targeted self-test', async () => {
    const rec = await execution({target_runner_id: runner});
    assert.equal((await getExecutionRec(rec.id))?.target_runner_id, runner);
    assert.equal(await claimExecutionRec(rec.id, {workerId: 'other', instanceId: 'X', leaseSeconds: 60}), null);
    assert.ok(await claimExecutionRec(rec.id, {workerId: runner, instanceId: 'A', leaseSeconds: 60}));
    const job = await createInferenceJobRec({queue_name: 'synapseone-inference-system', type: 'embeddings', request: {}, target_runner_id: runner});
    assert.equal((await getInferenceJobRec(job.id))?.target_runner_id, runner);
    assert.equal(await claimInferenceJobRec(job.id, {runnerId: 'other', instanceId: 'X', leaseSeconds: 60}), null);
    assert.ok(await claimInferenceJobRec(job.id, {runnerId: runner, instanceId: 'A', leaseSeconds: 60}));
  });
  it('rejects every inference mutation once its lease has expired', async (t) => {
    t.mock.timers.enable({apis: ['Date'], now: Date.now()});
    const rec = await createInferenceJobRec({queue_name: 'synapseone-inference-system', type: 'embeddings', request: {}});
    assert.ok(await claimInferenceJobRec(rec.id, {runnerId: runner, instanceId: 'A', leaseSeconds: 15}));
    t.mock.timers.tick(16000);
    const stale = {runnerId: runner, instanceId: 'A', attempt: 1};
    assert.equal(await heartbeatInferenceJobRec(rec.id, {...stale, leaseSeconds: 60}), null);
    assert.equal(await releaseInferenceJobRec(rec.id, stale), null);
    assert.equal(await finishInferenceJobRec(rec.id, {...stale, status: 'success', result: {}}), null);
    const current = await claimInferenceJobRec(rec.id, {runnerId: runner, instanceId: 'B', leaseSeconds: 60});
    assert.equal(current?.attempt, 2);
    assert.equal(await finishInferenceJobRec(rec.id, {...stale, status: 'success', result: {}}), null);
    assert.ok(await finishInferenceJobRec(rec.id, {runnerId: runner, instanceId: 'B', attempt: 2, status: 'success', result: {ok: true}}));
    t.mock.timers.reset();
  });
  it('preserves the in-process worker path for executions without connector instances', async () => {
    const rec = await execution();
    assert.ok(await claimExecutionRec(rec.id, {workerId: 'builtin', leaseSeconds: 60}));
    assert.ok(await heartbeatExecutionRec(rec.id, {workerId: 'builtin', leaseSeconds: 60}));
    assert.ok(await finishExecutionRec(rec.id, {...finish, workerId: 'builtin'}));
  });
});
