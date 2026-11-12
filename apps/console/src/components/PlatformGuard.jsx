// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';
import { Badge, Btn, Card, Err, Field, Input, PageTitle } from './ui.jsx';

export default function PlatformGuard({ children }) {
  const { auth } = useAuth();
  const platform = usePlatformAuth();
  const loc = useLocation();
  const [code, setCode] = useState('');
  const [localErr, setLocalErr] = useState(null);

  if (!auth) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;

  if (platform.session) return children;

  if (auth.apiKey) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-24">
        <PageTitle title="Platform administration" sub="A human user session is required" />
        <Card>
          <p className="text-sm text-normal-text">
            API-key sessions cannot open the platform console. Sign in with a password or SSO user, then enrol TOTP MFA.
          </p>
          <Link to="/login" className="mt-4 inline-block text-sm text-main-blue hover:underline">Sign in as a user</Link>
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
  const knownState = ['platform_admin_required', 'platform_admin_inactive', 'platform_mfa_required'].includes(errCode);

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
        {errCode === 'platform_mfa_required' && (
          <p className="mt-3 text-sm text-amber-600">
            TOTP MFA must be enabled on your account first. <Link to="/security" className="underline">Open Security</Link>.
          </p>
        )}
        {errCode === 'platform_admin_required' || errCode === 'platform_admin_inactive' ? (
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
