// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, PageTitle, Pager, Table, TableSkeleton } from '../../components/ui.jsx';

const SERVICES = ['ai', 'inference', 'workflow'];
const LIMIT = 50;

export default function AdminQuotas() {
  const platform = usePlatformAuth();
  const [service, setService] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState({ service: '', q: '', offset: 0 });
  const [data, setData] = useState({ items: [], total: 0 });
  const [defaults, setDefaults] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setErr(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(query.offset) });
      if (query.service) params.set('service', query.service);
      if (query.q) params.set('q', query.q);
      const [list, def] = await Promise.all([
        platform.request(`/v1/platform/quotas?${params.toString()}`),
        platform.request('/v1/platform/quotas/defaults'),
      ]);
      if (seq !== seqRef.current) return;
      setData({ items: Array.isArray(list.items) ? list.items : [], total: Number(list.total) || 0 });
      setDefaults(def.defaults || null);
    } catch (e) {
      if (seq === seqRef.current) setErr(e);
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [platform, query]);

  useEffect(() => { load(); }, [load]);

  const search = (e) => {
    e.preventDefault();
    setQuery({ service, q: q.trim(), offset: 0 });
  };

  const fmtLimit = (v) => (v == null ? 'default' : Number(v).toLocaleString());

  return (
    <>
      <PageTitle
        title="Rate Limits & Quotas"
        sub="Per-organization budgets for AI, Inference and Flow (workflow), enforced at the gateway edge"
        right={<Btn kind="secondary" onClick={load} loading={loading}>Refresh</Btn>}
      />
      <Err e={err} />
      {defaults && (
        <Card className="mb-4">
          <h3 className="font-semibold text-main-text mb-2">Global defaults <span className="font-normal text-xs text-normal-text">(applied when an organization has no override)</span></h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            {SERVICES.map((s) => {
              const d = defaults[s] || {};
              return (
                <div key={s} className="rounded-2xl bg-background p-3">
                  <p className="font-mono font-medium text-main-text mb-1">{s}</p>
                  <p className="text-normal-text text-xs space-y-0.5">
                    <span className="block">{fmtLimit(d.requestsPerMin)} requests/min</span>
                    <span className="block">{fmtLimit(d.requestsPer5h)} requests/5h</span>
                    <span className="block">{fmtLimit(d.requestsPerDay)} requests/day</span>
                    {d.tokensPerDay != null && <span className="block">{fmtLimit(d.tokensPerDay)} tokens/day</span>}
                    {d.executionsPerHour != null && <span className="block">{fmtLimit(d.executionsPerHour)} flow executions/hour</span>}
                    {d.concurrentExecutions != null && <span className="block">{fmtLimit(d.concurrentExecutions)} concurrent flows</span>}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      )}
      <Card className="mb-4">
        <form onSubmit={search} className="flex flex-wrap gap-2 items-end">
          <Field label="Service">
            <select value={service} onChange={(e) => setService(e.target.value)} className="px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
              <option value="">All services</option>
              {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Search org or service">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="acme" />
          </Field>
          <Btn type="submit" kind="secondary" className="mb-3" loading={loading}>Search</Btn>
          <Btn type="button" kind="secondary" className="mb-3" onClick={() => { setService(''); setQ(''); setQuery({ service: '', q: '', offset: 0 }); }}>Clear</Btn>
        </form>
      </Card>
      <Card>
        {!loaded ? <TableSkeleton rows={6} cols={8} /> : data.items.length ? (
          <Table head={['Organization', 'Service', 'Requests/min', 'Requests/5h', 'Requests/day', 'Tokens/day', 'Flow exec/hour', 'Concurrent']}>
            {data.items.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="py-2 pr-4">
                  <Link to={`/admin/orgs/${r.org_id}`} className="font-medium text-main-blue hover:underline">{r.org_slug || r.org_id?.slice(0, 8)}</Link>
                </td>
                <td className="py-2 pr-4"><Badge tone="blue">{r.service}</Badge></td>
                <td className="py-2 pr-4 tabular-nums">{fmtLimit(r.requests_per_min)}</td>
                <td className="py-2 pr-4 tabular-nums">{fmtLimit(r.requests_per_5h)}</td>
                <td className="py-2 pr-4 tabular-nums">{fmtLimit(r.requests_per_day)}</td>
                <td className="py-2 pr-4 tabular-nums">{fmtLimit(r.tokens_per_day)}</td>
                <td className="py-2 pr-4 tabular-nums">{fmtLimit(r.executions_per_hour)}</td>
                <td className="py-2 pr-4 tabular-nums">{fmtLimit(r.concurrent_executions)}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty text={query.service || query.q ? 'No overrides match this filter' : 'No per-organization overrides yet — every tenant uses the global defaults above'} />}
        <Pager total={data.total} limit={LIMIT} offset={query.offset} onChange={(offset) => setQuery((current) => ({ ...current, offset }))} loading={!loaded} />
      </Card>
      <p className="mt-3 text-xs text-normal-text">
        Request windows are fixed: minute epoch buckets, five-hour epoch buckets and UTC calendar days. To change an override, open the organization and use its Quotas tab. Changes take effect at the edge within ~30 seconds.
      </p>
    </>
  );
}
