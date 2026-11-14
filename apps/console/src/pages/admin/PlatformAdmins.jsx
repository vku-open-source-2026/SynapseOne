// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import AdminActionDialog from '../../components/AdminActionDialog.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../../components/ui.jsx';

export default function AdminPlatformAdmins() {
  const platform = usePlatformAuth();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [form, setForm] = useState({ email: '', role: 'operator', reason: '', code: '' });
  const [revoke, setRevoke] = useState(null);
  const [notice, setNotice] = useState(null);
  const [invite, setInvite] = useState(null);
  const seqRef = useRef(0);
  const isOwner = platform.role === 'owner';

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setErr(null);
    setActionErr(null);
    setLoading(true);
    try {
      const out = await platform.request('/v1/platform/admins');
      if (seq !== seqRef.current) return;
      setRows(Array.isArray(out.items) ? out.items : []);
    } catch (e) {
      if (seq === seqRef.current) setErr(e);
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [platform]);

  useEffect(() => { if (!isOwner) { setLoading(false); setLoaded(true); return; } load(); }, [isOwner, load]);

  const grant = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setFormErr(null);
    try {
      const step = await platform.stepUp(form.code.trim(), 'admin:grant');
      const out = await platform.request('/v1/platform/admins', {
        method: 'POST',
        body: { email: form.email.trim().toLowerCase(), role: form.role, reason: form.reason.trim() || undefined },
        stepUpToken: step.token,
      });
      setOpen(false);
      setForm({ email: '', role: 'operator', reason: '', code: '' });
      setNotice('Platform administrator granted.');
      if (out.inviteToken) setInvite({ email: out.email, token: out.inviteToken });
      await load();
    } catch (ex) {
      setFormErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async ({ reason, stepUpToken }) => {
    await platform.request(`/v1/platform/admins/${encodeURIComponent(revoke.user_id)}`, {
      method: 'DELETE',
      body: { reason },
      stepUpToken,
    });
    setNotice('Platform administrator revoked and sessions cleared.');
    await load();
  };

  if (!isOwner) {
    return (
      <>
        <PageTitle title="Platform Administrators" sub="Owner-only management of the cross-tenant control plane" />
        <Card><Empty text="Your role cannot view or manage platform administrators." /></Card>
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Platform Administrators"
        sub="Owner-only management of the cross-tenant control plane"
        right={<div className="flex gap-2"><Btn kind="secondary" onClick={load} loading={loading}>Refresh</Btn><Btn onClick={() => { setOpen(true); setFormErr(null); setForm({ email: '', role: 'operator', reason: '', code: '' }); }}>+ Grant administrator</Btn></div>}
      />
      <Err e={err} />
      <Err e={actionErr} />
      <div role="status" aria-live="polite">
        {notice && <div className="mb-4 px-4 py-2.5 rounded-2xl bg-emerald-500/10 text-emerald-700 text-sm">{notice}</div>}
      </div>
      <Card>
        {!loaded ? <TableSkeleton rows={4} cols={6} /> : err ? (
          <div className="py-6 text-center"><Btn kind="secondary" onClick={load}>Retry</Btn></div>
        ) : rows.length ? (
          <Table head={['Email', 'Role', 'Granted', 'Status', 'Reason', '']}>
            {rows.map((a) => (
              <tr key={a.user_id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">
                  {a.email || a.user_id}
                  {a.display_name && <p className="text-xs text-normal-text">{a.display_name}</p>}
                </td>
                <td className="py-2 pr-4"><Badge tone={a.role === 'owner' ? 'blue' : a.role === 'operator' ? 'green' : 'gray'}>{a.role}</Badge></td>
                <td className="py-2 pr-4 text-xs text-normal-text">{a.granted_at ? new Date(a.granted_at).toLocaleDateString() : '–'}</td>
                <td className="py-2 pr-4"><Badge tone={a.revoked_at || a.active === false ? 'gray' : 'green'}>{a.revoked_at ? 'revoked' : a.active === false ? 'inactive' : 'active'}</Badge></td>
                <td className="py-2 pr-4 text-xs text-normal-text max-w-48 truncate" title={a.reason || ''}>{a.reason || '–'}</td>
                <td className="py-2 text-right">
                  {!a.revoked_at && (
                    <button type="button" onClick={() => { if (a.user_id === platform.user?.id) { setActionErr(Object.assign(new Error('You cannot revoke your own platform administrator access. Ask another owner.'), { code: 'self_revoke_forbidden' })); return; } setRevoke(a); }} className="text-xs text-red-500 hover:underline">Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : <Empty text="No platform administrators" />}
      </Card>

      {open && (
        <Modal title="Grant platform administrator" onClose={() => setOpen(false)}>
          <p className="text-sm text-normal-text mb-3">
            The account is created in the reserved platform organization. The person must activate the one-time code
            and enrol TOTP MFA before opening this console.
          </p>
          {formErr && <div className="mb-3"><Err e={formErr} /></div>}
          <form onSubmit={grant}>
            <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field>
            <Field label="Role">
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
                <option value="operator">Operator</option><option value="auditor">Auditor</option><option value="owner">Owner</option>
              </select>
            </Field>
            <Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Operations onboarding" /></Field>
            <Field label="Your authenticator code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} autoComplete="one-time-code" required /></Field>
            <Btn type="submit" loading={busy}>Grant access</Btn>
          </form>
        </Modal>
      )}

      {invite && (
        <Modal title="One-time activation code" onClose={() => setInvite(null)}>
          <p className="text-sm text-normal-text">
            Send this code to <strong>{invite.email}</strong> through a trusted channel. It expires in 7 days and can
            be used once at <code>/register</code>.
          </p>
          <div className="mt-3 rounded-2xl bg-background p-3 break-all font-mono text-xs">{invite.token}</div>
          <Btn className="mt-4" onClick={() => navigator.clipboard?.writeText(invite.token)}>Copy code</Btn>
          <Btn kind="secondary" className="mt-4 ml-2" onClick={() => setInvite(null)}>Close</Btn>
        </Modal>
      )}

      <AdminActionDialog
        open={!!revoke}
        title="Revoke platform administrator"
        message={revoke ? `Revoke ${revoke.email} and clear their platform sessions, refresh tokens and API keys?` : ''}
        action="admin:revoke"
        confirmLabel="Revoke access"
        requireReason
        onClose={() => setRevoke(null)}
        onConfirm={doRevoke}
      />
    </>
  );
}
