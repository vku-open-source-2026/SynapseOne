// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';
import { Badge, Btn, Card, Err, Field, Input, PageTitle } from './ui.jsx';

export default function PlatformGuard({ children }) {
  const { auth, logout } = useAuth();
  const platform = usePlatformAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [localErr, setLocalErr] = useState(null);
  const attemptedAutoExchange = useRef(false);

  // A platform administrator who just completed password/TOTP login already
  // has a fresh second factor. Try the exchange without a code first; only
  // fall back to the code form when the backend asks for a new factor.
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
        <PageTitle title="Platform Super Admin" sub="Opening your isolated administrator session" />
        <Card>
          <p className="text-sm text-normal-text">Verifying the MFA you just completed at sign-in…</p>
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
        <PageTitle title="Platform administration" sub="Sign in with the platform organization" />
        <Card>
          <p className="text-sm text-normal-text">
            Your current session belongs to a tenant organization. Platform administration is bound to the
            platform organization account and requires its own sign-in plus a fresh MFA code. Sign in to{' '}
            <code className="font-mono">{platformCtx.slug}</code> to continue.
          </p>
          <Btn className="mt-4" onClick={() => {
            try { sessionStorage.setItem('synapseone.login.prefillOrg', platformCtx.slug); } catch { /* storage blocked */ }
            logout();
            nav('/login', { replace: true, state: { prefillOrg: platformCtx.slug, platformContext: true } });
          }}>
            Sign in with the platform organization
          </Btn>
          <Link to="/dashboard" className="block mt-3 text-sm text-main-blue">Return to the tenant console</Link>
        </Card>
      </div>
    );
  }
  if (contextsLoaded && !hasPlatformContext) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-24">
        <PageTitle title="Platform administration" sub="Platform Administrator required" />
        <Card>
          <p className="text-sm text-normal-text">
            This account is not an active Platform Administrator. Use the tenant console for organization resources.
          </p>
          <Link to="/dashboard"><Btn className="mt-4">Return to tenant console</Btn></Link>
        </Card>
      </div>
    );
  }

  if (auth.apiKey) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-24">
        <PageTitle title="Platform administration" sub="A human user session is required" />
        <Card>
          <p className="text-sm text-normal-text">
            API-key sessions cannot open the platform console. Sign in with a password or SSO user, then enrol TOTP MFA.
          </p>
          <Btn className="mt-4" onClick={() => { logout(); nav('/login', { replace: true }); }}>
            Sign out and sign in as a user
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

  const error = localErr || platform.exchangeError;
  const errCode = error?.code;
  const errorMessage = String(error?.body?.message || '');
  const mfaNotEnabled = errCode === 'platform_mfa_required' && /enable TOTP/i.test(errorMessage);
  const knownState = ['platform_admin_required', 'platform_admin_inactive', 'platform_admin_org_required', 'platform_mfa_required', 'not_found'].includes(errCode);

  return (
    <div className="mx-auto max-w-xl px-4 pt-24">
      <PageTitle title="Platform Super Admin" sub="Step-up authentication required" />
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-main-text font-medium">Enter a fresh authenticator code</p>
            <p className="text-xs text-normal-text mt-1">
              The platform console uses a short-lived, isolated administrator session.
            </p>
          </div>
          <Badge tone="amber">MFA</Badge>
        </div>
        {error && !knownState && <div className="mt-4"><Err e={error} /></div>}
        {mfaNotEnabled && (
          <p className="mt-3 text-sm text-amber-600">
            TOTP MFA must be enabled on your account first. <Link to="/security" className="underline">Open Security</Link>.
          </p>
        )}
        {errCode === 'not_found' ? (
          <p className="mt-3 text-sm text-amber-600">Platform administration is disabled on this deployment.</p>
        ) : errCode === 'platform_admin_org_required' ? (
          <p className="mt-3 text-sm text-red-600">This account is not a member of the reserved platform organization.</p>
        ) : errCode === 'platform_admin_required' || errCode === 'platform_admin_inactive' ? (
          <p className="mt-3 text-sm text-red-600">
            This account is not an active platform administrator.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-4 flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="sm:w-52">
              <Field label="Authenticator or recovery code">
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
            <Btn type="submit" loading={platform.busy} className="mb-3" disabled={!code.trim()}>Continue</Btn>
          </form>
        )}
        <p className="mt-4 text-xs text-normal-text">
          Not a platform administrator? <Link to="/dashboard" className="text-main-blue">Return to the tenant console</Link>.
        </p>
      </Card>
    </div>
  );
}
