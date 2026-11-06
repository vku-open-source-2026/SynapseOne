// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

const when = (v) => (v ? new Date(v).toLocaleString() : '–');

function keyStatus(k) {
  if (k.revoked_at) return { tone: 'gray', label: 'revoked' };
  if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) return { tone: 'gray', label: 'expired' };
  if (k.expires_at) return { tone: 'amber', label: 'expiring' };
  return { tone: 'green', label: 'live' };
}

export default function Keys() {
  const { headers, auth } = useAuth();
  const me = auth?.user?.id || null;
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('console');
  const [scopes, setScopes] = useState('*');
  const [bindToMe, setBindToMe] = useState(true);
  const [created, setCreated] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [rotating, setRotating] = useState(null);
  const [sessions, setSessions] = useState(null);
  const loadSeq = useRef(0);

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    const my = ++loadSeq.current;
    setErr(null);
    try {
      const v = await api.listKeys(scope.accountId, headers);
      if (loadSeq.current === my) setRows(Array.isArray(v) ? v : []);
    } catch (e) {
      if (loadSeq.current === my) setErr(e);
    } finally {
      if (loadSeq.current === my) setLoaded(true);
    }
  };

  const loadSessions = async () => {
    if (!headers.token) return setSessions([]);
    try {
      const v = await api.sessions(headers);
      setSessions(Array.isArray(v) ? v : []);
    } catch {
      setSessions([]);
    }
  };

  useEffect(() => {
    load();
  }, [scope.accountId, headers]);

  useEffect(() => {
    loadSessions();
  }, [headers]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!scope.accountId) {
      setErr(new Error('Pick an account before creating a key'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const list = scopes.split(',').map((s) => s.trim()).filter(Boolean);
      const k = await api.createKey(scope.accountId, name, headers, { scopes: list, userId: bindToMe ? me : null });
      setCreated({ ...k, title: 'New API key (save it now!)' });
      setOpen(false);
      load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    if (revoking) return;
    if (!window.confirm('Revoke this key? Calls using it will start failing.')) return;
    setRevoking(id);
    try {
      await api.revokeKey(id, headers);
      setCreated(null);
      load();
    } catch (e) {
      setErr(e);
    } finally {
      setRevoking(null);
    }
  };

  const rotate = async (id) => {
    if (rotating) return;
    const raw = window.prompt('Keep the old key valid for how many seconds? (0 = revoke it now, max 604800)', '300');
    if (raw === null) return;
    const grace = Number(raw);
    if (!Number.isInteger(grace) || grace < 0 || grace > 604800) {
      setErr(new Error('Grace period must be an integer between 0 and 604800 seconds'));
      return;
    }
    setRotating(id);
    try {
      const k = await api.rotateKey(id, grace, headers);
      setCreated({ ...k, title: 'Rotated API key (save the new secret now!)' });
      load();
    } catch (e) {
      setErr(e);
    } finally {
      setRotating(null);
    }
  };

  const revokeSession = async (id) => {
    if (!window.confirm('Sign this session out? Its refresh token stops working.')) return;
    try {
      await api.revokeSession(id, headers);
      loadSessions();
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    setErr(null);
  }, [scope.accountId]);

  return (
    <>
      <PageTitle title="API Keys & Sessions" sub="Scoped, owner-bound, rotatable credentials, secrets are shown only once" right={<Btn onClick={() => setOpen(true)}>+ New key</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        <p className="text-sm text-normal-text mb-3">
          Keys belong to account <b className="text-main-text">{scope.accounts.find((a) => a.id === scope.accountId)?.slug || '–'}</b>.
          A key's <b className="text-main-text">scopes</b> cap what it may do (e.g. <code>storage:*</code>); a key bound to a user also
          inherits, and can never exceed, that user's policies.
        </p>
        {!loaded ? (
          <TableSkeleton rows={4} cols={6} />
        ) : !scope.accountId ? (
          <Empty text="Pick an account first" />
        ) : rows.length ? (
          <Table head={['Name', 'Prefix', 'Scopes', 'Owner', 'Last used', 'Expires', 'Status', '']}>
            {rows.map((k) => {
              const st = keyStatus(k);
              const live = st.label === 'live' || st.label === 'expiring';
              return (
                <tr key={k.id} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-medium text-main-text">{k.name}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text font-mono">{k.prefix}…</td>
                  <td className="py-2 pr-4 text-xs font-mono text-normal-text">{(k.scopes || []).join(', ') || '–'}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">
                    {k.user_id ? (k.user_id === me ? 'you' : <span className="font-mono">{k.user_id.slice(0, 8)}…</span>) : 'account'}
                  </td>
                  <td className="py-2 pr-4 text-xs text-normal-text">{when(k.last_used_at)}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">
                    {k.expires_at ? new Date(k.expires_at).toLocaleString() : 'never'}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {live && (
                      <>
                        <button onClick={() => rotate(k.id)} disabled={rotating === k.id} className="text-xs text-blue-600 disabled:opacity-50 mr-3">
                          {rotating === k.id ? 'Rotating…' : 'Rotate'}
                        </button>
                        <button onClick={() => revoke(k.id)} disabled={revoking === k.id} className="text-xs text-red-500 disabled:opacity-50 inline-flex items-center gap-1.5">
                          {revoking === k.id && <span className="sdx-spinner h-3.5 w-3.5 border-2" />}
                          {revoking === k.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty text="No keys yet" />
        )}
      </Card>

      <div className="mt-4">
        <Card>
          <h3 className="font-semibold text-main-text mb-1">Your sessions</h3>
          <p className="text-sm text-normal-text mb-3">Each sign-in holds a rotating refresh token. Sign out a lost device without touching the others.</p>
          {sessions === null ? (
            <TableSkeleton rows={2} cols={3} />
          ) : sessions.length ? (
            <Table head={['Session', 'Signed in', 'Expires', '']}>
              {sessions.map((s, i) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-2 pr-4 text-xs font-mono text-normal-text">{s.id.slice(0, 8)}… {i === 0 && <Badge tone="blue">newest</Badge>}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">{when(s.created_at)}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">{when(s.expires_at)}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => revokeSession(s.id)} className="text-xs text-red-500">Sign out</button>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text={headers.token ? 'No active sessions' : 'Signed in with an API key, no sessions'} />
          )}
        </Card>
      </div>

      {created && (
        <Modal title={created.title} onClose={() => setCreated(null)}>
          <Code data={{ id: created.id, prefix: created.prefix, apiKey: created.apiKey, ...(created.rotatedFrom ? { rotatedFrom: created.rotatedFrom, oldKeyExpiresAt: created.oldKeyExpiresAt } : {}) }} />
        </Modal>
      )}
      {open && (
        <Modal title="New API key" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Key name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Scopes (comma-separated action patterns, e.g. storage:*, base:Read)">
              <Input value={scopes} onChange={(e) => setScopes(e.target.value)} />
            </Field>
            {me && (
              <label className="flex items-center gap-2 text-sm text-normal-text mb-4">
                <input type="checkbox" checked={bindToMe} onChange={(e) => setBindToMe(e.target.checked)} />
                Bind to me, the key inherits my permissions (recommended)
              </label>
            )}
            <Btn type="submit" loading={busy}>Create</Btn>
          </form>
        </Modal>
      )}
      <p className="mt-3 text-xs text-normal-text">
        <Badge>Tip</Badge> Set <code>AUTHZ_MODE=enforce</code> on the gateway to block requests that scopes or policies do not allow
        (<code>audit</code> only logs them).
      </p>
    </>
  );
}
