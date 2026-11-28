// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { usePlatformAuth } from '../lib/platform-auth.jsx';
import { useI18n } from '../lib/i18n-context.js';
import { EDGE_COPY } from '../lib/edge-i18n.js';
import { buildRecordInput, edgePath, recordValue } from '../lib/edge.js';
import { Badge, Btn, Card, Empty, Err, Field, Input, PageTitle, Skeleton, Table } from '../components/ui.jsx';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR'];
const EMPTY_RECORD = { type: 'A', name: '@', value: '', ttl: '300' };

function errorText(error) {
  return String(error?.body?.message || error?.message || error || '');
}

export default function SynapseDNSPage() {
  const { request } = usePlatformAuth();
  const { lang } = useI18n();
  const t = EDGE_COPY[lang];
  const d = t.dns;
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('zone') || '';
  const [zones, setZones] = useState([]);
  const [zone, setZone] = useState(null);
  const [ready, setReady] = useState(null);
  const [loading, setLoading] = useState(true);
  const [zoneLoading, setZoneLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [showZone, setShowZone] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  const [zoneForm, setZoneForm] = useState({ name: '', nameservers: '' });
  const [recordForm, setRecordForm] = useState(EMPTY_RECORD);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [zoneList, readiness] = await Promise.all([
        request(edgePath('dns', '/v1/zones')),
        request(edgePath('dns', '/ready')),
      ]);
      const nextZones = zoneList?.zones || [];
      setZones(nextZones);
      setReady(readiness);
      if (!selected && nextZones.length) {
        setSearchParams({ zone: nextZones[0].name }, { replace: true });
      } else if (selected && !nextZones.some((item) => item.name === selected)) {
        setSearchParams({}, { replace: true });
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [request, selected, setSearchParams]);

  const loadZone = useCallback(async () => {
    if (!selected) { setZone(null); return; }
    setZoneLoading(true);
    setError(null);
    try {
      const detail = await request(edgePath('dns', `/v1/zones/${encodeURIComponent(selected)}`));
      setZone(detail);
    } catch (err) {
      setZone(null);
      setError(err);
    } finally {
      setZoneLoading(false);
    }
  }, [request, selected]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadZone(); }, [loadZone]);

  const createZone = async (event) => {
    event.preventDefault();
    setBusy('zone');
    setFormError('');
    try {
      const nameservers = zoneForm.nameservers.split(',').map((value) => value.trim()).filter(Boolean);
      const created = await request(edgePath('dns', '/v1/zones'), {
        method: 'POST',
        body: { name: zoneForm.name.trim(), ...(nameservers.length ? { nameservers } : {}) },
      });
      setNotice(d.zoneCreated);
      setShowZone(false);
      setZoneForm({ name: '', nameservers: '' });
      setZones((items) => [...items, { ...created, recordCount: created.records?.length || 2 }]);
      setZone(created);
      setSearchParams({ zone: created.name }, { replace: true });
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const createRecord = async (event) => {
    event.preventDefault();
    if (!selected) return;
    setBusy('record');
    setFormError('');
    try {
      await request(edgePath('dns', `/v1/zones/${encodeURIComponent(selected)}/records`), {
        method: 'POST', body: buildRecordInput(recordForm, selected),
      });
      setNotice(d.recordCreated);
      setShowRecord(false);
      setRecordForm(EMPTY_RECORD);
      await loadZone();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const remove = async (kind, id) => {
    if (!window.confirm(kind === 'zone' ? d.deleteZoneConfirm : d.deleteRecordConfirm)) return;
    setBusy(`${kind}-${id}`);
    setError(null);
    try {
      const suffix = kind === 'zone'
        ? `/v1/zones/${encodeURIComponent(selected)}`
        : `/v1/zones/${encodeURIComponent(selected)}/records/${encodeURIComponent(id)}`;
      await request(edgePath('dns', suffix), { method: 'DELETE' });
      setNotice(d.deleted);
      if (kind === 'zone') {
        setSearchParams({}, { replace: true });
        setZone(null);
        await load();
      } else {
        await loadZone();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  };

  const soa = zone?.records?.find((record) => record.type === 'SOA');
  const nameservers = (zone?.records || []).filter((record) => record.type === 'NS');
  const appRecords = (zone?.records || []).filter((record) => !['SOA', 'NS'].includes(record.type));

  return (
    <div className="space-y-6">
      <PageTitle
        title={d.title}
        sub={d.subtitle}
        right={<>
          <Badge tone="blue">{t.adminOnly}</Badge>
          <Link to="/docs?tab=dns" className="px-3 py-2 text-sm text-main-blue hover:underline">{t.docs}</Link>
          <Btn kind="secondary" onClick={load} loading={loading}>{t.refresh}</Btn>
          <Btn onClick={() => { setShowZone(true); setFormError(''); }}>{d.newZone}</Btn>
        </>}
      />

      {notice && <div className="rounded-2xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      <Err e={error} />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-main-text">{d.zones}</h2>
              <Badge tone={ready?.status === 'ready' ? 'green' : 'amber'}>{ready?.status === 'ready' ? t.healthy : t.degraded}</Badge>
            </div>
            <p className="mt-1 text-xs text-normal-text">UDP/TCP 53 · API 4014 · atomic JSON storage</p>
          </div>
          {selected && <div className="text-xs text-normal-text">{d.serial}: <code className="font-mono text-main-text">{soa?.serial ?? '—'}</code></div>}
        </div>
        {loading ? <Skeleton className="mt-5 h-24 w-full" /> : zones.length ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {zones.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => { setSearchParams({ zone: item.name }); setNotice(''); }}
                className={`rounded-2xl border p-4 text-left transition-all ${selected === item.name ? 'border-main-blue bg-main-blue/5 shadow-sm' : 'border-slate-200 hover:border-main-blue/50 hover:bg-slate-50'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-main-text break-all">{item.name}</span>
                  <Badge tone={selected === item.name ? 'blue' : 'gray'}>{item.recordCount ?? '—'}</Badge>
                </div>
                <div className="mt-2 text-xs text-normal-text">SOA · NS · A · AAAA · CNAME · MX · TXT · SRV · CAA · PTR</div>
              </button>
            ))}
          </div>
        ) : <Empty title={d.noZones} sub={d.noZonesText} />}
      </Card>

      {showZone && (
        <Card>
          <h2 className="mb-4 font-semibold text-main-text">{d.newZone}</h2>
          <form onSubmit={createZone} className="grid gap-4 md:grid-cols-2">
            <Field label={d.zoneName}><Input autoFocus required value={zoneForm.name} onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })} placeholder={d.zonePlaceholder} /></Field>
            <Field label={d.nameservers} desc={d.nameserversHint}><Input value={zoneForm.nameservers} onChange={(e) => setZoneForm({ ...zoneForm, nameservers: e.target.value })} placeholder="ns1.example.com, ns2.example.com" /></Field>
            {formError && <div className="md:col-span-2"><Err e={new Error(formError)} /></div>}
            <div className="flex gap-2 md:col-span-2">
              <Btn type="submit" loading={busy === 'zone'}>{d.createZone}</Btn>
              <Btn kind="secondary" onClick={() => setShowZone(false)}>{t.cancel}</Btn>
            </div>
          </form>
        </Card>
      )}

      {selected && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="font-semibold text-main-text break-all">{selected}</h2>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-normal-text">
                {nameservers.map((record) => <code key={record.id} className="rounded-lg bg-slate-100 px-2 py-1">{record.target}</code>)}
              </div>
            </div>
            <div className="flex gap-2">
              <Btn kind="secondary" onClick={() => { setShowRecord(true); setFormError(''); }}>{d.addRecord}</Btn>
              <Btn kind="danger" loading={busy === `zone-${selected}`} onClick={() => remove('zone', selected)}>{t.delete}</Btn>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">{d.delegationTitle}</p>
            <p className="mt-1 text-xs leading-5">{d.delegationText}</p>
          </div>

          {showRecord && (
            <form onSubmit={createRecord} className="mt-5 rounded-2xl bg-slate-50 p-4">
              <div className="grid gap-4 md:grid-cols-4">
                <Field label={d.recordType}>
                  <select value={recordForm.type} onChange={(e) => setRecordForm({ ...recordForm, type: e.target.value, value: '' })} className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm">
                    {RECORD_TYPES.map((type) => <option key={type}>{type}</option>)}
                  </select>
                </Field>
                <Field label={d.recordName} desc={d.recordNameHint}><Input required value={recordForm.name} onChange={(e) => setRecordForm({ ...recordForm, name: e.target.value })} /></Field>
                <Field label={d.recordValue} desc={d.valueHints[recordForm.type]}>
                  {recordForm.type === 'TXT'
                    ? <textarea required rows={3} value={recordForm.value} onChange={(e) => setRecordForm({ ...recordForm, value: e.target.value })} className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                    : <Input required value={recordForm.value} onChange={(e) => setRecordForm({ ...recordForm, value: e.target.value })} />}
                </Field>
                <Field label={d.ttl}><Input required type="number" min={1} max={86400} value={recordForm.ttl} onChange={(e) => setRecordForm({ ...recordForm, ttl: e.target.value })} /></Field>
              </div>
              {formError && <div className="mt-3"><Err e={new Error(formError)} /></div>}
              <div className="mt-4 flex gap-2">
                <Btn type="submit" loading={busy === 'record'}>{d.addRecord}</Btn>
                <Btn kind="secondary" onClick={() => setShowRecord(false)}>{t.cancel}</Btn>
              </div>
            </form>
          )}

          <div className="mt-6">
            {zoneLoading ? <Skeleton className="h-40 w-full" /> : appRecords.length ? (
              <Table head={[d.recordType, d.recordName, d.recordValue, d.ttl, t.actions]}>
                {appRecords.map((record) => (
                  <tr key={record.id} className="border-t border-slate-100">
                    <td className="py-3 pr-4"><Badge tone="blue">{record.type}</Badge></td>
                    <td className="py-3 pr-4 font-mono text-xs break-all">{record.name}</td>
                    <td className="py-3 pr-4 font-mono text-xs break-all max-w-sm">{recordValue(record)}</td>
                    <td className="py-3 pr-4 text-xs text-normal-text">{record.ttl}</td>
                    <td className="py-3"><Btn kind="secondary" loading={busy === `record-${record.id}`} onClick={() => remove('record', record.id)}>{t.delete}</Btn></td>
                  </tr>
                ))}
              </Table>
            ) : <Empty text={d.noRecords} />}
          </div>
        </Card>
      )}
    </div>
  );
}
