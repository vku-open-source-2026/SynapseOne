// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

const SAMPLE = JSON.stringify(
  {
    Version: '2026-01-01',
    Statement: [
      { Effect: 'Allow', Action: ['workflow:Execute'], Resource: '*' },
      { Effect: 'Deny', Action: ['iam:*'], Resource: '*' },
    ],
  },
  null,
  2,
);

export default function Policies() {
  const { headers, auth } = useAuth();
  const canAdmin = !!auth?.user?.is_org_admin;
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [view, setView] = useState(null);
  const [slug, setSlug] = useState('');
  const [doc, setDoc] = useState(SAMPLE);
  const [managed, setManaged] = useState([]);

  useEffect(() => {
    if (!open || managed.length) return;
    api.managedPolicies(headers).then((v) => setManaged(Array.isArray(v) ? v : []), () => setManaged([]));
  }, [open, headers]);

  const pickManaged = (name) => {
    const m = managed.find((x) => x.name === name);
    if (!m) return;
    setDoc(JSON.stringify(m.document, null, 2));
    if (!slug) setSlug(name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
  };

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    setErr(null);
    try {
      const v = await api.policies(scope.accountId, headers);
      setRows(Array.isArray(v) ? v : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, [scope.accountId, headers]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    let parsed;
    try {
      parsed = JSON.parse(doc);
    } catch {
      setErr(new Error('Policy document is not valid JSON'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createPolicy(scope.accountId, slug, parsed, headers);
      setOpen(false);
      setSlug('');
      load();
    } catch (ex) {
      setFormErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this policy?')) return;
    try {
      await api.deletePolicy(id, headers);
      load();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageTitle title="Policies" sub="AWS-style JSON: Allow/Deny + Action/Resource + Condition" right={canAdmin ? <Btn onClick={() => { setFormErr(null); setOpen(true); }}>+ New</Btn> : undefined} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        {!loaded ? (
          <TableSkeleton rows={5} cols={3} />
        ) : rows.length ? (
          <Table head={['Slug', 'Statements', '', '']}>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{p.slug}</td>
                <td className="py-2 pr-4">{Array.isArray(p.document?.Statement) ? p.document.Statement.length : 0}</td>
                <td className="py-2 pr-4">
                  <button onClick={() => setView(p)} className="text-xs text-main-blue">View JSON</button>
                </td>
                <td className="py-2 text-right">
                  <button onClick={() => remove(p.id)} className="text-xs text-red-500">Delete</button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text={scope.accountId ? 'No policies yet' : 'Pick an account to see its policies'} />
        )}
      </Card>
      {open && (
        <Modal title="New policy" onClose={() => { setOpen(false); setFormErr(null); }}>
          <form onSubmit={create}><Err e={formErr} />
            {managed.length > 0 && (
              <Field label="Start from an AWS-style managed policy (optional)">
                <select defaultValue="" onChange={(e) => pickManaged(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm outline-none focus:border-main-blue">
                  <option value="">Custom document</option>
                  {managed.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}: {m.description}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="run-only" />
            </Field>
            <Field label="JSON document">
              <textarea value={doc} onChange={(e) => setDoc(e.target.value)} rows={12} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono outline-none focus:border-main-blue" />
            </Field>
            <Btn type="submit" loading={busy}>Create</Btn>
          </form>
        </Modal>
      )}
      {view && (
        <Modal title={`Policy ${view.slug}`} onClose={() => setView(null)}>
          <Code data={view.document} />
        </Modal>
      )}
    </>
  );
}
