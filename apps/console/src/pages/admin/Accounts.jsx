// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, PageTitle, Table, TableSkeleton } from '../../components/ui.jsx';

export default function AdminAccounts() {
  const platform = usePlatformAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const PAGE = 50;

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (query) p.set('q', query);
      setData(await platform.request(`/v1/platform/accounts?${p}`));
    } catch (e) { setErr(e); } finally { setLoading(false); }
  }, [platform, query, offset]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageTitle title="Accounts" sub="Tenant accounts across all organizations" right={<Btn kind="secondary" onClick={load} loading={loading}>Refresh</Btn>} />
      <Err e={err} />
      <Card className="mb-4">
        <form onSubmit={(e) => { e.preventDefault(); setOffset(0); setQuery(q.trim()); }} className="flex flex-wrap items-end gap-2">
          <Field label="Slug or display name"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="production" /></Field>
          <Btn type="submit" kind="secondary" className="mb-3">Search</Btn>
          <Btn type="button" kind="secondary" className="mb-3" onClick={() => { setQ(''); setQuery(''); setOffset(0); }}>Clear</Btn>
        </form>
      </Card>
      <Card>
        {loading ? <TableSkeleton rows={6} cols={5} /> : data.items?.length ? (
          <Table head={['Organization', 'Account', 'Display name', 'ID']}>
            {data.items.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="py-2 pr-4"><Link to={`/admin/orgs/${a.org_id}`} className="text-main-blue hover:underline">{a.org_slug}</Link></td>
                <td className="py-2 pr-4 font-medium">{a.slug}</td>
                <td className="py-2 pr-4">{a.display_name}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.id?.slice(0, 8)}…</td>
              </tr>
            ))}
          </Table>
        ) : <Empty text="No accounts match" />}
      </Card>
      <div className="flex justify-between items-center mt-3">
        <span className="text-xs text-normal-text">{data.total || 0} accounts</span>
        <div className="flex gap-2">
          <Btn kind="secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
          <Btn kind="secondary" disabled={offset + PAGE >= (data.total || 0) || loading} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
        </div>
      </div>
    </>
  );
}
