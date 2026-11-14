// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';
import { Btn, Field, Input, Modal } from './ui.jsx';

/** Context switcher is shown only when IAM returned more than one legitimate
 *  context for the signed-in email. A target tenant is never minted from the
 *  caller's identity: the user must enter that organization's own password
 *  (and its MFA factor, if enrolled). A platform context always requires the
 *  platform-org login + MFA. */
export default function ContextSwitcher({ className = '' }) {
  const { auth, switchContext, completeMfa, logout } = useAuth();
  const platform = usePlatformAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState(null);
  const contexts = Array.isArray(auth?.contexts) ? auth.contexts : [];
  const current = auth?.currentContext;
  if (contexts.length < 2 || !current) return null;

  const close = () => {
    if (busy) return;
    setPending(null);
    setPassword('');
    setCode('');
    setMfaToken(null);
    setErr(null);
  };

  const change = (id) => {
    const target = contexts.find((c) => c.id === id);
    if (!target || target.id === current.id) return;
    setErr(null);
    // A platform token is bound to the identity that exchanged it. Any context
    // change ends it synchronously.
    platform.logout();
    if (target.type === 'platform') {
      // Platform administration is bound to the platform-org identity. End the
      // tenant session and require that account's own sign-in + MFA.
      try { sessionStorage.setItem('synapseone.login.prefillOrg', target.slug); } catch { /* storage blocked */ }
      logout();
      nav('/login', { replace: true, state: { prefillOrg: target.slug, platformContext: true } });
      return;
    }
    setPending(target);
    setPassword('');
    setCode('');
    setMfaToken(null);
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    if (!pending) return;
    setErr(null);
    setBusy(true);
    try {
      const result = await switchContext(pending.orgId, password);
      if (result?.mfaRequired && result?.mfaToken) {
        setMfaToken(result.mfaToken);
        setCode('');
        return;
      }
      setPending(null);
      nav('/dashboard', { replace: true });
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e) => {
    e.preventDefault();
    if (!mfaToken) return;
    setErr(null);
    setBusy(true);
    try {
      const value = code.trim();
      await completeMfa(mfaToken, value, undefined);
      setPending(null);
      nav('/dashboard', { replace: true });
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const errCode = err?.body?.error || err?.code;
  const errText = err?.body?.message || err?.message || '';

  return (
    <>
      <div className={`flex items-center gap-1.5 ${className}`}>
        <label className="sr-only" htmlFor="context-switcher">Context</label>
        <select
          id="context-switcher"
          value={current.id}
          disabled={busy}
          onChange={(e) => change(e.target.value)}
          className="max-w-52 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-main-text"
          title="Switch authorized context"
        >
          {contexts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.type === 'platform' ? `Platform · ${c.role}` : `${c.name} · ${c.role}`}
            </option>
          ))}
        </select>
      </div>
      <Modal open={!!pending} title={`Switch to ${pending?.name || 'organization'}`} onClose={close}>
        {mfaToken ? (
          <form onSubmit={submitMfa}>
            <p className="text-sm text-normal-text mb-3">
              Enter this organization&apos;s authenticator code or a recovery code. The caller&apos;s MFA is not reused.
            </p>
            <Field label="Authenticator or recovery code">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="text"
                autoComplete="one-time-code"
                autoFocus
                placeholder="123456"
              />
            </Field>
            {errText && <p className="text-xs text-red-600 mb-2" role="alert">{errText}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <Btn kind="secondary" onClick={close} disabled={busy}>Cancel</Btn>
              <Btn type="submit" loading={busy} disabled={!code.trim()}>Verify and switch</Btn>
            </div>
          </form>
        ) : (
          <form onSubmit={submitPassword}>
            <p className="text-sm text-normal-text mb-3">
              Switching organizations re-authenticates the target identity. Enter the password for{' '}
              <code className="font-mono">{pending?.slug}</code>. A matching email alone is not sufficient.
            </p>
            <Field label="Target organization password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
                required
              />
            </Field>
            {errText && <p className="text-xs text-red-600 mb-2" role="alert">{errText}</p>}
            {errCode === 'target_login_required' && (
              <Btn
                kind="secondary"
                className="mb-3"
                onClick={() => {
                  try { if (pending?.slug) sessionStorage.setItem('synapseone.login.prefillOrg', pending.slug); } catch { /* storage blocked */ }
                  logout();
                  nav('/login', { replace: true, state: { prefillOrg: pending?.slug, platformContext: false } });
                }}
              >
                Sign in to this organization instead
              </Btn>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <Btn kind="secondary" onClick={close} disabled={busy}>Cancel</Btn>
              <Btn type="submit" loading={busy} disabled={!password}>Continue</Btn>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
