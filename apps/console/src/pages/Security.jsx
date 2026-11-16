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
import { Badge, Btn, Card, Err, Field, Input, PageTitle, Skeleton } from '../components/ui.jsx';

function RecoveryCodes({ codes, onDone }) {
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
      <p className="text-sm font-medium text-main-text">Recovery codes, shown only once</p>
      <p className="text-xs text-normal-text mt-1">
        Each code signs you in once if you lose your phone. Store them somewhere safe.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-main-text">
        {codes.map((c) => <li key={c} className="rounded-xl bg-white px-3 py-1.5">{c}</li>)}
      </ul>
      <div className="mt-3 flex gap-2">
        <Btn kind="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy codes'}</Btn>
        <Btn onClick={onDone}>I saved them</Btn>
      </div>
    </div>
  );
}

export default function Security() {
  const { auth, headers } = useAuth();
  const [status, setStatus] = useState(null);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

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
    if (isUser) load();
  }, [headers]);

  const run = async (name, fn) => {
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

  if (!isUser) {
    return (
      <>
        <PageTitle title="Security" sub="Multi-factor authentication" />
        <Card>
          <p className="text-sm text-normal-text">
            MFA belongs to a user account. You are signed in with an API key, sign in as a user to manage MFA.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageTitle title="Security" sub="Protect your sign-in with an authenticator app (TOTP)" />
      <Err e={err} />
      <Card>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-main-text">Two-factor authentication</h3>
          {status ? (
            <Badge tone={status.enabled ? 'green' : 'gray'}>{status.enabled ? 'On' : 'Off'}</Badge>
          ) : (
            <Skeleton className="h-6 w-12 rounded-full" />
          )}
        </div>

        {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

        {status && !status.enabled && !setup && (
          <div className="mt-3">
            <p className="text-sm text-normal-text">
              After your password, sign-in will ask for a 6-digit code from Google Authenticator,
              Microsoft Authenticator, 2FAS or any TOTP app.
            </p>
            <Btn className="mt-4" onClick={start} loading={busy === 'setup'}>Set up authenticator</Btn>
          </div>
        )}

        {setup && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-normal-text">
              1. In your authenticator app, add an account with this key (or open the link on your phone).
            </p>
            <div className="rounded-2xl bg-background p-3 font-mono text-sm break-all text-main-text">{setup.secret}</div>
            <a href={setup.otpauthUrl} className="text-sm text-main-blue break-all">{setup.otpauthUrl}</a>
            <p className="text-sm text-normal-text">2. Enter the 6-digit code the app shows.</p>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="sm:w-48">
                <Field label="Code">
                  <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
                </Field>
              </div>
              <Btn className="mb-4" onClick={enable} loading={busy === 'enable'} disabled={!/^\d{6}$/.test(code.trim())}>Turn on</Btn>
              <Btn className="mb-4" kind="secondary" onClick={() => setSetup(null)}>Cancel</Btn>
            </div>
          </div>
        )}

        {status?.enabled && (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-normal-text">
              Enabled {status.enabledAt ? `on ${new Date(status.enabledAt).toLocaleDateString()}` : ''} ·{' '}
              {status.recoveryCodesRemaining} recovery codes left
            </p>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="sm:w-56">
                <Field label="Authenticator or recovery code">
                  <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456" />
                </Field>
              </div>
              <Btn className="mb-4" kind="secondary" onClick={regenerate} loading={busy === 'regen'} disabled={!/^\d{6}$/.test(code.trim())}>
                New recovery codes
              </Btn>
              <Btn className="mb-4" kind="danger" onClick={disable} loading={busy === 'disable'} disabled={!code.trim()}>
                Turn off
              </Btn>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
