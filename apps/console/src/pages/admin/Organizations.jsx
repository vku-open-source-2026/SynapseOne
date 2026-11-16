// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [created, setCreated] = useState(null);
  const [form, setForm] = useState({ slug: '', displayName: '', adminEmail: '', adminDisplayName: '', reason: '', code: '' });
  const seqRef = useRef(0);
  const canWrite = platform.role === 'owner' || platform.role === 'operator';

  const load = useCallback(async (nextOffset = offset) => {
    const seq = ++seqRef.current;
    setErr(null);
    setLoading(true);
    try {
      const out = await platform.request(`/v1/platform/orgs?q=${encodeURIComponent(query)}&limit=${PAGE}&offset=${nextOffset}`);
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
  }, [platform, query, offset]);

  useEffect(() => { load(); }, [load]);

  const search = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(q.trim());
    if (q.trim() === query && offset === 0) load(0);
  };

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormErr(null);
    try {
      const step = await platform.stepUp(form.code.trim(), 'org:create');
      const out = await platform.request('/v1/platform/orgs', {
        method: 'POST',
        body: {
          slug: form.slug.trim().toLowerCase(),
          displayName: form.displayName.trim(),
          adminEmail: form.adminEmail.trim().toLowerCase(),
          adminDisplayName: form.adminDisplayName.trim() || undefined,
          reason: form.reason.trim() || undefined,
        },
        stepUpToken: step.token,
      });
      setCreated(out);
      setOpen(false);
      setForm({ slug: '', displayName: '', adminEmail: '', adminDisplayName: '', reason: '', code: '' });
      setOffset(0);
      if (offset === 0) load(0);
    } catch (ex) {
      setFormErr(ex);
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
        right={(
          <div className="flex gap-2">
            <Btn kind="secondary" onClick={() => load()} loading={loading}>Refresh</Btn>
            {canWrite && <Btn onClick={() => { setOpen(true); setCreated(null); setFormErr(null); }}>+ New organization</Btn>}
          </div>
        )}
      />
      {!canWrite && (
        <div className="mb-4 px-4 py-2.5 rounded-2xl bg-amber-500/10 text-amber-700 text-sm">
          Auditor role: organization creation is disabled.
        </div>
      )}
      <Err e={err} />
      <Card className="mb-4">
        <form onSubmit={search} className="flex flex-wrap gap-2 items-end">
          <Field label="Search slug or display name">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="acme" />
          </Field>
          <Btn type="submit" kind="secondary" className="mb-3" loading={loading}>Search</Btn>
          <Btn type="button" kind="secondary" className="mb-3" onClick={() => { setQ(''); setQuery(''); setOffset(0); }}>Clear</Btn>
        </form>
      </Card>
      <Card>
        {!loaded ? <TableSkeleton rows={6} cols={6} /> : err ? (
          <div className="py-6 text-center"><Btn kind="secondary" onClick={load}>Retry</Btn></div>
        ) : data.items.length ? (
          <Table head={['Organization', 'Status', 'Accounts', 'Users', 'Active', 'Org admins', 'Created']}>
            {data.items.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="py-2 pr-4">
                  <Link to={`/admin/orgs/${o.id}`} className="font-medium text-main-blue hover:underline">{o.slug}</Link>
                  <p className="text-xs text-normal-text">{o.display_name}</p>
                </td>
                <td className="py-2 pr-4"><Badge tone={o.status === 'suspended' ? 'red' : 'green'}>{o.status || 'active'}</Badge></td>
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
            <div className="flex gap-2 items-center">
              <Btn kind="secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
              <span className="px-2 py-2">{page} / {pages}</span>
              <Btn kind="secondary" disabled={offset + PAGE >= data.total || loading} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
            </div>
          </div>
        )}
      </Card>

      {created && (
        <Modal title="Organization created" onClose={() => setCreated(null)}>
          <p className="text-sm text-normal-text">
            The organization and its first administrator were created. Send the one-time activation code below to the
            administrator through a trusted channel.
          </p>
          <div className="mt-3 rounded-2xl bg-background p-3 text-sm space-y-1">
            <p><strong>Organization:</strong> {created.organization?.slug}</p>
            <p><strong>Admin email:</strong> {created.admin?.email}</p>
            <p><strong>Organization ID:</strong> <span className="font-mono text-xs">{created.organization?.id}</span></p>
            <p><strong>Admin user ID:</strong> <span className="font-mono text-xs">{created.admin?.id}</span></p>
          </div>
          {created.inviteToken ? (
            <>
              <p className="text-xs text-normal-text mt-3">One-time activation code (expires in 7 days):</p>
              <div className="mt-2 rounded-2xl bg-background p-3 break-all font-mono text-xs">{created.inviteToken}</div>
              <div className="flex gap-2 mt-3">
                <Btn onClick={() => navigator.clipboard?.writeText(created.inviteToken)}>Copy code</Btn>
                <Link to={`/admin/users/${created.admin?.id}`} className="text-sm text-main-blue self-center hover:underline">Open admin user</Link>
              </div>
            </>
          ) : (
            <p className="text-xs text-normal-text mt-3">This account already has a password; no activation code was issued.</p>
          )}
          <div className="flex gap-2 mt-4">
            <Link to={`/admin/orgs/${created.organization?.id}`}><Btn kind="secondary">Open organization</Btn></Link>
            <Btn kind="secondary" onClick={() => setCreated(null)}>Close</Btn>
          </div>
        </Modal>
      )}

      {open && (
        <Modal title="New tenant organization" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            {formErr && <div className="mb-3"><Err e={formErr} /></div>}
            <Field label="Slug (lowercase, unique)">
              <Input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder="acme"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />
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
            <Field label="Your authenticator code">
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} autoComplete="one-time-code" placeholder="123456" required autoFocus />
            </Field>
            <Btn type="submit" loading={busy}>Create organization</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
