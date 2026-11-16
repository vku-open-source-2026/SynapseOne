// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRunnerUsage } from './runner-usage';
import * as store from './store';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 10, 1, 0, 0, 0);

function request(
  lane: 'workflow' | 'inference',
  startMs: number,
  endMs: number | null,
  status = 'success',
) {
  return {
    lane,
    started_at: new Date(startMs).toISOString(),
    finished_at: endMs === null ? null : new Date(endMs).toISOString(),
    status,
  };
}

describe('runner usage aggregation', () => {
  it('counts requests per hour and reconstructs peak concurrency from intervals', () => {
    const usage = aggregateRunnerUsage([
      request('workflow', BASE + 10 * 60_000, BASE + 70 * 60_000),
      request('workflow', BASE + 30 * 60_000, BASE + 40 * 60_000),
      request('inference', BASE + 50 * 60_000, null, 'running'),
    ], [
      {
        instance_id: 'i1',
        hour_start: new Date(BASE).toISOString(),
        samples: 4,
        cpu_used_sum: 2,
        cpu_limit_sum: 8,
        mem_used_sum: 1024,
        mem_limit_sum: 4096,
        max_cpu_percent: 30,
      },
    ], BASE, BASE + 2 * HOUR, 'hour');

    assert.equal(usage.buckets.length, 2);
    assert.deepEqual(usage.buckets[0].requests, { workflow: 2, inference: 1, total: 3 });
    assert.equal(usage.buckets[0].concurrency.peak, 2);
    assert.equal(usage.buckets[1].requests.total, 0);
    assert.equal(usage.buckets[1].concurrency.peak, 2);
    assert.equal(usage.buckets[0].cpuPercent, 25);
    assert.equal(usage.buckets[0].memoryUsedMb, 256);
    assert.equal(usage.buckets[0].memoryLimitMb, 1024);
    assert.equal(usage.buckets[1].cpuPercent, null);
    assert.deepEqual(usage.totals, { workflow: 2, inference: 1, total: 3, peakConcurrency: 2 });
  });

  it('rolls hourly buckets into UTC days', () => {
    const usage = aggregateRunnerUsage([
      request('workflow', BASE + 23.5 * HOUR, BASE + 23.75 * HOUR),
      request('workflow', BASE + DAY + 0.5 * HOUR, BASE + DAY + 1.5 * HOUR),
      request('inference', BASE + DAY + 1 * HOUR, null, 'running'),
    ], [], BASE, BASE + 2 * DAY, 'day');

    assert.equal(usage.buckets.length, 2);
    assert.equal(usage.buckets[0].requests.total, 1);
    assert.equal(usage.buckets[1].requests.total, 2);
    assert.equal(usage.buckets[1].requests.inference, 1);
    assert.equal(usage.buckets[1].concurrency.peak, 2);
    assert.equal(usage.totals.total, 3);
  });

  it('aligns weekly buckets to Monday and monthly buckets to the first', () => {
    const week = aggregateRunnerUsage([
      request('workflow', Date.UTC(2026, 10, 4, 10), Date.UTC(2026, 10, 4, 11)),
      request('workflow', Date.UTC(2026, 10, 8, 10), Date.UTC(2026, 10, 8, 11)),
      request('workflow', Date.UTC(2026, 10, 9, 10), Date.UTC(2026, 10, 9, 11)),
    ], [], Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 16), 'week');
    assert.equal(week.buckets[0].start, '2026-10-26T00:00:00.000Z');
    const firstWeek = week.buckets.find((bucket) => bucket.requests.total === 2);
    assert.ok(firstWeek);
    assert.equal(firstWeek.start, '2026-11-02T00:00:00.000Z');
    assert.equal(firstWeek.concurrency.peak, 1);

    const month = aggregateRunnerUsage([
      request('workflow', Date.UTC(2025, 10, 1, 10), Date.UTC(2025, 10, 1, 11)),
      request('inference', Date.UTC(2025, 10, 30, 10), Date.UTC(2025, 10, 30, 11)),
      request('workflow', Date.UTC(2025, 11, 1, 10), Date.UTC(2025, 11, 1, 11)),
    ], [], Date.UTC(2025, 10, 1), Date.UTC(2026, 0, 1), 'month');
    assert.equal(month.buckets.length, 2);
    assert.equal(month.buckets[0].start, '2025-11-01T00:00:00.000Z');
    assert.equal(month.buckets[0].requests.total, 2);
    assert.equal(month.buckets[1].start, '2025-12-01T00:00:00.000Z');
    assert.equal(month.buckets[1].requests.total, 1);
    assert.equal(month.totals.total, 3);
  });

  it('does not count queued or cancelled rows as concurrent work', () => {
    const usage = aggregateRunnerUsage([
      request('workflow', BASE, BASE + HOUR, 'queued'),
      request('workflow', BASE + 10, BASE + 20, 'cancelled'),
    ], [], BASE, BASE + HOUR, 'hour');
    assert.equal(usage.buckets[0].requests.total, 2);
    assert.equal(usage.buckets[0].concurrency.peak, 0);
    assert.equal(usage.buckets[0].concurrency.average, 0);
  });
});

describe('runner usage rollups (in-memory)', () => {
  beforeEach(() => store.__clearMem());

  it('folds heartbeat samples into one hourly row', async () => {
    const at = new Date(BASE + 5 * 60_000).toISOString();
    await store.recordRunnerResourceUsage('instance-1', 'runner-1', {
      observedAt: at,
      sampledAt: at,
      cpu: { limitCores: 4, usedCores: 1, availableCores: 3 },
      memory: { limitMb: 1024, usedMb: 256, availableMb: 768 },
      source: 'cgroup-v2',
    });
    await store.recordRunnerResourceUsage('instance-1', 'runner-1', {
      observedAt: at,
      sampledAt: at,
      cpu: { limitCores: 4, usedCores: 3, availableCores: 1 },
      memory: { limitMb: 1024, usedMb: 512, availableMb: 512 },
      source: 'cgroup-v2',
    });

    const rows = await store.listRunnerUsageHourly('runner-1', new Date(BASE));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].samples, 2);
    assert.equal(rows[0].cpu_used_sum, 4);
    assert.equal(rows[0].cpu_limit_sum, 8);
    assert.equal(rows[0].mem_used_sum, 768);
    assert.equal(rows[0].mem_limit_sum, 2048);
    assert.equal(rows[0].max_cpu_percent, 75);
  });

  it('attributes requests from both lanes to the runner registration', async () => {
    const execution = await store.createExecutionRec({
      workflow_id: 'usage-workflow',
      status: 'success',
      input: {},
      output: null,
      node_runs: [],
      triggered_by: 'test',
      startedAt: new Date(BASE + HOUR).toISOString(),
      worker_id: 'runner-1',
      runner_instance_id: 'instance-1',
    } as any);
    const job = await store.createInferenceJobRec({
      queue_name: 'usage-inference',
      type: 'embeddings',
      request: {},
    });
    await store.claimInferenceJobRec(job.id, { runnerId: 'runner-1', instanceId: 'instance-1', leaseSeconds: 60 });
    await store.finishInferenceJobRec(job.id, {
      status: 'success', result: {}, runnerId: 'runner-1', instanceId: 'instance-1', attempt: 1,
    });

    const rows = await store.listRunnerUsageRequests('runner-1', new Date(BASE));
    assert.equal(rows.filter((row) => row.lane === 'workflow').length, 1);
    assert.equal(rows.filter((row) => row.lane === 'inference').length, 1);
    assert.equal(rows[0].started_at, execution.startedAt);
  });
});
