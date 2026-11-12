// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCopy, faPlus, faRotateRight, faServer, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { ScopeBar, useScope } from '../components/Scope.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Spinner, Table } from '../components/ui.jsx';

const DEFAULT_SCOPES = 'workflow:*,queue:*,*:read,base:query,base:vector-search,inference:*';

function tone(status) {
  if (status === 'connected') return 'green';
  if (status === 'waiting') return 'blue';
  if (status === 'stale') return 'amber';
  return 'gray';
}

export default function WorkflowRunners() {
  const { headers } = useAuth();
  const scope = useScope();
  const [runners, setRunners] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState('custom');
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [connection, setConnection] = useState(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.workflowRunners(headers);
      setRunners(Array.isArray(res?.data) ? res.data : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [headers]);

  useEffect(() => {
    if (!created?.runner?.id) return undefined;
    const id = created.runner.id;
    let stopped = false;
    const check = async () => {
      try {
        const c = await api.workflowRunnerConnection(id, headers);
        if (stopped) return;
        setConnection(c);
        if (c.connected) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          load();
        }
      } catch { /* keep polling */ }
    };
    check();
    pollRef.current = setInterval(check, 2500);
    return () => {
      stopped = true;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [created?.runner?.id, headers]);

  const reset = () => {
    setOpen(false);
    setBusy(false);
    setCreated(null);
    setApiKey('');
    setConnection(null);
    setCopied(false);
    setName('');
    setMode('custom');
    setScopes(DEFAULT_SCOPES);
  };

  const createRunner = async () => {
    if (!name.trim()) return setErr(new Error('Runner name is required'));
    if (!scope.accountId) return setErr(new Error('Pick an account in the scope bar first — runner API keys belong to an account'));
    const scopeList = scopes.split(',').map((s) => s.trim()).filter(Boolean);
    if (!scopeList.length) return setErr(new Error('At least one API key scope is required'));
    setBusy(true);
    setErr(null);
    let keyId = null;
    try {
      // 1) Mint the runner's scoped API key (shown once, never stored by us).
      const key = await api.createKey(scope.accountId, `workflow-runner-${name.trim()}`.slice(0, 100), headers, { scopes: scopeList });
      keyId = key.id;
      // 2) Register runner metadata (queue, mode, tenant binding).
      const reg = await api.createWorkflowRunner({
        name: name.trim(), mode, apiKeyId: key.id, keyPrefix: key.prefix, scopes: scopeList,
      }, headers);
      // 3) Render the copy-paste command WITH the API key.
      const cmd = await api.workflowRunnerCommand(reg.runner.id, key.apiKey, headers);
      setApiKey(key.apiKey);
      setCreated({ ...reg, command: cmd.command });
      load();
    } catch (e) {
      if (keyId) api.revokeKey(keyId, headers).catch(() => undefined);
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(created.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may be blocked; the textarea remains selectable */ }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this runner registration? Its API key is not revoked automatically — revoke it in API Keys.')) return;
    try {
      await api.deleteWorkflowRunner(id, headers);
      load();
    } catch (e) {
      setErr(e);
    }
  };

  const rows = useMemo(() => (Array.isArray(runners) ? runners : []), [runners]);

  return (
    <>
      <PageTitle
        title="Workflow Runners"
        sub="Run SynapseFlow DAGs on SynapseOne workers or in your own infrastructure — queue-backed, API-key scoped"
        right={<><Btn kind="secondary" onClick={load} disabled={loading}><FontAwesomeIcon icon={faRotateRight} className="mr-1.5" />Refresh</Btn><Btn onClick={() => setOpen(true)}><FontAwesomeIcon icon={faPlus} className="mr-1.5" />New runner</Btn></>}
      />
      <ScopeBar scope={scope} />
      <Err e={err} />
      <Card>
        <h3 className="font-semibold text-main-text mb-2 flex items-center gap-2"><FontAwesomeIcon icon={faServer} /> Self-hosted runners ({rows.length})</h3>
        {loading && !runners ? <div className="py-6 flex justify-center"><Spinner /></div> : rows.length ? (
          <Table head={['Name', 'Mode', 'Queue', 'Status', 'Key', 'Last seen', '']}>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="py-2 pr-4">
                  <div className="font-medium text-main-text text-sm">{r.name}</div>
                  <div className="font-mono text-[11px] text-normal-text">{r.id.slice(0, 8)}…</div>
                </td>
                <td className="py-2 pr-4 text-xs">{r.mode}</td>
                <td className="py-2 pr-4 font-mono text-xs">{r.queue}</td>
                <td className="py-2 pr-4"><Badge tone={tone(r.status)}>{r.status}</Badge></td>
                <td className="py-2 pr-4 font-mono text-xs">{r.keyPrefix ? `${r.keyPrefix}…` : '–'}</td>
                <td className="py-2 pr-4 text-xs text-normal-text">{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : 'never'}</td>
                <td className="py-2 pr-4 text-right">
                  <button onClick={() => remove(r.id)} title="Delete runner registration" className="px-2 py-1 rounded-xl bg-red-500/10 text-red-500 text-xs">
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No self-hosted runners yet. The built-in platform worker is always available; create a runner to run DAGs in your own infra." />
        )}
      </Card>

      <Modal title="Create self-hosted runner" open={open} onClose={reset}>
        {!created ? (
          <>
            <Field label="Runner name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="edge-runner-eu" />
            </Field>
            <Field label="Mode">
              <select value={mode} onChange={(e) => setMode(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none">
                <option value="custom">custom — only workflows set to this runner's queue</option>
                <option value="hybrid">hybrid — shares the queue with SynapseOne's platform worker</option>
              </select>
            </Field>
            <Field label="API key scopes (comma-separated)">
              <Input value={scopes} onChange={(e) => setScopes(e.target.value)} />
            </Field>
            <p className="text-[11px] text-normal-text mb-3">
              The runner key can call the workflow/queue APIs plus any read-only service. Add write scopes only when your DAGs need them.
            </p>
            <Btn onClick={createRunner} disabled={busy} loading={busy}>Create runner &amp; show command</Btn>
          </>
        ) : (
          <>
            <div className="mb-3">
              <Badge tone={connection?.connected ? 'green' : 'blue'}>
                {connection?.connected ? 'Connected' : connection?.status === 'stale' ? 'Stale' : 'Waiting for connection…'}
              </Badge>
              {connection?.lastError && <span className="ml-2 text-xs text-red-500">{connection.lastError}</span>}
            </div>
            <p className="text-xs text-normal-text mb-2">
              Copy this command and run it on the machine that should execute workflows. The API key is included and shown only in this dialog.
            </p>
            <textarea
              readOnly
              value={created.command}
              rows={9}
              spellCheck={false}
              className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-[11px] font-mono outline-none bg-slate-50"
            />
            <div className="flex flex-wrap gap-2 mt-2 mb-3">
              <Btn onClick={copyCommand}><FontAwesomeIcon icon={copied ? faCheck : faCopy} className="mr-1.5" />{copied ? 'Copied' : 'Copy command'}</Btn>
              <Btn kind="secondary" onClick={() => setConnection(null)}>Re-check connection</Btn>
            </div>
            <div className="text-[11px] text-normal-text">
              Queue <span className="font-mono">{created.runner.queue}</span> · runner id <span className="font-mono">{created.runner.id}</span>.
              {apiKey ? ' The key is in the command above; it cannot be shown again after you close this dialog.' : ''}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
