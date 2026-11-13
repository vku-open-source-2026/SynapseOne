// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';

/** Context switcher is shown only when IAM returned more than one legitimate
 *  context for the signed-in email. Platform context is never minted from a
 *  tenant token: it requires the platform-org login + MFA exchange. */
export default function ContextSwitcher({ className = '' }) {
  const { auth, switchContext, logout } = useAuth();
  const platform = usePlatformAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const contexts = Array.isArray(auth?.contexts) ? auth.contexts : [];
  const current = auth?.currentContext;
  if (contexts.length < 2 || !current) return null;

  const change = async (id) => {
    const target = contexts.find((c) => c.id === id);
    if (!target || target.id === current.id) return;
    setErr('');
    // A platform token is bound to the identity that exchanged it. Any context
    // change ends it synchronously; returning to platform always requires the
    // platform-org login plus a fresh MFA code.
    platform.logout();
    if (target.type === 'platform') {
      logout();
      nav('/login', { replace: true, state: { prefillOrg: target.slug, platformContext: true } });
      return;
    }
    setBusy(true);
    try {
      await switchContext(target.orgId);
      nav('/dashboard', { replace: true });
    } catch (e) {
      setErr(e?.body?.message || e?.message || 'Unable to switch context');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <label className="sr-only" htmlFor="context-switcher">Context</label>
      <select
        id="context-switcher"
        value={current.id}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
        className="max-w-52 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-main-text"
        title={err || 'Switch authorized context'}
      >
        {contexts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.type === 'platform' ? `Platform · ${c.role}` : `${c.name} · ${c.role}`}
          </option>
        ))}
      </select>
      {err && <span className="text-[10px] text-red-600 max-w-40 truncate">{err}</span>}
    </div>
  );
}
