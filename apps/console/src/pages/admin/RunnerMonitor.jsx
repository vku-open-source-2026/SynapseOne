// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useEffect, useState } from 'react';
import { Badge, Btn } from '../../components/ui.jsx';
import { freshSample } from '../../lib/runner-capacity.mjs';

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const memory = (v) => num(v) >= 1024 ? `${(num(v) / 1024).toFixed(1)} GiB` : `${Math.round(num(v))} MiB`;
const clock = (v) => new Date(v).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});

export function ResourceChart({ title, samples, getValue, maximum, format, color }) {
  const [hover, setHover] = useState(null);
  const width = 600, height = 150, pad = 12;
  const max = Math.max(1, maximum, ...samples.map(getValue));
  const start = new Date(samples[0]?.sampledAt || 0).getTime();
  const end = new Date(samples.at(-1)?.sampledAt || 0).getTime();
  const x = (sample) => pad + (new Date(sample.sampledAt).getTime() - start) / Math.max(1, end - start) * (width - pad * 2);
  const y = (sample) => height - pad - Math.min(max, Math.max(0, getValue(sample))) / max * (height - pad * 2);
  const active = hover !== null && samples[hover] ? samples[hover] : samples.at(-1);
  return <div className="rounded-2xl border border-slate-200 p-3 min-w-0">
    <div className="flex justify-between items-center text-xs mb-2"><h5 className="font-semibold">{title}</h5><span>{format(max)} max</span></div>
    {samples.length < 2 ? <p className="text-xs text-normal-text py-10">Waiting for two resource samples…</p> : <>
      <svg role="img" aria-label={`${title} over time`} viewBox={`0 0 ${width} ${height}`} className="w-full h-36" onMouseLeave={() => setHover(null)} onMouseMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const target = (event.clientX - box.left) / box.width * width;
        let nearest = 0;
        for (let i = 1; i < samples.length; i++) if (Math.abs(x(samples[i]) - target) < Math.abs(x(samples[nearest]) - target)) nearest = i;
        setHover(nearest);
      }}>
        {[0, .5, 1].map((part) => <line key={part} x1={pad} x2={width - pad} y1={pad + part * (height - pad * 2)} y2={pad + part * (height - pad * 2)} stroke="#e2e8f0" strokeDasharray="3 3" />)}
        <polyline fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" points={samples.map(s => `${x(s)},${y(s)}`).join(' ')} />
        {active && <circle cx={x(active)} cy={y(active)} r="4" fill={color} />}
      </svg>
      <div className="flex justify-between text-[10px] text-normal-text"><span>{clock(samples[0].sampledAt)}</span><span>{clock(samples.at(-1).sampledAt)}</span></div>
    </>}
    <div className="text-xs mt-2" aria-live="polite">{active ? `${clock(active.sampledAt)} · ${format(getValue(active))}` : 'No resource samples yet'}</div>
  </div>;
}

/** Combined day/hour chart: request volume (bars), peak concurrency and the
 *  CPU/RAM percentage at the same bucket. All lines share a 0..100 axis; the
 *  request bars use their own scale and the tooltip shows exact values. */
const USAGE_RANGES = {
  '24h': { hours: 24, interval: 'hour', label: 'hour' },
  '7d': { hours: 168, interval: 'day', label: 'day' },
  '30d': { hours: 720, interval: 'day', label: 'day' },
  '90d': { hours: 2160, interval: 'day', label: 'day' },
  '1y': { hours: 8760, interval: 'week', label: 'week' },
  '3y': { hours: 26280, interval: 'month', label: 'month' },
};

