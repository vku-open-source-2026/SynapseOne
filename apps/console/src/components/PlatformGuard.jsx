// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';
import { mfaEnabled } from '../lib/site.js';
import { platformMfaFormRequired } from '../lib/mfa.js';
import { useI18n } from '../lib/i18n-context.js';
import { Badge, Btn, Card, Err, Field, Input, PageTitle } from './ui.jsx';

export default function PlatformGuard({ children }) {
  const { auth, logout } = useAuth();
  const platform = usePlatformAuth();
  const { m } = useI18n();
  const t = m.platform;
  const mfa = mfaEnabled();
  const loc = useLocation();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [localErr, setLocalErr] = useState(null);
  const attemptedAutoExchange = useRef(false);

  // A platform administrator who just completed sign-in already has the
  // authentication this deployment requires. Try the exchange without a code
  // first; a server MFA challenge overrides the runtime feature hint.
  useEffect(() => {
    if (!auth || platform.session || attemptedAutoExchange.current) return;
    const contexts = Array.isArray(auth.contexts) ? auth.contexts : [];
    const platformContext = contexts.find((context) => context.type === 'platform');
    if (!platformContext || auth.currentContext?.type !== 'platform') return;
    attemptedAutoExchange.current = true;
    platform.exchange('').catch(() => undefined);
  }, [auth, platform]);

  if (!auth) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;

  if (platform.session) return children;

  if (platform.busy && !platform.exchangeError) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-24">
        <PageTitle title={t.title} sub={t.openingSub} />
        <Card>
          <p className="text-sm text-normal-text">{mfa ? t.verifyingMfa : t.verifyingSession}</p>
        </Card>
      </div>
    );
  }

  const contextsLoaded = Array.isArray(auth.contexts) && auth.contexts.length > 0;
  const platformCtx = (auth.contexts || []).find((c) => c.type === 'platform');
  const hasPlatformContext = !!platformCtx;
  if (contextsLoaded && hasPlatformContext && auth.currentContext?.type !== 'platform') {
    return (
      <div className="mx-auto max-w-xl px-4 pt-24">
        <PageTitle title={t.contextTitle} sub={t.contextSub} />
        <Card>
          <p className="text-sm text-normal-text">
            {t.tenantContextBefore}{' '}
            <code className="font-mono">{platformCtx.slug}</code>{' '}
            {mfa ? t.tenantContextMfa : t.tenantContextNoMfa}{' '}
            {t.signInPrompt}
          </p>
          <Btn className="mt-4" onClick={() => {
            try { sessionStorage.setItem('synapseone.login.prefillOrg', platformCtx.slug); } catch { /* storage blocked */ }
            logout();
            nav('/login', { replace: true, state: { prefillOrg: platformCtx.slug, platformContext: true } });
          }}>
            {t.signInPlatform}
          </Btn>
          <Link to="/dashboard" className="block mt-3 text-sm text-main-blue">{t.returnTenant}</Link>
        </Card>
      </div>
    );
  }
  if (contextsLoaded && !hasPlatformContext) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-24">
        <PageTitle title={t.contextTitle} sub={t.adminRequiredSub} />
        <Card>
          <p className="text-sm text-normal-text">{t.notAdmin}</p>
          <Link to="/dashboard"><Btn className="mt-4">{t.returnTenant}</Btn></Link>
        </Card>
      </div>
    );
  }

  if (auth.apiKey) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-24">
        <PageTitle title={t.contextTitle} sub={t.humanSub} />
        <Card>
          <p className="text-sm text-normal-text">{mfa ? t.apiKeyWithMfa : t.apiKeyNoMfa}</p>
          <Btn className="mt-4" onClick={() => { logout(); nav('/login', { replace: true }); }}>
            {t.signOutUser}
          </Btn>
        </Card>
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setLocalErr(null);
    try {
      await platform.exchange(code.trim());
    } catch (err) {
      setLocalErr(err);
    }
  };

  const retryExchange = () => {
    setLocalErr(null);
    platform.exchange('').catch((err) => setLocalErr(err));
  };

  const error = localErr || platform.exchangeError;
  const errCode = error?.code;
  const errorMessage = String(error?.body?.message || '');
  const showMfaForm = platformMfaFormRequired(mfa, error);
  const mfaNotEnabled = mfa && errCode === 'platform_mfa_required' && /enable TOTP/i.test(errorMessage);
  const knownState = ['platform_admin_required', 'platform_admin_inactive', 'platform_admin_org_required', 'not_found'].includes(errCode)
    || (mfa && errCode === 'platform_mfa_required');

  return (
    <div className="mx-auto max-w-xl px-4 pt-24">
      <PageTitle title={t.title} sub={showMfaForm ? t.stepUpSub : t.exchangeSub} />
      <Card>
        {showMfaForm && (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-main-text font-medium">{t.enterCode}</p>
              <p className="text-xs text-normal-text mt-1">{t.isolatedSession}</p>
            </div>
            <Badge tone="amber">{t.mfaBadge}</Badge>
          </div>
        )}
        {error && !knownState && <div className="mt-4"><Err e={error} /></div>}
        {mfaNotEnabled && (
          <p className="mt-3 text-sm text-amber-600">
            {t.enrollMfa} <Link to="/security" className="underline">{t.openSecurity}</Link>.
          </p>
        )}
        {errCode === 'not_found' ? (
          <p className="mt-3 text-sm text-amber-600">{t.deploymentDisabled}</p>
        ) : errCode === 'platform_admin_org_required' ? (
          <p className="mt-3 text-sm text-red-600">{t.reservedOrg}</p>
        ) : errCode === 'platform_admin_required' || errCode === 'platform_admin_inactive' ? (
          <p className="mt-3 text-sm text-red-600">{t.notActiveAdmin}</p>
        ) : showMfaForm ? (
          <form onSubmit={submit} className="mt-4 flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="sm:w-52">
              <Field label={t.codeLabel}>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="text"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  autoFocus
                />
              </Field>
            </div>
            <Btn type="submit" loading={platform.busy} className="mb-3" disabled={!code.trim()}>{t.continue}</Btn>
          </form>
        ) : !knownState && (
          <div className="mt-4">
            {!error && <p className="text-sm text-normal-text">{t.exchangeReady}</p>}
            <Btn onClick={retryExchange} loading={platform.busy}>{t.retry}</Btn>
          </div>
        )}
        <p className="mt-4 text-xs text-normal-text">
          {t.notAdminQuestion} <Link to="/dashboard" className="text-main-blue">{t.returnTenant}</Link>.
        </p>
      </Card>
    </div>
  );
}
