// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Dedicated platform-administrator session. The normal tenant session proves
 * identity; a fresh TOTP code is exchanged for a short-lived platform token
 * held in sessionStorage (not localStorage) and only used on /v1/platform/*.
 *
 * Step-up proofs are one-time, session-bound and action-bound. They are never
 * cached or auto-attached: the action dialog passes the proof explicitly to the
 * one request it authorizes.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, baseUrl, authStore } from './api.js';
import { useAuth } from './auth.jsx';

const KEY = 'synapseone.admin.session';
const SESSION_INVALID = new Set([
  'invalid_token',
  'unauthorized',
  'platform_session_required',
  'platform_admin_required',
  'platform_admin_inactive',
  'platform_admin_org_required',
]);

export class PlatformError extends Error {
  constructor(status, path, body) {
    super(`platform ${status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.path = path;
    this.body = body;
    this.code = body && typeof body === 'object' ? body.error : undefined;
  }
}

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

  const request = useCallback(async (path, { method = 'GET', body, platformToken, stepUpToken } = {}) => {
    const token = platformToken || session?.token;
    if (!token) throw new PlatformError(401, path, { error: 'platform_session_required' });
    if (session?.expiresAt && session.expiresAt <= Date.now()) {
      clear();
      throw new PlatformError(401, path, { error: 'platform_session_expired' });
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    if (stepUpToken) headers['x-platform-step-up'] = stepUpToken;
    let res;
    try {
      res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`platform network ${path}: ${e.message || e}`);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const code = json && typeof json === 'object' ? json.error : undefined;
    if (res.status === 401 && SESSION_INVALID.has(code)) {
      clear();
      setExchangeError(new PlatformError(res.status, path, json));
      throw new PlatformError(res.status, path, json);
    }
    if (res.status === 403 && SESSION_INVALID.has(code)) {
      clear();
      setExchangeError(new PlatformError(res.status, path, json));
      throw new PlatformError(res.status, path, json);
    }
    if (!res.ok) throw new PlatformError(res.status, path, json);
    return json;
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
