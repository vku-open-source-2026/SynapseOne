// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Dedicated platform-administrator session. The normal tenant session proves
 * identity; when required, a fresh TOTP code is exchanged for a short-lived
 * platform token held in sessionStorage and only used on /v1/platform/*.
 *
 * Step-up proofs are one-time, session-bound and action-bound. They are never
 * cached or auto-attached: the action dialog passes the proof explicitly to the
 * one request it authorizes.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, authStore } from './api.js';
import {
  fetchPlatform,
  isInvalidPlatformSession,
  mergePlatformSession,
  needsPlatformSessionRevalidation,
  PlatformError,
} from './platform-session.js';
import { useAuth } from './auth.jsx';

export { PlatformError };

const KEY = 'synapseone.admin.session';

function readSession() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v?.token || !v?.expiresAt || v.expiresAt <= Date.now()) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

const PlatformAuthCtx = createContext(null);

export function PlatformAuthProvider({ children }) {
  const { auth, logout: logoutTenant } = useAuth();
  const [session, setSession] = useState(readSession);
  const [exchangeError, setExchangeError] = useState(null);
  const [busy, setBusy] = useState(false);
  const tenantUserId = auth?.user?.id || null;
  const restoredSessionToken = useRef(session?.token || null);
  const revalidatedSessionToken = useRef(null);
  const currentSessionToken = useRef(session?.token || null);
  const mounted = useRef(false);
  currentSessionToken.current = session?.token || null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
    else sessionStorage.removeItem(KEY);
  }, [session]);

  // A platform session belongs to exactly one tenant identity. A logout or a
  // different user in the same tab must never inherit the old platform token.
  useEffect(() => {
    if (!session) return;
    if (!tenantUserId || (session.user?.id && session.user.id !== tenantUserId)) {
      setSession(null);
      setExchangeError(null);
    }
  }, [tenantUserId, session]);

  const clear = useCallback(() => {
    setSession(null);
  }, []);

  // Session flags are cached for fast first paint, but the server is
  // authoritative. Revalidate only the token restored from sessionStorage;
  // updating flags keeps the token/expiry dependencies of request() stable.
  useEffect(() => {
    const token = session?.token;
    if (!tenantUserId || !needsPlatformSessionRevalidation(restoredSessionToken.current, token, revalidatedSessionToken.current)) return;
    revalidatedSessionToken.current = token;
    fetchPlatform(token, '/v1/platform/me').then((profile) => {
      if (!mounted.current) return;
      setSession((current) => current?.token === token ? mergePlatformSession(current, profile) : current);
    }).catch((error) => {
      if (!mounted.current || currentSessionToken.current !== token || !isInvalidPlatformSession(error)) return;
      clear();
      setExchangeError(error);
    });
  }, [session?.token, tenantUserId, clear]);

  const request = useCallback(async (path, { method = 'GET', body, platformToken, stepUpToken } = {}) => {
    const token = platformToken || session?.token;
    if (!token) throw new PlatformError(401, path, { error: 'platform_session_required' });
    if (session?.expiresAt && session.expiresAt <= Date.now()) {
      clear();
      throw new PlatformError(401, path, { error: 'platform_session_expired' });
    }
    try {
      return await fetchPlatform(token, path, { method, body, stepUpToken });
    } catch (error) {
      if (isInvalidPlatformSession(error)) {
        clear();
        setExchangeError(error);
      }
      throw error;
    }
  }, [session?.token, session?.expiresAt, clear]);

  const exchange = useCallback(async (code) => {
    setBusy(true);
    setExchangeError(null);
    try {
      const live = authStore.get()?.token || auth?.token;
      if (!live) {
        logoutTenant();
        throw new PlatformError(401, '/v1/platform/session', { error: 'login_required' });
      }
      const value = String(code || '').trim();
      const body = /^\d{6}$/.test(value)
        ? { code: value }
        : value
          ? { recoveryCode: value }
          : {};
      // Uses the console API client so an expired tenant access token is
      // refreshed (single-flight) before the platform exchange.
      let json;
      try {
        json = await api.call('POST', '/v1/platform/session', body, { token: live });
      } catch (e) {
        throw new PlatformError(e.status || 0, '/v1/platform/session', e.body || e.message);
      }
      const next = {
        token: json.accessToken,
        expiresAt: Date.now() + Number(json.expiresIn || 900) * 1000,
        role: json.role,
        user: json.user,
        mfa: json.mfa ?? null,
        mfaRequired: json.mfaRequired !== false,
        stepUpRequired: json.stepUpRequired !== false,
      };
      setSession(next);
      return next;
    } catch (e) {
      setExchangeError(e);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [auth?.token, logoutTenant]);

  const stepUp = useCallback(async (code, action) => {
    setBusy(true);
    try {
      const value = String(code || '').trim();
      const body = {
        action,
        ...(/^\d{6}$/.test(value) ? { code: value } : { recoveryCode: value }),
      };
      const r = await request('/v1/platform/step-up', { method: 'POST', body });
      return {
        token: r.stepUpToken,
        expiresAt: Date.now() + Number(r.expiresIn || 300) * 1000,
        action: r.action || action,
      };
    } finally {
      setBusy(false);
    }
  }, [request]);

  const logout = useCallback(() => {
    clear();
    setExchangeError(null);
  }, [clear]);

  const value = useMemo(() => ({
    session,
    role: session?.role || null,
    user: session?.user || null,
    mfa: session?.mfa ?? null,
    mfaRequired: session?.mfaRequired !== false,
    stepUpRequired: session?.stepUpRequired !== false,
    exchangeError,
    busy,
    request,
    exchange,
    stepUp,
    logout,
    clear,
  }), [session, exchangeError, busy, request, exchange, stepUp, logout, clear]);

  return <PlatformAuthCtx.Provider value={value}>{children}</PlatformAuthCtx.Provider>;
}

export function usePlatformAuth() {
  const v = useContext(PlatformAuthCtx);
  if (!v) throw new Error('usePlatformAuth must be used inside PlatformAuthProvider');
  return v;
}
