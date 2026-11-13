// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, Field, InlineLoader, Input, Modal, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Users() {
  const { headers, auth } = useAuth();
  const canAdmin = !!auth?.user?.is_org_admin;
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [invite, setInvite] = useState(null);
  const [roles, setRoles] = useState([]);
  const [assignUser, setAssignUser] = useState('');
  const [assignRole, setAssignRole] = useState('');
  // Bumped after each assign so every expanded row refetches roles + counts.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!scope.orgId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    setErr(null);
    api.users(scope.orgId, headers).then((v) => setRows(Array.isArray(v) ? v : [])).catch(setErr).finally(() => setLoaded(true));
  }, [scope.orgId, headers]);

  useEffect(() => {
    if (!scope.accountId) {
      setRoles([]);
      return;
    }
    setAssignRole('');
    api.roles(scope.accountId, headers).then((v) => setRoles(Array.isArray(v) ? v : [])).catch(() => setRoles([]));
  }, [scope.accountId, headers]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createUser(scope.orgId, email, displayName || undefined, headers);
      setOpen(false);
      setEmail('');
      setDisplayName('');
      if (created?.inviteToken) {
        setInvite({ email: created.email || email, token: created.inviteToken });
      }
      api.users(scope.orgId, headers).then((v) => setRows(Array.isArray(v) ? v : [])).catch(setErr);
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const doAssign = async (e) => {
    e.preventDefault();
    if (!assignUser || !assignRole || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.assign(assignUser, assignRole, headers);
      setTick((t) => t + 1);
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const doUnassign = async (userId, roleId) => {
    if (!window.confirm('Remove this role from the user?')) return false;
    try {
      await api.unassign(userId, roleId, headers);
      return true;
    } catch (e) {
      setErr(e);
      return false;
    }
  };

  return (
    <>
      <PageTitle title="Users" sub="Shadow users federated from Authentik/Keycloak (email + OIDC sub)" right={canAdmin ? <Btn onClick={() => setOpen(true)}>+ New</Btn> : undefined} />
      <Err e={err} />
      <ScopeBar scope={scope} showAccount={false} />
      {canAdmin && scope.accountId && rows.length > 0 && roles.length > 0 && (
        <Card className="mb-4">
          <form onSubmit={doAssign} className="flex flex-wrap items-end gap-2 [&>label]:mb-0">
            <Field label="User">
              <select value={assignUser} onChange={(e) => setAssignUser(e.target.value)} className="px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none">
                <option value="">Pick…</option>
                {rows.map((u) => (
                  <option key={u.id} value={u.id}>{u.email}</option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <select value={assignRole} onChange={(e) => setAssignRole(e.target.value)} className="px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none">
                <option value="">Pick…</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.slug}</option>
                ))}
              </select>
            </Field>
            <Btn type="submit" disabled={busy || !assignUser || !assignRole}>Assign</Btn>
          </form>
        </Card>
      )}
      <Card>
        {!loaded ? (
          <TableSkeleton rows={5} cols={4} />
        ) : rows.length ? (
          <Table head={['Email', 'Name', 'OIDC sub', 'Roles']}>
            {rows.map((u) => (
              <Row key={u.id} u={u} headers={headers} onUnassign={doUnassign} tick={tick} canAdmin={canAdmin} />
            ))}
          </Table>
        ) : (
          <Empty text={scope.orgId ? 'No users yet' : 'Pick an organization to see its users'} />
        )}
      </Card>
      {invite && (
        <Modal title="User invited" onClose={() => setInvite(null)}>
          <p className="text-sm text-normal-text">
            Send this one-time activation code to <strong>{invite.email}</strong> through a trusted channel.
          </p>
          <p className="text-xs text-normal-text mt-3">Activation code (expires in 7 days):</p>
          <div className="mt-2 rounded-2xl bg-background p-3 break-all font-mono text-xs">{invite.token}</div>
          <div className="flex gap-2 mt-3">
            <Btn onClick={() => navigator.clipboard?.writeText(invite.token)}>Copy code</Btn>
            <Btn kind="secondary" onClick={() => setInvite(null)}>Close</Btn>
          </div>
        </Modal>
      )}
      {open && (
        <Modal title="New user" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="a@acme.local" />
            </Field>
            <Field label="Display name (optional)">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Alice" />
            </Field>
            <Btn type="submit" loading={busy}>Create</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}

function Row({ u, headers, onUnassign, tick, canAdmin }) {
  const [n, setN] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [assigned, setAssigned] = useState(null);
  const [rtick, setRtick] = useState(0);
  const [unassigning, setUnassigning] = useState(null);
  const [secBusy, setSecBusy] = useState(null);
  const [secMsg, setSecMsg] = useState(null);
  // Policy count + assigned roles refetch on: mount, session/token change,
  // parent assign (tick), and local unassign (rtick). Live flags prevent
  // setState after unmount or user switch.
  useEffect(() => {
    let live = true;
    api.userPolicies(u.id, headers).then((p) => live && setN(Array.isArray(p) ? p.length : 0)).catch(() => live && setN(0));
    return () => {
      live = false;
    };
  }, [u.id, headers, tick, rtick]);
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    setAssigned(null);
    api.userRoles(u.id, headers).then((v) => live && setAssigned(Array.isArray(v) ? v : [])).catch(() => live && setAssigned([]));
    return () => {
      live = false;
    };
  }, [expanded, tick, rtick, u.id, headers]);

  const toggle = () => setExpanded((v) => !v);

  // Org admins: lost authenticator / locked-out user.
  const security = async (kind) => {
    setSecBusy(kind);
    setSecMsg(null);
    try {
      if (kind === 'mfa') {
        const r = await api.resetUserMfa(u.id, headers);
        setSecMsg(r.removed ? 'MFA removed, the user can enrol again.' : 'This user had no MFA.');
      } else {
        await api.unlockUser(u.id, headers);
        setSecMsg('Sign-in lockout cleared.');
      }
    } catch (e) {
      setSecMsg(e?.body?.message || e?.message || 'Request failed');
    } finally {
      setSecBusy(null);
    }
  };

  const unassign = async (roleId) => {
    if (unassigning) return;
    setUnassigning(roleId);
    try {
      if (await onUnassign(u.id, roleId)) setRtick((t) => t + 1);
    } finally {
      setUnassigning(null);
    }
  };

  return (
    <React.Fragment>
      <tr className="border-t border-slate-100">
        <td className="py-2 pr-4 font-medium text-main-text">{u.email}</td>
        <td className="py-2 pr-4">{u.display_name || '–'}</td>
        <td className="py-2 pr-4 text-xs text-normal-text font-mono">{u.external_sub?.slice(0, 18) || '–'}</td>
        <td className="py-2 pr-4">
          {n === null ? <span className="text-xs text-normal-text">…</span> : <Badge tone={n ? 'blue' : 'gray'}>{n} policies</Badge>}{' '}
          <button onClick={toggle} className="text-xs text-main-blue">{expanded ? 'Hide roles' : 'Roles'}</button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} className="pb-3">
            {assigned === null ? (
              <InlineLoader />
            ) : assigned.length ? (
              <ul className="space-y-1">
                {assigned.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-xs bg-background rounded-xl px-3 py-1.5">
                    <span className="font-mono text-main-text">{r.slug}</span>
                    {canAdmin && <button onClick={() => unassign(r.id)} disabled={unassigning === r.id} className="ml-auto text-red-500 disabled:opacity-50">
                      {unassigning === r.id ? 'Removing…' : 'Unassign'}
                    </button>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-normal-text">No roles assigned</p>
            )}
            {canAdmin && <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <button onClick={() => security('mfa')} disabled={!!secBusy} className="text-main-blue disabled:opacity-50">
                {secBusy === 'mfa' ? 'Resetting…' : 'Reset MFA'}
              </button>
              <button onClick={() => security('unlock')} disabled={!!secBusy} className="text-main-blue disabled:opacity-50">
                {secBusy === 'unlock' ? 'Unlocking…' : 'Unlock sign-in'}
              </button>
              {secMsg && <span className="text-normal-text">{secMsg}</span>}
            </div>}
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}
