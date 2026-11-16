// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Pure runner usage aggregation for the owner console.
 *
 * Request counts come from execution/inference intervals; CPU/RAM come from
 * hourly heartbeat rollups. Keeping this pure makes the day/hour chart
 * testable without a server or database.
 */

export type RunnerUsageInterval = 'hour' | 'day' | 'week' | 'month';

export interface RunnerUsageRequestRow {
  lane: 'workflow' | 'inference';
  started_at: string;
  finished_at: string | null;
  status: string;
}

export interface RunnerUsageHourRow {
  instance_id: string;
  hour_start: string;
  samples: number;
  cpu_used_sum: number;
  cpu_limit_sum: number;
  mem_used_sum: number;
  mem_limit_sum: number;
  max_cpu_percent: number;
}

export interface RunnerUsageBucket {
  start: string;
  end: string;
  requests: { workflow: number; inference: number; total: number };
  concurrency: { peak: number; average: number };
  cpuPercent: number | null;
  memoryUsedMb: number | null;
  memoryLimitMb: number | null;
  samples: number;
  instances: number;
}

export interface RunnerUsageResult {
  from: string;
  to: string;
  interval: RunnerUsageInterval;
  buckets: RunnerUsageBucket[];
  totals: { workflow: number; inference: number; total: number; peakConcurrency: number };
}

export function usageBucketStart(ms: number, interval: RunnerUsageInterval): number {
  const d = new Date(ms);
  if (interval === 'month') {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
  } else if (interval === 'week') {
    const offset = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - offset);
    d.setUTCHours(0, 0, 0, 0);
  } else if (interval === 'day') {
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setUTCMinutes(0, 0, 0);
  }
  return d.getTime();
}

function usageBucketEnd(start: number, interval: RunnerUsageInterval): number {
  if (interval === 'month') {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.getTime();
  }
  if (interval === 'week') return start + 7 * 86_400_000;
  return start + (interval === 'day' ? 86_400_000 : 3_600_000);
}

/** Merge request intervals and hourly CPU/RAM rollups into chart buckets.
 *  Peak concurrency is computed from real job start/finish intervals, not from
 *  the heartbeats' `activeJobs` counter (which can be lost on a crash). */
export function aggregateRunnerUsage(
  requests: readonly RunnerUsageRequestRow[],
  resources: readonly RunnerUsageHourRow[],
  fromMs: number,
  toMs: number,
  interval: RunnerUsageInterval,
): RunnerUsageResult {
  const buckets = new Map<number, {
    requests: { workflow: number; inference: number; total: number };
    events: Array<{ at: number; delta: number }>;
    busyMs: number;
    cpuUsedSum: number;
    cpuLimitSum: number;
    memUsedSum: number;
    memLimitSum: number;
    samples: number;
    instances: Set<string>;
  }>();
  const first = usageBucketStart(fromMs, interval);
  const now = Date.now();
  const last = usageBucketStart(Math.max(first, Math.min(toMs, now) - 1), interval);
  for (let start = first; start <= last; start = usageBucketEnd(start, interval)) {
    buckets.set(start, {
      requests: { workflow: 0, inference: 0, total: 0 },
      events: [],
      busyMs: 0,
      cpuUsedSum: 0,
      cpuLimitSum: 0,
      memUsedSum: 0,
      memLimitSum: 0,
      samples: 0,
      instances: new Set(),
    });
  }
  const totals = { workflow: 0, inference: 0, total: 0, peakConcurrency: 0 };
  for (const request of requests) {
    const start = Date.parse(request.started_at);
    if (!Number.isFinite(start) || start < fromMs || start > toMs) continue;
    const bucket = buckets.get(usageBucketStart(start, interval));
    if (!bucket) continue;
    bucket.requests[request.lane] += 1;
    bucket.requests.total += 1;
    totals[request.lane] += 1;
    totals.total += 1;
    if (request.status === 'queued' || request.status === 'cancelled') continue;
    const rawEnd = request.status === 'running' ? now : Date.parse(request.finished_at || '');
    const end = Math.max(start, Math.min(Number.isFinite(rawEnd) ? rawEnd : now, toMs));
    if (end <= start) continue;
    // Add the interval to every bucket it overlaps, clipped at bucket edges.
    for (let b = usageBucketStart(start, interval); b < end; b = usageBucketEnd(b, interval)) {
      const target = buckets.get(b);
      if (!target) break;
      const clipStart = Math.max(start, b);
      const clipEnd = Math.min(end, usageBucketEnd(b, interval));
      target.events.push({ at: clipStart, delta: 1 }, { at: clipEnd, delta: -1 });
      target.busyMs += Math.max(0, clipEnd - clipStart);
    }
  }
  for (const row of resources) {
    const at = Date.parse(row.hour_start);
    if (!Number.isFinite(at) || at < fromMs) continue;
    const bucket = buckets.get(usageBucketStart(at, interval));
    if (!bucket) continue;
    bucket.cpuUsedSum += Number(row.cpu_used_sum) || 0;
    bucket.cpuLimitSum += Number(row.cpu_limit_sum) || 0;
    bucket.memUsedSum += Number(row.mem_used_sum) || 0;
    bucket.memLimitSum += Number(row.mem_limit_sum) || 0;
    bucket.samples += Number(row.samples) || 0;
    bucket.instances.add(row.instance_id);
  }
  const out: RunnerUsageBucket[] = [];
  for (const [start, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
    bucket.events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let active = 0;
    let peak = 0;
    for (const event of bucket.events) {
      active += event.delta;
      peak = Math.max(peak, active);
    }
    const duration = usageBucketEnd(start, interval) - start;
    const instanceCount = bucket.instances.size;
    out.push({
      start: new Date(start).toISOString(),
      end: new Date(usageBucketEnd(start, interval)).toISOString(),
      requests: bucket.requests,
      concurrency: {
        peak,
        average: duration > 0 ? Math.round(bucket.busyMs / duration * 100) / 100 : 0,
      },
      cpuPercent: bucket.cpuLimitSum > 0 ? Math.round(bucket.cpuUsedSum / bucket.cpuLimitSum * 1000) / 10 : null,
      memoryUsedMb: bucket.samples > 0 && instanceCount > 0
        ? Math.round(bucket.memUsedSum / bucket.samples * instanceCount)
        : null,
      memoryLimitMb: bucket.samples > 0 && instanceCount > 0
        ? Math.round(bucket.memLimitSum / bucket.samples * instanceCount)
        : null,
      samples: bucket.samples,
      instances: instanceCount,
    });
    totals.peakConcurrency = Math.max(totals.peakConcurrency, peak);
  }
  return {
    from: new Date(first).toISOString(),
    to: new Date(usageBucketEnd(last, interval)).toISOString(),
    interval,
    buckets: out,
    totals,
  };
}
