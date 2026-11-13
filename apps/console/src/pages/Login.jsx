// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { Btn, Err, Field, Input } from '../components/ui.jsx';
import SiteToggles from '../components/SiteToggles.jsx';
import { useI18n } from '../lib/i18n-context.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState('email');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(null); // { token } after 401 mfa_required
  const [mfaCode, setMfaCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [sso, setSso] = useState(null);
  const { auth, login, loginWithKey, completeMfa } = useAuth();
  const nav = useNavigate();
  const { m } = useI18n();
  const t = m.login;

  useEffect(() => {
    let alive = true;
    api.oidcConfig()
      .then((cfg) => { if (alive) setSso(cfg); })
      .catch(() => { if (alive) setSso(null); });
    return () => { alive = false; };
  }, []);

  if (auth) return <Navigate to="/dashboard" replace />;

  const orgSlug = org.trim().toLowerCase();
  const ssoAvailable = sso ? (sso.ssoAvailable ?? sso.issuerPublic) !== false : null;

  const submitSso = async () => {
    setErr(null);
    if (!orgSlug) {
      setErr(new Error(t.orgRequired));
      return;
    }
    setBusy(true);
    try {
      const start = await api.oidcStart(orgSlug);
      if (!start || typeof start.authorizeUrl !== 'string' || !start.authorizeUrl || !start.state) {
        throw new Error(t.ssoMissing);
      }
      // Bind the signed state to this browser tab; the callback refuses a
      // state that was not issued by this tab (login CSRF protection).
      try { sessionStorage.setItem('synapseone.oidc.state', String(start.state)); } catch { /* storage blocked */ }
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
      if (mode === 'email') {
        if (!orgSlug) throw new Error(t.orgRequired);
        await login(email, orgSlug, password);
      }
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
                <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" required />
              </Field>
              <Field label={t.org}>
                {/* Not `required`: the submit handler explains the missing org in the
                    selected locale instead of the browser's generic tooltip. */}
                <Input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="your-org" autoComplete="organization" />
              </Field>
              <Field label={t.password}>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t.passwordPlaceholder}
                  autoComplete="current-password"
                />
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
          disabled={busy || ssoAvailable === false}
          className="w-full py-2.5 rounded-2xl text-sm font-medium bg-background text-main-text disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          title={ssoAvailable === false ? t.ssoUnavailable : undefined}
        >
          {busy && <span className="sdx-spinner h-4 w-4 border-2" />}
          {busy ? t.redirecting : ssoAvailable === false ? t.ssoUnavailable : t.sso}
        </button>
        {ssoAvailable === false && (
          <p className="text-xs text-amber-600 mt-2">{t.ssoUnavailableHint}</p>
        )}
        <p className="text-xs text-normal-text mt-4 text-center">
          {t.note}
          <br />
          <Link to="/register" className="text-main-blue">Have an activation code? Activate your account</Link>
          {' · '}
          <Link to="/about" className="text-main-blue">{t.about}</Link>
          {' · '}
          <Link to="/api-docs" className="text-main-blue">{m.nav.apiDocs}</Link>
        </p>
      </div>
    </div>
  );
}
