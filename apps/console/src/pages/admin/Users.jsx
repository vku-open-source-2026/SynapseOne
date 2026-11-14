// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, PageTitle, Table, TableSkeleton } from '../../components/ui.jsx';

const PAGE = 25;

export default function AdminUsers() {
  const platform = usePlatformAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [q, setQ] = useState(params.get('q') || '');
  const [query, setQuery] = useState(params.get('q') || '');
  const [orgId, setOrgId] = useState(params.get('orgId') || '');
  const [active, setActive] = useState(params.get('active') || '');
  const [isOrgAdmin, setIsOrgAdmin] = useState(params.get('isOrgAdmin') || '');
  const [orgs, setOrgs] = useState([]);
  const [offset, setOffset] = useState(Math.max(0, Number(params.get('offset')) || 0));
  const [data, setData] = useState({ items: [], total: 0 });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const seqRef = useRef(0);

  useEffect(() => {
    platform.request('/v1/platform/orgs?limit=200').then((r) => setOrgs(Array.isArray(r.items) ? r.items : [])).catch(() => setOrgs([]));
  }, [platform]);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setErr(null);
    setLoading(true);
    const p = new URLSearchParams({ q: query, limit: String(PAGE), offset: String(offset) });
    if (orgId) p.set('orgId', orgId);
    if (active) p.set('active', active);
    if (isOrgAdmin) p.set('isOrgAdmin', isOrgAdmin);
    try {
      const out = await platform.request(`/v1/platform/users?${p.toString()}`);
      if (seq !== seqRef.current) return;
      setData({ items: Array.isArray(out.items) ? out.items : [], total: Number(out.total) || 0 });
    } catch (e) {
      if (seq === seqRef.current) setErr(e);
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [platform, query, orgId, active, isOrgAdmin, offset]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (orgId) next.set('orgId', orgId);
    if (active) next.set('active', active);
    if (isOrgAdmin) next.set('isOrgAdmin', isOrgAdmin);
    if (offset) next.set('offset', String(offset));
    setParams(next, { replace: true });
  }, [query, orgId, active, isOrgAdmin, offset, setParams]);

  const search = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(q.trim());
    if (q.trim() === query && offset === 0) load();
  };
  const clear = () => {
    setQ(''); setQuery(''); setOrgId(''); setActive(''); setIsOrgAdmin(''); setOffset(0);
  };
  const pages = Math.max(1, Math.ceil(data.total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <>
      <PageTitle
        title="Users & Access"
        sub="Search users across organizations and review access state"
        right={<Btn kind="secondary" onClick={() => load()} loading={loading}>Refresh</Btn>}
      />
      <Err e={err} />
      <Card className="mb-4">
        <form onSubmit={search} className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
          <Field label="Email or name"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="alice@example.com" /></Field>
          <Field label="Organization">
            <select value={orgId} onChange={(e) => { setOrgId(e.target.value); setOffset(0); }} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
              <option value="">All organizations</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.slug}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={active} onChange={(e) => { setActive(e.target.value); setOffset(0); }} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
              <option value="">Any status</option><option value="true">Active</option><option value="false">Inactive</option>
            </select>
          </Field>
          <Field label="Org admin">
            <select value={isOrgAdmin} onChange={(e) => { setIsOrgAdmin(e.target.value); setOffset(0); }} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
              <option value="">Any role</option><option value="true">Org admins</option><option value="false">Members</option>
            </select>
          </Field>
          <div className="flex gap-2 mb-3"><Btn type="submit">Search</Btn><Btn kind="secondary" onClick={clear}>Clear</Btn></div>
        </form>
      </Card>

      <Card>
        {!loaded ? <TableSkeleton rows={6} cols={6} /> : data.items.length ? (
          <Table head={['Email', 'Organization', 'Status', 'Org admin', 'MFA', 'Created']}>
            {data.items.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="py-2 pr-4"><Link to={`/admin/users/${u.id}`} state={{ from: `${location.pathname}${location.search}` }} className="font-medium text-main-blue hover:underline">{u.email}</Link><p className="text-xs text-normal-text">{u.display_name || '–'}</p></td>
                <td className="py-2 pr-4 text-sm">{u.org_slug || '–'}</td>
                <td className="py-2 pr-4"><Badge tone={u.active !== false ? 'green' : 'gray'}>{u.active !== false ? 'active' : 'inactive'}</Badge></td>
                <td className="py-2 pr-4"><Badge tone={u.is_org_admin ? 'blue' : 'gray'}>{u.is_org_admin ? 'admin' : 'member'}</Badge></td>
                <td className="py-2 pr-4"><Badge tone={u.mfa_enabled ? 'green' : 'amber'}>{u.mfa_enabled ? 'on' : 'off'}</Badge></td>
                <td className="py-2 pr-4 text-xs text-normal-text">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '–'}</td>
              </tr>
            ))}
          </Table>
        ) : err ? (
          <div className="py-6 text-center"><Btn kind="secondary" onClick={load}>Retry</Btn></div>
        ) : <Empty text="No users match these filters" />}
        {data.total > PAGE && (
          <div className="flex items-center justify-between mt-4 text-xs text-normal-text">
            <span>{data.total} users</span>
            <div className="flex gap-2 items-center">
              <Btn kind="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
              <span>{page} / {pages}</span>
              <Btn kind="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
