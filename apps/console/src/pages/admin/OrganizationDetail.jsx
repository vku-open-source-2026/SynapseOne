// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Card, Empty, Err, PageTitle, Skeleton, StatValue, Table } from '../../components/ui.jsx';

export default function AdminOrganizationDetail() {
  const { orgId } = useParams();
  const platform = usePlatformAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setData(await platform.request(`/v1/platform/orgs/${encodeURIComponent(orgId)}`));
    } catch (e) {
      setErr(e);
    }
  }, [platform, orgId]);

  useEffect(() => { load(); }, [load]);

  if (err) return <><PageTitle title="Organization" /><Err e={err} /><Link to="/admin/orgs" className="text-sm text-main-blue">Back to organizations</Link></>;

  return (
    <>
      <PageTitle
        title={data?.organization?.slug || 'Organization'}
        sub={data?.organization?.display_name || 'Tenant organization detail'}
        right={<Link to="/admin/orgs" className="text-sm text-main-blue hover:underline">Back</Link>}
      />
      {!data ? <Skeleton className="h-48 w-full" /> : (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              ['Accounts', data.counts?.accounts],
              ['Users', data.counts?.users],
              ['Active users', data.counts?.activeUsers],
              ['Org admins', data.counts?.orgAdmins],
            ].map(([label, value]) => (
              <Card key={label}><p className="text-[11px] uppercase text-normal-text mb-2">{label}</p><StatValue value={value ?? 0} /></Card>
            ))}
          </section>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-6">
            <Card>
              <h3 className="font-semibold text-main-text mb-3">Accounts</h3>
              {data.accounts?.length ? (
                <Table head={['Slug', 'Display name', 'ID']}>
                  {data.accounts.map((a) => (
                    <tr key={a.id} className="border-t border-slate-100">
                      <td className="py-2 pr-4 font-medium text-main-text">{a.slug}</td>
                      <td className="py-2 pr-4">{a.display_name}</td>
                      <td className="py-2 pr-4 text-xs font-mono text-normal-text">{a.id?.slice(0, 8)}…</td>
                    </tr>
                  ))}
                </Table>
              ) : <Empty text="No accounts in this organization" />}
            </Card>
            <Card>
              <h3 className="font-semibold text-main-text mb-3">Organization administrators</h3>
              {data.admins?.length ? (
                <ul className="space-y-2 text-sm">
                  {data.admins.map((u) => (
                    <li key={u.id} className="flex items-center gap-2">
                      <Badge tone="blue">admin</Badge>
                      <Link to={`/admin/users/${u.id}`} className="text-main-blue hover:underline truncate">{u.email}</Link>
                      <span className="ml-auto text-xs text-normal-text">{u.display_name || '–'}</span>
                    </li>
                  ))}
                </ul>
              ) : <Empty text="No organization administrator" />}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
