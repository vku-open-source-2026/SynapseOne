// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import AdminActionDialog from '../../components/AdminActionDialog.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../../components/ui.jsx';

export default function AdminPlatformAdmins() {
  const platform = usePlatformAuth();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'operator', reason: '', code: '' });
  const [revoke, setRevoke] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const out = await platform.request('/v1/platform/admins');
      setRows(Array.isArray(out.items) ? out.items : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
    }
  }, [platform]);

  useEffect(() => { load(); }, [load]);

  const grant = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const step = await platform.stepUp(form.code.trim());
      await platform.request('/v1/platform/admins', {
        method: 'POST',
        body: { email: form.email, role: form.role, reason: form.reason },
        stepUpToken: step.token,
      });
      setOpen(false);
      setForm({ email: '', role: 'operator', reason: '', code: '' });
      setNotice('Platform administrator granted.');
      await load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async ({ reason, stepUpToken }) => {
    await platform.request(`/v1/platform/admins/${encodeURIComponent(revoke.user_id)}`, { method: 'DELETE', body: { reason }, stepUpToken });
    setNotice('Platform administrator revoked and sessions cleared.');
    await load();
  };

  return (
    <>
      <PageTitle
        title="Platform Administrators"
        sub="Owner-only management of the cross-tenant control plane"
        right={<Btn onClick={() => setOpen(true)}>+ Grant administrator</Btn>}
      />
      <Err e={err} />
      {notice && <div className="mb-4 px-4 py-2.5 rounded-2xl bg-emerald-500/10 text-emerald-700 text-sm">{notice}</div>}
      <Card>
        {!loaded ? <TableSkeleton rows={4} cols={5} /> : rows.length ? (
          <Table head={['Email', 'Role', 'Granted', 'Status', '']}>
            {rows.map((a) => (
              <tr key={a.user_id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{a.email || a.user_id}</td>
                <td className="py-2 pr-4"><Badge tone={a.role === 'owner' ? 'blue' : a.role === 'operator' ? 'green' : 'gray'}>{a.role}</Badge></td>
                <td className="py-2 pr-4 text-xs text-normal-text">{a.granted_at ? new Date(a.granted_at).toLocaleDateString() : '–'}</td>
                <td className="py-2 pr-4"><Badge tone={a.revoked_at ? 'gray' : 'green'}>{a.revoked_at ? 'revoked' : 'active'}</Badge></td>
                <td className="py-2 text-right">
                  {!a.revoked_at && <button type="button" onClick={() => setRevoke(a)} className="text-xs text-red-500">Revoke</button>}
                </td>
              </tr>
            ))}
          </Table>
        ) : <Empty text="No platform administrators" />}
      </Card>

      {open && (
        <Modal title="Grant platform administrator" onClose={() => setOpen(false)}>
          <p className="text-sm text-normal-text mb-3">
            The account is created in the reserved platform organization. The person must enrol TOTP MFA before opening this console.
          </p>
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

      <AdminActionDialog
        open={!!revoke}
        title="Revoke platform administrator"
        message={revoke ? `Revoke ${revoke.email} and all of their refresh sessions?` : ''}
        confirmLabel="Revoke access"
        requireReason
        onClose={() => setRevoke(null)}
        onConfirm={doRevoke}
      />
    </>
  );
}