export function UsageChart({ buckets = [], interval = 'hour' }) {
  const [hover, setHover] = useState(null);
  const width = 720, height = 200, pad = 18;
  const data = buckets.filter((b) => b && b.start);
  const maxRequests = Math.max(1, ...data.map((b) => num(b.requests?.total)));
  const maxConcurrent = Math.max(1, ...data.map((b) => num(b.concurrency?.peak)));
  const left = pad, right = width - pad, top = pad, bottom = height - 26;
  const step = data.length ? (right - left) / data.length : 0;
  const xAt = (index) => left + step * index + step / 2;
  const yPercent = (value) => bottom - Math.min(100, Math.max(0, num(value))) / 100 * (bottom - top);
  const yConcurrent = (value) => bottom - Math.min(maxConcurrent, Math.max(0, num(value))) / maxConcurrent * (bottom - top);
  const yRequests = (value) => bottom - Math.min(maxRequests, Math.max(0, num(value))) / maxRequests * (bottom - top);
  const label = (bucket) => {
    const date = new Date(bucket.start);
    if (interval === 'month') return date.toLocaleDateString([], { month: 'short', year: 'numeric' });
    if (interval === 'week') return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    if (interval === 'day') return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const full = (bucket) => {
    const start = new Date(bucket.start);
    if (interval === 'month') return start.toLocaleDateString([], { month: 'long', year: 'numeric' });
    if (interval === 'week') return `Week of ${start.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
    if (interval === 'day') return start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return `${start.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}–${new Date(bucket.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };
  const active = hover !== null && data[hover] ? data[hover] : data.at(-1);
  const cpu = active?.cpuPercent;
  const ramPercent = active && num(active.memoryLimitMb) > 0 ? num(active.memoryUsedMb) / num(active.memoryLimitMb) * 100 : null;
  const line = (getY, getValue) => {
    const segments = [];
    let current = [];
    data.forEach((bucket, index) => {
      const value = getValue(bucket);
      if (value === null || value === undefined || !Number.isFinite(Number(value))) {
        if (current.length > 1) segments.push(current.join(' '));
        current = [];
      } else {
        current.push(`${xAt(index)},${getY(value)}`);
      }
    });
    if (current.length > 1) segments.push(current.join(' '));
    return segments;
  };
  const cpuSegments = line(yPercent, (b) => b.cpuPercent);
  const ramSegments = line(yPercent, (b) => b.memoryLimitMb ? num(b.memoryUsedMb) / num(b.memoryLimitMb) * 100 : null);
  const concurrentSegments = line(yConcurrent, (b) => b.concurrency?.peak ?? 0);
  return <div className="rounded-2xl border border-slate-200 p-3 min-w-0">
    <div className="flex flex-wrap justify-between items-center gap-2 text-xs mb-2">
      <h5 className="font-semibold">Requests, concurrency, CPU &amp; RAM</h5>
      <span className="text-normal-text">request bars · orange peak concurrent · blue CPU % · purple RAM %</span>
    </div>
    {data.length < 1 ? <p className="text-xs text-normal-text py-10">No usage history yet. Request bars appear after the runner executes work; CPU/RAM needs heartbeat samples.</p> : <>
      <svg role="img" aria-label="Runner requests, concurrent jobs, CPU and RAM over time" viewBox={`0 0 ${width} ${height}`} className="w-full h-52" onMouseLeave={() => setHover(null)} onMouseMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const target = (event.clientX - box.left) / box.width * width;
        let nearest = 0;
        for (let i = 1; i < data.length; i++) if (Math.abs(xAt(i) - target) < Math.abs(xAt(nearest) - target)) nearest = i;
        setHover(nearest);
      }}>
        {[0, 25, 50, 75, 100].map((percent) => <g key={percent}><line x1={left} x2={right} y1={yPercent(percent)} y2={yPercent(percent)} stroke="#e2e8f0" strokeDasharray="3 3" /><text x={left - 4} y={yPercent(percent) + 3} textAnchor="end" fontSize="9" fill="#64748b">{percent}%</text></g>)}
        {data.map((bucket, index) => {
          const barHeight = bottom - yRequests(bucket.requests?.total);
          return <rect key={`bar-${bucket.start}`} x={xAt(index) - Math.max(2, step * .28)} y={yRequests(bucket.requests?.total)} width={Math.max(4, step * .56)} height={Math.max(0, barHeight)} rx="2" fill="#bae6fd" />;
        })}
        {cpuSegments.map((points, index) => <polyline key={`cpu-${index}`} fill="none" stroke="#0284c7" strokeWidth="2" strokeLinejoin="round" points={points} />)}
        {ramSegments.map((points, index) => <polyline key={`ram-${index}`} fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinejoin="round" points={points} />)}
        {concurrentSegments.map((points, index) => <polyline key={`conc-${index}`} fill="none" stroke="#ea580c" strokeWidth="2" strokeDasharray="5 3" strokeLinejoin="round" points={points} />)}
        {active && <><line x1={xAt(hover ?? data.length - 1)} x2={xAt(hover ?? data.length - 1)} y1={top} y2={bottom} stroke="#94a3b8" strokeDasharray="2 3" /><circle cx={xAt(hover ?? data.length - 1)} cy={yPercent(cpu ?? 0)} r="3.5" fill="#0284c7" /></>}
      </svg>
      <div className="flex justify-between text-[10px] text-normal-text"><span>{label(data[0])}</span><span>{label(data.at(-1))}</span></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mt-2" aria-live="polite">
        <div><p className="text-normal-text">{active ? full(active) : 'No bucket'}</p><p className="font-semibold">{active ? `${num(active.requests?.total)} requests` : '–'}</p><p className="text-normal-text">{active ? `${num(active.requests?.workflow)} workflow · ${num(active.requests?.inference)} inference` : ''}</p></div>
        <div><p className="text-normal-text">Concurrent jobs</p><p className="font-semibold text-orange-600">{active ? `${num(active.concurrency?.peak)} peak` : '–'}</p><p className="text-normal-text">{active ? `${num(active.concurrency?.average).toFixed(2)} average` : ''}</p></div>
        <div><p className="text-normal-text">CPU at that time</p><p className="font-semibold text-sky-700">{cpu === null || cpu === undefined ? '–' : `${num(cpu).toFixed(1)}%`}</p></div>
        <div><p className="text-normal-text">RAM at that time</p><p className="font-semibold text-violet-700">{active?.memoryUsedMb === null || active?.memoryUsedMb === undefined ? '–' : memory(active.memoryUsedMb)}</p><p className="text-normal-text">{ramPercent === null ? 'No sample' : `${ramPercent.toFixed(1)}% of ${memory(active.memoryLimitMb)}`}</p></div>
      </div>
    </>}
  </div>;
}

export default function RunnerMonitor({runner, platform}) {
  const [expanded, setExpanded] = useState(true);
  const [instanceId, setInstanceId] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [usageRange, setUsageRange] = useState('24h');
  const [usage, setUsage] = useState(null);
  const [usageErr, setUsageErr] = useState(null);
  const usageRequest = platform?.request;
  const usageSpec = USAGE_RANGES[usageRange] || USAGE_RANGES['24h'];
  const instances = runner.instances || [];
  const instance = instances.find(i => i.id === instanceId) || instances.find(i => i.status === 'connected') || instances[0];
  const resources = instance?.metadata?.resources;
  const fresh = !!instance && !!freshSample(runner, instance);
  const samples = (instance?.metadata?.resourceHistory || []).filter(s => {
    const t = new Date(s?.sampledAt || 0).getTime();
    return Number.isFinite(t) && t >= Date.now() - minutes * 60000 && s.cpu && s.memory;
  }).sort((a,b) => new Date(a.sampledAt) - new Date(b.sampledAt));
  const active = instance?.metadata?.activeJobs;
  const awaitingTelemetry = !resources && instance?.status === 'connected';
  useEffect(() => {
    if (!usageRequest || !runner.id) return undefined;
    const { hours, interval } = usageSpec;
    let stopped = false;
    const loadUsage = async () => {
      try {
        const out = await usageRequest(`/v1/platform/runners/${encodeURIComponent(runner.id)}/usage?interval=${interval}&hours=${hours}`);
        if (stopped) return;
        setUsage(out);
        setUsageErr(null);
      } catch (e) {
        if (!stopped) setUsageErr(e);
      }
    };
    loadUsage();
    const timer = setInterval(loadUsage, 60000);
    return () => { stopped = true; clearInterval(timer); };
  }, [runner.id, usageRequest, usageSpec]);
  const usageTotals = usage?.totals;
  return <section aria-label="Runner resource monitoring" className="mb-4 rounded-2xl border border-slate-200 p-3">
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <h4 className="font-semibold text-sm flex-1">Resource monitoring</h4>
      <Badge tone={fresh ? 'green' : 'amber'}>{fresh ? 'Live resources' : 'No fresh resource sample'}</Badge>
      <Btn kind="secondary" onClick={() => setExpanded(v => !v)}>{expanded ? 'Hide charts' : 'Monitor resources'}</Btn>
    </div>
    {instances.length > 1 && <select aria-label="Monitored connector" className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs mb-3" value={instance?.id || ''} onChange={e => setInstanceId(e.target.value)}>
      {instances.map(i => <option key={i.id} value={i.id}>{i.hostname || i.id} · {i.status}</option>)}
    </select>}
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
      <div><p className="text-normal-text">CPU usage</p><p className="font-semibold mt-1">{resources ? `${num(resources.cpu?.percent).toFixed(1)}%` : '–'}</p><p className="text-normal-text">{resources ? `${num(resources.cpu?.usedCores).toFixed(2)} / ${num(resources.cpu?.limitCores).toFixed(2)} cores` : 'Waiting for telemetry'}</p></div>
      <div><p className="text-normal-text">CPU available</p><p className="font-semibold mt-1">{resources ? `${num(resources.cpu?.availableCores).toFixed(2)} cores` : '–'}</p></div>
      <div><p className="text-normal-text">Memory usage</p><p className="font-semibold mt-1">{resources ? memory(resources.memory?.usedMb) : '–'}</p><p className="text-normal-text">{resources ? `of ${memory(resources.memory?.limitMb)}` : 'Waiting for telemetry'}</p></div>
      <div><p className="text-normal-text">Memory available</p><p className="font-semibold mt-1">{resources ? memory(resources.memory?.availableMb) : '–'}</p></div>
    </div>
    <p className="text-[11px] text-normal-text mb-3">{resources ? `Last sample ${clock(resources.sampledAt)}. ` : ''}Task admission reserves CPU and memory, with 10% CPU and 256 MiB memory headroom. Jobs wait when capacity is unavailable.{active ? ` Active jobs: ${num(active.workflow)} workflow, ${num(active.inference)} inference.` : ''}</p>
    {!resources && <p role="status" className="text-xs text-amber-700 mb-3">{awaitingTelemetry
      ? 'This connector has not reported CPU/RAM telemetry. If it is using an older runner image, replace it with the current Docker command from this page. A supported runner reports every 15 seconds; charts appear after two samples.'
      : 'Connect a runner using the Docker command from this page. CPU/RAM charts appear after two heartbeat samples (about 30 seconds).'}</p>}
    {expanded && <>
      <div className="flex items-center gap-2 mb-3 text-xs"><label htmlFor={`resource-range-${runner.id}`}>Time range</label><select id={`resource-range-${runner.id}`} className="px-2 py-1 border rounded-xl" value={minutes} onChange={e => setMinutes(Number(e.target.value))}><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option></select><span className="text-normal-text">{samples.length} samples</span></div>
      <div className="grid md:grid-cols-2 gap-3">
        <ResourceChart title="CPU" samples={samples} getValue={s => num(s.cpu.percent)} maximum={100} format={v => `${num(v).toFixed(1)}%`} color="#0284c7" />
        <ResourceChart title="RAM" samples={samples} getValue={s => num(s.memory.usedMb)} maximum={num(resources?.memory?.limitMb)} format={memory} color="#7c3aed" />
      </div>
      <div className="mt-4 border-t border-slate-200 pt-4">
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
          <h5 className="font-semibold flex-1">Requests by {usage?.interval || usageSpec.label}</h5>
          <label htmlFor={`runner-usage-range-${runner.id}`}>History</label>
          <select id={`runner-usage-range-${runner.id}`} className="px-2 py-1 border rounded-xl" value={usageRange} onChange={e => setUsageRange(e.target.value)}>
            <option value="24h">Last 24 hours (hourly)</option>
            <option value="7d">Last 7 days (daily)</option>
            <option value="30d">Last 30 days (daily)</option>
            <option value="90d">Last 90 days (daily)</option>
            <option value="1y">Last 1 year (weekly)</option>
            <option value="3y">Last 3 years (monthly)</option>
          </select>
          {usageTotals && <Badge tone="blue">{num(usageTotals.total)} requests · peak {num(usageTotals.peakConcurrency)} concurrent</Badge>}
        </div>
        {usageTotals && <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
          <div><p className="text-normal-text">Total requests</p><p className="font-semibold text-lg mt-1">{num(usageTotals.total)}</p><p className="text-normal-text">{num(usageTotals.workflow)} workflow</p></div>
          <div><p className="text-normal-text">Inference requests</p><p className="font-semibold text-lg mt-1">{num(usageTotals.inference)}</p></div>
          <div><p className="text-normal-text">Peak concurrent</p><p className="font-semibold text-lg mt-1 text-orange-600">{num(usageTotals.peakConcurrency)}</p><p className="text-normal-text">real job intervals</p></div>
          <div><p className="text-normal-text">Buckets with traffic</p><p className="font-semibold text-lg mt-1">{usage.buckets?.filter(b => num(b.requests?.total) > 0).length || 0}</p><p className="text-normal-text">of {usage.buckets?.length || 0} {usage.interval} buckets</p></div>
        </div>}
        {usageErr && <p className="text-xs text-red-600 mb-2">Usage history unavailable: {String(usageErr.message || usageErr)}</p>}
        <UsageChart buckets={usage?.buckets || []} interval={usage?.interval || 'hour'} />
        <p className="text-[11px] text-normal-text mt-2">Requests are counted at the time the runner claimed the job (inference: enqueue time). Concurrent jobs are reconstructed from real claim/finish intervals. CPU/RAM are hourly heartbeat rollups; a bucket with no heartbeat shows no resource line point.</p>
      </div>
    </>}
  </section>;
}
