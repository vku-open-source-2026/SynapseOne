// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Skeleton, StatValue, Table } from '../../components/ui.jsx';

export default function AdminOrganizationDetail() {
  const { orgId } = useParams();
  const platform = usePlatformAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [form, setForm] = useState({ slug: '', displayName: '', reason: '', code: '' });
  const [notice, setNotice] = useState(null);
  const canWrite = platform.role === 'owner' || platform.role === 'operator';

  const load = useCallback(async () => {
    setErr(null);
    try {
      setData(await platform.request(`/v1/platform/orgs/${encodeURIComponent(orgId)}`));
    } catch (e) {
      setErr(e);
    }
  }, [platform, orgId]);

  useEffect(() => { load(); }, [load]);

  const createAccount = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormErr(null);
    try {
      const step = await platform.stepUp(form.code.trim(), 'org:account:create');
      await platform.request(`/v1/platform/orgs/${encodeURIComponent(orgId)}/accounts`, {
        method: 'POST',
        body: {
          slug: form.slug.trim().toLowerCase(),
          displayName: form.displayName.trim(),
          reason: form.reason.trim() || undefined,
        },
        stepUpToken: step.token,
      });
      setOpen(false);
      setForm({ slug: '', displayName: '', reason: '', code: '' });
      setNotice('Account created and recorded in the audit log.');
      await load();
    } catch (ex) {
      setFormErr(ex);
    } finally {
      setBusy(false);
    }
  };

  if (err) {
    return (
      <>
        <PageTitle title="Organization" right={<Link to="/admin/orgs" className="text-sm text-main-blue">Back</Link>} />
        <Err e={err} />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title={data?.organization?.slug || 'Organization'}
        sub={data?.organization?.display_name || 'Tenant organization detail'}
        right={<div className="flex gap-3"><Link to={`/admin/users?orgId=${encodeURIComponent(orgId)}`} className="text-sm text-main-blue hover:underline">Manage users</Link><Link to="/admin/orgs" className="text-sm text-main-blue hover:underline">Back</Link></div>}
      />
      <div role="status" aria-live="polite">
        {notice && <div className="mb-4 px-4 py-2.5 rounded-2xl bg-emerald-500/10 text-emerald-700 text-sm">{notice}</div>}
      </div>
      {!data ? <Skeleton className="h-48 w-full" /> : (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              ['Accounts', data.counts?.accounts],
              ['Users', data.counts?.users],
              ['Active users', data.counts?.activeUsers],
              ['Org admins', data.counts?.orgAdmins],
            ].map(([label, value]) => (
              <Card key={label}><p className="text-[11px] uppercase text-normal-text mb-2">{label}</p><StatValue value={value ?? 0} /></Card>
            ))}
          </section>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-6">
            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-main-text">Accounts</h3>
                {canWrite && <Btn kind="secondary" onClick={() => { setOpen(true); setFormErr(null); }}>+ New account</Btn>}
              </div>
              {data.accounts?.length ? (
                <Table head={['Slug', 'Display name', 'ID']}>
                  {data.accounts.map((a) => (
                    <tr key={a.id} className="border-t border-slate-100">
                      <td className="py-2 pr-4 font-medium text-main-text">{a.slug}</td>
                      <td className="py-2 pr-4">{a.display_name}</td>
                      <td className="py-2 pr-4 text-xs font-mono text-normal-text">{a.id?.slice(0, 8)}…</td>
                    </tr>
                  ))}
                </Table>
              ) : <Empty text="No accounts in this organization" />}
            </Card>
            <Card>
              <h3 className="font-semibold text-main-text mb-3">Organization administrators</h3>
              {data.admins?.length ? (
                <ul className="space-y-2 text-sm">
                  {data.admins.map((u) => (
                    <li key={u.id} className="flex items-center gap-2">
                      <Badge tone="blue">admin</Badge>
                      <Link to={`/admin/users/${u.id}`} className="text-main-blue hover:underline truncate">{u.email}</Link>
                      <span className="ml-auto text-xs text-normal-text">{u.display_name || '–'}</span>
                    </li>
                  ))}
                </ul>
              ) : <Empty text="No organization administrator" />}
            </Card>
          </div>
        </>
      )}

      {open && (
        <Modal title="New tenant account" onClose={() => setOpen(false)}>
          <p className="text-sm text-normal-text mb-3">Accounts group roles, policies, service accounts and API keys inside this organization.</p>
          {formErr && <div className="mb-3"><Err e={formErr} /></div>}
          <form onSubmit={createAccount}>
            <Field label="Slug (lowercase, unique in the organization)">
              <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="production" autoCapitalize="none" required />
            </Field>
            <Field label="Display name">
              <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Production" required />
            </Field>
            <Field label="Reason (audit log)">
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Initial account" />
            </Field>
            <Field label="Your authenticator code">
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} autoComplete="one-time-code" required />
            </Field>
            <Btn type="submit" loading={busy}>Create account</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
