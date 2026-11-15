// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Atomic runner CPU/RAM admission.
 *
 * Memory mode always runs. Postgres mode runs when
 * WORKFLOW_TEST_DATABASE_URL points at a disposable database; the same test
 * file proves the advisory-lock transaction under concurrent claims.
 */
import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_URL = String(process.env.WORKFLOW_TEST_DATABASE_URL || '').trim();
let store: typeof import('./store');

before(async () => {
  // store.ts reads DATABASE_URL at module load, so set it before the dynamic
  // import. Never default to a production URL: Postgres tests are opt-in.
  if (TEST_URL) {
    process.env.DATABASE_URL = TEST_URL;
    process.env.DATABASE_DIRECT_URL = TEST_URL;
  }
  store = await import('./store');
});

const RUNNER = 'capacity-registration';
const INSTANCE = 'capacity-instance';

interface SampleOptions {
  sampledAt?: number;
  cpuLimit?: number;
  cpuUsed?: number;
  memLimit?: number;
  memUsed?: number;
}

function resourceSample(options: SampleOptions = {}): Record<string, any> {
  const cpuLimit = options.cpuLimit ?? 1;
  const cpuUsed = Math.min(options.cpuUsed ?? 0, cpuLimit);
  const memLimit = options.memLimit ?? 1024;
  const memUsed = Math.min(options.memUsed ?? 100, memLimit);
  return {
    sampledAt: new Date(options.sampledAt ?? Date.now()).toISOString(),
    observedAt: new Date(options.sampledAt ?? Date.now()).toISOString(),
    source: 'cgroup-v2',
    cpu: {
      limitCores: cpuLimit,
      usedCores: cpuUsed,
      percent: cpuLimit > 0 ? Math.round((cpuUsed / cpuLimit) * 1000) / 10 : 0,
      availableCores: Math.max(0, Math.round((cpuLimit - cpuUsed) * 1000) / 1000),
    },
    memory: {
      limitMb: memLimit,
      usedMb: memUsed,
      availableMb: Math.max(0, memLimit - memUsed),
    },
  };
}

function capacityError(code: string) {
  return (error: any): boolean => {
    assert.equal(error?.status, 409);
    assert.equal(error?.code, code);
    assert.equal(typeof error?.message, 'string');
    return true;
  };
}

async function execution(requirements: { cpu: number; memoryMb: number }, extra: Record<string, any> = {}) {
  return store.createExecutionRec({
    workflow_id: 'capacity-workflow',
    status: 'queued',
    input: {},
    output: null,
    node_runs: [],
    triggered_by: 'test',
    startedAt: new Date().toISOString(),
    resource_requirements: requirements,
    ...extra,
  });
}

async function inference(requirements: { cpu: number; memoryMb: number }) {
  return store.createInferenceJobRec({
    queue_name: 'synapseone-inference-capacity-test',
    type: 'embeddings',
    request: { input: 'capacity' },
    resource_requirements: requirements,
  });
}

async function registerInstance(
  metadata: Record<string, any>,
  runnerId = RUNNER,
  instanceId = INSTANCE,
  concurrency = 1,
) {
  return store.upsertRunnerInstance({
    id: instanceId,
    runner_id: runnerId,
    hostname: 'capacity-host',
    queue: 'capacity-queue',
    concurrency,
    metadata,
  });
}

function claimExecution(id: string, extra: Record<string, any> = {}) {
  return store.claimExecutionRec(id, {
    workerId: RUNNER,
    instanceId: INSTANCE,
    leaseSeconds: 60,
    enforceCapacity: true,
    ...extra,
  });
}

function claimInference(id: string, extra: Record<string, any> = {}) {
  return store.claimInferenceJobRec(id, {
    runnerId: RUNNER,
    instanceId: INSTANCE,
    leaseSeconds: 60,
    enforceCapacity: true,
    ...extra,
  });
}

