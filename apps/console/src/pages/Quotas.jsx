// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';

const SERVICES = ['ai', 'inference', 'workflow'];
const FIELDS = [
  ['requestsPerMin', 'Requests/min'],
  ['requestsPer5h', 'Requests/5h'],
  ['requestsPerDay', 'Requests/day'],
  ['tokensPerDay', 'Tokens/day'],
  ['executionsPerHour', 'Flow exec/hour'],
  ['concurrentExecutions', 'Concurrent flows'],
];

function applies(service, field) {
  if (field === 'tokensPerDay') return service !== 'workflow';
  if (field === 'executionsPerHour' || field === 'concurrentExecutions') return service === 'workflow';
  return true;
}

function QuotaValue({ quota, field }) {
  if (!applies(quota.service, field)) return <span className="text-normal-text">Not applicable</span>;
  const value = quota[field];
  const overridden = quota.overrides?.[field] === true;
  return (
    <div>
      <p className="tabular-nums">{value == null ? 'Unlimited' : Number(value).toLocaleString()}</p>
      <p className="text-[11px] text-normal-text">{overridden ? 'override' : 'default'}</p>
    </div>
  );
}

export default function Quotas() {
  const { headers, auth } = useAuth();
  const [organization, setOrganization] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      let orgId = auth?.currentContext?.orgId || null;
      let org = null;
      if (orgId) org = await api.org(orgId, headers);
      else {
        const orgs = await api.orgs(headers);
        const list = Array.isArray(orgs) ? orgs : orgs?.items || [];
        org = list[0] || null;
        orgId = org?.id || null;
      }
      if (!orgId || !org) {
        setOrganization(null);
        setData(null);
        return;
      }
      const quotaData = await api.orgQuotas(orgId, headers);
      setOrganization(org);
      setData(quotaData);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [headers, auth?.currentContext?.orgId]);

  return (
    <>
      <PageTitle
        title="Organization Quotas"
        sub={organization ? `${organization.display_name || organization.slug} — effective service limits` : 'Effective service limits for your organization'}
        right={<Btn kind="secondary" onClick={load} loading={loading}>Refresh</Btn>}
      />
      <Err e={err} />
      <Card>
        {loading ? <TableSkeleton rows={3} cols={8} /> : data?.quotas ? (
          <>
            <Table head={['Service', ...FIELDS.map(([, label]) => label), 'Source']}>
              {SERVICES.map((service) => {
                const quota = data.quotas[service];
                if (!quota) return null;
                return (
                  <tr key={service} className="border-t border-slate-100">
                    <td className="py-3 pr-4 font-mono">{service}</td>
                    {FIELDS.map(([field]) => <td key={field} className="py-3 pr-4"><QuotaValue quota={quota} field={field} /></td>)}
                    <td className="py-3 pr-4">{quota.overridden ? <Badge tone="blue">override</Badge> : <Badge tone="green">default</Badge>}</td>
                  </tr>
                );
              })}
            </Table>
            <p className="mt-3 text-xs text-normal-text">
              Request windows are fixed: minute epoch buckets, five-hour epoch buckets and UTC calendar days. “Default” inherits the platform-wide limit; “override” is an organization-specific value. Empty/non-applicable limits are never presented as zero.
            </p>
          </>
        ) : <Empty text="No organization quota data is available for this session." />}
      </Card>
    </>
  );
}
