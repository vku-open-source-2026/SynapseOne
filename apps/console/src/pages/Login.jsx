// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { Btn, Err, Field, Input } from '../components/ui.jsx';
import SiteToggles from '../components/SiteToggles.jsx';
import { useI18n } from '../lib/i18n-context.js';

export default function Login() {
  const [email, setEmail] = useState('demo@acme.local');
  const [org, setOrg] = useState('acme');
  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState('email');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(null); // { token } after 401 mfa_required
  const [mfaCode, setMfaCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const { auth, login, loginWithKey, completeMfa } = useAuth();
  const nav = useNavigate();
  const { m } = useI18n();
  const t = m.login;

  if (auth) return <Navigate to="/dashboard" replace />;

  const submitSso = async () => {
    setErr(null);
    setBusy(true);
    try {
      const start = await api.oidcStart(org || 'acme');
      if (!start || typeof start.authorizeUrl !== 'string' || !start.authorizeUrl) {
        throw new Error(t.ssoMissing);
      }
      window.location.href = start.authorizeUrl;
    } catch (ex) {
      setErr(ex);
      setBusy(false);
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'email') await login(email, org || 'acme');
      else {
        if (!apiKey) throw new Error(t.enterKey);
        loginWithKey(apiKey);
      }
      nav('/dashboard', { replace: true });
    } catch (ex) {
      if (ex?.status === 401 && ex.body?.error === 'mfa_required' && ex.body.mfaToken) {
        setMfa({ token: ex.body.mfaToken });
        setMfaCode('');
      } else {
        setErr(ex);
      }
    } finally {
      setBusy(false);
    }
  };
  const submitMfa = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const code = mfaCode.trim();
      await completeMfa(mfa.token, useRecovery ? undefined : code, useRecovery ? code : undefined);
      nav('/dashboard', { replace: true });
    } catch (ex) {
      if (ex?.body?.error === 'invalid_mfa_token') setMfa(null);
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <SiteToggles className="fixed top-3 right-3 sm:top-4 sm:right-4" />
      <div className="bg-white rounded-3xl shadow-md p-8 w-full max-w-md">
        <h1 className="text-3xl font-semibold text-center bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">
          {t.title}
        </h1>
        <p className="text-center text-normal-text text-sm mt-2 mb-6">
          {t.sub} <span className="text-main-blue">{baseUrl()}</span>
        </p>
        <div className="flex gap-2 mb-5">
          {['email', 'apikey'].map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={`flex-1 whitespace-nowrap py-2 rounded-2xl text-sm font-medium ${
                mode === id ? 'bg-gradient-to-b from-main-start to-main-end text-white' : 'bg-background text-normal-text'
              }`}
            >
              {id === 'email' ? t.modeEmail : t.modeKey}
            </button>
          ))}
        </div>
        <Err e={err} />
        {mfa ? (
          <form onSubmit={submitMfa}>
            <Field label={useRecovery ? t.recoveryCode : t.mfaCode}>
              <Input
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder={useRecovery ? 'xxxx-xxxx' : '123456'}
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoFocus
              />
            </Field>
            <Btn type="submit" loading={busy} className="w-full">
              <span className="block w-full text-center">{t.verify}</span>
            </Btn>
            <div className="flex justify-between mt-3 text-xs">
              <button type="button" className="text-main-blue" onClick={() => { setUseRecovery(!useRecovery); setMfaCode(''); }}>
                {useRecovery ? t.useAuthenticator : t.useRecovery}
              </button>
              <button type="button" className="text-normal-text" onClick={() => { setMfa(null); setErr(null); }}>
                {t.back}
              </button>
            </div>
          </form>
        ) : (
        <form onSubmit={submit}>
          {mode === 'email' ? (
            <>
              <Field label={t.email}>
                <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="demo@acme.local" />
              </Field>
              <Field label={t.org}>
                <Input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="acme" />
              </Field>
            </>
          ) : (
            <Field label={t.apiKey}>
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="synapseone_..."
              />
            </Field>
          )}
          <Btn type="submit" loading={busy} className="w-full">
            <span className="block w-full text-center">{t.submit}</span>
          </Btn>
        </form>
        )}
        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs text-normal-text">{t.or}</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>
        <button
          type="button"
          onClick={submitSso}
          disabled={busy}
          className="w-full py-2.5 rounded-2xl text-sm font-medium bg-background text-main-text disabled:opacity-60 disabled:cursor-wait inline-flex items-center justify-center gap-2"
        >
          {busy && <span className="sdx-spinner h-4 w-4 border-2" />}
          {busy ? t.redirecting : t.sso}
        </button>
        <p className="text-xs text-normal-text mt-4 text-center">
          {t.note}
          <br />
          <Link to="/about" className="text-main-blue">{t.about}</Link>
          {' · '}
          <Link to="/api-docs" className="text-main-blue">{m.nav.apiDocs}</Link>
        </p>
      </div>
    </div>
  );
}
