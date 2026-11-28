// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Account security: TOTP multi-factor authentication for the signed-in user.
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { mfaEnabled } from '../lib/site.js';
import { mfaStatusAvailable } from '../lib/mfa.js';
import { useI18n } from '../lib/i18n-context.js';
import { Badge, Btn, Card, Err, Field, Input, PageTitle, Skeleton } from '../components/ui.jsx';

function RecoveryCodes({ codes, onDone }) {
  const { m } = useI18n();
  const t = m.security;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      /* clipboard blocked: codes stay visible */
    }
  };
  return (
    <div className="mt-4 rounded-2xl border border-amber-400/40 bg-amber-50 p-4">
      <p className="text-sm font-medium text-main-text">{t.recoveryTitle}</p>
      <p className="text-xs text-normal-text mt-1">{t.recoveryLead}</p>
      <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-main-text">
        {codes.map((c) => <li key={c} className="rounded-xl bg-white px-3 py-1.5">{c}</li>)}
      </ul>
      <div className="mt-3 flex gap-2">
        <Btn kind="secondary" onClick={copy}>{copied ? t.copied : t.copyCodes}</Btn>
        <Btn onClick={onDone}>{t.savedCodes}</Btn>
      </div>
    </div>
  );
}

export default function Security() {
  const { auth, headers } = useAuth();
  const { m } = useI18n();
  const t = m.security;
  const mfa = mfaEnabled();
  const [status, setStatus] = useState(null);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const available = mfaStatusAvailable(status);

  const isUser = !!auth?.token;

  const load = async () => {
    setErr(null);
    try {
      setStatus(await api.mfaStatus(headers));
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    if (isUser && mfa) load();
  }, [headers, isUser, mfa]);

  const run = async (name, fn) => {
    if (!mfa || !available) return;
    setErr(null);
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const start = () => run('setup', async () => {
    setSetup(await api.mfaSetup(headers));
    setCode('');
  });
  const enable = () => run('enable', async () => {
    const r = await api.mfaEnable(code.trim(), headers);
    setCodes(r.recoveryCodes);
    setSetup(null);
    setCode('');
    await load();
  });
  const regenerate = () => run('regen', async () => {
    const r = await api.mfaRecoveryCodes(code.trim(), headers);
    setCodes(r.recoveryCodes);
    setCode('');
    await load();
  });
  const disable = () => run('disable', async () => {
    const v = code.trim();
    await api.mfaDisable(/^\d{6}$/.test(v) ? { code: v } : { recoveryCode: v }, headers);
    setCode('');
    await load();
  });

  if (!mfa) {
    return (
      <>
        <PageTitle title={t.title} sub={t.disabledSubtitle} />
        <Card>
          <p role="status" className="text-sm text-normal-text">{t.disabledMessage}</p>
        </Card>
      </>
    );
  }

  if (!isUser) {
    return (
      <>
        <PageTitle title={t.title} sub={t.subtitle} />
        <Card>
          <p className="text-sm text-normal-text">{t.apiKeyMessage}</p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageTitle title={t.title} sub={t.subtitle} />
      <Err e={err} />
      <Card>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-main-text">{t.heading}</h3>
          {status ? (
            <Badge tone={!available ? 'gray' : status.enabled ? 'green' : 'gray'}>
              {!available ? t.statusUnavailable : status.enabled ? t.statusOn : t.statusOff}
            </Badge>
          ) : (
            <Skeleton className="h-6 w-12 rounded-full" />
          )}
        </div>

        {!available && <p className="mt-3 text-sm text-normal-text">{t.unavailableMessage}</p>}
        {available && codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

        {available && status && !status.enabled && !setup && (
          <div className="mt-3">
            <p className="text-sm text-normal-text">{t.enrollmentLead}</p>
            <Btn className="mt-4" onClick={start} loading={busy === 'setup'}>{t.setup}</Btn>
          </div>
        )}

        {available && setup && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-normal-text">{t.setupStepOne}</p>
            <div className="rounded-2xl bg-background p-3 font-mono text-sm break-all text-main-text">{setup.secret}</div>
            <a href={setup.otpauthUrl} className="text-sm text-main-blue break-all">{setup.otpauthUrl}</a>
            <p className="text-sm text-normal-text">{t.setupStepTwo}</p>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="sm:w-48">
                <Field label={t.codeLabel}>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
                </Field>
              </div>
              <Btn className="mb-4" onClick={enable} loading={busy === 'enable'} disabled={!/^\d{6}$/.test(code.trim())}>{t.turnOn}</Btn>
              <Btn className="mb-4" kind="secondary" onClick={() => setSetup(null)}>{t.cancel}</Btn>
            </div>
          </div>
        )}

        {available && status?.enabled && (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-normal-text">
              {t.enabledPrefix}{status.enabledAt ? ` ${t.onDate} ${new Date(status.enabledAt).toLocaleDateString()}` : ''} ·{' '}
              {status.recoveryCodesRemaining} {t.recoveryCodesLeft}
            </p>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="sm:w-56">
                <Field label={t.authenticatorOrRecoveryCode}>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456" />
                </Field>
              </div>
              <Btn className="mb-4" kind="secondary" onClick={regenerate} loading={busy === 'regen'} disabled={!/^\d{6}$/.test(code.trim())}>
                {t.newRecoveryCodes}
              </Btn>
              <Btn className="mb-4" kind="danger" onClick={disable} loading={busy === 'disable'} disabled={!code.trim()}>
                {t.turnOff}
              </Btn>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
