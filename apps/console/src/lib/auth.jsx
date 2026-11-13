// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, authStore } from './api.js';

const AuthCtx = createContext(null);
// NOTE(security): session lives in localStorage so a reload keeps you logged in.
// That makes it readable by any JS on this origin — keep the console origin clean
// (strict CSP at the reverse proxy, patched deps) and prefer short JWT TTL +
// refresh rotation. Never put tokens in URLs (they leak via history/logs).
const KEY = 'synapseone.console.auth';
// Pre-rebrand key: keep existing sessions across the upgrade, then migrate.
const LEGACY_KEY = 'synapsedx.console.auth';

function readStoredAuth() {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    return JSON.parse(raw || 'null');
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(readStoredAuth);

  useEffect(() => {
    if (auth) {
      localStorage.setItem(KEY, JSON.stringify(auth));
      localStorage.removeItem(LEGACY_KEY);
    } else {
      localStorage.removeItem(KEY);
      localStorage.removeItem(LEGACY_KEY);
    }
  }, [auth]);

  // Wire the api-level session hook: silent refresh persists the rotated pair,
  // dead refresh drops the session (pages re-render to login).
  useEffect(() => {
    authStore.get = readStoredAuth;
    authStore.set = (patch) => {
      const cur = authStore.get() || {};
      const next = { ...cur, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      setAuth(next);
    };
    authStore.clear = () => setAuth(null);
  }, []);

  const headers = useMemo(
    () => (auth?.token ? { token: auth.token } : auth?.apiKey ? { apiKey: auth.apiKey } : {}),
    [auth],
  );

  const persistSession = useCallback(async (r) => {
    let contexts = [];
    let current = null;
    try {
      const ctx = await api.authContexts({ token: r.accessToken });
      contexts = Array.isArray(ctx?.contexts) ? ctx.contexts : [];
      current = ctx?.current || null;
    } catch { /* older deployment or transient failure */ }
    const next = { token: r.accessToken, refreshToken: r.refreshToken, user: r.user, email: r.user?.email, contexts, currentContext: current };
    setAuth(next);
    return { ...r, contexts, currentContext: current };
  }, []);

  const login = useCallback(async (email, orgSlug, password) => {
    const r = await api.login(email, orgSlug || 'acme', password);
    return persistSession(r);
  }, [persistSession]);

  // SSO: exchange an IdP authorization `code` (+ signed `state`) for platform
  // tokens. The code is single-use and short-lived — safe to POST from the
  // callback page, and never lands in history (unlike tokens in URLs).
  const loginWithOidc = useCallback(async (code, state) => {
    const r = await api.oidcCallback(code, state);
    return persistSession(r);
  }, [persistSession]);

  // Second sign-in step when the account has MFA (login threw 401 mfa_required).
  const completeMfa = useCallback(async (mfaToken, code, recoveryCode) => {
    const r = await api.verifyMfa(mfaToken, code, recoveryCode);
    return persistSession(r);
  }, [persistSession]);

  const loginWithKey = useCallback((apiKey) => setAuth({ apiKey }), []);

  const acceptInvite = useCallback(async (token, password, displayName) => {
    const r = await api.acceptInvite(token, password, displayName);
    return persistSession(r);
  }, [persistSession]);
  // Revalidate context metadata after reload/token rotation. The backend is
  // authoritative; localStorage contexts are only a UI hint.
  useEffect(() => {
    if (!auth?.token) return;
    let alive = true;
    api.authContexts({ token: auth.token })
      .then((ctx) => {
        if (!alive) return;
        const contexts = Array.isArray(ctx?.contexts) ? ctx.contexts : [];
        const current = ctx?.current || null;
        const before = JSON.stringify({ c: auth.contexts || [], u: auth.currentContext || null });
        const after = JSON.stringify({ c: contexts, u: current });
        if (before !== after) setAuth((prev) => prev ? { ...prev, contexts, currentContext: current } : prev);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [auth?.token]);

  const switchContext = useCallback(async (orgId) => {
    if (!auth?.token) throw new Error('Not signed in');
    const r = await api.switchContext(orgId, { token: auth.token });
    return persistSession(r);
  }, [auth?.token, persistSession]);

  // Server-side logout: revoke the refresh token so it can't be reused after
  // the browser session is gone (best-effort — local state clears regardless).
  const logout = useCallback(() => {
    const rt = auth?.refreshToken;
    setAuth(null);
    if (rt) api.logoutServer(rt);
  }, [auth?.refreshToken]);

  return (
    <AuthCtx.Provider value={{ auth, headers, login, loginWithKey, loginWithOidc, completeMfa, acceptInvite, switchContext, logout, setAuth }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
