// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Owner-scoped (platform) runners. These are system compute connectors: any
 * platform owner can manage them, they hold no user token, and they execute
 * `system`-mode workflows for every tenant through a per-job delegation.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck, faCopy, faKey, faPlug, faPlus, faRotateRight, faServer, faTerminal, faTrash, faGear, faPlay,
} from '@fortawesome/free-solid-svg-icons';
import RunnerMonitor from './RunnerMonitor.jsx';
import RunnerFleet from './RunnerFleet.jsx';
import RunnerResources from './RunnerResources.jsx';
import { commandWithResources, dockerDefaults } from '../../lib/runner-capacity.mjs';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Spinner, Table } from '../../components/ui.jsx';

function statusTone(status) {
  if (status === 'connected') return 'green';
  if (status === 'degraded') return 'amber';
  if (status === 'offline') return 'red';
  if (status === 'waiting') return 'blue';
  return 'gray';
}

function statusLabel(status) {
  if (status === 'connected') return 'Connected';
  if (status === 'degraded') return 'Degraded';
  if (status === 'offline') return 'Offline';
  if (status === 'waiting') return 'Waiting for connector';
  if (status === 'disabled') return 'Disabled';
  return status || 'Unknown';
}

function fmtTime(value) {
  if (!value) return 'never';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

function age(value) {
  if (!value) return '';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const SELECT_CLASS = 'w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none';
const DEFAULT_INFERENCE = {
  mode: 'local', capabilities: ['embeddings', 'decision', 'route'],
  models: { embeddings: 'sentence-transformers/all-MiniLM-L6-v2', decision: 'vllm-sr/Decision-2.0-Eos-0.8B' },
  limits: { threads: 2, maxBatch: 8, maxTokens: 512, maxRssMb: 6144, timeoutMs: 120000 },
};
const freshInference = (value) => ({
  ...DEFAULT_INFERENCE, ...value, mode: 'local',
  capabilities: [...(value?.capabilities || DEFAULT_INFERENCE.capabilities)],
  models: { ...DEFAULT_INFERENCE.models, ...value?.models },
  limits: { ...DEFAULT_INFERENCE.limits, ...value?.limits },
});

function InferenceFields({ value, onChange }) {
  const changeLimit = (key, raw) => onChange({ ...value, limits: { ...value.limits, [key]: raw === '' ? '' : Number(raw) } });
  return (
    <div className="rounded-2xl bg-slate-50 p-3 mb-3">
      <p className="text-xs text-normal-text mb-3">Models run inside this Docker container. The image includes MiniLM embeddings and Decision-2.0. Allow 6 GiB RAM for both models.</p>
      <fieldset className="mb-3">
        <legend className="text-xs font-medium text-normal-text mb-2">Local capabilities</legend>
        <div className="flex flex-wrap gap-4">
          {['embeddings', 'decision', 'route'].map((cap) => (
            <label key={cap} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={value.capabilities.includes(cap)} onChange={(e) => onChange({
                ...value, capabilities: e.target.checked ? [...value.capabilities, cap] : value.capabilities.filter((v) => v !== cap),
              })} />{cap}
            </label>
          ))}
        </div>
      </fieldset>
      <details>
        <summary className="text-xs font-medium cursor-pointer mb-3">Models and resource limits</summary>
        <Field label="Embedding model" desc="Must be available in the runner image's offline model cache.">
          <Input value={value.models.embeddings || ''} onChange={(e) => onChange({ ...value, models: { ...value.models, embeddings: e.target.value } })} />
        </Field>
        <Field label="Decision model">
          <Input value={value.models.decision || ''} onChange={(e) => onChange({ ...value, models: { ...value.models, decision: e.target.value } })} />
        </Field>
        <div className="grid grid-cols-2 gap-x-3">
          {[
            ['threads', 'CPU threads', 0, 64], ['maxRssMb', 'Memory limit (MiB)', 128, 32768],
            ['maxBatch', 'Maximum batch', 1, 64], ['maxTokens', 'Maximum output tokens', 1, 8192],
            ['timeoutMs', 'Job timeout (ms)', 1000, 300000],
          ].map(([key, label, min, max]) => (
            <Field key={key} label={label}><Input type="number" min={min} max={max} value={value.limits[key]} onChange={(e) => changeLimit(key, e.target.value)} /></Field>
          ))}
        </div>
      </details>
    </div>
  );
}

function InferenceHealth({ health }) {
  if (!health) return <p className="text-xs text-normal-text">Waiting for the connector to report local model readiness.</p>;
  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center text-xs"><Badge tone={health.ready ? 'green' : 'amber'}>{health.status || 'Starting'}</Badge><span>Last report: {fmtTime(health.checkedAt || health.updatedAt)}</span></div>
      {Object.entries(health.capabilities || {}).map(([cap, state]) => (
        <div key={cap} className="rounded-xl border border-slate-200 px-3 py-2 text-xs">
          <div className="flex flex-wrap gap-2 items-center"><b>{cap}</b><Badge tone={state.ready === true ? 'green' : state.enabled === false ? 'gray' : 'amber'}>{state.ready === true ? 'Ready' : state.state || 'Unavailable'}</Badge><span className="break-all">{state.model || 'No model'}{state.backend ? ` · ${state.backend}` : ''}</span></div>
          {state.error && <p className="mt-1 text-red-600 break-words">{typeof state.error === 'string' ? state.error : state.error.message || state.error.code}</p>}
        </div>
      ))}
      {health.lastError && <p className="text-xs text-red-600 break-words">{typeof health.lastError === 'string' ? health.lastError : health.lastError.message}</p>}
    </div>
  );
}

export default function AdminRunners() {
  const platform = usePlatformAuth();
  const isOwner = platform.role === 'owner';
  const [runners, setRunners] = useState(null);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('workflow');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [check, setCheck] = useState(null);
  const [copied, setCopied] = useState(false);
  const [inference, setInference] = useState(() => freshInference());
  const [editing, setEditing] = useState(null);
  const [dockerResources, setDockerResources] = useState(() => dockerDefaults({kind: 'workflow'}));
  const [actionBusy, setActionBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testType, setTestType] = useState('workflow');
  const testSeq = useRef(0);
  const seq = useRef(0);
  const selectedRef = useRef(null);
  selectedRef.current = selectedId;
  useEffect(() => { testSeq.current += 1; setTestResult(null); setTestType('workflow'); }, [selectedId]);

  const load = useCallback(async (quiet = false) => {
    if (!isOwner) return;
    const my = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const out = await platform.request('/v1/platform/runners');
      if (my !== seq.current) return;
      const list = Array.isArray(out?.data) ? out.data : [];
      setRunners(list);
      setMeta(out?.platformRunner || null);
      if (selectedRef.current) {
        const fresh = list.find((r) => r.id === selectedRef.current);
        if (fresh) setDetail(fresh);
      }
      setErr(null);
    } catch (e) {
      if (my === seq.current) setErr(e);
    } finally {
      if (my === seq.current && !quiet) setLoading(false);
    }
  }, [isOwner, platform]);

  useEffect(() => {
    if (!isOwner) return undefined;
    load();
    return () => { seq.current += 1; };
  }, [isOwner, load]);

  useEffect(() => {
    if (!isOwner || !autoRefresh) return undefined;
    const t = setInterval(() => { load(true); }, 5000);
    return () => clearInterval(t);
  }, [isOwner, autoRefresh, load]);

  useEffect(() => {
    if (!selectedId || !isOwner) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const out = await platform.request(`/v1/platform/runners/${encodeURIComponent(selectedId)}/connection`);
        if (stopped) return;
        if (out?.runner) setDetail(out.runner);
      } catch {
        /* keep the last known detail */
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => { stopped = true; clearInterval(t); };
  }, [selectedId, isOwner, platform]);

  useEffect(() => {
    if (!created?.runner?.id || !isOwner) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const out = await platform.request(`/v1/platform/runners/${encodeURIComponent(created.runner.id)}/connection`);
        if (stopped) return;
        setCheck(out);
        if (out?.runner) setCreated((cur) => (cur ? { ...cur, runner: out.runner } : cur));
      } catch {
        /* keep polling */
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => { stopped = true; clearInterval(t); };
  }, [created?.runner?.id, isOwner, platform]);

  const resetCreate = () => {
    setOpen(false);
    setBusy(false);
    setCreated(null);
    setCheck(null);
    setCopied(false);
    setName('');
    setKind('workflow');
    setInference(freshInference());
    setDockerResources(dockerDefaults({kind: 'workflow'}));
  };

  const createRunner = async () => {
    if (!name.trim()) return setErr(new Error('Runner name is required'));
    setBusy(true);
    setErr(null);
    try {
      const out = await platform.request('/v1/platform/runners', {
        method: 'POST',
        body: { name: name.trim(), kind, dockerResources, ...(kind !== 'workflow' ? { inference } : {}) },
      });
      setCreated(out);
      setDockerResources(dockerDefaults(out.runner));
      setSelectedId(out.runner?.id || null);
      setCheck({ connected: false, status: 'waiting', instanceCount: 0 });
      await load(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const rotateKey = async (runner) => {
    if (!runner) return;
    if (!window.confirm('Rotate this runner key? The old key is revoked immediately; the connector must be restarted with the new key.')) return;
    try {
      const out = await platform.request(`/v1/platform/runners/${encodeURIComponent(runner.id)}/rotate-key`, { method: 'POST' });
      setCreated(out);
      setDockerResources(dockerDefaults(out.runner));
      setCheck(null);
      setCopied(false);
      setSelectedId(runner.id);
      // The new key is returned exactly once by the rotate response. Without
      // opening the connect modal the owner would never see it after the old
      // key has already been revoked.
      setOpen(true);
      await load(true);
    } catch (e) {
      setErr(e);
    }
  };

  const showCommand = async (runner) => {
    setActionBusy(true);
    try {
      const out = await platform.request(`/v1/platform/runners/${encodeURIComponent(runner.id)}/command`, {method: 'POST'});
      setCreated({...out, runner});
      setDockerResources(dockerDefaults(runner));
      setCopied(false);
      setCheck(null);
      setOpen(true);
    } catch (e) { setErr(e); } finally { setActionBusy(false); }
  };

  const removeRunner = async (runner) => {
    if (!runner) return;
    if (!window.confirm('Delete this platform runner? Its key is revoked and connector instances are removed. System-mode jobs stay queued until another runner is online.')) return;
    try {
      await platform.request(`/v1/platform/runners/${encodeURIComponent(runner.id)}`, { method: 'DELETE' });
      if (selectedId === runner.id) {
        setSelectedId(null);
        setDetail(null);
      }
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const manage = async (action, message) => {
    if (message && !window.confirm(message)) return;
    setActionBusy(true);
    setErr(null);
    try {
      const out = await platform.request(`/v1/platform/runners/${encodeURIComponent(detail.id)}/${action}`, { method: 'POST' });
      if (out.runner) setDetail(out.runner);
      await load(true);
    } catch (e) { setErr(e); } finally { setActionBusy(false); }
  };

  const saveSettings = async () => {
    setActionBusy(true);
    setErr(null);
    try {
      const out = await platform.request(`/v1/platform/runners/${encodeURIComponent(editing.id)}`, {
        method: 'PATCH', body: { name: editing.name.trim(), kind: editing.kind, dockerResources: editing.dockerResources, ...(editing.kind !== 'workflow' ? { inference: editing.inference } : {}) },
      });
      if (out.runner) setDetail(out.runner);
      setEditing(null);
      await load(true);
    } catch (e) { setErr(e); } finally { setActionBusy(false); }
  };

  const removeInstance = async (inst) => {
    if (!window.confirm('Remove this offline connector record?')) return;
    setActionBusy(true);
    try {
      await platform.request(`/v1/platform/runners/${encodeURIComponent(detail.id)}/instances/${encodeURIComponent(inst.id)}`, { method: 'DELETE' });
      await load(true);
    } catch (e) { setErr(e); } finally { setActionBusy(false); }
  };

  const runTest = async () => {
    const my = ++testSeq.current;
    const id = detail.id;
    setActionBusy(true);
    setTestResult(null);
    setErr(null);
    try {
      let out = await platform.request(`/v1/platform/runners/${encodeURIComponent(id)}/test`, { method: 'POST', body: { type: detail.kind === 'inference' && testType === 'workflow' ? 'embeddings' : testType } });
      if (my !== testSeq.current) return;
      setTestResult(out);
      const deadline = Date.now() + 300000;
      const pollUrl = out.pollUrl;
      while (['queued', 'running'].includes(out.status) && pollUrl && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (my !== testSeq.current) return;
        out = await platform.request(pollUrl);
        if (my !== testSeq.current) return;
        setTestResult(out);
      }
    } catch (e) { if (my === testSeq.current) setErr(e); }
    finally { setActionBusy(false); }
  };

  const copyCommand = async () => {
    try {
      const command = commandWithResources(created?.command, dockerResources);
      await platform.request(`/v1/platform/runners/${encodeURIComponent(created.runner.id)}`, {method: 'PATCH', body: {dockerResources}});
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { setErr(e); /* textarea remains selectable */ }
  };

  if (!isOwner) {
    return (
      <>
        <PageTitle title="Platform Runners" sub="Owner-managed system compute for every tenant" />
        <Card><Empty text="Your platform role cannot manage platform runners. Ask a platform owner." /></Card>
      </>
    );
  }

  const rows = Array.isArray(runners) ? runners : [];

  return (
    <>
      <PageTitle
        title="Platform Runners"
        sub="Manage system workflow and local inference runners"
        right={(
          <>
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={`mr-2 px-3 py-1.5 rounded-2xl text-xs font-medium ${autoRefresh ? 'bg-emerald-500/10 text-emerald-600' : 'bg-slate-100 text-normal-text'}`}
            >
              {autoRefresh ? 'Live · 5s' : 'Live off'}
            </button>
            <Btn kind="secondary" onClick={() => load()} disabled={loading}>
              <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" />Refresh
            </Btn>
            <Btn onClick={() => { resetCreate(); setOpen(true); }}>
              <FontAwesomeIcon icon={faPlus} className="mr-1.5" />New platform runner
            </Btn>
          </>
        )}
      />
      <Err e={err} />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white flex items-center justify-center">
            <FontAwesomeIcon icon={faServer} />
          </div>
          <div className="flex-1 min-w-[240px]">
            <h3 className="font-semibold text-main-text">Connect a Docker host</h3>
            <p className="text-xs text-normal-text mt-0.5">Create a runner, copy its command and run it on a host with Docker installed. Monitor connectors, test jobs and manage access here.</p>
            <p className="text-xs text-normal-text mt-1">Inference models run locally inside the runner container. Model readiness is reported separately from the connection.</p>
          </div>
        </div>
      </Card>

      <RunnerFleet runners={rows} />

      <Card className="mb-4">
        <h3 className="font-semibold text-main-text mb-2 flex items-center gap-2">
          <FontAwesomeIcon icon={faPlug} /> Platform runners ({rows.length})
        </h3>
        {loading && !runners ? (
          <div className="py-6 flex justify-center"><Spinner /></div>
        ) : rows.length ? (
          <Table head={['Runner', 'Type', 'Queue', 'Connectors', 'CPU / RAM', 'Status', 'Last seen', '']}>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => { setSelectedId(r.id); setDetail(r); }}
                className={`border-t border-slate-100 cursor-pointer hover:bg-background ${selectedId === r.id ? 'bg-sky-50/60' : ''}`}
              >
                <td className="py-2 pr-4">
                  <div className="font-medium text-main-text text-sm">{r.name}</div>
                  <div className="font-mono text-[11px] text-normal-text">{r.id.slice(0, 8)}…</div>
                </td>
                <td className="py-2 pr-4"><Badge tone={r.kind === 'hybrid' ? 'amber' : r.kind === 'inference' ? 'blue' : 'gray'}>{r.kind || 'workflow'}</Badge></td>
                <td className="py-2 pr-4 font-mono text-[11px]">
                  <div>{r.kind === 'inference' ? (r.inferenceQueue || r.queue) : r.queue}</div>
                  {r.kind === 'hybrid' && r.inferenceQueue && <div className="text-normal-text">{r.inferenceQueue}</div>}
                </td>
                <td className="py-2 pr-4 text-xs">
                  <span className="font-medium">{r.connectedInstances || 0}</span>
                  <span className="text-normal-text"> / {r.instanceCount || 0} online</span>
                </td>
                <td className="py-2 pr-4 text-xs text-normal-text">{(() => {
                  const sample = r.instances?.find(i => i.status === 'connected')?.metadata?.resources;
                  if (!sample || Date.now() - new Date(sample.sampledAt).getTime() > 45000) return 'No fresh sample';
                  return `${Number(sample.cpu?.percent || 0).toFixed(0)}% · ${Math.round(sample.memory?.usedMb || 0)} MiB`;
                })()}</td>
                <td className="py-2 pr-4"><Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge></td>
                <td className="py-2 pr-4 text-xs text-normal-text">{r.lastSeenAt ? `${fmtTime(r.lastSeenAt)} · ${age(r.lastSeenAt)}` : 'never'}</td>
                <td className="py-2 pr-4 text-right">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeRunner(r); }}
                    title="Delete platform runner"
                    className="px-2 py-1 rounded-xl bg-red-500/10 text-red-500 text-xs"
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No platform runners yet. Create one to run workflows whose execution mode is `system`." />
        )}
      </Card>

      {selectedId && detail && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-start gap-3 mb-3">
            <div className="w-10 h-10 rounded-2xl bg-slate-100 text-main-text flex items-center justify-center">
              <FontAwesomeIcon icon={faPlug} />
            </div>
            <div className="flex-1 min-w-[240px]">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-main-text">{detail.name}</h3>
                <Badge tone={statusTone(detail.status)}>{statusLabel(detail.status)}</Badge>
                <Badge tone="blue">platform</Badge>
              </div>
              <p className="text-xs text-normal-text mt-0.5">
                <span className="font-mono">{detail.id}</span> · <b>{detail.kind}</b> · key {detail.keyPrefix ? `${detail.keyPrefix}…` : '–'}
              </p>
              <p className="text-[11px] text-normal-text mt-0.5 font-mono">
                {detail.kind !== 'inference' ? `workflow: ${detail.queue}` : ''}
                {detail.kind === 'hybrid' ? ' · ' : ''}
                {detail.kind !== 'workflow' ? `inference: ${detail.inferenceQueue || '-'}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn kind="secondary" disabled={actionBusy} onClick={() => showCommand(detail)}><FontAwesomeIcon icon={faTerminal} />Docker command</Btn>
              <Btn kind="secondary" disabled={actionBusy} onClick={() => setEditing({ id: detail.id, name: detail.name, kind: detail.kind, dockerResources: dockerDefaults(detail), inference: freshInference(detail.inference || detail.metadata?.inference) })}>
                <FontAwesomeIcon icon={faGear} />Settings
              </Btn>
              <Btn kind="secondary" disabled={actionBusy} onClick={() => manage(detail.status === 'disabled' ? 'enable' : 'disable')}>
                {detail.status === 'disabled' ? 'Enable' : 'Disable'}
              </Btn>
              <Btn kind="secondary" disabled={actionBusy} onClick={() => manage('revoke-key', 'Revoke the runner key and disable this runner? Rotate the key to reconnect it.')}>
                Revoke key
              </Btn>
              <Btn kind="secondary" disabled={actionBusy} onClick={() => rotateKey(detail)}>
                <FontAwesomeIcon icon={faKey} className="mr-1.5" />Rotate key
              </Btn>
              <Btn kind="secondary" onClick={() => removeRunner(detail)}>
                <FontAwesomeIcon icon={faTrash} className="mr-1.5" />Delete
              </Btn>
            </div>
          </div>

          <RunnerMonitor key={detail.id} runner={detail} platform={platform} />
          {detail.lastError && <p className="text-xs text-red-600 mb-3 break-words">{detail.lastError}</p>}
          {detail.kind !== 'workflow' && <div className="mb-4"><h4 className="font-semibold text-sm mb-2">Local inference</h4><InferenceHealth health={detail.inferenceHealth || detail.metadata?.inferenceHealth} /></div>}
          <div className="rounded-2xl border border-slate-200 p-3 mb-4">
            <h4 className="font-semibold text-sm mb-2">Test this runner</h4>
            <div className="flex flex-wrap gap-2">
              <select aria-label="Test job type" className={SELECT_CLASS + ' max-w-[220px]'} value={detail.kind === 'inference' && testType === 'workflow' ? 'embeddings' : testType} onChange={(e) => setTestType(e.target.value)}>
                {detail.kind !== 'inference' && <option value="workflow">Workflow job</option>}
                {detail.kind !== 'workflow' && (detail.inference?.capabilities || detail.metadata?.inference?.capabilities || ['embeddings', 'decision', 'route']).filter((v) => v !== 'chat').map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <Btn loading={actionBusy} disabled={!detail.connected || detail.status === 'disabled'} onClick={runTest}><FontAwesomeIcon icon={faPlay} />Run test</Btn>
            </div>
            {testResult && <div aria-live="polite" className="mt-3 text-xs">
              <Badge tone={testResult.ok === true && testResult.status === 'success' ? 'green' : testResult.status === 'error' ? 'red' : 'blue'}>{testResult.status || 'Checking'}</Badge>
              <p className="mt-2">{testResult.model}{testResult.dimensions ? ` · ${testResult.dimensions} dimensions` : ''}{testResult.vectorCount ? ` · ${testResult.vectorCount} vector(s)` : ''}</p>
              {testResult.jobId && <p className="break-all">Job: {testResult.jobId}</p>}
              {testResult.runnerId && <p className="break-all">Runner: {testResult.runnerId}</p>}
              {testResult.error && <p className="text-red-600 break-words">{typeof testResult.error === 'string' ? testResult.error : testResult.error.message}</p>}
              {['queued', 'running'].includes(testResult.status) && <p className="mt-1">Waiting for the runner to finish the job…</p>}
            </div>}
          </div>
          <div className="flex items-center justify-between mb-2 mt-4">
            <h4 className="font-semibold text-main-text text-sm">Connectors ({detail.instances?.length || 0})</h4>
            <span className="text-[11px] text-normal-text">stale after {meta?.staleAfterSeconds || 60}s · heartbeat {meta?.heartbeatIntervalSeconds || 15}s</span>
          </div>
          {detail.instances?.length ? (
            <Table head={['Instance', 'Host', 'Version', 'Concurrency', 'Status', 'Last seen', '']}>
              {detail.instances.map((inst) => (
                <tr key={inst.id} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-mono text-[11px] text-main-text">{inst.id}</td>
                  <td className="py-2 pr-4 text-xs">{inst.hostname || '–'}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{inst.version || '–'}</td>
                  <td className="py-2 pr-4 text-xs">{inst.concurrency}</td>
                  <td className="py-2 pr-4"><Badge tone={inst.status === 'connected' ? 'green' : 'gray'}>{inst.status}</Badge></td>
                  <td className="py-2 pr-4 text-xs text-normal-text">{fmtTime(inst.lastSeenAt)} · {age(inst.lastSeenAt)}</td>
                  <td>{inst.status !== 'connected' && <button type="button" className="text-xs text-red-600" disabled={actionBusy} onClick={() => removeInstance(inst)}>Remove</button>}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-xs text-normal-text">
              No connector has connected yet. Deploy the runner with its platform key and it will appear here after the first heartbeat.
            </div>
          )}
        </Card>
      )}

      <Modal title={created ? 'Connect the platform runner' : 'New platform runner'} open={open} onClose={resetCreate}>
        {!created ? (
          <>
            <Field label="Runner name">
              <Input aria-label="Runner name" value={name} onChange={(e) => setName(e.target.value)} placeholder="system-compute-eu" />
            </Field>
            <Field label="Runner type">
              <select
                aria-label="Runner type"
                value={kind}
                onChange={(e) => { setKind(e.target.value); setDockerResources(dockerDefaults({kind: e.target.value})); }}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none"
              >
                <option value="workflow">workflow — execute system-mode SynapseFlow DAGs</option>
                <option value="inference">inference — run models locally in this container</option>
                <option value="hybrid">hybrid — workflow + inference lanes in one connector</option>
              </select>
            </Field>
            <div className="mb-3 rounded-2xl bg-sky-500/10 p-3 text-[11px] text-sky-900">
              Platform runners are always <b>system</b> scope on queue{' '}
              <span className="font-mono">{meta?.queue || 'synapseone-wf-system'}</span>. They can execute any tenant&apos;s
              workflow that explicitly selects <span className="font-mono">system</span> execution mode.
            </div>
            <RunnerResources value={dockerResources} onChange={setDockerResources} />
            {kind !== 'workflow' && <InferenceFields value={inference} onChange={setInference} />}
            <Err e={err} />
            <Btn onClick={createRunner} disabled={busy || (kind !== 'workflow' && !inference.capabilities.length)} loading={busy}>
              Create platform runner <FontAwesomeIcon icon={faServer} className="ml-1.5" />
            </Btn>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Badge tone={check?.connected ? 'green' : check?.instanceCount ? 'amber' : 'blue'}>
                {check?.connected ? 'Connected' : check?.instanceCount ? 'Connector offline' : 'Waiting for connector…'}
              </Badge>
              <span className="text-xs text-normal-text">
                {check?.connected
                  ? `${check.connectedInstances || 0} connector(s) online — you can close this dialog.`
                  : 'Run the command below. This panel checks the heartbeat every 2.5s.'}
              </span>
              {check?.lastError && <span className="text-xs text-red-500">{check.lastError}</span>}
            </div>
            <p className="text-[11px] text-normal-text mb-2">Copy command also saves these resource settings. It does not change a running container.</p>
            <p className="text-xs text-normal-text mb-2">Run this single command on your Docker host. When reconnecting, remove the previous runner container before running the replacement command.</p>
            <RunnerResources value={dockerResources} onChange={setDockerResources} />
            <textarea
              aria-label="Runner Docker command"
              readOnly
              value={commandWithResources(created?.command, dockerResources)}
              rows={11}
              spellCheck={false}
              className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-[11px] font-mono outline-none bg-slate-50"
            />
            <div className="flex flex-wrap gap-2 mt-2 mb-3">
              <Btn onClick={copyCommand}>
                <FontAwesomeIcon icon={copied ? faCheck : faCopy} className="mr-1.5" />{copied ? 'Copied' : 'Copy command'}
              </Btn>
              <Btn kind="secondary" onClick={async () => {
                try { setCheck(await platform.request(`/v1/platform/runners/${encodeURIComponent(created.runner.id)}/connection`)); } catch (e) { setErr(e); }
              }}>
                <FontAwesomeIcon icon={faPlug} className="mr-1.5" />Re-check
              </Btn>
            </div>
            <div className="text-[11px] text-normal-text">
              <div className="font-medium text-main-text mb-1 flex items-center gap-1.5">
                <FontAwesomeIcon icon={faTerminal} /> {created?.apiKey ? 'The key is shown once' : 'Use your existing runner key'}
              </div>
              Queue <span className="font-mono">{created?.queue}</span> · runner id <span className="font-mono">{created?.runner?.id}</span>.
              {created?.apiKey ? 'Store the key in the runner host secret manager; workflow-service never persists it.' : 'The existing key cannot be retrieved. Replace the key placeholder with your saved runner key, or rotate the key to get a new one.'}
            </div>
            {created?.warning && <div className="mt-2 rounded-2xl bg-amber-500/10 p-3 text-[11px] text-amber-800">{created.warning}</div>}
            {created?.runner?.kind !== 'workflow' && <div className="mt-3"><InferenceHealth health={check?.runner?.inferenceHealth || check?.runner?.metadata?.inferenceHealth} /></div>}
            <Err e={err} />
            <div className="mt-3">
              <Btn kind="secondary" onClick={() => { const id = created?.runner?.id; resetCreate(); if (id) setSelectedId(id); }}>
                Open runner
              </Btn>
            </div>
          </>
        )}
      </Modal>
      <Modal title="Runner settings" open={!!editing} onClose={() => { if (!actionBusy) setEditing(null); }}>
        {editing && <>
          <Field label="Runner name"><Input aria-label="Runner name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
          <Field label="Runner type" desc={detail?.connected ? 'Disconnect the connector before changing its type.' : undefined}>
            <select aria-label="Runner type" className={SELECT_CLASS} disabled={!!detail?.connected} value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })}>
              <option value="workflow">workflow</option><option value="inference">inference</option><option value="hybrid">hybrid</option>
            </select>
          </Field>
          <RunnerResources value={editing.dockerResources} onChange={(value) => setEditing({...editing, dockerResources: value})} />
          {editing.kind !== 'workflow' && <InferenceFields value={editing.inference} onChange={(value) => setEditing({ ...editing, inference: value })} />}
          <p className="text-xs text-normal-text mb-3">After changing models or resource limits, rotate the key and restart the connector using its updated Docker command.</p>
          <Err e={err} /><Btn onClick={saveSettings} loading={actionBusy} disabled={!editing.name.trim() || (editing.kind !== 'workflow' && !editing.inference.capabilities.length)}>Save settings</Btn>
        </>}
      </Modal>
    </>
  );
}
