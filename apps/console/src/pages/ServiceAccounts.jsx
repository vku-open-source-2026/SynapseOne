// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Pager, SearchBox, Spinner, Table, TableSkeleton } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function ServiceAccounts() {
  const { headers, auth } = useAuth();
  const canAdmin = !!auth?.user?.is_org_admin;
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [slug, setSlug] = useState('');
  const [token, setToken] = useState(null);
  const [minting, setMinting] = useState(null);
  const [roles, setRoles] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [assigned, setAssigned] = useState([]);
  const [roleBusy, setRoleBusy] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const limit = 20;

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    setErr(null);
    try {
      const v = await api.serviceAccountsPaged(scope.accountId, { limit, offset, q, status }, headers);
      setRows(Array.isArray(v?.items) ? v.items : []);
      setTotal(Number(v?.total) || 0);
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [scope.accountId, headers, offset, q, status]);
  useEffect(() => { setOffset(0); }, [q, status]);
  useEffect(() => {
    if (scope.accountId && canAdmin) {
      api.roles(scope.accountId, headers).then((v) => setRoles(Array.isArray(v) ? v : [])).catch(() => setRoles([]));
    }
  }, [scope.accountId, headers, canAdmin]);

  const toggleRoles = async (sa) => {
    if (expanded === sa.id) {
      setExpanded(null);
      return;
    }
    setExpanded(sa.id);
    setAssigned([]);
    try {
      const v = await api.saRoles(sa.id, headers);
      setAssigned(Array.isArray(v) ? v : []);
    } catch (e) {
      setErr(e);
    }
  };

  const grant = async (sa, roleId) => {
    if (!roleId || roleBusy) return;
    setRoleBusy(true);
    try {
      await api.saGrantRole(sa.id, roleId, headers);
      setAssigned(await api.saRoles(sa.id, headers));
    } catch (e) {
      setErr(e);
    } finally {
      setRoleBusy(false);
    }
  };

  const revoke = async (sa, roleId) => {
    if (!window.confirm('Remove this role from the service account?')) return;
    setRoleBusy(true);
    try {
      await api.saRevokeRole(sa.id, roleId, headers);
      setAssigned(await api.saRoles(sa.id, headers));
    } catch (e) {
      setErr(e);
    } finally {
      setRoleBusy(false);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormErr(null);
    setErr(null);
    try {
      await api.createSA(scope.accountId, slug, headers);
      setOpen(false);
      setSlug('');
      load();
    } catch (ex) {
      setFormErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const issue = async (id) => {
    if (minting) return;
    setMinting(id);
    try {
      setToken(await api.saToken(id, headers));
    } catch (e) {
      setErr(e);
    } finally {
      setMinting(null);
    }
  };

  return (
    <>
      <PageTitle title="Service Accounts" sub="Machine identity (kind=service-account JWTs)" right={canAdmin ? <Btn onClick={() => { setFormErr(null); setOpen(true); }}>+ New</Btn> : undefined} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[240px]"><SearchBox value={q} onChange={setQ} placeholder="Search service accounts…" /></div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="mb-3 px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="revoked">Revoked</option>
        </select>
      </div>
      <Card>
        {!loaded ? (
          <TableSkeleton rows={4} cols={3} />
        ) : rows.length ? (
          <Table head={['Slug', 'ID', 'Roles', '']}>
            {rows.map((s) => (
              <React.Fragment key={s.id}>
                <tr className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-medium text-main-text">{s.slug}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text font-mono">{s.id?.slice(0, 8)}…</td>
                  <td className="py-2 pr-4 text-xs">
                    {canAdmin ? (
                      <button className="text-main-blue hover:underline" onClick={() => toggleRoles(s)}>
                        {expanded === s.id ? 'Hide roles' : 'Manage roles'}
                      </button>
                    ) : <span className="text-normal-text">–</span>}
                  </td>
                  <td className="py-2 text-right">
                    <button onClick={() => issue(s.id)} disabled={minting === s.id} className="text-xs text-main-blue disabled:opacity-50 inline-flex items-center gap-1.5">
                      {minting === s.id && <Spinner size="xs" />}
                      {minting === s.id ? 'Minting…' : 'Mint token'}
                    </button>
                  </td>
                </tr>
                {expanded === s.id && (
                  <tr>
                    <td colSpan={4} className="pb-3">
                      <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                        <select disabled={roleBusy} onChange={(e) => { grant(s, e.target.value); e.target.value = ''; }} defaultValue="" className="px-2 py-1.5 rounded-xl border border-slate-200 text-xs bg-white">
                          <option value="">Add role…</option>
                          {roles.filter((r) => !assigned.some((a) => a.id === r.id)).map((r) => (
                            <option key={r.id} value={r.id}>{r.slug}</option>
                          ))}
                        </select>
                      </div>
                      {assigned.length ? assigned.map((r) => (
                        <span key={r.id} className="inline-flex items-center gap-2 text-xs bg-background rounded-xl px-3 py-1.5 mr-2">
                          <span className="font-mono text-main-text">{r.slug}</span>
                          <button className="text-red-500 disabled:opacity-50" disabled={roleBusy} onClick={() => revoke(s, r.id)}>Remove</button>
                        </span>
                      )) : <span className="text-xs text-normal-text">No roles assigned</span>}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </Table>
        ) : (
          <Empty text={scope.accountId ? 'No service accounts yet' : 'Pick an account to see its service accounts'} />
        )}
      </Card>
      <Pager total={total} limit={limit} offset={offset} onChange={setOffset} loading={!loaded} />
      {open && (
        <Modal title="New service account" onClose={() => { setOpen(false); setFormErr(null); }}>
          <form onSubmit={create}><Err e={formErr} />
            <Field label="Slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="etl-worker" />
            </Field>
            <Btn type="submit" loading={busy}>Create</Btn>
          </form>
        </Modal>
      )}
      {token && (
        <Modal title="Service token (save it now!)" onClose={() => setToken(null)}>
          <Code data={token} />
        </Modal>
      )}
    </>
  );
}
