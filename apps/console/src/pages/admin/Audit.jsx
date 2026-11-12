// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../../components/ui.jsx';

const PAGE = 50;
const COMMON_ACTIONS = [
  'platform:org:create',
  'platform:user:org-admin',
  'platform:user:reset-mfa',
  'platform:user:invite',
  'platform:user:disable',
  'platform:user:revoke-sessions',
  'platform:admin:grant',
  'platform:admin:revoke',
  'platform:session:exchange',
  'platform:step-up',
  'iam:user:org-admin',
  'iam:user:register',
  'iam:mfa:enable',
];

function toIso(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

export default function AdminAudit() {
  const platform = usePlatformAuth();
  const [orgs, setOrgs] = useState([]);
  const [filters, setFilters] = useState({ orgId: '', actor: '', action: '', resource: '', allowed: '', from: '', to: '' });
  const [rows, setRows] = useState([]);
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    platform.request('/v1/platform/orgs?limit=200')
      .then((r) => setOrgs(Array.isArray(r.items) ? r.items : []))
      .catch(() => setOrgs([]));
  }, [platform]);

  const orgNames = useMemo(() => new Map(orgs.map((o) => [o.id, o.slug])), [orgs]);

  const load = useCallback(async (nextOffset = offset) => {
    setErr(null);
    setLoading(true);
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
    for (const [k, v] of Object.entries(filters)) {
      if (!v) continue;
      if (k === 'from' || k === 'to') {
        const iso = toIso(v);
        if (iso) p.set(k, iso);
      } else {
        p.set(k, v);
      }
    }
    try {
      const out = await platform.request(`/v1/platform/audit?${p.toString()}`);
      setRows(Array.isArray(out) ? out : []);
      setOffset(nextOffset);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [platform, filters, offset]);

  useEffect(() => { load(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [platform]);

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const apply = (e) => { e.preventDefault(); load(0); };
  const clear = () => { setFilters({ orgId: '', actor: '', action: '', resource: '', allowed: '', from: '', to: '' }); setOffset(0); };
  const openRow = (a) => setSelected(a);
  const onRowKey = (e, a) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(a); } };

  return (
    <>
      <PageTitle
        title="Audit & Security"
        sub="Cross-tenant administrative and data-plane audit trail"
        right={<div className="flex gap-2"><Btn kind="secondary" onClick={() => load(offset)} loading={loading}>Refresh</Btn></div>}
      />
      <Err e={err} />
      <Card className="mb-4">
        <form onSubmit={apply}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
            <Field label="Organization">
              <select value={filters.orgId} onChange={(e) => set('orgId', e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
                <option value="">All</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.slug}</option>)}
              </select>
            </Field>
            <Field label="Actor ID"><Input value={filters.actor} onChange={(e) => set('actor', e.target.value)} placeholder="UUID" /></Field>
            <Field label="Action">
              <Input list="audit-actions" value={filters.action} onChange={(e) => set('action', e.target.value)} placeholder="platform:user:org-admin" />
              <datalist id="audit-actions">{COMMON_ACTIONS.map((a) => <option key={a} value={a} />)}</datalist>
            </Field>
            <Field label="Resource"><Input value={filters.resource} onChange={(e) => set('resource', e.target.value)} placeholder="/v1/platform/orgs" /></Field>
            <Field label="Decision">
              <select value={filters.allowed} onChange={(e) => set('allowed', e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
                <option value="">All</option><option value="true">Allow</option><option value="false">Deny</option>
              </select>
            </Field>
            <Field label="From"><Input type="datetime-local" value={filters.from} onChange={(e) => set('from', e.target.value)} /></Field>
            <Field label="To"><Input type="datetime-local" value={filters.to} onChange={(e) => set('to', e.target.value)} /></Field>
            <div className="flex gap-2 mb-3">
              <Btn type="submit" loading={loading}>Apply filters</Btn>
              <Btn kind="secondary" onClick={clear}>Clear</Btn>
            </div>
          </div>
          <p className="text-[11px] text-normal-text">Times are entered in your browser timezone and sent as ISO/UTC.</p>
        </form>
      </Card>

      <Card>
        {!loaded && !loading ? <TableSkeleton rows={8} cols={6} /> : err ? (
          <div className="py-6 text-center"><Btn kind="secondary" onClick={() => load(offset)}>Retry</Btn></div>
        ) : rows.length ? (
          <>
            <Table head={['Time', 'Org', 'Actor', 'Action', 'Resource', 'Decision']}>
              {rows.map((a) => (
                <tr
                  key={a.id}
                  tabIndex={0}
                  role="button"
                  className="border-t border-slate-100 hover:bg-background/60 cursor-pointer focus:outline-none focus:bg-background"
                  onClick={() => openRow(a)}
                  onKeyDown={(e) => onRowKey(e, a)}
                >
                  <td className="py-2 pr-4 text-xs whitespace-nowrap">{a.created_at ? new Date(a.created_at).toLocaleString() : '–'}</td>
                  <td className="py-2 pr-4 text-xs">{a.org_id ? (orgNames.get(a.org_id) || String(a.org_id).slice(0, 8) + '…') : '—'}</td>
                  <td className="py-2 pr-4 text-xs font-mono">{a.actor_type}:{a.actor_id ? String(a.actor_id).slice(0, 8) : '–'}</td>
                  <td className="py-2 pr-4 text-xs font-mono">{a.action}</td>
                  <td className="py-2 pr-4 text-xs font-mono max-w-56 truncate">{a.resource}</td>
                  <td className="py-2 pr-4"><Badge tone={a.decision ? 'green' : 'red'}>{a.decision ? 'ALLOW' : 'DENY'}</Badge></td>
                </tr>
              ))}
            </Table>
            <div className="flex items-center justify-between mt-4 text-xs text-normal-text">
              <span>Showing {offset + 1}–{offset + rows.length}</span>
              <div className="flex gap-2 items-center">
                <Btn kind="secondary" disabled={offset === 0 || loading} onClick={() => load(Math.max(0, offset - PAGE))}>Previous</Btn>
                <span>Page {Math.floor(offset / PAGE) + 1}</span>
                <Btn kind="secondary" disabled={rows.length < PAGE || loading} onClick={() => load(offset + PAGE)}>Next</Btn>
              </div>
            </div>
          </>
        ) : <Empty text={err ? 'Audit query failed' : 'No audit records match these filters'} />}
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