describe('runner capacity admission (in-memory)', { skip: TEST_URL ? 'WORKFLOW_TEST_DATABASE_URL is set' : false }, () => {
  beforeEach(() => {
    store.__clearMem();
  });

  it('stores incremental resource requirements on create and maps them back', async () => {
    const exec = await execution({ cpu: 0.75, memoryMb: 384 });
    assert.deepEqual((await store.getExecutionRec(exec.id))?.resource_requirements, { cpu: 0.75, memoryMb: 384 });
    const job = await inference({ cpu: 1, memoryMb: 256 });
    assert.deepEqual((await store.getInferenceJobRec(job.id))?.resource_requirements, { cpu: 1, memoryMb: 256 });
  });

  it('fails closed when the platform instance has no resource telemetry', async () => {
    await registerInstance({});
    const exec = await execution({ cpu: 0.5, memoryMb: 128 });
    await assert.rejects(() => claimExecution(exec.id), capacityError('runner_resources_unavailable'));
    assert.equal((await store.getExecutionRec(exec.id))?.status, 'queued');
  });

  it('rejects a sample older than 45 seconds and admits a fresh one', async () => {
    await registerInstance({ resources: resourceSample({ sampledAt: Date.now() - 46_000 }) });
    const stale = await execution({ cpu: 0.5, memoryMb: 128 });
    await assert.rejects(() => claimExecution(stale.id), capacityError('runner_resources_unavailable'));
    assert.equal((await store.getExecutionRec(stale.id))?.status, 'queued');

    await registerInstance({ resources: resourceSample({ sampledAt: Date.now() - 40_000 }) });
    const fresh = await execution({ cpu: 0.5, memoryMb: 128 });
    assert.ok(await claimExecution(fresh.id));
  });

  it('uses the runner observation clock even when the heartbeat receipt is fresh', async () => {
    const observed = new Date(Date.now() - 60_000).toISOString();
    await registerInstance({
      heartbeatIntervalSeconds: 15,
      resources: { ...resourceSample(), sampledAt: new Date().toISOString(), observedAt: observed },
    });
    const exec = await execution({ cpu: 0.5, memoryMb: 128 });
    await assert.rejects(() => claimExecution(exec.id), capacityError('runner_resources_unavailable'));
    assert.equal((await store.getExecutionRec(exec.id))?.status, 'queued');
    assert.equal((await store.listRunnerInstances(RUNNER))[0].metadata.resources.observedAt, observed);
  });

  it('scales the freshness window with the instance heartbeat interval', async () => {
    await registerInstance({
      heartbeatIntervalSeconds: 60,
      resources: resourceSample({ sampledAt: Date.now() - 46_000 }),
    });
    const slow = await execution({ cpu: 0.5, memoryMb: 128 });
    assert.ok(await claimExecution(slow.id), '60 s interval gives a 180 s window');

    await registerInstance({
      heartbeatIntervalSeconds: 5,
      resources: resourceSample({ sampledAt: Date.now() - 46_000 }),
    }, RUNNER, INSTANCE, 2);
    const fast = await execution({ cpu: 0.5, memoryMb: 128 });
    await assert.rejects(() => claimExecution(fast.id), capacityError('runner_resources_unavailable'));
  });

  it('refuses telemetry with no measured source instead of relabelling it as host', async () => {
    await registerInstance({ resources: { ...resourceSample(), source: 'unknown' } });
    const exec = await execution({ cpu: 0.5, memoryMb: 128 });
    await assert.rejects(() => claimExecution(exec.id), capacityError('runner_resources_unavailable'));
  });

  it('serializes CPU reservations and reclaims them after release', async () => {
    await registerInstance({ resources: resourceSample({ cpuLimit: 2, cpuUsed: 0, memLimit: 4096, memUsed: 512 }) }, RUNNER, INSTANCE, 8);
    const first = await execution({ cpu: 1, memoryMb: 128 });
    const second = await execution({ cpu: 1, memoryMb: 128 });

    const claimed = await claimExecution(first.id);
    assert.equal(claimed?.attempt, 1);
    await assert.rejects(async () => {
      try {
        await claimExecution(second.id);
      } catch (e: any) {
        assert.ok(e.available.cpu < 1, `expected less than one free core, got ${e.available.cpu}`);
        assert.equal(e.required.cpu, 1);
        throw e;
      }
    }, capacityError('runner_capacity_unavailable'));
    assert.equal((await store.getExecutionRec(second.id))?.status, 'queued');

    assert.ok(await store.releaseExecutionRec(first.id, {
      workerId: RUNNER, instanceId: INSTANCE, attempt: claimed?.attempt,
    }));
    assert.ok(await claimExecution(second.id));
  });

  it('serializes RAM reservations and reclaims them after finish', async () => {
    await registerInstance({ resources: resourceSample({ cpuLimit: 4, cpuUsed: 0, memLimit: 1024, memUsed: 100 }) }, RUNNER, INSTANCE, 8);
    const first = await execution({ cpu: 0.1, memoryMb: 512 });
    const second = await execution({ cpu: 0.1, memoryMb: 512 });

    assert.ok(await claimExecution(first.id));
    await assert.rejects(async () => {
      try {
        await claimExecution(second.id);
      } catch (e: any) {
        assert.equal(e.required.memoryMb, 512);
        assert.ok(e.available.memoryMb < 512, `expected less than 512 MiB free, got ${e.available.memoryMb}`);
        throw e;
      }
    }, capacityError('runner_capacity_unavailable'));

    assert.ok(await store.finishExecutionRec(first.id, {
      status: 'success', output: null, node_runs: [], finishedAt: new Date().toISOString(),
      workerId: RUNNER, instanceId: INSTANCE, attempt: 1,
    }));
    assert.ok(await claimExecution(second.id));
  });

  it('shares one reservation pool across workflow and inference lanes', async () => {
    await registerInstance({
      resources: resourceSample({ cpuLimit: 1, cpuUsed: 0, memLimit: 4096, memUsed: 512 }),
      inferenceConcurrency: 8,
    }, RUNNER, INSTANCE, 8);
    const exec = await execution({ cpu: 0.6, memoryMb: 128 });
    const job = await inference({ cpu: 0.5, memoryMb: 256 });

    assert.ok(await claimExecution(exec.id));
    await assert.rejects(() => claimInference(job.id), capacityError('runner_capacity_unavailable'));
    assert.equal((await store.getInferenceJobRec(job.id))?.status, 'queued');

    assert.ok(await store.finishExecutionRec(exec.id, {
      status: 'success', output: null, node_runs: [], finishedAt: new Date().toISOString(),
      workerId: RUNNER, instanceId: INSTANCE, attempt: 1,
    }));
    assert.ok(await claimInference(job.id));
  });

  it('excludes expired leases from reservations and admits the next job', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await registerInstance({ resources: resourceSample({ cpuLimit: 2, cpuUsed: 0, memLimit: 4096, memUsed: 512 }) }, RUNNER, INSTANCE, 8);
      const first = await execution({ cpu: 1, memoryMb: 128 });
      const second = await execution({ cpu: 1, memoryMb: 128 });

      assert.ok(await claimExecution(first.id, { leaseSeconds: 15 }));
      await assert.rejects(() => claimExecution(second.id), capacityError('runner_capacity_unavailable'));

      t.mock.timers.tick(16_000);
      assert.ok(await claimExecution(second.id));
    } finally {
      t.mock.timers.reset();
    }
  });

  it('caps workflow claims at the instance-reported lane concurrency even with ample CPU/RAM', async () => {
    await registerInstance({ resources: resourceSample({ cpuLimit: 8, cpuUsed: 0, memLimit: 16384, memUsed: 512 }) }, RUNNER, INSTANCE, 2);
    const jobs = await Promise.all(Array.from({ length: 4 }, () => execution({ cpu: 0.05, memoryMb: 64 })));
    const results = await Promise.allSettled(jobs.map((job) => claimExecution(job.id)));
    const won = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled' && !!result.value);
    const denied = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(won.length, 2, 'only the instance-reported two workflow slots may win');
    assert.equal(denied.length, 2);
    for (const denial of denied) {
      assert.equal(denial.reason?.status, 409);
      assert.equal(denial.reason?.code, 'runner_capacity_unavailable');
      assert.equal(denial.reason?.lane, 'workflow');
      assert.equal(denial.reason?.limit, 2);
      assert.equal(denial.reason?.active, 2);
    }
    for (const job of jobs) {
      const row = await store.getExecutionRec(job.id);
      const claimed = won.some((result) => result.value.id === job.id);
      assert.equal(row?.status, claimed ? 'running' : 'queued');
    }
  });

  it('restores the workflow lane slot after release and finish, using the reported concurrency', async () => {
    // The owner's generated-command preference says 32, but the live instance
    // reported 1: server authority follows the live instance, not desired config.
    await registerInstance({
      resources: resourceSample({ cpuLimit: 8, cpuUsed: 0, memLimit: 16384, memUsed: 512 }),
      dockerResources: { concurrency: 32 },
    }, RUNNER, INSTANCE, 1);
    const a = await execution({ cpu: 0.05, memoryMb: 64 });
    const b = await execution({ cpu: 0.05, memoryMb: 64 });
    const c = await execution({ cpu: 0.05, memoryMb: 64 });

    const first = await claimExecution(a.id);
    assert.ok(first);
    await assert.rejects(async () => {
      try {
        await claimExecution(b.id);
      } catch (error: any) {
        assert.equal(error.code, 'runner_capacity_unavailable');
        assert.equal(error.lane, 'workflow');
        assert.equal(error.limit, 1, 'pending dockerResources.concurrency must not widen a live slot');
        throw error;
      }
    }, capacityError('runner_capacity_unavailable'));

    assert.ok(await store.releaseExecutionRec(a.id, {
      workerId: RUNNER, instanceId: INSTANCE, attempt: first?.attempt,
    }));
    const second = await claimExecution(b.id);
    assert.ok(second);

    assert.ok(await store.finishExecutionRec(b.id, {
      status: 'success', output: null, node_runs: [], finishedAt: new Date().toISOString(),
      workerId: RUNNER, instanceId: INSTANCE, attempt: second?.attempt,
    }));
    assert.ok(await claimExecution(c.id));
  });

  it('frees the workflow lane slot when the running lease expires', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await registerInstance({ resources: resourceSample({ cpuLimit: 8, cpuUsed: 0, memLimit: 16384, memUsed: 512 }) }, RUNNER, INSTANCE, 1);
      const first = await execution({ cpu: 0.05, memoryMb: 64 });
      const second = await execution({ cpu: 0.05, memoryMb: 64 });
      assert.ok(await claimExecution(first.id, { leaseSeconds: 15 }));
      await assert.rejects(async () => {
        try {
          await claimExecution(second.id);
        } catch (error: any) {
          assert.equal(error.lane, 'workflow');
          assert.equal(error.limit, 1);
          throw error;
        }
      }, capacityError('runner_capacity_unavailable'));
      t.mock.timers.tick(16_000);
      assert.ok(await claimExecution(second.id));
    } finally {
      t.mock.timers.reset();
    }
  });

  it('keeps workflow and inference lane caps independent on one shared resource pool', async () => {
    await registerInstance({
      resources: resourceSample({ cpuLimit: 8, cpuUsed: 0, memLimit: 16384, memUsed: 512 }),
      // A non-numeric heartbeat value must fall back to the serial default.
      inferenceConcurrency: '8; id',
    }, RUNNER, INSTANCE, 2);
    const w1 = await execution({ cpu: 0.05, memoryMb: 64 });
    const w2 = await execution({ cpu: 0.05, memoryMb: 64 });
    const w3 = await execution({ cpu: 0.05, memoryMb: 64 });
    const w4 = await execution({ cpu: 0.05, memoryMb: 64 });
    const i1 = await inference({ cpu: 0.05, memoryMb: 64 });
    const i2 = await inference({ cpu: 0.05, memoryMb: 64 });
    const i3 = await inference({ cpu: 0.05, memoryMb: 64 });

    assert.ok(await claimExecution(w1.id));
    assert.ok(await claimExecution(w2.id));
    assert.ok(await claimInference(i1.id));

    // Workflow lane is full (2/2) while the inference lane still has 0/1 free
    // within its own cap; inference is full at 1/1 even though workflow has 2.
    await assert.rejects(async () => {
      try {
        await claimExecution(w3.id);
      } catch (error: any) {
        assert.equal(error.lane, 'workflow');
        assert.equal(error.limit, 2);
        throw error;
      }
    }, capacityError('runner_capacity_unavailable'));
    await assert.rejects(async () => {
      try {
        await claimInference(i2.id);
      } catch (error: any) {
        assert.equal(error.lane, 'inference');
        assert.equal(error.limit, 1);
        assert.equal(error.active, 1);
        throw error;
      }
    }, capacityError('runner_capacity_unavailable'));

    // Finishing one workflow job frees only the workflow slot; the inference
    // lane stays capped until its own job finishes.
    assert.ok(await store.finishExecutionRec(w1.id, {
      status: 'success', output: null, node_runs: [], finishedAt: new Date().toISOString(),
      workerId: RUNNER, instanceId: INSTANCE, attempt: 1,
    }));
    assert.ok(await claimExecution(w3.id));
    await assert.rejects(() => claimInference(i2.id), capacityError('runner_capacity_unavailable'));

    assert.ok(await store.finishInferenceJobRec(i1.id, {
      status: 'success', result: {}, runnerId: RUNNER, instanceId: INSTANCE, attempt: 1,
    }));
    assert.ok(await claimInference(i2.id));
    await assert.rejects(() => claimExecution(w4.id), capacityError('runner_capacity_unavailable'));
    assert.ok(await store.finishInferenceJobRec(i2.id, {
      status: 'success', result: {}, runnerId: RUNNER, instanceId: INSTANCE, attempt: 1,
    }));
    assert.ok(await claimInference(i3.id));
  });

  it('clamps an oversized instance inference concurrency to 32', async () => {
    await registerInstance({
      resources: resourceSample({ cpuLimit: 8, cpuUsed: 0, memLimit: 32768, memUsed: 512 }),
      inferenceConcurrency: 999,
    }, RUNNER, INSTANCE, 32);
    const jobs = await Promise.all(Array.from({ length: 33 }, () => inference({ cpu: 0.05, memoryMb: 64 })));
    const results = await Promise.allSettled(jobs.map((job) => claimInference(job.id)));
    const won = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled' && !!result.value);
    const denied = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(won.length, 32);
    assert.equal(denied.length, 1);
    assert.equal(denied[0].reason?.code, 'runner_capacity_unavailable');
    assert.equal(denied[0].reason?.lane, 'inference');
    assert.equal(denied[0].reason?.limit, 32);
  });

  it('binds an instance id to one registration and never reuses another runner telemetry', async () => {
    const original = resourceSample({ cpuLimit: 8, cpuUsed: 0, memLimit: 8192, memUsed: 1024 });
    await registerInstance({ resources: original, marker: 'owner-a' });

    await assert.rejects(async () => {
      try {
        await registerInstance({ resources: resourceSample({ cpuLimit: 64, cpuUsed: 0, memLimit: 65536, memUsed: 0 }) }, 'other-registration');
      } catch (e: any) {
        assert.equal(e.status, 409);
        assert.equal(e.code, 'instance_conflict');
        throw e;
      }
    }, capacityError('instance_conflict'));

    const instances = await store.listRunnerInstances(RUNNER);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].runner_id, RUNNER);
    assert.deepEqual(instances[0].metadata.resources, original);
    assert.equal(instances[0].metadata.marker, 'owner-a');

    const exec = await execution({ cpu: 0.5, memoryMb: 128 });
    await assert.rejects(
      () => store.claimExecutionRec(exec.id, {
        workerId: 'other-registration', instanceId: INSTANCE, leaseSeconds: 60, enforceCapacity: true,
      }),
      capacityError('runner_resources_unavailable'),
    );
    assert.equal((await store.getExecutionRec(exec.id))?.status, 'queued');
  });

  it('keeps the legacy internal claim path when capacity is not enforced', async () => {
    const exec = await execution({ cpu: 64, memoryMb: 262144 });
    assert.ok(await store.claimExecutionRec(exec.id, { workerId: 'builtin', leaseSeconds: 60 }));
  });
});

