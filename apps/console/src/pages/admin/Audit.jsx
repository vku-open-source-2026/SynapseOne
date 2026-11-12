// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../../components/ui.jsx';

export default function AdminAudit() {
  const platform = usePlatformAuth();
  const [orgs, setOrgs] = useState([]);
  const [filters, setFilters] = useState({ orgId: '', actor: '', action: '', allowed: '', from: '', to: '' });
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    platform.request('/v1/platform/orgs?limit=200').then((r) => setOrgs(Array.isArray(r.items) ? r.items : [])).catch(() => setOrgs([]));
  }, [platform]);

  const load = useCallback(async () => {
    setErr(null);
    const p = new URLSearchParams({ limit: '100' });
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    try {
      const out = await platform.request(`/v1/platform/audit?${p.toString()}`);
      setRows(Array.isArray(out) ? out : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
    }
  }, [platform, filters]);

  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <>
      <PageTitle title="Audit & Security" sub="Cross-tenant administrative and data-plane audit trail" />
      <Err e={err} />
      <Card className="mb-4">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
          <Field label="Organization">
            <select value={filters.orgId} onChange={(e) => set('orgId', e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
              <option value="">All</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.slug}</option>)}
            </select>
          </Field>
          <Field label="Actor ID"><Input value={filters.actor} onChange={(e) => set('actor', e.target.value)} placeholder="UUID" /></Field>
          <Field label="Action"><Input value={filters.action} onChange={(e) => set('action', e.target.value)} placeholder="iam:user:org-admin" /></Field>
          <Field label="Decision">
            <select value={filters.allowed} onChange={(e) => set('allowed', e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
              <option value="">All</option><option value="true">Allow</option><option value="false">Deny</option>
            </select>
          </Field>
          <Field label="From"><Input type="datetime-local" value={filters.from} onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label="To"><Input type="datetime-local" value={filters.to} onChange={(e) => set('to', e.target.value)} /></Field>
        </div>
        <div className="flex gap-2 mt-2">
          <Btn onClick={load}>Apply filters</Btn>
          <Btn kind="secondary" onClick={() => setFilters({ orgId: '', actor: '', action: '', allowed: '', from: '', to: '' })}>Clear</Btn>
        </div>
      </Card>

      <Card>
        {!loaded ? <TableSkeleton rows={8} cols={6} /> : rows.length ? (
          <Table head={['Time', 'Org', 'Actor', 'Action', 'Resource', 'Decision']}>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-100 hover:bg-background/60 cursor-pointer" onClick={() => setSelected(a)}>
                <td className="py-2 pr-4 text-xs whitespace-nowrap">{a.created_at ? new Date(a.created_at).toLocaleString() : '–'}</td>
                <td className="py-2 pr-4 text-xs">{a.org_id ? String(a.org_id).slice(0, 8) + '…' : '—'}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.actor_type}:{a.actor_id ? String(a.actor_id).slice(0, 8) : '–'}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.action}</td>
                <td className="py-2 pr-4 text-xs font-mono max-w-56 truncate">{a.resource}</td>
                <td className="py-2 pr-4"><Badge tone={a.decision ? 'green' : 'red'}>{a.decision ? 'ALLOW' : 'DENY'}</Badge></td>
              </tr>
            ))}
          </Table>
        ) : <Empty text="No audit records match these filters" />}
      </Card>

      {selected && (
        <Modal title="Audit event" onClose={() => setSelected(null)}>
          <div className="space-y-2 text-sm">
            <p><strong>Action:</strong> <span className="font-mono">{selected.action}</span></p>
            <p><strong>Resource:</strong> <span className="font-mono">{selected.resource}</span></p>
            <p><strong>Actor:</strong> {selected.actor_type} · <span className="font-mono">{selected.actor_id || '—'}</span></p>
            <p><strong>Organization:</strong> <span className="font-mono">{selected.org_id || '—'}</span></p>
            <p><strong>Decision:</strong> {selected.decision ? 'ALLOW' : 'DENY'}</p>
            <p><strong>Time:</strong> {selected.created_at ? new Date(selected.created_at).toLocaleString() : '—'}</p>
          </div>
          <div className="mt-4"><Code data={selected.context || {}} /></div>
        </Modal>
      )}
    </>
  );
}
