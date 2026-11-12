// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import AdminActionDialog from '../../components/AdminActionDialog.jsx';
import { Badge, Btn, Card, Empty, Err, PageTitle, Skeleton, Table } from '../../components/ui.jsx';

export default function AdminUserDetail() {
  const { userId } = useParams();
  const platform = usePlatformAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setData(await platform.request(`/v1/platform/users/${encodeURIComponent(userId)}`));
    } catch (e) {
      setErr(e);
    }
  }, [platform, userId]);

  useEffect(() => { load(); }, [load]);

  const run = async ({ reason, stepUpToken }) => {
    const a = confirm;
    if (!a) return;
    const body = {};
    if (a.kind === 'org-admin') body.isOrgAdmin = !a.current;
    if (reason) body.reason = reason;
    const path = a.kind === 'org-admin'
      ? `/v1/platform/users/${encodeURIComponent(userId)}/org-admin`
      : `/v1/platform/users/${encodeURIComponent(userId)}/${a.kind}`;
    await platform.request(path, { method: a.kind === 'org-admin' ? 'PUT' : 'POST', body, stepUpToken });
    setNotice('Action completed and recorded in the audit log.');
    await load();
  };

  if (err) return <><PageTitle title="User" /><Err e={err} /><Link to="/admin/users" className="text-sm text-main-blue">Back to users</Link></>;
  if (!data) return <Skeleton className="h-64 w-full" />;

  const u = data.user || {};
  const mfa = data.mfa || {};
  const actions = [
    { kind: 'org-admin', label: u.is_org_admin ? 'Revoke org admin' : 'Grant org admin', current: u.is_org_admin, danger: u.is_org_admin },
    { kind: 'reset-mfa', label: 'Reset MFA', danger: true },
    { kind: 'revoke-sessions', label: 'Revoke sessions', danger: true },
    { kind: u.active ? 'disable' : 'enable', label: u.active ? 'Disable user' : 'Enable user', danger: u.active },
    { kind: 'unlock', label: 'Unlock sign-in', danger: false },
  ];

  return (
    <>
      <PageTitle
        title={u.email}
        sub={`${data.organization?.slug || '–'} · ${u.display_name || 'No display name'}`}
        right={<Link to="/admin/users" className="text-sm text-main-blue hover:underline">Back</Link>}
      />
      {notice && <div className="mb-4 px-4 py-2.5 rounded-2xl bg-emerald-500/10 text-emerald-700 text-sm">{notice}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Identity</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-normal-text">User ID</dt><dd className="font-mono text-xs text-main-text truncate">{u.id}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">Organization</dt><dd>{data.organization?.slug}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">Status</dt><dd><Badge tone={u.active ? 'green' : 'gray'}>{u.active ? 'active' : 'inactive'}</Badge></dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">Org admin</dt><dd><Badge tone={u.is_org_admin ? 'blue' : 'gray'}>{u.is_org_admin ? 'yes' : 'no'}</Badge></dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">MFA</dt><dd><Badge tone={mfa.enabled ? 'green' : 'amber'}>{mfa.enabled ? `${mfa.recoveryCodesRemaining} recovery codes` : 'not enabled'}</Badge></dd></div>
          </dl>
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Roles</h3>
          {data.roles?.length ? (
            <ul className="space-y-1 text-sm">{data.roles.map((r) => <li key={r.id} className="font-mono text-xs bg-background rounded-xl px-3 py-1.5">{r.slug}</li>)}</ul>
          ) : <Empty text="No roles assigned" />}
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Actions</h3>
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Btn key={a.kind} kind={a.danger ? 'danger' : 'secondary'} onClick={() => setConfirm(a)}>{a.label}</Btn>
            ))}
          </div>
          <p className="text-xs text-normal-text mt-3">Destructive actions require a fresh authenticator code. Every action is audited.</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-6">
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Effective policy statements</h3>
          {data.policies?.length ? (
            <Table head={['#', 'Statements']}>
              {data.policies.map((p) => <tr key={p.index} className="border-t border-slate-100"><td className="py-2 pr-4">{p.index + 1}</td><td className="py-2 pr-4">{p.Statement}</td></tr>)}
            </Table>
          ) : <Empty text="No policies via roles" />}
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Sessions</h3>
          {data.sessions?.length ? (
            <Table head={['Session', 'Created', 'Expires']}>
              {data.sessions.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-2 pr-4 text-xs font-mono text-normal-text">{s.id.slice(0, 8)}…</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">{s.created_at ? new Date(s.created_at).toLocaleString() : '–'}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">{s.expires_at ? new Date(s.expires_at).toLocaleString() : '–'}</td>
                </tr>
              ))}
            </Table>
          ) : <Empty text="No active sessions" />}
        </Card>
      </div>

      <AdminActionDialog
        open={!!confirm}
        title={confirm ? `${confirm.label}?` : ''}
        message={confirm ? `This affects ${u.email}. A fresh TOTP code is required.` : ''}
        confirmLabel={confirm?.label || 'Confirm'}
        requireReason={confirm?.kind === 'org-admin'}
        onClose={() => setConfirm(null)}
        onConfirm={run}
      />
    </>
  );
}
