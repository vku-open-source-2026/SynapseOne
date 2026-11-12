// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, Input, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';

export default function Audit() {
  const { headers } = useAuth();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [actor, setActor] = useState('');
  const [decision, setDecision] = useState('');

  const load = async () => {
    setErr(null);
    if (loaded) setFiltering(true);
    try {
      const v = await api.audit(100, actor || undefined, headers, decision === '' ? undefined : decision === 'allow');
      setRows(Array.isArray(v) ? v : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
      setFiltering(false);
    }
  };

  useEffect(() => {
    load();
  }, [headers]);

  const fmtTime = (t) => {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString();
  };

  const errCode = err?.body?.error || err?.code;
  if (['org_admin_required', 'access_denied', 'forbidden'].includes(errCode)) {
    return (
      <>
        <PageTitle title="Audit Log" sub="Every authorize decision, newest first" />
        <Card className="max-w-2xl">
          <h3 className="text-lg font-semibold text-main-text">Cần quyền quản trị tổ chức</h3>
          <p className="text-sm text-normal-text mt-2">
            Bạn vẫn sử dụng được các tính năng tenant khác, nhưng Audit yêu cầu quyền
            <strong> Organization Administrator</strong>.
          </p>
          <p className="text-sm text-normal-text mt-2">
            Hãy đăng nhập bằng tài khoản admin của tổ chức, hoặc nhờ admin hiện tại cấp quyền
            <code className="mx-1 rounded bg-background px-1.5 py-0.5 text-xs">is_org_admin</code>
            cho tài khoản của bạn.
          </p>
          <p className="text-xs text-normal-text mt-3 font-mono">{errCode}</p>
          <div className="flex flex-wrap gap-2 mt-5">
            <Link to="/dashboard"><Btn>Về Dashboard</Btn></Link>
            <Btn kind="secondary" onClick={load} loading={filtering}>Thử lại</Btn>
          </div>
        </Card>
      </>
    );
  }

  if (err) {
    return (
      <>
        <PageTitle title="Audit Log" sub="Every authorize decision, newest first" />
        <Err e={err} />
        <Card className="max-w-2xl">
          <p className="text-sm text-normal-text">Không tải được audit. Kiểm tra kết nối hoặc quyền tài khoản rồi thử lại.</p>
          <Btn kind="secondary" className="mt-4" onClick={load} loading={filtering}>Thử lại</Btn>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageTitle title="Audit Log" sub="Every authorize decision, newest first" />
      <div className="flex gap-2 mb-4">
        <Input placeholder="Filter by actor id (user)…" value={actor} onChange={(e) => setActor(e.target.value)} />
        <select value={decision} onChange={(e) => setDecision(e.target.value)} className="px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none" title="Decision">
          <option value="">All decisions</option>
          <option value="allow">Allow only</option>
          <option value="deny">Deny only</option>
        </select>
        <Btn onClick={load} kind="secondary" loading={filtering}>Filter</Btn>
      </div>
      <Card>
        {!loaded ? (
          <TableSkeleton rows={6} cols={5} />
        ) : filtering ? (
          <TableSkeleton rows={6} cols={5} />
        ) : rows.length ? (
          <Table head={['Time', 'Actor', 'Action', 'Resource', 'Decision']}>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 text-xs whitespace-nowrap">{fmtTime(a.created_at)}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.actor_type || '?'}:{a.actor_id ? String(a.actor_id).slice(0, 8) : '–'}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.action}</td>
                <td className="py-2 pr-4 text-xs font-mono max-w-48 truncate">{a.resource}</td>
                <td className="py-2 pr-4">
                  <Badge tone={a.decision ? 'green' : 'red'}>{a.decision ? 'ALLOW' : 'DENY'}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No audit records yet" />
        )}
      </Card>
    </>
  );
}
