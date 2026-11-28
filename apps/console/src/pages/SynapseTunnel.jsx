// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { useI18n } from '../lib/i18n-context.js';
import { EDGE_COPY } from '../lib/edge-i18n.js';
import { addressRecordConflict, connectorScript, defaultAddressRecord, edgePath, normalizeHostname, zoneForHostname } from '../lib/edge.js';
import { Badge, Btn, Card, Empty, Err, Field, Input, PageTitle, Skeleton } from '../components/ui.jsx';

const EMPTY_FORM = {
  name: '', upstreamUrl: 'http://localhost:3000', hostname: '', pathPrefix: '',
  dnsMode: 'external', zone: '', recordType: 'CNAME', recordTarget: '',
};

function errorText(error) {
  return String(error?.body?.message || error?.message || error || '');
}

function validateUpstream(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid HTTP(S) upstream URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Upstream must be an HTTP(S) URL without credentials, query, or fragment');
  }
  return url.href;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function Step({ number, active, complete, children }) {
  return (
    <div className={`flex items-center gap-2 rounded-2xl px-3 py-2 text-sm ${active ? 'bg-main-blue text-white' : complete ? 'bg-emerald-500/10 text-emerald-700' : 'bg-slate-100 text-normal-text'}`}>
      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${active ? 'bg-white/20' : complete ? 'bg-emerald-500/15' : 'bg-white'}`}>{complete ? '✓' : number}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

export default function SynapseTunnelPage() {
  const { headers } = useAuth();
  const request = useCallback(
    (path, { method = 'GET', body } = {}) => api.call(method, path, body, headers),
    [headers],
  );
  const { lang } = useI18n();
  const t = EDGE_COPY[lang];
  const d = t.tunnel;
  const [connectors, setConnectors] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [zones, setZones] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [wizard, setWizard] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [issued, setIssued] = useState(null);
  const [connectionTest, setConnectionTest] = useState({ status: 'idle', attempts: 0, error: '' });
  const inFlight = useRef(false);
  const connectionGeneration = useRef(0);

  const publicOrigin = config?.publicOrigin
    || (typeof window !== 'undefined' && window.SYNAPSEONE_CONFIG?.TUNNEL_PUBLIC_ORIGIN)
    || import.meta.env?.VITE_SYNAPSETUNNEL_PUBLIC_ORIGIN
    || '';

  const loadStatus = useCallback(async (initial = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (initial) setLoading(true);
    setError(null);
    try {
      const [connectorData, routeData] = await Promise.all([
        request(edgePath('tunnel', '/v1/connectors')),
        request(edgePath('tunnel', '/v1/routes')),
      ]);
      setConnectors(connectorData?.connectors || []);
      setRoutes(routeData?.routes || []);
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = false;
      if (initial) setLoading(false);
    }
  }, [request]);

  const loadInitial = useCallback(async () => {
    await Promise.allSettled([
      loadStatus(true),
      request(edgePath('tunnel', '/v1/config')).then((value) => setConfig(value)).catch((err) => setError(err)),
      request(edgePath('dns', '/v1/zones')).then((value) => setZones(value?.zones || [])).catch(() => undefined),
    ]);
  }, [loadStatus, request]);

  useEffect(() => {
    void loadInitial();
    const timer = setInterval(() => { void loadStatus(); }, 5000);
    return () => {
      clearInterval(timer);
      connectionGeneration.current += 1;
    };
  }, [loadInitial, loadStatus]);

  const matchingZone = useMemo(() => {
    try { return form.hostname ? zoneForHostname(form.hostname, zones) : null; } catch { return null; }
  }, [form.hostname, zones]);

  const openWizard = () => {
    connectionGeneration.current += 1;
    setForm({ ...EMPTY_FORM, zone: matchingZone || '' });
    setIssued(null);
    setConnectionTest({ status: 'idle', attempts: 0, error: '' });
    setFormError('');
    setWizard({ step: 1 });
  };

  const closeWizard = () => {
    connectionGeneration.current += 1;
    setWizard(null);
    setIssued(null);
    setConnectionTest({ status: 'idle', attempts: 0, error: '' });
    setForm(EMPTY_FORM);
    setFormError('');
  };

  const nextStep = () => {
    setFormError('');
    if (wizard.step === 1) {
      try { validateUpstream(form.upstreamUrl); } catch (err) { setFormError(err.message); return; }
      if (!form.name.trim()) { setFormError(t.name + ' is required'); return; }
      const suggestion = defaultAddressRecord(publicOrigin);
      setForm((current) => ({
        ...current,
        zone: matchingZone || current.zone,
        recordType: current.recordTarget ? current.recordType : suggestion.type,
        recordTarget: current.recordTarget || suggestion.target,
      }));
      setWizard({ step: 2 });
      return;
    }
    try { normalizeHostname(form.hostname); } catch (err) { setFormError(err.message); return; }
    if (form.dnsMode === 'managed') {
      if (!form.zone) { setFormError(d.noZone); return; }
      if (!form.recordTarget.trim()) { setFormError(d.recordTarget + ' is required'); return; }
    }
    setWizard({ step: 3 });
  };

  const createTunnel = async () => {
    setBusy('create');
    setFormError('');
    let connectorId = '';
    let routeId = '';
    let zoneDetail = null;
    let dnsRecordAttempted = false;
    const cleanupErrors = [];
    try {
      const hostname = normalizeHostname(form.hostname);
      if (form.dnsMode === 'managed') {
        const selectedZone = matchingZone || form.zone;
        if (!selectedZone || (hostname !== selectedZone.replace(/\.$/, '') && !hostname.endsWith(`.${selectedZone.replace(/\.$/, '')}`))) {
          throw new Error(d.noZone);
        }
        zoneDetail = await request(edgePath('dns', `/v1/zones/${encodeURIComponent(selectedZone)}`));
        const conflict = addressRecordConflict(zoneDetail.records, `${hostname}.`, form.recordType, form.recordTarget);
        if (conflict === 'conflict') throw new Error('An A, AAAA, or CNAME record already exists for this hostname with a different target');
      }

      const created = await request(edgePath('tunnel', '/v1/connectors'), {
        method: 'POST', body: { name: form.name.trim(), upstreamUrl: validateUpstream(form.upstreamUrl) },
      });
      connectorId = created.connector.id;
      const token = created.token;
      if (!token) throw new Error('Connector token was not returned; recreate the tunnel');

      const routeCreated = await request(edgePath('tunnel', '/v1/routes'), {
        method: 'POST',
        body: { name: form.name.trim(), hostname, connectorId, ...(form.pathPrefix.trim() ? { pathPrefix: form.pathPrefix.trim() } : {}) },
      });
      routeId = routeCreated.route.id;

      if (form.dnsMode === 'managed') {
        const conflict = addressRecordConflict(zoneDetail.records, `${hostname}.`, form.recordType, form.recordTarget);
        if (conflict !== 'same') {
          const recordBody = form.recordType === 'CNAME'
            ? { type: 'CNAME', name: `${hostname}.`, target: form.recordTarget.trim(), ttl: 300 }
            : { type: form.recordType, name: `${hostname}.`, address: form.recordTarget.trim(), ttl: 300 };
          dnsRecordAttempted = true;
          await request(edgePath('dns', `/v1/zones/${encodeURIComponent(zoneDetail.name)}/records`), { method: 'POST', body: recordBody });
        }
      }

      setIssued({ token, connectorId, routeId, hostname, publicOrigin });
      setConnectionTest({ status: 'idle', attempts: 0, error: '' });
      setWizard({ step: 3, done: false });
      setNotice(d.created);
      await loadStatus();
    } catch (err) {
      if (routeId) {
        try { await request(edgePath('tunnel', `/v1/routes/${encodeURIComponent(routeId)}`), { method: 'DELETE' }); } catch { cleanupErrors.push('route'); }
      }
      if (connectorId) {
        try { await request(edgePath('tunnel', `/v1/connectors/${encodeURIComponent(connectorId)}`), { method: 'DELETE' }); } catch { cleanupErrors.push('connector'); }
      }
      // The DNS POST may have reached the server even if its response was lost.
      // Remove only the exact record this wizard tried to create; pre-existing
      // records were detected before connector creation and are never deleted.
      if (dnsRecordAttempted && zoneDetail) {
        try {
          const current = await request(edgePath('dns', `/v1/zones/${encodeURIComponent(zoneDetail.name)}`));
          const wantedName = `${normalizeHostname(form.hostname)}.`;
          const wantedValue = String(form.recordTarget || '').replace(/\.$/, '').toLowerCase();
          const orphan = (current.records || []).find((record) => record.type === form.recordType
            && String(record.name).toLowerCase() === wantedName
            && String(record.address ?? record.target ?? '').replace(/\.$/, '').toLowerCase() === wantedValue);
          if (orphan) await request(edgePath('dns', `/v1/zones/${encodeURIComponent(zoneDetail.name)}/records/${encodeURIComponent(orphan.id)}`), { method: 'DELETE' });
        } catch { cleanupErrors.push('dns-record'); }
      }
      setFormError(errorText(err) + (cleanupErrors.length ? ` (cleanup failed: ${cleanupErrors.join(', ')})` : ''));
      await loadStatus();
    } finally {
      setBusy('');
    }
  };

  const toggleConnector = async (connector) => {
    setBusy(`connector-${connector.id}`);
    setError(null);
    try {
      await request(edgePath('tunnel', `/v1/connectors/${encodeURIComponent(connector.id)}`), {
        method: 'PATCH', body: { enabled: !connector.enabled },
      });
      setNotice(d.updated);
      await loadStatus();
    } catch (err) { setError(err); } finally { setBusy(''); }
  };

  const deleteRoute = async (route) => {
    if (!window.confirm(d.deleteRouteConfirm)) return;
    setBusy(`route-${route.id}`);
    setError(null);
    try {
      await request(edgePath('tunnel', `/v1/routes/${encodeURIComponent(route.id)}`), { method: 'DELETE' });
      setNotice(d.routeDeleted);
      await loadStatus();
    } catch (err) { setError(err); } finally { setBusy(''); }
  };

  const deleteConnector = async (connector) => {
    if (!window.confirm(d.deleteConnectorConfirm)) return;
    setBusy(`connector-${connector.id}`);
    setError(null);
    try {
      await request(edgePath('tunnel', `/v1/connectors/${encodeURIComponent(connector.id)}`), { method: 'DELETE' });
      setNotice(d.connectorDeleted);
      await loadStatus();
    } catch (err) { setError(err); } finally { setBusy(''); }
  };

  const copyToken = async () => {
    if (!issued?.token) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setNotice(t.copied);
    } catch {
      setFormError('Clipboard access is unavailable. Select and copy the token manually.');
    }
  };

  const copyCommand = async () => {
    if (!script) return;
    try {
      await navigator.clipboard.writeText(script);
      setNotice(t.copied);
    } catch {
      setFormError(d.clipboardUnavailable);
    }
  };

  const startConnectionTest = async () => {
    if (!issued?.connectorId) return;
    const generation = ++connectionGeneration.current;
    const started = Date.now();
    let attempts = 0;
    let lastError = '';
    setConnectionTest({ status: 'testing', attempts: 0, error: '' });
    while (generation === connectionGeneration.current && Date.now() - started < 60_000) {
      attempts += 1;
      try {
        const payload = await Promise.race([
          request(edgePath('tunnel', `/v1/connectors/${encodeURIComponent(issued.connectorId)}`)),
          delay(8_000).then(() => { throw new Error('Connection status request timed out'); }),
        ]);
        if (generation !== connectionGeneration.current) return;
        if (payload?.connector?.connected) {
          setConnectionTest({
            status: 'success', attempts, error: '', connectedAt: payload.connector.connectedAt || new Date().toISOString(),
          });
          setWizard((current) => current ? { ...current, done: true } : current);
          setNotice(d.connectionSuccess);
          await loadStatus();
          return;
        }
      } catch (err) {
        if (generation !== connectionGeneration.current) return;
        lastError = errorText(err);
        if ([401, 403, 404].includes(Number(err?.status))) {
          setConnectionTest({ status: 'error', attempts, error: lastError });
          return;
        }
      }
      setConnectionTest({ status: 'testing', attempts, error: lastError });
      await delay(1_500);
    }
    if (generation === connectionGeneration.current) {
      setConnectionTest({ status: 'timeout', attempts, error: lastError });
    }
  };

  const stopConnectionTest = () => {
    connectionGeneration.current += 1;
    setConnectionTest((current) => ({ ...current, status: 'idle' }));
  };

  let script = '';
  if (issued) {
    try { script = connectorScript(issued.connectorId, issued.publicOrigin || publicOrigin); } catch { script = ''; }
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title={d.title}
        sub={d.subtitle}
        right={<>
          <Badge tone="blue">{t.organizationScoped}</Badge>
          <Link to="/docs?tab=tunnel" className="px-3 py-2 text-sm text-main-blue hover:underline">{t.docs}</Link>
          <Btn kind="secondary" onClick={() => loadStatus()} loading={loading}>{t.refresh}</Btn>
          <Btn onClick={openWizard}>{d.newTunnel}</Btn>
        </>}
      />

      {notice && <div className="rounded-2xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      <Err e={error} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><div className="text-xs text-normal-text">{d.connectors}</div><div className="mt-2 text-2xl font-semibold text-main-text">{connectors.length}</div><div className="mt-1 text-xs text-emerald-600">{connectors.filter((item) => item.connected).length} {t.connected.toLowerCase()}</div></Card>
        <Card><div className="text-xs text-normal-text">{d.routes}</div><div className="mt-2 text-2xl font-semibold text-main-text">{routes.length}</div><div className="mt-1 text-xs text-normal-text">HTTP / SSE</div></Card>
        <Card><div className="text-xs text-normal-text">{d.endpoint}</div><div className="mt-2 break-all font-mono text-sm text-main-text">{publicOrigin || '—'}</div><div className="mt-1 text-xs text-normal-text">{d.autoRefresh}</div></Card>
      </div>

      {wizard && (
        <Card className="border border-main-blue/20">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-main-text">{issued ? d.tokenTitle : d.createTitle}</h2>
              <p className="mt-1 text-sm text-normal-text">{wizard.step === 1 ? d.stepApplication : wizard.step === 2 ? d.stepAddress : d.stepRun}</p>
            </div>
            <Btn kind="secondary" onClick={closeWizard}>{t.close}</Btn>
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            {d.steps.map((label, index) => <Step key={label} number={index + 1} active={wizard.step === index + 1 && !wizard.done} complete={wizard.done || wizard.step > index + 1}>{label}</Step>)}
          </div>

          {wizard.step === 1 && (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <Field label={t.name}><Input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="city-app" /></Field>
              <Field label={d.upstream} desc={d.upstreamHint}><Input required value={form.upstreamUrl} onChange={(e) => setForm({ ...form, upstreamUrl: e.target.value })} placeholder={d.upstreamPlaceholder} /></Field>
              <div className="md:col-span-2"><Field label={d.pathPrefix} desc={d.pathHint}><Input value={form.pathPrefix} onChange={(e) => setForm({ ...form, pathPrefix: e.target.value })} placeholder="/api" /></Field></div>
            </div>
          )}

          {wizard.step === 2 && (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <Field label={d.hostname}><Input autoFocus required value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} placeholder="app.example.com" /></Field>
              <Field label={d.dnsMode}>
                <select value={form.dnsMode} onChange={(e) => setForm({ ...form, dnsMode: e.target.value })} className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm">
                  <option value="external">{d.externalDns}</option>
                  <option value="managed" disabled={!zones.length}>{d.managedDns}</option>
                </select>
              </Field>
              {form.dnsMode === 'managed' ? <>
                <Field label={d.zone} desc={matchingZone ? null : d.noZone}>
                  <select required value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm">
                    <option value="">{d.selectZone}</option>
                    {zones.map((zone) => <option key={zone.id} value={zone.name}>{zone.name}</option>)}
                  </select>
                </Field>
                <Field label={d.recordType}>
                  <select value={form.recordType} onChange={(e) => setForm({ ...form, recordType: e.target.value, recordTarget: e.target.value === defaultAddressRecord(publicOrigin).type ? defaultAddressRecord(publicOrigin).target : '' })} className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm">
                    <option value="CNAME">CNAME</option><option value="A">A</option><option value="AAAA">AAAA</option>
                  </select>
                </Field>
                <div className="md:col-span-2"><Field label={d.recordTarget} desc={d.recordTargetHint}><Input required value={form.recordTarget} onChange={(e) => setForm({ ...form, recordTarget: e.target.value })} placeholder={form.recordType === 'A' ? '192.0.2.10' : form.recordType === 'AAAA' ? '2001:db8::10' : 'edge.example.net'} /></Field></div>
              </> : <div className="md:col-span-2 rounded-2xl bg-slate-50 p-4 text-sm text-normal-text">{d.externalHint}</div>}
              <div className="md:col-span-2 rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-xs leading-5 text-amber-900">{d.tlsWarning}</div>
            </div>
          )}

          {wizard.step === 3 && !issued && (
            <div className="mt-6 rounded-2xl bg-slate-50 p-5">
              <h3 className="font-medium text-main-text">{form.name}</h3>
              <p className="mt-1 font-mono text-sm text-normal-text">{form.hostname} → {form.upstreamUrl}</p>
              <p className="mt-3 text-xs text-normal-text">{form.dnsMode === 'managed' ? `${form.zone} · ${form.recordType} ${form.recordTarget}` : d.externalHint}</p>
            </div>
          )}

          {wizard.step === 3 && issued && (
            <div className="mt-6 grid gap-5 lg:grid-cols-2">
              <div>
                <div className="rounded-2xl border border-amber-300/70 bg-amber-50 p-4 text-sm text-amber-900">
                  <p className="font-medium">{d.tokenWarning}</p>
                  <p className="mt-1 text-xs">{issued.hostname}</p>
                </div>
                <Field label={d.connectorToken}>
                  <div className="flex gap-2">
                    <Input readOnly value={issued.token} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
                    <Btn kind="secondary" onClick={copyToken}>{t.copy}</Btn>
                  </div>
                </Field>
                <Btn kind="success" onClick={closeWizard}>{connectionTest.status === 'success' ? d.finish : d.savedToken}</Btn>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium text-main-text">{d.runTitle}</h3>
                  {script && <Btn kind="secondary" onClick={copyCommand}>{d.copyCommand}</Btn>}
                </div>
                <p className="mt-1 text-xs text-normal-text">{d.runHint}</p>
                {script ? <pre className="mt-3 overflow-x-auto rounded-2xl bg-slate-900 p-4 text-xs leading-5 text-slate-100"><code>{script}</code></pre> : <div className="mt-3 rounded-2xl bg-red-50 p-4 text-sm text-red-700">{d.publicOriginMissing}</div>}

                <div className={`mt-4 rounded-2xl border p-4 ${
                  connectionTest.status === 'success' ? 'border-emerald-300 bg-emerald-50' :
                    connectionTest.status === 'testing' ? 'border-amber-300 bg-amber-50' :
                      ['timeout', 'error'].includes(connectionTest.status) ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'
                }`} aria-live="polite">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-medium text-main-text">{d.connectionTest}</h4>
                    <Badge tone={connectionTest.status === 'success' ? 'green' : connectionTest.status === 'testing' ? 'amber' : ['timeout', 'error'].includes(connectionTest.status) ? 'red' : 'gray'}>
                      {connectionTest.status === 'success' ? d.connectionSuccess : connectionTest.status === 'testing' ? d.testingConnection : connectionTest.status === 'timeout' ? d.connectionTimeout : connectionTest.status === 'error' ? d.connectionError : t.disconnected}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-normal-text">
                    {connectionTest.status === 'success' ? d.connectionSuccessHint :
                      connectionTest.status === 'testing' ? d.connectionTestingHint :
                        connectionTest.status === 'timeout' ? d.connectionTimeoutHint :
                          connectionTest.status === 'error' ? d.connectionErrorHint : d.connectionIdle}
                  </p>
                  {connectionTest.status === 'testing' && <p className="mt-1 text-[11px] text-normal-text">{d.connectionAttempts}: {connectionTest.attempts}</p>}
                  {connectionTest.error && <p className="mt-2 break-all font-mono text-[11px] text-red-700">{connectionTest.error}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Btn onClick={startConnectionTest} loading={connectionTest.status === 'testing'} disabled={connectionTest.status === 'testing'}>
                      {connectionTest.status === 'testing' ? d.testingConnection : ['success', 'timeout', 'error'].includes(connectionTest.status) ? d.testAgain : d.testConnection}
                    </Btn>
                    {connectionTest.status === 'testing' && <Btn kind="secondary" onClick={stopConnectionTest}>{d.stopTest}</Btn>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {formError && <div className="mt-4"><Err e={new Error(formError)} /></div>}
          {!issued && <div className="mt-6 flex gap-2">
            {wizard.step > 1 && <Btn kind="secondary" onClick={() => { setWizard({ step: wizard.step - 1 }); setFormError(''); }}>{t.back}</Btn>}
            {wizard.step < 3 && <Btn onClick={nextStep}>{t.next}</Btn>}
            {wizard.step === 3 && <Btn onClick={createTunnel} loading={busy === 'create'}>{busy === 'create' ? d.creating : d.create}</Btn>}
            <Btn kind="secondary" onClick={closeWizard}>{t.cancel}</Btn>
          </div>}
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_1.15fr]">
        <Card>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-main-text">{d.connectors}</h2>
            <Badge tone="gray">{connectors.filter((item) => item.connected).length}/{connectors.length} {t.connected}</Badge>
          </div>
          {loading ? <Skeleton className="h-48 w-full" /> : connectors.length ? (
            <div className="space-y-3">
              {connectors.map((connector) => {
                const count = routes.filter((route) => route.connectorId === connector.id).length;
                return (
                  <div key={connector.id} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-medium text-main-text break-all">{connector.name}</h3>
                          <Badge tone={connector.connected ? 'green' : 'gray'}>{connector.connected ? t.connected : t.disconnected}</Badge>
                          {!connector.enabled && <Badge tone="amber">{t.disabled}</Badge>}
                        </div>
                        <p className="mt-1 break-all font-mono text-xs text-normal-text">{connector.upstreamUrl}</p>
                        <p className="mt-2 text-xs text-normal-text">{count} {d.routeCount.toLowerCase()} · <code>{connector.id}</code></p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Btn kind="secondary" loading={busy === `connector-${connector.id}`} onClick={() => toggleConnector(connector)}>{connector.enabled ? d.disable : d.enable}</Btn>
                        <Btn kind="danger" loading={busy === `connector-${connector.id}`} onClick={() => deleteConnector(connector)}>{t.delete}</Btn>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <Empty title={d.noConnectors} sub={d.noConnectorsText} action={<Btn onClick={openWizard}>{d.newTunnel}</Btn>} />}
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-main-text">{d.routes}</h2>
            <Link to="/dns" className="text-sm text-main-blue hover:underline">SynapseDNS</Link>
          </div>
          {loading ? <Skeleton className="h-48 w-full" /> : routes.length ? (
            <div className="space-y-3">
              {routes.map((route) => {
                const connector = connectors.find((item) => item.id === route.connectorId);
                return (
                  <div key={route.id} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-medium text-main-text break-all">{route.hostname}{route.pathPrefix || ''}</h3>
                          <Badge tone={route.enabled ? (connector?.connected ? 'green' : 'amber') : 'gray'}>{route.enabled ? (connector?.connected ? t.connected : t.disconnected) : t.disabled}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-normal-text">{connector?.name || route.connectorId} · {route.timeoutMs || 30000} ms</p>
                      </div>
                      <Btn kind="secondary" loading={busy === `route-${route.id}`} onClick={() => deleteRoute(route)}>{t.delete}</Btn>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <Empty text={d.noRoutes} />}
        </Card>
      </div>
    </div>
  );
}
