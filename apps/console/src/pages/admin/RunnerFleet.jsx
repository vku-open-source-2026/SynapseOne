// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, {useState} from 'react';
import {Badge, Card, Input} from '../../components/ui.jsx';
import {estimateFleet, fleetHistory} from '../../lib/runner-capacity.mjs';
import {ResourceChart} from './RunnerMonitor.jsx';
const memory = v => `${(v / 1024).toFixed(2)} GiB`;
export default function RunnerFleet({runners}) {
  const [minutes, setMinutes] = useState(15);
  const [profile, setProfile] = useState({cpu: .5, memoryMb: 128, duration: 1});
  const summary = estimateFleet(runners, profile);
  const samples = fleetHistory(runners, minutes);
  return <Card className="mb-4">
    <section aria-label="Fleet monitoring">
      <div className="flex flex-wrap items-center gap-3 mb-4"><h3 className="font-semibold flex-1">Fleet monitoring</h3><Badge tone={summary.fresh ? 'green' : 'amber'}>{summary.fresh} / {summary.connectors} connectors with live resources</Badge></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs mb-4">
        <div><p className="text-normal-text">Total CPU usage / limit</p><p className="font-semibold text-lg mt-1">{summary.fresh ? `${summary.cpuUsed.toFixed(2)} / ${summary.cpuLimit.toFixed(2)}` : '—'}</p><p>cores</p></div>
        <div><p className="text-normal-text">Total RAM usage / limit</p><p className="font-semibold text-lg mt-1">{summary.fresh ? `${memory(summary.memoryUsed)} / ${memory(summary.memoryLimit)}` : '—'}</p></div>
        <div><p className="text-normal-text">Reported active jobs</p><p className="font-semibold text-lg mt-1">{summary.fresh ? summary.active : '—'}</p><p>{summary.workflowFresh} live workflow connectors</p></div>
        <div aria-live="polite"><p className="text-normal-text">Estimated additional workflow jobs</p><p className="font-semibold text-lg mt-1" data-testid="fleet-slots">{summary.workflowFresh ? summary.slots : '—'}</p><p data-testid="fleet-rps">{summary.workflowFresh ? `≈ ${summary.rps.toFixed(2)} requests/s` : 'Waiting for live telemetry'}</p></div>
      </div>
      <div className="rounded-xl bg-slate-50 p-3 mb-4">
        <h4 className="text-xs font-semibold mb-2">Capacity scenario</h4>
        <div className="grid md:grid-cols-3 gap-3">{[['cpu','CPU per job (cores)',.05,64,.05], ['memoryMb','RAM per job (MiB)',32,262144,1], ['duration','Average job duration (seconds)',.1,3600,.1]].map(([key,label,min,max,step]) => <label key={key} className="text-xs">{label}<Input aria-label={label} type="number" min={min} max={max} step={step} value={profile[key]} onChange={e => setProfile({...profile,[key]: e.target.value === '' ? '' : Number(e.target.value)})} /></label>)}</div>
        <p className="text-[11px] text-normal-text mt-2">Scenario estimate, not measured throughput. Additional jobs fit per connector after 10% CPU / 256 MiB RAM headroom and reported concurrency. Active jobs assume default reservations (workflow 0.5 CPU / 128 MiB, inference 1 CPU / 256 MiB). Actual scheduling uses each job&apos;s persisted requirements; custom jobs, shared hosts and external service latency can lower throughput. Disabled, offline and stale connectors are excluded.</p>
      </div>
      <div className="flex gap-2 items-center text-xs mb-3"><label htmlFor="fleet-time-range">Fleet time range</label><select id="fleet-time-range" value={minutes} onChange={e => setMinutes(Number(e.target.value))} className="border rounded-lg px-2 py-1"><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option></select><span className="text-normal-text">{samples.length} complete fleet samples · live connectors only</span></div>
      <div className="grid md:grid-cols-2 gap-3"><ResourceChart title="Fleet CPU" samples={samples} getValue={s => s.cpu.percent} maximum={100} format={v => `${v.toFixed(1)}%`} color="#0284c7" /><ResourceChart title="Fleet RAM" samples={samples} getValue={s => s.memory.usedMb} maximum={summary.memoryLimit} format={memory} color="#7c3aed" /></div>
    </section>
  </Card>;
}
