// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import AdminActionDialog from '../../components/AdminActionDialog.jsx';
import { Badge, Btn, Card, Code, Empty, Err, Modal, PageTitle, Skeleton, Table } from '../../components/ui.jsx';

export default function AdminUserDetail() {
  const { userId } = useParams();
  const platform = usePlatformAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState(null);
  const [invite, setInvite] = useState(null);

  const canWrite = platform.role === 'owner' || platform.role === 'operator';

  const load = useCallback(async () => {
    setErr(null);
    try {
      setData(await platform.request(`/v1/platform/users/${encodeURIComponent(userId)}`));
    } catch (e) {
      setErr(e);
    }
  }, [platform, userId]);

  useEffect(() => { setData(null); setErr(null); setNotice(null); setInvite(null); setConfirm(null); }, [userId]);
  useEffect(() => { load(); }, [load]);

  const run = async ({ reason, stepUpToken }) => {
    const a = confirm;
    if (!a) return;
    const body = {};
    if (a.action === 'user:org-admin') body.isOrgAdmin = !data.user.is_org_admin;
    if (reason) body.reason = reason;
    const out = await platform.request(
      a.path || `/v1/platform/users/${encodeURIComponent(userId)}/${a.kind}`,
      { method: a.method || 'POST', body, stepUpToken },
    );
    setNotice(`${a.label} completed and recorded in the audit log.`);
    if (out?.inviteToken) setInvite({ email: data.user.email, token: out.inviteToken });
    await load();
  };

  if (err && !data) {
    return (
      <>
        <PageTitle title="User" right={<Link to="/admin/users" className="text-sm text-main-blue hover:underline">Back</Link>} />
        <Err e={err} />
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageTitle title="User detail" right={<Link to="/admin/users" className="text-sm text-main-blue hover:underline">Back</Link>} />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  const u = data.user || {};
  const mfa = data.mfa || {};
  const active = u.active !== false;
  const actions = [
    {
      kind: 'org-admin', action: 'user:org-admin', method: 'PUT',
      label: u.is_org_admin ? 'Revoke org admin' : 'Grant org admin',
      danger: !!u.is_org_admin, requireReason: true,
      message: u.is_org_admin
        ? 'Revokes organization-administrator rights. The last active org admin cannot be removed.'
        : 'Grants organization-administrator rights for this organization.',
    },
    ...(mfa.enabled ? [{
      kind: 'reset-mfa', action: 'user:reset-mfa', label: 'Reset MFA', danger: true,
      message: 'Removes TOTP MFA and revokes all refresh sessions and API keys for this user.',
    }] : []),
    {
      kind: 'revoke-sessions', action: 'user:revoke-sessions', label: 'Revoke sessions', danger: true,
      message: 'Revokes refresh sessions and user-owned API keys. The user must sign in again.',
    },
    {
      kind: active ? 'disable' : 'enable', action: active ? 'user:disable' : 'user:enable',
      label: active ? 'Disable user' : 'Enable user', danger: active,
      message: active
        ? 'Deactivates the account and revokes its sessions and API keys.'
        : 'Reactivates the account. Previous sessions remain revoked.',
    },
    ...(data.lockedForSeconds > 0 ? [{
      kind: 'unlock', action: 'user:unlock', label: 'Unlock sign-in', danger: false,
      message: 'Clears the sign-in failure lockout for this user.',
    }] : []),
    ...(!u.passwordSet && active ? [{
      kind: 'invite', action: 'user:invite', label: 'Issue activation code', danger: false,
      message: 'Creates a one-time activation code for this passwordless user.',
    }] : []),
  ];

  return (
    <>
      <PageTitle
        title={u.email}
        sub={`${data.organization?.slug || '–'} · ${u.display_name || 'No display name'}`}
        right={<Link to="/admin/users" className="text-sm text-main-blue hover:underline">Back</Link>}
      />
      <Err e={err} />
      <div role="status" aria-live="polite">
        {notice && <div className="mb-4 px-4 py-2.5 rounded-2xl bg-emerald-500/10 text-emerald-700 text-sm">{notice}</div>}
      </div>
      {!canWrite && (
        <div className="mb-4 px-4 py-2.5 rounded-2xl bg-amber-500/10 text-amber-700 text-sm">
          Auditor role: this page is read-only.
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Identity</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-normal-text">User ID</dt><dd className="font-mono text-xs text-main-text truncate">{u.id}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">Organization</dt><dd>{data.organization?.slug}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">Status</dt><dd><Badge tone={active ? 'green' : 'gray'}>{active ? 'active' : 'inactive'}</Badge></dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">Org admin</dt><dd><Badge tone={u.is_org_admin ? 'blue' : 'gray'}>{u.is_org_admin ? 'yes' : 'no'}</Badge></dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">Password</dt><dd><Badge tone={u.passwordSet ? 'green' : 'amber'}>{u.passwordSet ? 'set' : 'activation pending'}</Badge></dd></div>
            <div className="flex justify-between gap-2"><dt className="text-normal-text">MFA</dt><dd><Badge tone={mfa.enabled ? 'green' : 'amber'}>{mfa.enabled ? `${mfa.recoveryCodesRemaining ?? 0} recovery codes` : 'not enabled'}</Badge></dd></div>
            {data.lockedForSeconds > 0 && (
              <div className="flex justify-between gap-2"><dt className="text-normal-text">Sign-in lock</dt><dd><Badge tone="red">{data.lockedForSeconds}s</Badge></dd></div>
            )}
          </dl>
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Roles</h3>
          {data.roles?.length ? (
            <ul className="space-y-1 text-sm">{data.roles.map((r) => <li key={r.id} className="font-mono text-xs bg-background rounded-xl px-3 py-1.5">{r.slug}</li>)}</ul>
          ) : <Empty text="No roles assigned" />}
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Administrative actions</h3>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <Btn key={a.kind} kind={a.danger ? 'danger' : 'secondary'} onClick={() => setConfirm(a)}>{a.label}</Btn>
              ))}
            </div>
          ) : <Empty text="Read-only for the auditor role" />}
          <p className="text-xs text-normal-text mt-3">High-risk actions require a fresh authenticator code. Every action is audited.</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-6">
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Policy documents</h3>
          {data.policies?.length ? (
            <div className="space-y-3">
              {data.policies.map((p) => (
                <div key={p.index}>
                  <p className="text-xs font-medium text-main-text mb-1">Policy {p.index + 1}</p>
                  <Code data={p.document || {}} />
                </div>
              ))}
            </div>
          ) : <Empty text="No policies via roles" />}
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Refresh sessions</h3>
          {data.sessions?.length ? (
            <Table head={['Session', 'Created', 'Expires', 'State']}>
              {data.sessions.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-2 pr-4 text-xs font-mono text-normal-text">{s.id.slice(0, 8)}…</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">{s.created_at ? new Date(s.created_at).toLocaleString() : '–'}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">{s.expires_at ? new Date(s.expires_at).toLocaleString() : '–'}</td>
                  <td className="py-2 pr-4"><Badge tone={s.revoked_at ? 'gray' : 'green'}>{s.revoked_at ? 'revoked' : 'active'}</Badge></td>
                </tr>
              ))}
            </Table>
          ) : <Empty text="No refresh sessions" />}
        </Card>
      </div>

      <AdminActionDialog
        open={!!confirm}
        title={confirm ? `${confirm.label}?` : ''}
        message={confirm ? (confirm.message || `This affects ${u.email}.`) : ''}
        action={confirm?.action}
        confirmLabel={confirm?.label || 'Confirm'}
        requireReason={confirm?.requireReason}
        requireStepUp={confirm?.requireStepUp !== false}
        danger={confirm?.danger !== false}
        onClose={() => setConfirm(null)}
        onConfirm={run}
      />

      {invite && (
        <Modal title="One-time activation code" onClose={() => setInvite(null)}>
          <p className="text-sm text-normal-text">
            Send this code to <strong>{invite.email}</strong> through a trusted channel. It expires in 7 days and
            can be used once at <code>/register</code> to set a password.
          </p>
          <div className="mt-3 rounded-2xl bg-background p-3 break-all font-mono text-xs">{invite.token}</div>
          <Btn className="mt-4" onClick={() => { navigator.clipboard?.writeText(invite.token); }}>Copy code</Btn>
          <Btn kind="secondary" className="mt-4 ml-2" onClick={() => setInvite(null)}>Close</Btn>
        </Modal>
      )}
    </>
  );
}
