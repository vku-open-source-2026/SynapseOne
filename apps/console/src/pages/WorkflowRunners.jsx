// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowRight, faCheck, faCopy, faPen, faPlug, faPlus, faRotateRight,
  faServer, faTerminal, faTrash, faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { ScopeBar, useScope } from '../components/Scope.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Spinner, Table } from '../components/ui.jsx';

const DEFAULT_SCOPES = 'workflow:*,queue:*,*:read,base:query,base:vector-search,inference:*';

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

export default function WorkflowRunners() {
  const { headers } = useAuth();
  const scope = useScope();
  const [options, setOptions] = useState(null);
  const [runners, setRunners] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [check, setCheck] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [mode, setMode] = useState('custom');
  const [queue, setQueue] = useState('');
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [concurrency, setConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editMode, setEditMode] = useState('custom');
  const [editQueue, setEditQueue] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const selectedRef = useRef(null);
  const seq = useRef(0);
  selectedRef.current = selectedId;

  const applyOptions = (o) => {
    if (!o) return;
    setOptions(o);
    if (!queue) setQueue(mode === 'hybrid' ? o.queues?.shared : o.queues?.custom);
  };

  const load = async (quiet = false) => {
    const my = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const res = await api.workflowRunners(headers);
      if (my !== seq.current) return;
      if (res?.options) applyOptions(res.options);
      const list = Array.isArray(res?.data) ? res.data : [];
      setRunners(list);
      if (selectedRef.current) {
        const fresh = list.find((r) => r.id === selectedRef.current);
        if (fresh) setDetail(fresh);
      }
    } catch (e) {
      if (my === seq.current) setErr(e);
    } finally {
      if (my === seq.current && !quiet) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    api.workflowRunnerOptions(headers).then(applyOptions).catch(() => undefined);
    return () => { seq.current += 1; };
  }, [headers]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const t = setInterval(() => { load(true); }, 5000);
    return () => clearInterval(t);
  }, [autoRefresh, headers]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let stopped = false;
    const run = async () => {
      try {
        const res = await api.workflowRunner(selectedId, headers);
        if (stopped) return;
        if (res?.options) applyOptions(res.options);
        setDetail(res?.runner || null);
      } catch (e) {
        if (!stopped && e?.status === 404) {
          setDetail(null);
          setSelectedId(null);
        }
      }
    };
    setDetailLoading(true);
    run().finally(() => { if (!stopped) setDetailLoading(false); });
    const t = setInterval(run, 4000);
    return () => { stopped = true; clearInterval(t); };
  }, [selectedId, headers]);

  useEffect(() => {
    if (!created?.runner?.id) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const c = await api.workflowRunnerConnection(created.runner.id, headers);
        if (stopped) return;
        setCheck(c);
        if (c?.runner) setCreated((cur) => (cur ? { ...cur, runner: c.runner } : cur));
        if (c?.connected) load(true);
      } catch { /* keep polling */ }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => { stopped = true; clearInterval(t); };
  }, [created?.runner?.id, headers]);

  const resetCreate = () => {
    setOpen(false);
    setStep(1);
    setBusy(false);
    setCreated(null);
    setCheck(null);
    setCopied(false);
    setName('');
    setMode('custom');
    setQueue(options?.queues?.custom || '');
    setScopes(DEFAULT_SCOPES);
    setConcurrency(1);
  };

  const createRunner = async () => {
    if (!name.trim()) return setErr(new Error('Runner name is required'));
    if (!scope.accountId) return setErr(new Error('Pick an account in the scope bar first — runner API keys belong to an account'));
    const scopeList = scopes.split(',').map((s) => s.trim()).filter(Boolean);
    if (!scopeList.length) return setErr(new Error('At least one API key scope is required'));
    if (!queue.trim()) return setErr(new Error('Queue is required'));
    setBusy(true);
    setErr(null);
    let keyId = null;
    try {
      const key = await api.createKey(scope.accountId, `workflow-runner-${name.trim()}`.slice(0, 100), headers, { scopes: scopeList });
      keyId = key.id;
      const reg = await api.createWorkflowRunner({
        name: name.trim(),
        mode,
        queue: queue.trim(),
        apiKeyId: key.id,
        keyPrefix: key.prefix,
        scopes: scopeList,
        metadata: { concurrency },
      }, headers);
      const cmd = await api.workflowRunnerCommand(reg.runner.id, key.apiKey, headers);
      if (reg.options) applyOptions(reg.options);
      setCreated({ ...reg, command: cmd.command, apiKey: key.apiKey });
      setStep(2);
      setCheck({ connected: false, status: 'waiting', instanceCount: 0 });
      load(true);
    } catch (e) {
      if (keyId) api.revokeKey(keyId, headers).catch(() => undefined);
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(created?.command || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* textarea remains selectable */ }
  };

  const testConnection = async (id = selectedId) => {
    if (!id) return;
    try {
      const c = await api.workflowRunnerConnection(id, headers);
      setCheck(c);
      if (c?.runner) setDetail(c.runner);
    } catch (e) {
      setErr(e);
    }
  };

  const removeRunner = async (id) => {
    if (!window.confirm('Delete this runner registration? Connector instances are removed. Revoke the API key separately in API Keys.')) return;
    try {
      await api.deleteWorkflowRunner(id, headers);
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      load();
    } catch (e) {
      setErr(e);
    }
  };

  const removeInstance = async (runnerId, instanceId) => {
    if (!window.confirm(`Remove connector ${instanceId}?`)) return;
    try {
      await api.deleteWorkflowRunnerInstance(runnerId, instanceId, headers);
      await testConnection(runnerId);
      load(true);
    } catch (e) {
      setErr(e);
    }
  };

  const openEdit = () => {
    if (!detail) return;
    setEditName(detail.name);
    setEditMode(detail.mode);
    setEditQueue(detail.queue);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!detail) return;
    setEditBusy(true);
    setErr(null);
    try {
      const res = await api.updateWorkflowRunner(detail.id, { name: editName.trim(), mode: editMode, queue: editQueue.trim() }, headers);
      setDetail(res.runner);
      setEditOpen(false);
      load(true);
    } catch (e) {
      setErr(e);
    } finally {
      setEditBusy(false);
    }
  };

  const rows = Array.isArray(runners) ? runners : [];
  const platform = options?.platformWorker;

  return (
    <>
      <PageTitle
        title="Workflow Runners"
        sub="Cloudflare-style connectors for SynapseFlow — queue-backed execution on SynapseOne or your own infrastructure"
        right={(
          <>
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className={`mr-2 px-3 py-1.5 rounded-2xl text-xs font-medium ${autoRefresh ? 'bg-emerald-500/10 text-emerald-600' : 'bg-slate-100 text-normal-text'}`}
            >
              {autoRefresh ? 'Live · 5s' : 'Live off'}
            </button>
            <Btn kind="secondary" onClick={() => load()} disabled={loading}>
              <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" />Refresh
            </Btn>
            <Btn onClick={() => { resetCreate(); setOpen(true); }}>
              <FontAwesomeIcon icon={faPlus} className="mr-1.5" />New runner
            </Btn>
          </>
        )}
      />
      <ScopeBar scope={scope} />
      <Err e={err} />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-white flex items-center justify-center">
            <FontAwesomeIcon icon={faServer} />
          </div>
          <div className="flex-1 min-w-[220px]">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-main-text">SynapseOne platform worker</h3>
              <Badge tone={platform?.enabled === false ? 'gray' : 'green'}>{platform?.enabled === false ? 'disabled' : 'running'}</Badge>
            </div>
            <p className="text-xs text-normal-text mt-0.5">
              Built-in worker · queue <span className="font-mono">{platform?.queue || options?.queues?.platform || 'synapseone-wf-platform'}</span> · concurrency {platform?.concurrency ?? 4}
            </p>
          </div>
        </div>
      </Card>

      <Card className="mb-4">
        <h3 className="font-semibold text-main-text mb-2 flex items-center gap-2">
          <FontAwesomeIcon icon={faPlug} /> Self-hosted runners ({rows.length})
        </h3>
        {loading && !runners ? (
          <div className="py-6 flex justify-center"><Spinner /></div>
        ) : rows.length ? (
          <Table head={['Runner', 'Mode', 'Queue', 'Connectors', 'Status', 'Version', 'Last seen', '']}>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`border-t border-slate-100 cursor-pointer hover:bg-background ${selectedId === r.id ? 'bg-amber-50/60' : ''}`}
              >
                <td className="py-2 pr-4">
                  <div className="font-medium text-main-text text-sm">{r.name}</div>
                  <div className="font-mono text-[11px] text-normal-text">{r.id.slice(0, 8)}…</div>
                </td>
                <td className="py-2 pr-4 text-xs">{r.mode}</td>
                <td className="py-2 pr-4 font-mono text-xs">{r.queue}</td>
                <td className="py-2 pr-4 text-xs">
                  <span className="font-medium">{r.connectedInstances || 0}</span>
                  <span className="text-normal-text"> / {r.instanceCount || 0} online</span>
                </td>
                <td className="py-2 pr-4"><Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge></td>
                <td className="py-2 pr-4 font-mono text-xs">{r.version || '–'}</td>
                <td className="py-2 pr-4 text-xs text-normal-text">{r.lastSeenAt ? `${fmtTime(r.lastSeenAt)} · ${age(r.lastSeenAt)}` : 'never'}</td>
                <td className="py-2 pr-4 text-right">
                  <button
                    onClick={(e) => { e.stopPropagation(); removeRunner(r.id); }}
                    title="Delete runner registration"
                    className="px-2 py-1 rounded-xl bg-red-500/10 text-red-500 text-xs"
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No self-hosted runners yet. The platform worker runs platform-mode workflows; add a runner for custom or hybrid execution." />
        )}
      </Card>

      {selectedId && (
        <Card className="mb-4">
          {detailLoading && !detail ? (
            <div className="py-8 flex justify-center"><Spinner /></div>
          ) : detail ? (
            <>
              <div className="flex flex-wrap items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-2xl bg-slate-100 text-main-text flex items-center justify-center">
                  <FontAwesomeIcon icon={faPlug} />
                </div>
                <div className="flex-1 min-w-[220px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-main-text">{detail.name}</h3>
                    <Badge tone={statusTone(detail.status)}>{statusLabel(detail.status)}</Badge>
                    {detail.connected && <span className="text-[11px] text-emerald-600">heartbeat OK</span>}
                  </div>
                  <p className="text-xs text-normal-text mt-0.5">
                    <span className="font-mono">{detail.id}</span> · {detail.mode} · queue <span className="font-mono">{detail.queue}</span> · key {detail.keyPrefix ? `${detail.keyPrefix}…` : '–'}
                  </p>
                  {Array.isArray(detail.metadata?.scopes) && (
                    <p className="text-[11px] text-normal-text mt-1">
                      scopes: <span className="font-mono">{detail.metadata.scopes.join(', ')}</span>
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Btn kind="secondary" onClick={() => testConnection(detail.id)}>
                    <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" />Test connection
                  </Btn>
                  <Btn kind="secondary" onClick={openEdit}><FontAwesomeIcon icon={faPen} className="mr-1.5" />Edit</Btn>
                  <Btn kind="secondary" onClick={() => removeRunner(detail.id)}><FontAwesomeIcon icon={faTrash} className="mr-1.5" />Delete</Btn>
                </div>
              </div>

              {check?.checkedAt && check?.runner?.id === detail.id && (
                <div className={`mb-3 px-3 py-2 rounded-2xl text-xs ${check.connected ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700'}`}>
                  Connection check at {fmtTime(check.checkedAt)}: <b>{statusLabel(check.status)}</b>
                  {' · '}{check.connectedInstances || 0}/{check.instanceCount || 0} connectors online
                </div>
              )}

              <div className="flex items-center justify-between mb-2 mt-4">
                <h4 className="font-semibold text-main-text text-sm">Connectors ({detail.instances?.length || 0})</h4>
                <span className="text-[11px] text-normal-text">stale after {options?.staleAfterSeconds || 60}s · heartbeat {options?.heartbeatIntervalSeconds || 15}s</span>
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
                      <td className="py-2 pr-4 text-right">
                        <button
                          onClick={() => removeInstance(detail.id, inst.id)}
                          title="Remove connector"
                          className="px-2 py-1 rounded-xl bg-slate-100 text-normal-text text-xs hover:text-red-500"
                        >
                          <FontAwesomeIcon icon={faXmark} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-xs text-normal-text">
                  <div className="font-medium text-main-text mb-1">No connector has connected yet</div>
                  Run the install command on the worker host. The runner will create a connector instance and appear here after its first heartbeat.
                </div>
              )}

              <div className="mt-4 rounded-2xl bg-slate-900 text-slate-100 p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium flex items-center gap-1.5"><FontAwesomeIcon icon={faTerminal} /> Install command</span>
                  <span className="text-[10px] text-slate-400">API key is shown only when you create/regenerate the key</span>
                </div>
                <pre className="text-[11px] whitespace-pre-wrap break-all font-mono text-slate-200">
                  {`docker run -d --restart unless-stopped \\
  -e SYNAPSEONE_URL=${options?.publicUrl || ''} \\
  -e SYNAPSEONE_API_KEY=<RUNNER_API_KEY> \\
  -e WORKFLOW_RUNNER_ID=${detail.id} \\
  ${options?.image || ''}`}
                </pre>
              </div>
            </>
          ) : (
            <Empty text="Runner not found" />
          )}
        </Card>
      )}

      <Modal title={step === 1 ? 'New self-hosted runner' : 'Connect your runner'} open={open} onClose={resetCreate}>
        {step === 1 ? (
          <>
            <Field label="Runner name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="edge-runner-eu" />
            </Field>
            <Field label="Mode">
              <select
                value={mode}
                onChange={(e) => {
                  const next = e.target.value;
                  setMode(next);
                  setQueue(next === 'hybrid' ? (options?.queues?.shared || '') : (options?.queues?.custom || ''));
                }}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none"
              >
                <option value="custom">custom — only workflows configured for this queue</option>
                <option value="hybrid">hybrid — competes with the platform worker on the shared queue</option>
              </select>
            </Field>
            <Field label="Queue">
              <Input value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="synapseone-wf-custom" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Connector concurrency">
                <Input type="number" min="1" max={options?.maxConcurrency || 32} value={concurrency} onChange={(e) => setConcurrency(Math.max(1, Math.min(Number(e.target.value) || 1, options?.maxConcurrency || 32)))} />
              </Field>
              <Field label="Heartbeat">
                <div className="px-3 py-2 rounded-2xl bg-slate-50 text-xs text-normal-text">every {options?.heartbeatIntervalSeconds || 15}s · stale {options?.staleAfterSeconds || 60}s</div>
              </Field>
            </div>
            <Field label="API key scopes (comma-separated)">
              <Input value={scopes} onChange={(e) => setScopes(e.target.value)} />
            </Field>
            <p className="text-[11px] text-normal-text mb-3">
              The key can read workflow/queue state and call the services your DAGs use. It is shown once in the install command.
            </p>
            <Btn onClick={createRunner} disabled={busy} loading={busy}>
              Create runner <FontAwesomeIcon icon={faArrowRight} className="ml-1.5" />
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
            <textarea
              readOnly
              value={created?.command || ''}
              rows={10}
              spellCheck={false}
              className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-[11px] font-mono outline-none bg-slate-50"
            />
            <div className="flex flex-wrap gap-2 mt-2 mb-3">
              <Btn onClick={copyCommand}>
                <FontAwesomeIcon icon={copied ? faCheck : faCopy} className="mr-1.5" />{copied ? 'Copied' : 'Copy command'}
              </Btn>
              <Btn kind="secondary" onClick={() => testConnection(created?.runner?.id)}>
                <FontAwesomeIcon icon={faPlug} className="mr-1.5" />Check now
              </Btn>
            </div>
            {check?.instances?.length ? (
              <div className="mb-3 rounded-2xl bg-emerald-500/10 p-3 text-xs text-emerald-800">
                <div className="font-medium mb-1">Connector registered</div>
                {check.instances.map((i) => (
                  <div key={i.id} className="font-mono text-[11px]">{i.id} · {i.hostname || 'unknown host'} · v{i.version || '?'}</div>
                ))}
              </div>
            ) : null}
            <div className="text-[11px] text-normal-text">
              Queue <span className="font-mono">{created?.runner?.queue}</span> · runner id <span className="font-mono">{created?.runner?.id}</span>.
              The API key is in the command and cannot be shown again after closing this dialog.
            </div>
            <div className="mt-3">
              <Btn kind="secondary" onClick={() => { const id = created?.runner?.id; resetCreate(); if (id) setSelectedId(id); }}>
                Open runner
              </Btn>
            </div>
          </>
        )}
      </Modal>

      <Modal title="Edit runner" open={editOpen} onClose={() => setEditOpen(false)}>
        <Field label="Name"><Input value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
        <Field label="Mode">
          <select value={editMode} onChange={(e) => setEditMode(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none">
            <option value="custom">custom</option>
            <option value="hybrid">hybrid</option>
          </select>
        </Field>
        <Field label="Queue"><Input value={editQueue} onChange={(e) => setEditQueue(e.target.value)} /></Field>
        <p className="text-[11px] text-normal-text mb-3">Queue/mode changes are blocked while a connector is online.</p>
        <Btn onClick={saveEdit} disabled={editBusy} loading={editBusy}>Save changes</Btn>
      </Modal>
    </>
  );
}
