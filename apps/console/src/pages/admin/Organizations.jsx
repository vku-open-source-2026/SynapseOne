// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../../components/ui.jsx';

const PAGE = 25;

export default function AdminOrganizations() {
  const platform = usePlatformAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [form, setForm] = useState({ slug: '', displayName: '', adminEmail: '', adminDisplayName: '', reason: '' });

  const load = useCallback(async () => {
    setErr(null);
    try {
      const out = await platform.request(`/v1/platform/orgs?q=${encodeURIComponent(query)}&limit=${PAGE}&offset=${offset}`);
      setData({ items: Array.isArray(out.items) ? out.items : [], total: Number(out.total) || 0 });
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
    }
  }, [platform, query, offset]);

  useEffect(() => { load(); }, [load]);

  const search = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(q.trim());
  };

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await platform.request('/v1/platform/orgs', { method: 'POST', body: form });
      setCreated(out);
      setOpen(false);
      setForm({ slug: '', displayName: '', adminEmail: '', adminDisplayName: '', reason: '' });
      setOffset(0);
      load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const pages = Math.max(1, Math.ceil(data.total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <>
      <PageTitle
        title="Organizations"
        sub="All tenant organizations on this SynapseOne deployment"
        right={<Btn onClick={() => { setOpen(true); setCreated(null); }}>+ New organization</Btn>}
      />
      <Err e={err} />
      <Card className="mb-4">
        <form onSubmit={search} className="flex flex-wrap gap-2 items-end">
          <Field label="Search slug or display name">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="acme" />
          </Field>
          <Btn type="submit" kind="secondary" className="mb-3">Search</Btn>
          <Btn type="button" kind="secondary" className="mb-3" onClick={() => { setQ(''); setQuery(''); setOffset(0); }}>Clear</Btn>
        </form>
      </Card>
      <Card>
        {!loaded ? <TableSkeleton rows={6} cols={6} /> : data.items.length ? (
          <Table head={['Organization', 'Accounts', 'Users', 'Active', 'Org admins', 'Created']}>
            {data.items.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="py-2 pr-4">
                  <Link to={`/admin/orgs/${o.id}`} className="font-medium text-main-blue hover:underline">{o.slug}</Link>
                  <p className="text-xs text-normal-text">{o.display_name}</p>
                </td>
                <td className="py-2 pr-4 tabular-nums">{o.counts?.accounts ?? 0}</td>
                <td className="py-2 pr-4 tabular-nums">{o.counts?.users ?? 0}</td>
                <td className="py-2 pr-4 tabular-nums">{o.counts?.activeUsers ?? 0}</td>
                <td className="py-2 pr-4 tabular-nums">{o.counts?.orgAdmins ?? 0}</td>
                <td className="py-2 pr-4 text-xs text-normal-text whitespace-nowrap">{o.created_at ? new Date(o.created_at).toLocaleDateString() : '–'}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty text={query ? 'No organizations match this search' : 'No tenant organizations yet'} />}
        {data.total > PAGE && (
          <div className="flex items-center justify-between mt-4 text-xs text-normal-text">
            <span>{data.total} organizations</span>
            <div className="flex gap-2">
              <Btn kind="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
              <span className="px-2 py-2">{page} / {pages}</span>
              <Btn kind="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
            </div>
          </div>
        )}
      </Card>

      {created && (
        <Modal title="Organization created" onClose={() => setCreated(null)}>
          <p className="text-sm text-normal-text">The first administrator account has been created. They can complete registration from the sign-in page.</p>
          <div className="mt-3 rounded-2xl bg-background p-3 text-sm">
            <p><strong>Organization:</strong> {created.organization?.slug}</p>
            <p><strong>Admin email:</strong> {created.admin?.email}</p>
          </div>
          <Btn className="mt-4" onClick={() => setCreated(null)}>Close</Btn>
        </Modal>
      )}

      {open && (
        <Modal title="New tenant organization" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug (lowercase, unique)">
              <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="acme" required />
            </Field>
            <Field label="Display name">
              <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="ACME Corporation" required />
            </Field>
            <Field label="First administrator email">
              <Input type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} placeholder="admin@acme.example" required />
            </Field>
            <Field label="Administrator display name (optional)">
              <Input value={form.adminDisplayName} onChange={(e) => setForm({ ...form, adminDisplayName: e.target.value })} />
            </Field>
            <Field label="Reason (audit log)">
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Customer onboarding" />
            </Field>
            <Btn type="submit" loading={busy}>Create organization</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
