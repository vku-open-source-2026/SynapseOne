// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { baseUrl } from '../../lib/api.js';
import { Badge, Btn, Card, Empty, Err, PageTitle, Skeleton } from '../../components/ui.jsx';

export default function AdminServiceHealth() {
  const [ready, setReady] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [last, setLast] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const r = await fetch(`${baseUrl()}/ready`);
      const body = await r.json();
      setReady(body);
      setLast(new Date());
      if (!r.ok && !body?.upstreams) setErr(new Error(`gateway /ready returned HTTP ${r.status}`));
    } catch (e) {
      setErr(e);
      setReady(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const upstreams = ready?.upstreams || [];
  const healthy = upstreams.filter((u) => u.ok).length;
  const status = ready?.status || (err ? 'unreachable' : 'unknown');

  return (
    <>
      <PageTitle
        title="Service Health"
        sub="Gateway readiness across platform dependencies"
        right={<><span className="text-xs text-normal-text mr-2">{last ? `Updated ${last.toLocaleTimeString()}` : '—'}</span><Btn kind="secondary" onClick={load} loading={loading}>Refresh now</Btn></>}
      />
      <Err e={err} />
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={status === 'ready' ? 'green' : status === 'degraded' ? 'amber' : 'red'}>{status}</Badge>
          <span className="text-sm text-main-text">{healthy}/{upstreams.length || '–'} dependencies healthy</span>
          <span className="text-xs text-normal-text">Auto-refresh every 30 seconds · endpoint <code>{baseUrl()}/ready</code></span>
        </div>
      </Card>
      {loading && !ready ? <Skeleton className="h-48 w-full" /> : upstreams.length ? (
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {upstreams.map((u) => (
            <Card key={u.name}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-main-text capitalize">{u.name}</h3>
                <Badge tone={u.ok ? 'green' : 'red'}>{u.ok ? 'healthy' : 'down'}</Badge>
              </div>
              <dl className="mt-3 space-y-1 text-xs text-normal-text">
                <div className="flex justify-between"><dt>HTTP</dt><dd>{u.status ?? '—'}</dd></div>
                <div className="flex justify-between"><dt>Latency</dt><dd>{u.ms != null ? `${u.ms} ms` : '—'}</dd></div>
                <div className="flex justify-between"><dt>Version</dt><dd className="font-mono">{u.version || '—'}</dd></div>
                {u.error && <div className="flex justify-between text-red-500"><dt>Error</dt><dd>{u.error}</dd></div>}
              </dl>
            </Card>
          ))}
        </section>
      ) : <Card><Empty text="No readiness data from the gateway" /></Card>}
    </>
  );
}
