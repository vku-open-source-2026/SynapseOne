// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import AdminActionDialog from '../../components/AdminActionDialog.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Skeleton, StatValue, Table } from '../../components/ui.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['accounts', 'Accounts'],
  ['members', 'Members'],
  ['admins', 'Administrators'],
  ['roles', 'Roles'],
  ['policies', 'Policies'],
  ['keys', 'API Keys'],
  ['serviceAccounts', 'Service Accounts'],
  ['audit', 'Audit'],
];

const fmt = (v) => v ? new Date(v).toLocaleString() : '–';

export default function AdminOrganizationDetail() {
  const { orgId } = useParams();
  const location = useLocation();
  const userListFrom = `${location.pathname}${location.search}`;
  const platform = usePlatformAuth();
  const [data, setData] = useState(null);
  const [audit, setAudit] = useState([]);
  const [tab, setTab] = useState('overview');
  const [err, setErr] = useState(null);
  const [auditErr, setAuditErr] = useState(null);
  const [modalErr, setModalErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [createRoleOpen, setCreateRoleOpen] = useState(false);
  const [createPolicyOpen, setCreatePolicyOpen] = useState(false);
  const [form, setForm] = useState({ slug: '', displayName: '', reason: '', code: '' });
  const [roleForm, setRoleForm] = useState({ accountId: '', slug: '', description: '', code: '' });
  const [policyForm, setPolicyForm] = useState({ accountId: '', slug: '', description: '', document: '{\n  "Version": "2026-01-01",\n  "Statement": [\n    { "Effect": "Deny", "Action": ["*"], "Resource": ["*"] }\n  ]\n}', code: '' });
  const canWrite = platform.role === 'owner' || platform.role === 'operator';
  const dataSeq = useRef(0);
  const auditSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++dataSeq.current;
    setErr(null);
    try {
      const out = await platform.request(`/v1/platform/orgs/${encodeURIComponent(orgId)}/resources`);
      if (seq === dataSeq.current) setData(out);
    } catch (e) {
      if (seq === dataSeq.current) setErr(e);
    }
  }, [platform, orgId]);

  const loadAudit = useCallback(async () => {
    const seq = ++auditSeq.current;
    setAuditErr(null);
    try {
      const out = await platform.request(`/v1/platform/orgs/${encodeURIComponent(orgId)}/audit?limit=100`);
      if (seq === auditSeq.current) setAudit(out);
    } catch (e) {
      if (seq === auditSeq.current) { setAudit([]); setAuditErr(e); }
    }
  }, [platform, orgId]);

  // Route params can change without unmounting this component. Never show the
  // previous organization's data while the new request is in flight.
  useEffect(() => { setData(null); setAudit([]); setErr(null); setAuditErr(null); setModalErr(null); setTab('overview'); }, [orgId]);
  useEffect(() => { load(); loadAudit(); }, [load, loadAudit]);

  const createAccount = async (e) => {
    e.preventDefault(); if (busy) return; setBusy(true); setErr(null); setModalErr(null);
    try {
      const step = await platform.stepUp(form.code.trim(), 'org:account:create');
      await platform.request(`/v1/platform/orgs/${encodeURIComponent(orgId)}/accounts`, {
        method: 'POST',
        body: { slug: form.slug.trim().toLowerCase(), displayName: form.displayName.trim(), reason: form.reason.trim() || undefined },
        stepUpToken: step.token,
      });
      setCreateAccountOpen(false); setForm({ slug: '', displayName: '', reason: '', code: '' });
      setNotice('Account created.'); await load(); await loadAudit();
    } catch (ex) { setModalErr(ex); } finally { setBusy(false); }
  };

  const createRole = async (e) => {
    e.preventDefault(); if (busy) return; setBusy(true); setErr(null); setModalErr(null);
    try {
      const step = await platform.stepUp(roleForm.code.trim(), 'org:role:create');
      await platform.request(`/v1/platform/orgs/${encodeURIComponent(orgId)}/roles`, {
        method: 'POST',
        body: { accountId: roleForm.accountId, slug: roleForm.slug.trim(), description: roleForm.description.trim() || undefined },
        stepUpToken: step.token,
      });
      setCreateRoleOpen(false); setRoleForm({ accountId: '', slug: '', description: '', code: '' });
      setNotice('Role created.'); await load(); await loadAudit();
    } catch (ex) { setModalErr(ex); } finally { setBusy(false); }
  };

  const createPolicy = async (e) => {
    e.preventDefault(); if (busy) return; setBusy(true); setErr(null); setModalErr(null);
    try {
      const document = JSON.parse(policyForm.document);
      const step = await platform.stepUp(policyForm.code.trim(), 'org:policy:create');
      await platform.request(`/v1/platform/orgs/${encodeURIComponent(orgId)}/policies`, {
        method: 'POST',
        body: { accountId: policyForm.accountId, slug: policyForm.slug.trim(), description: policyForm.description.trim() || undefined, document },
        stepUpToken: step.token,
      });
      setCreatePolicyOpen(false); setPolicyForm({ accountId: '', slug: '', description: '', document: '{\n  "Version": "2026-01-01",\n  "Statement": [\n    { "Effect": "Deny", "Action": ["*"], "Resource": ["*"] }\n  ]\n}', code: '' });
      setNotice('Policy created.'); await load(); await loadAudit();
    } catch (ex) { setModalErr(ex); } finally { setBusy(false); }
  };

  const runConfirm = async ({ reason, stepUpToken }) => {
    const a = confirm;
    if (!a) return;
    const res = await platform.request(a.path, { method: 'POST', body: { ...(reason ? { reason } : {}), ...(a.body || {}) }, stepUpToken });
    setNotice(a.success);
    setConfirm(null);
    if (res?.inviteToken) setNotice(`${a.success} Activation code: ${res.inviteToken}`);
    await load();
    await loadAudit();
  };

  if (err && !data) {
    return <><PageTitle title="Organization" right={<Link to="/admin/orgs" className="text-sm text-main-blue">Back</Link>} /><Err e={err} /></>;
  }

  const org = data?.organization;
  const tabBody = () => {
    if (!data) return <Skeleton className="h-48 w-full" />;
    if (tab === 'overview') return (
      <>
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[['Accounts', data.counts?.accounts], ['Users', data.counts?.users], ['Active users', data.counts?.activeUsers], ['Org admins', data.counts?.orgAdmins]].map(([l, v]) => (
            <Card key={l}><p className="text-[11px] uppercase text-normal-text mb-2">{l}</p><StatValue value={v ?? 0} /></Card>
          ))}
        </section>
        <Card className="mt-6">
          <h3 className="font-semibold text-main-text mb-3">Lifecycle</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-normal-text">Status</span><p><Badge tone={org?.status === 'suspended' ? 'red' : 'green'}>{org?.status || 'active'}</Badge></p></div>
            <div><span className="text-normal-text">Created</span><p>{fmt(org?.created_at)}</p></div>
            {org?.status === 'suspended' && <><div><span className="text-normal-text">Suspended at</span><p>{fmt(org?.suspended_at)}</p></div><div><span className="text-normal-text">Reason</span><p>{org?.suspend_reason || '–'}</p></div></>}
          </div>
          {canWrite && org?.status === 'suspended' && <Btn className="mt-4" onClick={() => setConfirm({ path: `/v1/platform/orgs/${orgId}/reactivate`, action: 'org:reactivate', title: 'Reactivate organization', message: 'Restore tenant access. Existing sessions were revoked at suspension and must sign in again.', success: 'Organization reactivated.' })}>Reactivate organization</Btn>}
          {canWrite && org?.status !== 'suspended' && <Btn kind="danger" className="mt-4" onClick={() => setConfirm({ path: `/v1/platform/orgs/${orgId}/suspend`, action: 'org:suspend', title: 'Suspend organization', message: 'All tenant users, sessions and API keys will be blocked until reactivation. Data is preserved.', confirmLabel: 'Suspend organization', requireReason: true, minReasonLength: 3, success: 'Organization suspended.' })}>Suspend organization</Btn>}
        </Card>
      </>
    );
    if (tab === 'accounts') return <Card><div className="flex justify-between mb-3"><h3 className="font-semibold">Accounts</h3>{canWrite && <Btn kind="secondary" onClick={() => { setModalErr(null); setCreateAccountOpen(true); }}>+ New account</Btn>}</div>{data.accounts?.length ? <Table head={['Slug', 'Display name', 'ID']}>{data.accounts.map((a) => <tr key={a.id} className="border-t border-slate-100"><td className="py-2 pr-4 font-medium">{a.slug}</td><td className="py-2 pr-4">{a.display_name}</td><td className="py-2 pr-4 text-xs font-mono">{a.id?.slice(0, 8)}…</td></tr>)}</Table> : <Empty text="No accounts" />}</Card>;
    if (tab === 'members') return <Card><h3 className="font-semibold mb-3">Members</h3>{data.users?.length ? <Table head={['Email', 'Name', 'Role', 'Status']}>{data.users.map((u) => <tr key={u.id} className="border-t border-slate-100"><td className="py-2 pr-4"><Link className="text-main-blue" to={`/admin/users/${u.id}`} state={{ from: userListFrom }}>{u.email}</Link></td><td className="py-2 pr-4">{u.display_name || '–'}</td><td className="py-2 pr-4">{u.is_org_admin ? <Badge tone="blue">org admin</Badge> : 'member'}</td><td className="py-2 pr-4">{u.active === false ? <Badge tone="red">disabled</Badge> : <Badge tone="green">active</Badge>}</td></tr>)}</Table> : <Empty text="No members" />}</Card>;
    if (tab === 'admins') return <Card><h3 className="font-semibold mb-3">Organization administrators</h3>{data.admins?.length ? <ul className="space-y-2 text-sm">{data.admins.map((u) => <li key={u.id}><Link className="text-main-blue" to={`/admin/users/${u.id}`} state={{ from: userListFrom }}>{u.email}</Link> <span className="text-normal-text">({u.display_name || '–'})</span></li>)}</ul> : <Empty text="No organization administrator" />}</Card>;
    if (tab === 'roles') return <Card><div className="flex justify-between mb-3"><h3 className="font-semibold">Roles</h3>{canWrite && <Btn kind="secondary" onClick={() => { setModalErr(null); setCreateRoleOpen(true); }}>+ New role</Btn>}</div>{data.roles?.length ? <Table head={['Account', 'Slug', 'Description']}>{data.roles.map((r) => <tr key={r.id} className="border-t border-slate-100"><td className="py-2 pr-4">{r.account_slug}</td><td className="py-2 pr-4 font-mono">{r.slug}</td><td className="py-2 pr-4">{r.description || '–'}</td></tr>)}</Table> : <Empty text="No roles" />}</Card>;
    if (tab === 'policies') return <Card><div className="flex justify-between mb-3"><h3 className="font-semibold">Policies</h3>{canWrite && <Btn kind="secondary" onClick={() => { setModalErr(null); setCreatePolicyOpen(true); }}>+ New policy</Btn>}</div>{data.policies?.length ? <Table head={['Account', 'Slug', 'Description']}>{data.policies.map((p) => <tr key={p.id} className="border-t border-slate-100"><td className="py-2 pr-4">{p.account_slug}</td><td className="py-2 pr-4 font-mono">{p.slug}</td><td className="py-2 pr-4">{p.description || '–'}</td></tr>)}</Table> : <Empty text="No policies" />}</Card>;
    if (tab === 'keys') return <Card><h3 className="font-semibold mb-3">API keys</h3>{data.keys?.length ? <Table head={['Account', 'Name', 'Prefix', 'Scopes', 'Expires', 'Status', '']}>{data.keys.map((k) => <tr key={k.id} className="border-t border-slate-100"><td className="py-2 pr-4">{k.account_slug}</td><td className="py-2 pr-4">{k.name}</td><td className="py-2 pr-4 font-mono">{k.prefix}</td><td className="py-2 pr-4 text-xs">{k.scopes?.join(', ')}</td><td className="py-2 pr-4">{fmt(k.expires_at)}</td><td className="py-2 pr-4">{k.revoked_at ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>}</td><td>{canWrite && !k.revoked_at && <Btn kind="danger" onClick={() => setConfirm({ path: `/v1/platform/orgs/${orgId}/keys/${k.id}/revoke`, action: 'org:key:revoke', title: 'Revoke API key', message: `Revoke ${k.name}? This cannot be undone.`, requireReason: true, success: 'API key revoked.' })}>Revoke</Btn>}</td></tr>)}</Table> : <Empty text="No API keys" />}</Card>;
    if (tab === 'serviceAccounts') return <Card><h3 className="font-semibold mb-3">Service accounts</h3>{data.serviceAccounts?.length ? <Table head={['Account', 'Slug', 'Description', 'Status', '']}>{data.serviceAccounts.map((s) => <tr key={s.id} className="border-t border-slate-100"><td className="py-2 pr-4">{s.account_slug}</td><td className="py-2 pr-4 font-mono">{s.slug}</td><td className="py-2 pr-4">{s.description || '–'}</td><td className="py-2 pr-4">{s.revoked_at ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>}</td><td>{canWrite && !s.revoked_at && <Btn kind="danger" onClick={() => setConfirm({ path: `/v1/platform/orgs/${orgId}/service-accounts/${s.id}/revoke`, action: 'org:service-account:revoke', title: 'Revoke service account', message: `Revoke ${s.slug}? New tokens are blocked; existing short-lived tokens are checked against org status.`, requireReason: true, success: 'Service account revoked.' })}>Revoke</Btn>}</td></tr>)}</Table> : <Empty text="No service accounts" />}</Card>;
    if (tab === 'audit') return <Card><h3 className="font-semibold mb-3">Organization audit</h3><Err e={auditErr} />{audit.length ? <Table head={['Time', 'Action', 'Actor', 'Decision']}>{audit.map((e) => <tr key={e.id} className="border-t border-slate-100"><td className="py-2 pr-4 text-xs">{fmt(e.created_at)}</td><td className="py-2 pr-4 font-mono text-xs">{e.action}</td><td className="py-2 pr-4 text-xs">{e.actor_id?.slice(0, 8)}…</td><td className="py-2 pr-4">{e.decision ? 'allow' : 'deny'}</td></tr>)}</Table> : <Empty text="No audit records" />}</Card>;
    return null;
  };

  return (
    <>
      <PageTitle title={org?.slug || 'Organization'} sub={org?.display_name || 'Tenant organization'} right={<div className="flex gap-3"><Link to={`/admin/users?orgId=${encodeURIComponent(orgId)}`} className="text-sm text-main-blue">Manage users</Link><Link to="/admin/orgs" className="text-sm text-main-blue">Back</Link></div>} />
      <Err e={err} />
      {notice && <div className="mb-4 px-4 py-2.5 rounded-2xl bg-emerald-500/10 text-emerald-700 text-sm">{notice}</div>}
      {org?.status === 'suspended' && <div className="mb-4 px-4 py-2.5 rounded-2xl bg-amber-500/10 text-amber-700 text-sm">This organization is suspended. Tenant access is blocked until reactivation.</div>}
      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map(([id, label]) => <button key={id} type="button" onClick={() => setTab(id)} className={`px-3 py-1.5 rounded-xl text-xs ${tab === id ? 'bg-main-blue text-white' : 'bg-white text-main-text border border-slate-200'}`}>{label}</button>)}
      </div>
      {tabBody()}

      {createAccountOpen && <Modal title="New tenant account" onClose={() => { setCreateAccountOpen(false); setModalErr(null); }}><form onSubmit={createAccount}><Err e={modalErr} /><Field label="Slug"><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required /></Field><Field label="Display name"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></Field><Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field><Field label="Authenticator code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} autoComplete="one-time-code" required /></Field><Btn type="submit" loading={busy}>Create account</Btn></form></Modal>}

      {createRoleOpen && <Modal title="New organization role" onClose={() => { setCreateRoleOpen(false); setModalErr(null); }}><form onSubmit={createRole}><Err e={modalErr} /><Field label="Account"><select value={roleForm.accountId} onChange={(e) => setRoleForm({ ...roleForm, accountId: e.target.value })} required className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">{<option value="">Select account</option>}{data?.accounts?.map((a) => <option key={a.id} value={a.id}>{a.slug}</option>)}</select></Field><Field label="Role slug"><Input value={roleForm.slug} onChange={(e) => setRoleForm({ ...roleForm, slug: e.target.value })} required /></Field><Field label="Description"><Input value={roleForm.description} onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })} /></Field><Field label="Authenticator code"><Input value={roleForm.code} onChange={(e) => setRoleForm({ ...roleForm, code: e.target.value })} autoComplete="one-time-code" required /></Field><Btn type="submit" loading={busy}>Create role</Btn></form></Modal>}

      {createPolicyOpen && <Modal title="New organization policy" onClose={() => { setCreatePolicyOpen(false); setModalErr(null); }}><form onSubmit={createPolicy}><Err e={modalErr} /><Field label="Account"><select value={policyForm.accountId} onChange={(e) => setPolicyForm({ ...policyForm, accountId: e.target.value })} required className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">{<option value="">Select account</option>}{data?.accounts?.map((a) => <option key={a.id} value={a.id}>{a.slug}</option>)}</select></Field><Field label="Policy slug"><Input value={policyForm.slug} onChange={(e) => setPolicyForm({ ...policyForm, slug: e.target.value })} required /></Field><Field label="Description"><Input value={policyForm.description} onChange={(e) => setPolicyForm({ ...policyForm, description: e.target.value })} /></Field><Field label="Policy JSON"><textarea value={policyForm.document} onChange={(e) => setPolicyForm({ ...policyForm, document: e.target.value })} rows={10} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono" /></Field><Field label="Authenticator code"><Input value={policyForm.code} onChange={(e) => setPolicyForm({ ...policyForm, code: e.target.value })} autoComplete="one-time-code" required /></Field><Btn type="submit" loading={busy}>Create policy</Btn></form></Modal>}

      {confirm && <AdminActionDialog open title={confirm.title} message={confirm.message} action={confirm.action} confirmLabel={confirm.confirmLabel || 'Confirm'} requireReason={!!confirm.requireReason} minReasonLength={confirm.minReasonLength || 1} onClose={() => setConfirm(null)} onConfirm={runConfirm} />}
    </>
  );
}
