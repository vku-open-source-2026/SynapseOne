// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { baseUrl } from '../../lib/api.js';
import { Badge, Btn, Card, Empty, Err, PageTitle, Skeleton, StatValue } from '../../components/ui.jsx';

const RANGES = [
  { id: '24h', label: '24 hours', ms: 24 * 3600_000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 3600_000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 3600_000 },
];

function windowFor(range) {
  const to = new Date();
  return { from: new Date(to.getTime() - range.ms).toISOString(), to: to.toISOString() };
}

export default function AdminOverview() {
  const platform = usePlatformAuth();
  const [range, setRange] = useState(RANGES[0]);
  const [overview, setOverview] = useState(null);
  const [usage, setUsage] = useState(null);
  const [recent, setRecent] = useState([]);
  const [ready, setReady] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    const w = windowFor(range);
    try {
      const [o, u, a] = await Promise.all([
        platform.request(`/v1/platform/overview?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`),
        platform.request(`/v1/platform/usage/summary?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`),
        platform.request('/v1/platform/audit?limit=6'),
      ]);
      setOverview(o);
      setUsage(u);
      setRecent(Array.isArray(a) ? a : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
    try {
      const r = await fetch(`${baseUrl()}/ready`);
      setReady(await r.json());
    } catch {
      setReady(null);
    }
  }, [platform, range]);

  useEffect(() => { load(); }, [load]);

  const totals = usage?.totals || overview?.usage || {};
  const tenancy = overview?.tenancy || {};
  const series = usage?.series || [];
  const max = useMemo(() => Math.max(1, ...series.map((s) => Number(s.requests) || 0)), [series]);
  const upstreams = ready?.upstreams || [];
  const healthy = upstreams.filter((u) => u.ok).length;

  return (
    <>
      <PageTitle
        title="Platform Overview"
        sub="Cross-tenant platform health, usage and administrative activity"
        right={(
          <div className="flex gap-1.5">
            {RANGES.map((r) => (
              <button key={r.id} type="button" onClick={() => setRange(r)} className={`px-3 py-1.5 rounded-2xl text-xs ${range.id === r.id ? 'bg-main-blue text-white' : 'bg-white text-main-text shadow-sm'}`}>
                {r.label}
              </button>
            ))}
            <Btn kind="secondary" onClick={load} loading={loading}>Refresh</Btn>
          </div>
        )}
      />
      <Err e={err} />

      <section className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-4">
        {[
          { label: 'Organizations', value: tenancy.organizations },
          { label: 'Accounts', value: tenancy.accounts },
          { label: 'Users', value: tenancy.users },
          { label: 'Active users', value: tenancy.activeUsers },
          { label: 'Org admins', value: tenancy.orgAdmins },
          { label: 'MFA enabled', value: tenancy.mfaEnabledUsers },
          { label: 'Requests', value: totals.requests },
          { label: 'Error rate', value: totals.errorRate == null ? '–' : `${totals.errorRate}%` },
          { label: 'p95 latency', value: totals.p95Ms == null ? '–' : `${totals.p95Ms} ms` },
          { label: 'Tokens', value: totals.totalTokens },
        ].map((k) => (
          <Card key={k.label} className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-normal-text mb-2">{k.label}</p>
            <StatValue loading={loading} value={k.value} />
          </Card>
        ))}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mt-6">
        <Card className="xl:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-main-text">Request activity</h3>
            <Badge tone={totals.errorRate > 5 ? 'red' : totals.errorRate > 1 ? 'amber' : 'green'}>{totals.requests || 0} requests</Badge>
          </div>
          {loading ? <Skeleton className="h-40 w-full" /> : series.length ? (
            <div className="h-44 flex items-end gap-[2px]" aria-label="Request activity chart">
              {series.map((s) => (
                <div
                  key={s.ts}
                  title={`${new Date(s.ts).toLocaleString()} · ${s.requests} requests · ${s.errors} errors`}
                  className="flex-1 min-w-[2px] rounded-t bg-gradient-to-t from-main-blue to-second-blue"
                  style={{ height: `${Math.max(2, (Number(s.requests) || 0) / max * 100)}%` }}
                />
              ))}
            </div>
          ) : <Empty text="No usage events in this range" />}
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-main-text">Service health</h3>
            <Badge tone={ready?.status === 'ready' ? 'green' : 'amber'}>{ready?.status || 'unknown'}</Badge>
          </div>
          <p className="text-xs text-normal-text mb-3">{healthy}/{upstreams.length || '–'} upstreams healthy</p>
          <ul className="space-y-2 text-xs">
            {upstreams.slice(0, 8).map((u) => (
              <li key={u.name} className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${u.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
                <span className="capitalize text-main-text">{u.name}</span>
                <span className="ml-auto text-normal-text">{u.ok ? `${u.ms} ms` : 'down'}</span>
              </li>
            ))}
          </ul>
          <Link to="/admin/health" className="mt-4 inline-block text-xs text-main-blue hover:underline">Open Service Health →</Link>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-6">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-main-text">Security signals</h3>
            <Link to="/admin/audit" className="text-xs text-main-blue hover:underline">Audit →</Link>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><StatValue loading={loading} value={overview?.audit?.denied} /><p className="text-[11px] text-normal-text mt-1">Denied</p></div>
            <div><StatValue loading={loading} value={overview?.audit?.failedLogins} /><p className="text-[11px] text-normal-text mt-1">Failed logins</p></div>
            <div><StatValue loading={loading} value={overview?.audit?.platformActions} /><p className="text-[11px] text-normal-text mt-1">Platform actions</p></div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-main-text">Recent platform activity</h3>
            <Badge tone="blue">{recent.length}</Badge>
          </div>
          {recent.length ? (
            <ul className="space-y-2 text-xs">
              {recent.map((a) => (
                <li key={a.id} className="flex items-center gap-2 min-w-0">
                  <Badge tone={a.decision ? 'green' : 'red'}>{a.decision ? 'ALLOW' : 'DENY'}</Badge>
                  <span className="font-mono text-main-text truncate">{a.action}</span>
                  <span className="ml-auto text-normal-text whitespace-nowrap">{a.created_at ? new Date(a.created_at).toLocaleString() : '–'}</span>
                </li>
              ))}
            </ul>
          ) : <Empty text="No platform activity yet" />}
        </Card>
      </div>
    </>
  );
}
