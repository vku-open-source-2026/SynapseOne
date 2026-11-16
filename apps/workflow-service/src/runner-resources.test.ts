// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Runner resource telemetry/admission tests.  cgroup/proc fixtures are real
 * files in a temp tree, so parsing and delta behaviour are exercised without
 * Docker or a model run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CPU_HEADROOM_PERCENT,
  DEFAULT_MEMORY_HEADROOM_MB,
  RESOURCE_HEARTBEAT_MS,
  RESOURCE_HISTORY_LIMIT,
  RunnerResourceSampler,
  appendResourceHistory,
  chooseRunnerResources,
  fitResources,
  fitRunnerResources,
  isResourceSampleStale,
  sanitizeResourceSample,
  type ResourceSample,
} from './runner-resources';

const MIB = 1024 * 1024;
const NOW = Date.parse('2026-11-14T16:00:00Z');

function makeTree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-runner-resources-'));
}

function writeFile(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeHost(
  procRoot: string,
  options: {
    cpuCount?: number;
    totalKb?: number;
    availableKb?: number;
    stat?: string;
  } = {},
): void {
  const cpuCount = options.cpuCount ?? 8;
  writeFile(
    procRoot,
    'meminfo',
    `MemTotal: ${options.totalKb ?? 8 * 1024 * 1024} kB\n` +
      `MemAvailable: ${options.availableKb ?? 6 * 1024 * 1024} kB\n`,
  );
  writeFile(
    procRoot,
    'cpuinfo',
    Array.from({ length: cpuCount }, (_, index) => `processor\t: ${index}`).join('\n') + '\n',
  );
  writeFile(
    procRoot,
    'stat',
    options.stat ?? 'cpu  100 0 100 800 0 0 0 0 0 0\n',
  );
}

function sampleAt(time: number, overrides: Partial<ResourceSample> = {}): ResourceSample {
  return {
    sampledAt: new Date(time).toISOString(),
    observedAt: new Date(time).toISOString(),
    cpu: { limitCores: 4, usedCores: 0.5, percent: 12.5, availableCores: 3.5 },
    memory: { limitMb: 2048, usedMb: 1000, availableMb: 1048 },
    source: 'cgroup-v2',
    ...overrides,
  };
}

describe('RunnerResourceSampler', () => {
  it('parses cgroup v2 limits, memory cap and monotonic CPU deltas', async () => {
    const root = makeTree();
    const cgroup = path.join(root, 'cgroup');
    const proc = path.join(root, 'proc');
    try {
      writeFile(cgroup, 'cpu.max', '200000 100000\n');
      writeFile(cgroup, 'cpu.stat', 'usage_usec 1000000\n');
      writeFile(cgroup, 'cpuset.cpus.effective', '0-3\n');
      writeFile(cgroup, 'memory.current', String(100 * MIB));
      writeFile(cgroup, 'memory.max', String(512 * MIB));
      writeHost(proc, { cpuCount: 8, totalKb: 8 * 1024 * 1024, availableKb: 6 * 1024 * 1024 });

      let clock = 1000;
      let wall = NOW;
      const sampler = new RunnerResourceSampler({
        cgroupRoot: cgroup,
        procRoot: proc,
        monotonic: () => clock,
        now: () => wall,
      });

      const first = await sampler.sample();
      assert.equal(first.source, 'cgroup-v2');
      assert.equal(first.sampledAt, new Date(NOW).toISOString());
      assert.equal(first.cpu.limitCores, 2);
      assert.equal(first.cpu.usedCores, 0);
      assert.equal(first.cpu.percent, 0);
      assert.equal(first.cpu.availableCores, 0, 'first counter sample has no delta yet');
      assert.equal(first.memory.limitMb, 512);
      assert.equal(first.memory.usedMb, 100);
      assert.equal(first.memory.availableMb, 412);

      clock += 1000;
      wall += 1000;
      writeFile(cgroup, 'cpu.stat', 'usage_usec 3000000\n');
      const second = await sampler.sample();
      assert.equal(second.cpu.usedCores, 2);
      assert.equal(second.cpu.percent, 100);
      assert.equal(second.cpu.availableCores, 0);

      clock += 1000;
      wall += 1000;
      writeFile(cgroup, 'cpu.stat', 'usage_usec 4000000\n');
      const third = await sampler.sample();
      assert.equal(third.cpu.usedCores, 1);
      assert.equal(third.cpu.percent, 50);
      assert.equal(third.cpu.availableCores, 1);

      // A counter reset/decrease must clamp to 0 and defer admission until a
      // genuine positive interval is measured.
      clock += 1000;
      wall += 1000;
      writeFile(cgroup, 'cpu.stat', 'usage_usec 500000\n');
      const fourth = await sampler.sample();
      assert.equal(fourth.cpu.usedCores, 0);
      assert.equal(fourth.cpu.availableCores, 0);

      clock += 1000;
      wall += 1000;
      writeFile(cgroup, 'cpu.stat', 'usage_usec 1500000\n');
      const fifth = await sampler.sample();
      assert.equal(fifth.cpu.usedCores, 1);
      assert.equal(fifth.cpu.availableCores, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses cgroup v1 quota, cpuset and memory', async () => {
    const root = makeTree();
    const cgroup = path.join(root, 'cgroup');
    const proc = path.join(root, 'proc');
    try {
      writeFile(cgroup, 'cpu,cpuacct/cpu.cfs_quota_us', '150000\n');
      writeFile(cgroup, 'cpu,cpuacct/cpu.cfs_period_us', '100000\n');
      writeFile(cgroup, 'cpu,cpuacct/cpuacct.usage', '1000000000\n');
      writeFile(cgroup, 'cpu,cpuacct/cpuset.cpus', '0-1\n');
      writeFile(cgroup, 'memory/memory.usage_in_bytes', String(200 * MIB));
      writeFile(cgroup, 'memory/memory.limit_in_bytes', String(1024 * MIB));
      writeHost(proc);

      let clock = 1000;
      let wall = NOW;
      const sampler = new RunnerResourceSampler({
        cgroupRoot: cgroup,
        procRoot: proc,
        monotonic: () => clock,
        now: () => wall,
      });

      const first = await sampler.sample();
      assert.equal(first.source, 'cgroup-v1');
      assert.equal(first.cpu.limitCores, 1.5);
      assert.equal(first.cpu.usedCores, 0);
      assert.equal(first.cpu.availableCores, 0, 'first counter sample cannot admit');
      assert.equal(first.memory.limitMb, 1024);
      assert.equal(first.memory.usedMb, 200);
      assert.equal(first.memory.availableMb, 824);

      clock += 1000;
      wall += 1000;
      writeFile(cgroup, 'cpu,cpuacct/cpuacct.usage', '2500000000\n');
      const second = await sampler.sample();
      assert.equal(second.cpu.usedCores, 1.5);
      assert.equal(second.cpu.percent, 100);
      assert.equal(second.cpu.availableCores, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not admit CPU work from the initial no-delta sample', async () => {
    const root = makeTree();
    const cgroup = path.join(root, 'cgroup');
    const proc = path.join(root, 'proc');
    try {
      writeHost(proc);
      writeFile(cgroup, 'cpu.max', '400000 100000\n');
      writeFile(cgroup, 'cpu.stat', 'usage_usec 1000000\n');
      writeFile(cgroup, 'memory.current', String(64 * MIB));
      writeFile(cgroup, 'memory.max', String(512 * MIB));
      let clock = 1000;
      const sampler = new RunnerResourceSampler({
        cgroupRoot: cgroup,
        procRoot: proc,
        monotonic: () => clock,
        now: () => NOW,
      });
      const options = {
        now: NOW,
        cpuHeadroomPercent: 0,
        memoryHeadroomMb: 0,
        activeReservations: [],
      };

      const first = await sampler.sample();
      assert.equal(first.cpu.availableCores, 0);
      const firstFit = fitRunnerResources(first, { cpuCores: 0.5, memoryMb: 64 }, options);
      assert.equal(firstFit.ok, false, 'startup burst must not be admitted');
      assert.equal(firstFit.reason, 'cpu');

      clock += 1000;
      writeFile(cgroup, 'cpu.stat', 'usage_usec 1500000\n');
      const second = await sampler.sample();
      assert.equal(second.cpu.usedCores, 0.5);
      const secondFit = fitRunnerResources(second, { cpuCores: 0.5, memoryMb: 64 }, options);
      assert.equal(secondFit.ok, true);

      clock += 1000;
      writeFile(cgroup, 'cpu.stat', 'usage_usec 1000000\n');
      const third = await sampler.sample();
      assert.equal(third.cpu.availableCores, 0);
      const thirdFit = fitRunnerResources(third, { cpuCores: 0.5, memoryMb: 64 }, options);
      assert.equal(thirdFit.ok, false, 'counter reset defers admission');
      assert.equal(thirdFit.reason, 'cpu');

      clock += 1000;
      writeFile(cgroup, 'cpu.stat', 'usage_usec 1500000\n');
      const fourth = await sampler.sample();
      const fourthFit = fitRunnerResources(fourth, { cpuCores: 0.5, memoryMb: 64 }, options);
      assert.equal(fourthFit.ok, true, 'a measured interval restores admission');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles unlimited cgroup limits and clamps to host availability', async () => {
    const root = makeTree();
    const cgroupV2 = path.join(root, 'cgroup-v2');
    const cgroupV1 = path.join(root, 'cgroup-v1');
    const proc = path.join(root, 'proc');
    try {
      writeHost(proc, { cpuCount: 8, totalKb: 8 * 1024 * 1024, availableKb: 512 * 1024 });
      writeFile(cgroupV2, 'cpu.max', 'max 100000\n');
      writeFile(cgroupV2, 'cpuset.cpus.effective', '0-1\n');
      writeFile(cgroupV2, 'cpu.stat', 'usage_usec 0\n');
      writeFile(cgroupV2, 'memory.current', String(100 * MIB));
      writeFile(cgroupV2, 'memory.max', 'max\n');

      const v2 = new RunnerResourceSampler({
        cgroupRoot: cgroupV2,
        procRoot: proc,
        monotonic: () => 1000,
        now: () => NOW,
      }).sample();
      const v2Sample = await v2;
      assert.equal(v2Sample.cpu.limitCores, 2);
      assert.equal(v2Sample.memory.limitMb, 8192);
      assert.equal(v2Sample.memory.availableMb, 512, 'host MemAvailable is the ceiling');

      writeFile(cgroupV1, 'cpu,cpuacct/cpu.cfs_quota_us', '-1\n');
      writeFile(cgroupV1, 'cpu,cpuacct/cpu.cfs_period_us', '100000\n');
      writeFile(cgroupV1, 'cpu,cpuacct/cpuacct.usage', '0\n');
      writeFile(cgroupV1, 'cpu,cpuacct/cpuset.cpus', '0-3\n');
      writeFile(cgroupV1, 'memory/memory.usage_in_bytes', String(100 * MIB));
      writeFile(cgroupV1, 'memory/memory.limit_in_bytes', '9223372036854771712\n');
      const v1Sample = await new RunnerResourceSampler({
        cgroupRoot: cgroupV1,
        procRoot: proc,
        monotonic: () => 1000,
        now: () => NOW,
      }).sample();
      assert.equal(v1Sample.cpu.limitCores, 4);
      assert.equal(v1Sample.memory.limitMb, 8192);
      assert.equal(v1Sample.memory.availableMb, 512);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats cgroup v2 memory.max=0 as a real zero cap, not unlimited', async () => {
    const root = makeTree();
    const cgroup = path.join(root, 'cgroup');
    const proc = path.join(root, 'proc');
    try {
      writeHost(proc);
      writeFile(cgroup, 'cpu.max', '100000 100000\n');
      writeFile(cgroup, 'cpu.stat', 'usage_usec 0\n');
      writeFile(cgroup, 'memory.current', '0\n');
      writeFile(cgroup, 'memory.max', '0\n');
      const sample = await new RunnerResourceSampler({
        cgroupRoot: cgroup,
        procRoot: proc,
        monotonic: () => 1000,
        now: () => NOW,
      }).sample();
      assert.equal(sample.memory.limitMb, 0);
      assert.equal(sample.memory.availableMb, 0);
      assert.equal(sample.source, 'cgroup-v2');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to /proc for host CPU/RAM and clamps a runaway counter', async () => {
    const root = makeTree();
    const cgroup = path.join(root, 'cgroup');
    const proc = path.join(root, 'proc');
    try {
      writeHost(proc, {
        cpuCount: 8,
        totalKb: 8 * 1024 * 1024,
        availableKb: 6 * 1024 * 1024,
        stat: 'cpu  100 0 100 800 0 0 0 0 0 0\n',
      });
      let clock = 1000;
      const sampler = new RunnerResourceSampler({
        cgroupRoot: cgroup,
        procRoot: proc,
        monotonic: () => clock,
        now: () => NOW,
      });
      const first = await sampler.sample();
      assert.equal(first.source, 'host');
      assert.equal(first.cpu.limitCores, 8);
      assert.equal(first.cpu.usedCores, 0);
      assert.equal(first.cpu.availableCores, 0, 'first counter sample has no delta yet');
      assert.equal(first.memory.limitMb, 8192);
      assert.equal(first.memory.usedMb, 2048);
      assert.equal(first.memory.availableMb, 6144);

      clock += 1000;
      writeFile(proc, 'stat', 'cpu  300 0 200 1500 0 0 0 0 0 0\n');
      const second = await sampler.sample();
      // busy 500-200=300, total 2000-1000=1000 => 0.3 * 8 cores.
      assert.equal(second.cpu.usedCores, 2.4);
      assert.equal(second.cpu.percent, 30);
      assert.equal(second.cpu.availableCores, 5.6);

      clock += 1000;
      writeFile(proc, 'stat', 'cpu  50 0 50 100 0 0 0 0 0 0\n');
      const third = await sampler.sample();
      assert.equal(third.cpu.usedCores, 0);
      assert.equal(third.cpu.availableCores, 0, 'counter reset defers admission');

      clock += 1000;
      writeFile(proc, 'stat', 'cpu  150 0 100 200 0 0 0 0 0 0\n');
      const fourth = await sampler.sample();
      assert.ok(fourth.cpu.usedCores > 0);
      assert.ok(fourth.cpu.availableCores > 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never throws or leaks host paths on malformed metrics', async () => {
    const root = makeTree();
    const cgroup = path.join(root, 'cgroup');
    const proc = path.join(root, 'proc');
    try {
      writeFile(cgroup, 'cpu.max', 'not-a-quota\n');
      writeFile(cgroup, 'cpu.stat', 'usage_usec nope\n');
      writeFile(cgroup, 'cpuset.cpus.effective', 'garbage\n');
      writeFile(cgroup, 'memory.current', 'NaN\n');
      writeFile(cgroup, 'memory.max', 'garbage\n');
      writeFile(proc, 'meminfo', 'MemTotal: nope\nMemAvailable: nope\n');
      writeFile(proc, 'stat', 'cpu nonsense\n');
      writeFile(proc, 'cpuinfo', 'not a processor\n');
      const sample = await new RunnerResourceSampler({
        cgroupRoot: cgroup,
        procRoot: proc,
        monotonic: () => 1000,
        now: () => NOW,
      }).sample();
      for (const value of [
        sample.cpu.limitCores,
        sample.cpu.usedCores,
        sample.cpu.percent,
        sample.cpu.availableCores,
        sample.memory.limitMb,
        sample.memory.usedMb,
        sample.memory.availableMb,
      ]) {
        assert.ok(Number.isFinite(value), `expected finite metric, got ${value}`);
        assert.ok(value >= 0, `expected non-negative metric, got ${value}`);
      }
      const serialized = JSON.stringify(sample);
      assert.equal(serialized.includes(root), false);
      assert.equal(serialized.includes('secret'), false);
      assert.equal(serialized.includes('token'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sanitizeResourceSample', () => {
  it('strips host identifiers/credentials and clamps impossible values', () => {
    const sanitized = sanitizeResourceSample({
      sampledAt: 'not-a-date',
      source: 'cgroup-v2',
      hostname: 'secret-host',
      path: '/sys/fs/cgroup/secret',
      token: 'must-not-leak',
      pid: 4242,
      cpu: {
        limitCores: 2,
        usedCores: 5,
        percent: 999,
        availableCores: 99,
        hostname: 'leak',
      },
      memory: {
        limitMb: 1024,
        usedMb: 2048,
        availableMb: 999,
        path: '/proc/meminfo',
      },
    });
    assert.deepEqual(Object.keys(sanitized).sort(), ['cpu', 'memory', 'observedAt', 'sampledAt', 'source']);
    assert.equal(sanitized.sampledAt, new Date(0).toISOString());
    assert.equal(sanitized.cpu.limitCores, 2);
    assert.equal(sanitized.cpu.usedCores, 2);
    assert.equal(sanitized.cpu.percent, 100);
    assert.equal(sanitized.cpu.availableCores, 0);
    assert.equal(sanitized.memory.limitMb, 1024);
    assert.equal(sanitized.memory.usedMb, 2048);
    assert.equal(sanitized.memory.availableMb, 0);
    const serialized = JSON.stringify(sanitized);
    assert.equal(serialized.includes('secret-host'), false);
    assert.equal(serialized.includes('/sys/fs/cgroup'), false);
    assert.equal(serialized.includes('must-not-leak'), false);
    assert.equal(serialized.includes('4242'), false);
  });

  it('returns a safe unknown sample for missing/invalid input', () => {
    const sanitized = sanitizeResourceSample(null);
    assert.equal(sanitized.source, 'unknown');
    assert.equal(sanitized.cpu.limitCores, 0);
    assert.equal(sanitized.memory.limitMb, 0);
  });

  it('preserves an explicit zero CPU availability instead of deriving free capacity', () => {
    const sanitized = sanitizeResourceSample({
      sampledAt: new Date(NOW).toISOString(),
      source: 'cgroup-v2',
      cpu: { limitCores: 4, usedCores: 0, percent: 0, availableCores: 0 },
      memory: { limitMb: 512, usedMb: 64, availableMb: 448 },
    });
    assert.equal(sanitized.cpu.availableCores, 0);
    assert.equal(sanitized.cpu.limitCores, 4);
  });
});

describe('appendResourceHistory', () => {
  it('keeps only the last 120 samples without mutating the input', () => {
    const samples = Array.from({ length: 130 }, (_, index) =>
      sampleAt(NOW + index * RESOURCE_HEARTBEAT_MS),
    );
    const existing = [samples[0]];
    let history: ResourceSample[] = existing;
    for (const sample of samples) history = appendResourceHistory(history, sample);
    assert.equal(history.length, RESOURCE_HISTORY_LIMIT);
    assert.equal(history[0].sampledAt, samples[10].sampledAt);
    assert.equal(history[history.length - 1].sampledAt, samples[129].sampledAt);
    assert.equal(existing.length, 1);

    const capped = appendResourceHistory(samples, samples[129], 500);
    assert.equal(capped.length, RESOURCE_HISTORY_LIMIT);
    assert.equal(JSON.stringify(history).includes('hostname'), false);
  });
});

describe('isResourceSampleStale', () => {
  it('rejects old and future samples unless they are within the heartbeat window', () => {
    assert.equal(isResourceSampleStale(sampleAt(NOW), NOW, RESOURCE_HEARTBEAT_MS), false);
    assert.equal(isResourceSampleStale(sampleAt(NOW - 20_000), NOW, RESOURCE_HEARTBEAT_MS), true);
    assert.equal(isResourceSampleStale(sampleAt(NOW + 20_000), NOW, RESOURCE_HEARTBEAT_MS), true);
    assert.equal(isResourceSampleStale({ sampledAt: 'bad' }, NOW), true);
  });
});

describe('fitRunnerResources', () => {
  const sample = sampleAt(NOW);
  const activeReservations = [{ cpuCores: 1, memoryMb: 256 }];

  it('applies default 10% CPU and 256 MiB memory headroom plus reservations', () => {
    assert.equal(DEFAULT_CPU_HEADROOM_PERCENT, 10);
    assert.equal(DEFAULT_MEMORY_HEADROOM_MB, 256);
    const fit = fitRunnerResources(
      sample,
      { cpuCores: 2, memoryMb: 500 },
      { now: NOW, activeReservations },
    );
    assert.equal(fit.ok, true);
    assert.equal(fit.cpu.observedBusyCores, 0.5);
    assert.equal(fit.cpu.reservedCores, 1);
    assert.equal(fit.cpu.effectiveBusyCores, 1);
    assert.equal(fit.cpu.headroomCores, 0.4);
    assert.equal(fit.cpu.availableCores, 2.6, 'limit - max(busy, reserved) - headroom');
    assert.equal(fit.memory.headroomMb, 256);
    assert.equal(fit.memory.reservedMb, 256);
    assert.equal(fit.memory.availableMb, 536);
    assert.equal(fit.cpu.remainingCores, 0.6);
    assert.equal(fit.memory.remainingMb, 36);
  });

  it('does not double-count active CPU jobs in observed usage and reservations', () => {
    // Actual busy 1 core, one active 1-core job reserved, limit 4, 10% headroom:
    // usable is 4 - max(1, 1) - 0.4 = 2.6, not 4 - 1 - 1 - 0.4 = 1.6.
    const oneReserved = fitRunnerResources(
      sampleAt(NOW, {
        cpu: { limitCores: 4, usedCores: 1, percent: 25, availableCores: 3 },
      }),
      { cpuCores: 0, memoryMb: 0 },
      { now: NOW, activeReservations: [{ cpuCores: 1 }] },
    );
    assert.equal(oneReserved.ok, true);
    assert.equal(oneReserved.cpu.observedBusyCores, 1);
    assert.equal(oneReserved.cpu.effectiveBusyCores, 1);
    assert.equal(oneReserved.cpu.availableCores, 2.6);

    const twoReserved = fitRunnerResources(
      sampleAt(NOW, {
        cpu: { limitCores: 4, usedCores: 1, percent: 25, availableCores: 3 },
      }),
      { cpuCores: 0, memoryMb: 0 },
      { now: NOW, activeReservations: [{ cpuCores: 2 }] },
    );
    assert.equal(twoReserved.cpu.effectiveBusyCores, 2);
    assert.equal(twoReserved.cpu.availableCores, 1.6);
  });

  it('never oversubscribes CPU or RAM and reports the limiting resource', () => {
    const cpuBound = fitRunnerResources(
      sample,
      { cpuCores: 2.601, memoryMb: 500 },
      { now: NOW, activeReservations },
    );
    assert.equal(cpuBound.ok, false);
    assert.equal(cpuBound.reason, 'cpu');
    assert.ok(cpuBound.cpu.remainingCores < 0);

    const memoryBound = fitRunnerResources(
      sample,
      { cpuCores: 1, memoryMb: 537 },
      { now: NOW, activeReservations },
    );
    assert.equal(memoryBound.ok, false);
    assert.equal(memoryBound.reason, 'memory');
    assert.ok(memoryBound.memory.remainingMb < 0);

    const both = fitRunnerResources(
      sample,
      { cpuCores: 9, memoryMb: 9999 },
      { now: NOW, activeReservations },
    );
    assert.equal(both.ok, false);
    assert.equal(both.reason, 'cpu+memory');

    const exactly = fitRunnerResources(
      sample,
      { cpuCores: 2.6, memoryMb: 536 },
      { now: NOW, activeReservations },
    );
    assert.equal(exactly.ok, true);
    assert.equal(exactly.cpu.remainingCores, 0);
    assert.equal(exactly.memory.remainingMb, 0);
  });

  it('honours custom headroom/reservations and rejects stale/invalid samples', () => {
    const noHeadroom = fitRunnerResources(
      sample,
      { cpuCores: 3.5, memoryMb: 1048 },
      { now: NOW, cpuHeadroomPercent: 0, memoryHeadroomMb: 0, activeReservations: [] },
    );
    assert.equal(noHeadroom.ok, true);

    const stale = fitRunnerResources(
      sampleAt(NOW - 60_000),
      { cpuCores: 0, memoryMb: 0 },
      { now: NOW, staleAfterMs: RESOURCE_HEARTBEAT_MS },
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stale');
    assert.equal(stale.cpu.availableCores, 0);
    assert.equal(stale.memory.availableMb, 0);

    const invalid = fitRunnerResources(sample, { cpuCores: -1, memoryMb: 10 }, { now: NOW });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.reason, 'invalid');

    const unavailable = fitRunnerResources(
      { ...sample, source: 'unknown' },
      { cpuCores: 0, memoryMb: 0 },
      { now: NOW },
    );
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.reason, 'unavailable');
  });

  it('chooses the first candidate that fits and keeps rejected reasons', () => {
    const choice = chooseRunnerResources(
      [
        { id: 'cpu-heavy', cpuCores: 9, memoryMb: 100 },
        { id: 'memory-heavy', cpuCores: 1, memoryMb: 900 },
        { id: 'fits', cpuCores: 2, memoryMb: 500 },
      ],
      sample,
      { now: NOW, activeReservations },
    );
    assert.equal(choice.selected?.id, 'fits');
    assert.equal(choice.rejected.length, 2);
    assert.equal(choice.rejected[0].fit.reason, 'cpu');
    assert.equal(choice.rejected[1].fit.reason, 'memory');
    assert.equal(fitResources, fitRunnerResources);
  });
});