describe('runner capacity admission (Postgres, concurrent)', { skip: TEST_URL ? false : 'WORKFLOW_TEST_DATABASE_URL not set' }, () => {
  let sequence = 0;
  const suffix = () => `${Date.now().toString(36)}-${process.pid}-${++sequence}`;

  before(async () => {
    await store.ensureTables();
  });

  async function pgExecution(requirements: { cpu: number; memoryMb: number }) {
    return execution(requirements, { workflow_id: `capacity-workflow-${suffix()}` });
  }

  async function pgInstance(metadata: Record<string, any>, concurrency = 1) {
    const instanceId = `capacity-instance-${suffix()}`;
    const runnerId = `capacity-runner-${suffix()}`;
    await registerInstance(metadata, runnerId, instanceId, concurrency);
    return { instanceId, runnerId };
  }

  it('rejects missing/stale telemetry without claiming the row', async () => {
    const { instanceId, runnerId } = await pgInstance({});
    const exec = await pgExecution({ cpu: 0.5, memoryMb: 128 });
    await assert.rejects(
      () => store.claimExecutionRec(exec.id, { workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true }),
      capacityError('runner_resources_unavailable'),
    );
    assert.equal((await store.getExecutionRec(exec.id))?.status, 'queued');

    await registerInstance({ resources: resourceSample({ sampledAt: Date.now() - 50_000 }) }, runnerId, instanceId);
    await assert.rejects(
      () => store.claimExecutionRec(exec.id, { workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true }),
      capacityError('runner_resources_unavailable'),
    );
  });

  it('atomically caps concurrent CPU claims, then reclaims after release', async () => {
    const { instanceId, runnerId } = await pgInstance({
      resources: resourceSample({ cpuLimit: 2, cpuUsed: 0, memLimit: 4096, memUsed: 512 }),
    }, 32);
    const candidates = await Promise.all([
      pgExecution({ cpu: 1, memoryMb: 128 }),
      pgExecution({ cpu: 1, memoryMb: 128 }),
      pgExecution({ cpu: 1, memoryMb: 128 }),
      pgExecution({ cpu: 1, memoryMb: 128 }),
    ]);
    const results = await Promise.allSettled(candidates.map((exec) => store.claimExecutionRec(exec.id, {
      workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true,
    })));
    const won = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled' && !!result.value);
    const denied = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(won.length, 1, 'only one core-sized claim may win');
    assert.equal(denied.length, 3);
    for (const denial of denied) assert.equal(denial.reason?.code, 'runner_capacity_unavailable');

    const winner = won[0].value;
    const pending = candidates.find((exec) => exec.id !== winner.id)!;
    assert.ok(await store.releaseExecutionRec(winner.id, {
      workerId: runnerId, instanceId, attempt: winner.attempt,
    }));
    assert.ok(await store.claimExecutionRec(pending.id, {
      workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true,
    }));
  });

  it('atomically caps the workflow lane at the reported instance concurrency', async () => {
    const { instanceId, runnerId } = await pgInstance({
      resources: resourceSample({ cpuLimit: 8, cpuUsed: 0, memLimit: 16384, memUsed: 512 }),
    }, 2);
    const candidates = await Promise.all(Array.from({ length: 4 }, () => pgExecution({ cpu: 0.05, memoryMb: 64 })));
    const results = await Promise.allSettled(candidates.map((exec) => store.claimExecutionRec(exec.id, {
      workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true,
    })));
    const won = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled' && !!result.value);
    const denied = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(won.length, 2, 'exactly the two reported workflow slots may win');
    assert.equal(denied.length, 2);
    for (const denial of denied) {
      assert.equal(denial.reason?.code, 'runner_capacity_unavailable');
      assert.equal(denial.reason?.lane, 'workflow');
      assert.equal(denial.reason?.limit, 2);
    }
    for (const candidate of candidates) {
      const row = await store.getExecutionRec(candidate.id);
      const claimed = won.some((result) => result.value.id === candidate.id);
      assert.equal(row?.status, claimed ? 'running' : 'queued');
    }
  });

  it('atomically caps concurrent RAM claims', async () => {
    const { instanceId, runnerId } = await pgInstance({
      resources: resourceSample({ cpuLimit: 8, cpuUsed: 0, memLimit: 1024, memUsed: 100 }),
    }, 32);
    const candidates = await Promise.all([
      pgExecution({ cpu: 0.1, memoryMb: 512 }),
      pgExecution({ cpu: 0.1, memoryMb: 512 }),
      pgExecution({ cpu: 0.1, memoryMb: 512 }),
    ]);
    const results = await Promise.allSettled(candidates.map((exec) => store.claimExecutionRec(exec.id, {
      workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true,
    })));
    const won = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled' && !!result.value);
    assert.equal(won.length, 1, 'only one 512 MiB claim may win');
    for (const result of results) {
      if (result.status === 'rejected') assert.equal(result.reason?.code, 'runner_capacity_unavailable');
    }
  });

  it('shares the atomic budget across concurrent workflow and inference claims', async () => {
    const { instanceId, runnerId } = await pgInstance({
      resources: resourceSample({ cpuLimit: 1, cpuUsed: 0, memLimit: 4096, memUsed: 512 }),
      inferenceConcurrency: 32,
    }, 32);
    const exec = await pgExecution({ cpu: 0.6, memoryMb: 128 });
    const job = await inference({ cpu: 0.5, memoryMb: 256 });
    const results = await Promise.allSettled([
      store.claimExecutionRec(exec.id, { workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true }),
      store.claimInferenceJobRec(job.id, { runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true }),
    ]);
    const won = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled' && !!result.value);
    assert.equal(won.length, 1, 'workflow and inference lanes must share one reservation pool');
    const denied = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(denied?.reason?.code, 'runner_capacity_unavailable');

    if (won[0].value.id === exec.id) {
      await store.releaseExecutionRec(exec.id, { workerId: runnerId, instanceId, attempt: won[0].value.attempt });
    } else {
      await store.releaseInferenceJobRec(job.id, { runnerId, instanceId, attempt: won[0].value.attempt });
    }
    const remaining = won[0].value.id === exec.id ? job.id : exec.id;
    const retry = won[0].value.id === exec.id
      ? await store.claimInferenceJobRec(remaining, { runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true })
      : await store.claimExecutionRec(remaining, { workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true });
    assert.ok(retry);
  });

  it('allows a new claim once the previous lease expires', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const { instanceId, runnerId } = await pgInstance({
        resources: resourceSample({ cpuLimit: 2, cpuUsed: 0, memLimit: 4096, memUsed: 512 }),
      }, 8);
      const first = await pgExecution({ cpu: 1, memoryMb: 128 });
      const second = await pgExecution({ cpu: 1, memoryMb: 128 });
      assert.ok(await store.claimExecutionRec(first.id, {
        workerId: runnerId, instanceId, leaseSeconds: 15, enforceCapacity: true,
      }));
      await assert.rejects(
        () => store.claimExecutionRec(second.id, {
          workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true,
        }),
        capacityError('runner_capacity_unavailable'),
      );
      t.mock.timers.tick(16_000);
      assert.ok(await store.claimExecutionRec(second.id, {
        workerId: runnerId, instanceId, leaseSeconds: 60, enforceCapacity: true,
      }));
    } finally {
      t.mock.timers.reset();
    }
  });

  it('keeps instance binding atomic across registrations', async () => {
    const owner = await pgInstance({ resources: resourceSample(), marker: 'owner-a' });
    await assert.rejects(
      () => registerInstance({ resources: resourceSample({ cpuLimit: 64 }) }, 'other-registration', owner.instanceId),
      capacityError('instance_conflict'),
    );
    const instances = await store.listRunnerInstances(owner.runnerId);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].metadata.marker, 'owner-a');

    const exec = await pgExecution({ cpu: 0.5, memoryMb: 128 });
    await assert.rejects(
      () => store.claimExecutionRec(exec.id, {
        workerId: 'other-registration', instanceId: owner.instanceId, leaseSeconds: 60, enforceCapacity: true,
      }),
      capacityError('runner_resources_unavailable'),
    );
  });
});
