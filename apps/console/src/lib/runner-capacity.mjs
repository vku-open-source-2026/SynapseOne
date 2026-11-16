// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
export const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
export function dockerDefaults(runner = {}) {
  const limits = runner.inference?.limits || runner.metadata?.inference?.limits || {};
  return { cpuEnabled: true, memoryEnabled: true, cpus: finite(limits.threads) > 0 ? finite(limits.threads) : 2,
    memoryMb: finite(limits.maxRssMb) > 0 ? finite(limits.maxRssMb) : runner.kind === 'workflow' ? 1024 : 6144,
    concurrency: 8, ...(runner.dockerResources || runner.metadata?.dockerResources) };
}
export function commandWithResources(command, settings) {
  // Only replace our generated numeric Docker flags; preserve the opaque key,
  // image, model names and shell quoting exactly as returned by the server.
  if (!command?.startsWith('docker run -d ')) return command || '';
  const cpus = Math.min(64, Math.max(.25, finite(settings.cpus, 2)));
  const memory = Math.round(Math.min(262144, Math.max(256, finite(settings.memoryMb, 1024))));
  const concurrency = Math.round(Math.min(32, Math.max(1, finite(settings.concurrency, 8))));
  const flags = [settings.cpuEnabled ? `--cpus=${cpus}` : '', settings.memoryEnabled ? `--memory=${memory}m --memory-swap=${memory}m` : ''].filter(Boolean).join(' ');
  const newline = command.indexOf('\n');
  const header = newline < 0 ? command : command.slice(0, newline);
  const tail = newline < 0 ? '' : command.slice(newline);
  return header.replace(/--(?:cpus|memory|memory-swap)=[\d.]+[mg]?\s*/g, '')
    .replace('docker run -d ', `docker run -d ${flags ? flags + ' ' : ''}`) +
    tail.replace(/(\n  -e WORKFLOW_RUNNER_CONCURRENCY=)\d+/, `$1${concurrency}`);
}
export function freshSample(runner, instance, now = Date.now()) {
  const sample = instance.metadata?.resources;
  const timestamp = Date.parse(sample?.sampledAt);
  return runner.status !== 'disabled' && instance.status === 'connected' && sample &&
    Number.isFinite(timestamp) && now - timestamp <= 45000 && timestamp - now <= 5000 &&
    finite(sample.cpu?.limitCores) > 0 && finite(sample.memory?.limitMb) > 0 ? sample : null;
}
export function estimateFleet(runners, profile = {}, now = Date.now()) {
  const cpu = Math.max(.05, finite(profile.cpu, .5));
  const memoryMb = Math.max(32, finite(profile.memoryMb, 128));
  const duration = Math.max(.1, finite(profile.duration, 1));
  const out = { connectors: 0, fresh: 0, workflowFresh: 0, cpuLimit: 0, cpuUsed: 0, memoryLimit: 0, memoryUsed: 0, active: 0, slots: 0, rows: [] };
  for (const runner of runners) for (const instance of runner.instances || []) {
    out.connectors++;
    const sample = freshSample(runner, instance, now);
    if (!sample) continue;
    out.fresh++;
    const active = instance.metadata?.activeJobs;
    const workflow = Math.max(0, finite(active?.workflow));
    const inference = Math.max(0, finite(active?.inference));
    out.active += workflow + inference;
    out.cpuLimit += finite(sample.cpu.limitCores);
    out.cpuUsed += finite(sample.cpu.usedCores);
    out.memoryLimit += finite(sample.memory.limitMb);
    out.memoryUsed += finite(sample.memory.usedMb);
    // Scenario estimate, using default active-job reservations. Actual claims
    // use persisted per-job requirements atomically on the server.
    const availableCpu = Math.max(0, Math.min(finite(sample.cpu.availableCores), finite(sample.cpu.limitCores) - workflow * .5 - inference) - finite(sample.cpu.limitCores) * .1);
    const availableMemory = Math.max(0, finite(sample.memory.availableMb) - workflow * 128 - inference * 256 - 256);
    const concurrency = Math.max(1, finite(instance.concurrency, 1));
    const workflowEligible = runner.kind !== 'inference';
    const slots = workflowEligible ? Math.max(0, Math.min(Math.floor((availableCpu + 1e-9) / cpu), Math.floor(availableMemory / memoryMb), concurrency - workflow)) : 0;
    if (workflowEligible) out.workflowFresh++;
    out.slots += slots;
    out.rows.push({ runnerId: runner.id, instanceId: instance.id, name: instance.hostname || instance.id, slots, availableCpu, availableMemory });
  }
  out.rps = out.slots / duration;
  return out;
}
export function fleetHistory(runners, minutes, now = Date.now()) {
  const eligible = runners.filter(r => r.status !== 'disabled').flatMap(r => (r.instances || []).filter(i => freshSample(r, i, now)));
  const buckets = new Map();
  for (const instance of eligible) for (const sample of instance.metadata?.resourceHistory || []) {
    const time = Date.parse(sample.sampledAt);
    if (!Number.isFinite(time) || time < now - minutes * 60000 || time > now + 5000 || !sample.cpu || !sample.memory) continue;
    const bucket = Math.floor(time / 15000) * 15000;
    if (!buckets.has(bucket)) buckets.set(bucket, new Map());
    const points = buckets.get(bucket);
    if (!points.has(instance.id) || time > Date.parse(points.get(instance.id).sampledAt)) points.set(instance.id, sample);
  }
  // Omit incomplete buckets, so a missing host does not look like lower load.
  return [...buckets].sort(([a], [b]) => a - b).filter(([, points]) => points.size === eligible.length).map(([time, points]) => {
    const total = [...points.values()].reduce((a,s) => ({ cores: a.cores + finite(s.cpu.limitCores), used: a.used + finite(s.cpu.usedCores), memory: a.memory + finite(s.memory.usedMb) }), {cores: 0, used: 0, memory: 0});
    return {sampledAt: new Date(time).toISOString(), cpu: {percent: total.cores ? total.used / total.cores * 100 : 0}, memory: {usedMb: total.memory}};
  });
}
