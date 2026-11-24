// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Pager, SearchBox, Table, TableSkeleton } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Accounts() {
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
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const limit = 20;

  const load = async () => {
    if (!scope.orgId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    setErr(null);
    try {
      const v = await api.accountsPaged(scope.orgId, { limit, offset, q, status }, headers);
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
  }, [scope.orgId, headers, offset, q, status]);
  useEffect(() => { setOffset(0); }, [q, status]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormErr(null);
    setErr(null);
    try {
      await api.createAccount(scope.orgId, slug, name, headers);
      setOpen(false);
      setSlug('');
      setName('');
      load();
    } catch (ex) {
      setFormErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const retire = async (account) => {
    const reason = window.prompt(`Retire account "${account.slug}"? Existing data is retained; its API keys and service accounts are revoked.`);
    if (!reason || reason.trim().length < 3) return;
    setErr(null);
    try {
      await api.retireAccount(account.id, reason.trim(), headers);
      await load();
    } catch (ex) {
      setErr(ex);
    }
  };

  const rename = async (account) => {
    const value = window.prompt('Account display name', account.display_name || account.slug);
    if (value === null) return;
    setErr(null);
    try {
      await api.updateAccount(account.id, value, headers);
      await load();
    } catch (ex) {
      setErr(ex);
    }
  };

  const reactivate = async (account) => {
    if (!window.confirm(`Reactivate account "${account.slug}"? Revoked credentials stay revoked.`)) return;
    setErr(null);
    try {
      await api.reactivateAccount(account.id, headers);
      await load();
    } catch (ex) {
      setErr(ex);
    }
  };

  return (
    <>
      <PageTitle title="Accounts" sub="Environments in an org: prod, staging… (like AWS Accounts)" right={canAdmin && scope.orgId ? <Btn onClick={() => { setFormErr(null); setOpen(true); }}>+ New</Btn> : undefined} />
      <Err e={err} />
      <ScopeBar scope={scope} showAccount={false} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[240px]"><SearchBox value={q} onChange={setQ} placeholder="Search accounts…" /></div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="mb-3 px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
          <option value="">All statuses</option>
          <option value="active">active</option>
          <option value="retired">retired</option>
        </select>
      </div>
      <Card>
        {!loaded ? (
          <TableSkeleton rows={4} cols={3} />
        ) : rows.length ? (
          <Table head={['Slug', 'Display name', 'Status', 'ID', 'Actions']}>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{a.slug}</td>
                <td className="py-2 pr-4">{a.display_name}</td>
                <td className="py-2 pr-4"><Badge tone={(a.status || 'active') === 'active' ? 'green' : 'red'}>{a.status || 'active'}</Badge></td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{a.id?.slice(0, 8)}…</td>
                <td className="py-2 pr-4">
                  {canAdmin && (
                    <>
                      <button className="text-xs text-main-blue hover:underline mr-3" onClick={() => rename(a)}>Rename</button>
                      {(a.status || 'active') === 'active' ? (
                        <button className="text-xs text-red-500 hover:underline" onClick={() => retire(a)}>Retire</button>
                      ) : (
                        <button className="text-xs text-main-blue hover:underline" onClick={() => reactivate(a)}>Reactivate</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text={scope.orgId ? 'No accounts yet' : 'Pick an organization to see its accounts'} />
        )}
      </Card>
      <Pager total={total} limit={limit} offset={offset} onChange={setOffset} loading={!loaded} />
      {open && (
        <Modal title="New account" onClose={() => { setOpen(false); setFormErr(null); }}>
          <form onSubmit={create}><Err e={formErr} />
            <Field label="Slug (unique in the org)">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="prod" />
            </Field>
            <Field label="Display name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production" />
            </Field>
            <Btn type="submit" loading={busy}>Create</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
