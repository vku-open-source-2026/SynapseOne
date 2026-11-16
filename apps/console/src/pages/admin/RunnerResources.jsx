// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Field, Input } from '../../components/ui.jsx';
export default function RunnerResources({value, onChange}) {
  const change = (key, val) => onChange({...value, [key]: val});
  return <fieldset className="rounded-2xl border border-slate-200 p-3 mb-3">
    <legend className="px-1 text-sm font-semibold">Docker resources</legend>
    {[
      {key: 'cpus', toggle: 'cpuEnabled', label: 'CPU limit', unit: 'cores', min: .25, max: 64, step: .25},
      {key: 'memoryMb', toggle: 'memoryEnabled', label: 'RAM limit', unit: 'MiB', min: 256, max: 262144, step: 256},
    ].map(({key, toggle, label, unit, min, max, step}) => <div key={key} className="mb-4">
      <div className="flex items-center gap-2 mb-2"><span className="text-xs font-medium flex-1">{label}</span>
        {[true, false].map(enabled => <button type="button" key={String(enabled)} aria-label={`${enabled ? 'Enable' : 'Disable'} ${label}`} aria-pressed={value[toggle] === enabled} onClick={() => change(toggle, enabled)} className={`px-2 py-1 rounded-lg text-xs ${value[toggle] === enabled ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600'}`}>{enabled ? 'Enable' : 'Disable'}</button>)}
      </div>
      <div className="flex items-center gap-3"><input aria-label={`${label} slider`} type="range" className="flex-1 min-w-0 accent-sky-600" min={min} max={max} step={step} disabled={!value[toggle]} value={value[key]} onChange={e => change(key, Number(e.target.value))} />
        <Input aria-label={label} className="w-28" type="number" min={min} max={max} step={key === 'cpus' ? .25 : 1} disabled={!value[toggle]} value={value[key]} onChange={e => change(key, e.target.value === '' ? '' : Number(e.target.value))} /><span className="text-xs">{unit}</span></div>
      {!value[toggle] && <p className="text-xs text-amber-700 mt-1">No Docker {key === 'cpus' ? 'CPU' : 'RAM'} cap; available host resources apply.</p>}
    </div>)}
    <Field label="Workflow concurrency" desc="Maximum parallel workflow jobs; CPU/RAM admission can admit fewer."><Input aria-label="Workflow concurrency" type="number" min={1} max={32} step={1} value={value.concurrency} onChange={e => change('concurrency', e.target.value === '' ? '' : Number(e.target.value))} /></Field>
    <p className="text-[11px] text-normal-text">RAM limit also disables swap. Settings affect the generated command; recreate the connector to apply them. Local model worker limits are configured separately.</p>
  </fieldset>;
}
