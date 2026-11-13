// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * OIDC callback page: the IdP redirects here with ?code&state (or ?error).
 * The single-use code is POSTed to the API for exchange, tokens never appear
 * in the URL. The signed state is also checked against this tab's sessionStorage
 * so a login-CSRF state from another browser cannot be completed here.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n-context.js';
import { landingPath } from '../lib/auth-routing.js';
import { Btn, Err, Field, Input, Spinner } from '../components/ui.jsx';

const OIDC_STATE_KEY = 'synapseone.oidc.state';

export default function OidcCallback() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { loginWithOidc, completeMfa } = useAuth();
  const { m } = useI18n();
  const t = m.login;
  const [err, setErr] = useState(null);
  const [mfa, setMfa] = useState(null);
  const [mfaCode, setMfaCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const idpError = params.get('error');
    const code = params.get('code');
    const state = params.get('state');
    let expected = null;
    try { expected = sessionStorage.getItem(OIDC_STATE_KEY); } catch { /* storage blocked */ }
    try { sessionStorage.removeItem(OIDC_STATE_KEY); } catch { /* storage blocked */ }
    if (idpError) {
      setErr(new Error(`Sign-in was not completed (${idpError}${params.get('error_description') ? `: ${params.get('error_description')}` : ''}).`));
      return;
    }
    if (!code || !state) {
      setErr(new Error(t.ssoCodeMissing));
      return;
    }
    if (!expected || expected !== state) {
      setErr(new Error(t.ssoStateMismatch));
      return;
    }
    loginWithOidc(code, state).then(
      (result) => nav(landingPath(result?.currentContext), { replace: true }),
      (ex) => {
        if (ex?.status === 401 && ex.body?.error === 'mfa_required' && ex.body.mfaToken) {
          setMfa({ token: ex.body.mfaToken });
          setMfaCode('');
          return;
        }
        setErr(ex);
      },
    );
  }, [params, loginWithOidc, nav, t]);

  const submitMfa = async (e) => {
    e.preventDefault();
    if (!mfa) return;
    setErr(null);
    setBusy(true);
    try {
      const code = mfaCode.trim();
      const result = await completeMfa(mfa.token, useRecovery ? undefined : code, useRecovery ? code : undefined);
      nav(landingPath(result?.currentContext), { replace: true });
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-md p-8 w-full max-w-md text-center">
        {!err && !mfa && <Spinner size="lg" className="mx-auto mb-4" label={t.ssoSigningIn} />}
        <h1 className="text-2xl font-semibold bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">
          {t.ssoSigningIn}
        </h1>
        <Err e={err} />
        {!err && !mfa && <p className="text-sm text-normal-text mt-3">{t.ssoExchanging}</p>}
        {mfa && (
          <form onSubmit={submitMfa} className="text-left mt-4">
            <p className="text-sm text-normal-text mb-3">{t.ssoMfaHint}</p>
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
            <Btn type="submit" loading={busy} className="w-full" disabled={!mfaCode.trim()}>
              <span className="block w-full text-center">{t.verify}</span>
            </Btn>
            <div className="flex justify-between mt-3 text-xs">
              <button type="button" className="text-main-blue" onClick={() => { setUseRecovery(!useRecovery); setMfaCode(''); }}>
                {useRecovery ? t.useAuthenticator : t.useRecovery}
              </button>
            </div>
          </form>
        )}
        {err && (
          <p className="text-sm mt-4">
            <Link to="/login" className="text-main-blue">{t.ssoBack}</Link>
          </p>
        )}
      </div>
    </div>
  );
}
