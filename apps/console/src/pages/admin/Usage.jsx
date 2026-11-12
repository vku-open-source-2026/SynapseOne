// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Empty, Err, Field, PageTitle, Skeleton, StatValue, Table } from '../../components/ui.jsx';

const RANGES = [
  { id: '24h', label: '24 hours', ms: 24 * 3600_000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 3600_000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 3600_000 },
];

export default function AdminUsage() {
  const platform = usePlatformAuth();
  const [range, setRange] = useState(RANGES[0]);
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState('');
  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState({ items: [], total: 0 });
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    platform.request('/v1/platform/orgs?limit=200').then((r) => setOrgs(Array.isArray(r.items) ? r.items : [])).catch(() => setOrgs([]));
  }, [platform]);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    const to = new Date();
    const from = new Date(to.getTime() - range.ms);
    const base = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}${orgId ? `&orgId=${encodeURIComponent(orgId)}` : ''}`;
    try {
      const [s, e] = await Promise.all([
        platform.request(`/v1/platform/usage/summary?${base}`),
        platform.request(`/v1/platform/usage/events?${base}&limit=25`),
      ]);
      setSummary(s);
      setEvents({ items: Array.isArray(e.items) ? e.items : [], total: Number(e.total) || 0 });
    } catch (ex) {
      setErr(ex);
    } finally {
      setLoading(false);
    }
  }, [platform, range, orgId]);

  useEffect(() => { load(); }, [load]);

  const totals = summary?.totals || {};
  const series = summary?.series || [];
  const max = useMemo(() => Math.max(1, ...series.map((s) => Number(s.requests) || 0)), [series]);
  const features = summary?.features || [];

  return (
    <>
      <PageTitle
        title="Usage & Metering"
        sub="Platform-wide request volume, error rate, latency and token usage"
        right={(
          <div className="flex flex-wrap gap-1.5 items-center">
            {RANGES.map((r) => <button key={r.id} type="button" onClick={() => setRange(r)} className={`px-3 py-1.5 rounded-2xl text-xs ${range.id === r.id ? 'bg-main-blue text-white' : 'bg-white text-main-text shadow-sm'}`}>{r.label}</button>)}
            <Btn kind="secondary" onClick={load} loading={loading}>Refresh</Btn>
          </div>
        )}
      />
      <Err e={err} />
      <Card className="mb-4">
        <Field label="Organization filter">
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="w-full md:w-80 px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
            <option value="">All organizations</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.slug}</option>)}
          </select>
        </Field>
      </Card>

      <section className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4">
        {[
          ['Requests', totals.requests], ['Success', totals.success], ['Errors', (totals.clientErrors || 0) + (totals.serverErrors || 0)],
          ['Error rate', totals.errorRate == null ? '–' : `${totals.errorRate}%`], ['Avg latency', totals.avgMs == null ? '–' : `${totals.avgMs} ms`],
          ['p95 latency', totals.p95Ms == null ? '–' : `${totals.p95Ms} ms`], ['Tokens', totals.totalTokens],
        ].map(([label, value]) => <Card key={label}><p className="text-[11px] uppercase text-normal-text mb-2">{label}</p><StatValue loading={loading} value={value} /></Card>)}
      </section>

      <Card className="mt-6">
        <div className="flex items-center justify-between mb-3"><h3 className="font-semibold text-main-text">Request timeline</h3><Badge tone="blue">{series.length} buckets</Badge></div>
        {loading ? <Skeleton className="h-40 w-full" /> : series.length ? (
          <div className="h-44 flex items-end gap-[2px]">
            {series.map((s) => (
              <div key={s.ts} title={`${new Date(s.ts).toLocaleString()} · ${s.requests} requests · ${s.errors} errors`} className="flex-1 min-w-[2px] rounded-t bg-gradient-to-t from-main-blue to-second-blue" style={{ height: `${Math.max(2, (Number(s.requests) || 0) / max * 100)}%` }} />
            ))}
          </div>
        ) : <Empty text="No usage in this range" />}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-6">
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Feature breakdown</h3>
          {features.length ? <Table head={['Feature', 'Requests', 'Errors', 'p95', 'Share']}>
            {features.map((f) => <tr key={f.feature} className="border-t border-slate-100"><td className="py-2 pr-4 font-medium">{f.feature}</td><td className="py-2 pr-4 tabular-nums">{f.requests}</td><td className="py-2 pr-4 tabular-nums">{f.clientErrors + f.serverErrors}</td><td className="py-2 pr-4 tabular-nums">{f.p95Ms} ms</td><td className="py-2 pr-4 tabular-nums">{f.share}%</td></tr>)}
          </Table> : <Empty text="No feature data" />}
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Top routes</h3>
          {summary?.topRoutes?.length ? <Table head={['Route', 'Method', 'Requests', 'Errors']}>
            {summary.topRoutes.map((r) => <tr key={`${r.route}-${r.method}`} className="border-t border-slate-100"><td className="py-2 pr-4 font-mono text-xs">{r.route}</td><td className="py-2 pr-4"><Badge tone="gray">{r.method}</Badge></td><td className="py-2 pr-4 tabular-nums">{r.requests}</td><td className="py-2 pr-4 tabular-nums">{r.errors}</td></tr>)}
          </Table> : <Empty text="No route data" />}
        </Card>
      </div>

      <Card className="mt-6">
        <h3 className="font-semibold text-main-text mb-3">Recent requests</h3>
        {events.items.length ? <Table head={['Time', 'Organization', 'Feature', 'Method', 'Path', 'Status', 'Latency']}>
          {events.items.map((e) => <tr key={e.id} className="border-t border-slate-100">
            <td className="py-2 pr-4 text-xs whitespace-nowrap">{e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : '–'}</td>
            <td className="py-2 pr-4 text-xs">{e.orgId || '–'}</td><td className="py-2 pr-4 text-xs">{e.feature}</td><td className="py-2 pr-4"><Badge tone="gray">{e.method}</Badge></td>
            <td className="py-2 pr-4 font-mono text-xs max-w-xs truncate">{e.path}</td><td className="py-2 pr-4"><Badge tone={e.status < 400 ? 'green' : e.status < 500 ? 'amber' : 'red'}>{e.status}</Badge></td><td className="py-2 pr-4 text-xs">{e.durationMs} ms</td>
          </tr>)}
        </Table> : <Empty text="No recent requests" />}
      </Card>
    </>
  );
}
