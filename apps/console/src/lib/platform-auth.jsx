// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Dedicated platform-administrator session. The normal tenant session proves
 * identity; a fresh TOTP code is exchanged for a short-lived platform token
 * held in sessionStorage (not localStorage) and only used on /v1/platform/*.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { baseUrl, authStore } from './api.js';
import { useAuth } from './auth.jsx';

const KEY = 'synapseone.admin.session';
const STEP_KEY = 'synapseone.admin.stepup';

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

function readStep() {
  try {
    const raw = sessionStorage.getItem(STEP_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v?.token || !v?.expiresAt || v.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STEP_KEY);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

const PlatformAuthCtx = createContext(null);

export function PlatformAuthProvider({ children }) {
  const { auth } = useAuth();
  const [session, setSession] = useState(readSession);
  const [step, setStep] = useState(readStep);
  const [exchangeError, setExchangeError] = useState(null);
  const [busy, setBusy] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
    else sessionStorage.removeItem(KEY);
  }, [session]);
  useEffect(() => {
    if (step) sessionStorage.setItem(STEP_KEY, JSON.stringify(step));
    else sessionStorage.removeItem(STEP_KEY);
  }, [step]);

  const clear = useCallback(() => {
    setSession(null);
    setStep(null);
  }, []);

  const request = useCallback(async (path, { method = 'GET', body, platformToken, stepUpToken } = {}) => {
    const token = platformToken || session?.token;
    if (!token) throw new PlatformError(401, path, { error: 'platform_session_required' });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const su = stepUpToken || stepRef.current?.token;
    if (su) headers['x-platform-step-up'] = su;
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
    if (res.status === 401) {
      clear();
      throw new PlatformError(res.status, path, json);
    }
    if (res.status === 403 && json && typeof json === 'object' && ['platform_admin_inactive', 'platform_admin_required'].includes(json.error)) {
      clear();
    }
    if (!res.ok) throw new PlatformError(res.status, path, json);
    return json;
  }, [session?.token, clear]);

  const exchange = useCallback(async (code) => {
    setBusy(true);
    setExchangeError(null);
    try {
      // The ordinary API client refreshes an expired tenant access token first.
      const live = authStore.get()?.token || auth?.token;
      if (!live) throw new PlatformError(401, '/v1/platform/session', { error: 'login_required' });
      const r = await fetch(`${baseUrl()}/v1/platform/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${live}` },
        body: JSON.stringify(/^\d{6}$/.test(String(code || '').trim()) ? { code: String(code).trim() } : { recoveryCode: String(code || '').trim() }),
      });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      if (!r.ok) throw new PlatformError(r.status, '/v1/platform/session', json);
      const next = {
        token: json.accessToken,
        expiresAt: Date.now() + Number(json.expiresIn || 900) * 1000,
        role: json.role,
        user: json.user,
      };
      setSession(next);
      setStep(null);
      return next;
    } catch (e) {
      setExchangeError(e);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [auth?.token]);

  const stepUp = useCallback(async (code) => {
    setBusy(true);
    try {
      const value = String(code || '').trim();
      const r = await request('/v1/platform/step-up', {
        method: 'POST',
        body: /^\d{6}$/.test(value) ? { code: value } : { recoveryCode: value },
      });
      const next = { token: r.stepUpToken, expiresAt: Date.now() + Number(r.expiresIn || 300) * 1000 };
      setStep(next);
      return next;
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
    exchangeError,
    busy,
    request,
    exchange,
    stepUp,
    stepUpToken: step?.token || null,
    logout,
    clear,
  }), [session, exchangeError, busy, request, exchange, stepUp, step?.token, logout, clear]);

  return <PlatformAuthCtx.Provider value={value}>{children}</PlatformAuthCtx.Provider>;
}

export function usePlatformAuth() {
  const v = useContext(PlatformAuthCtx);
  if (!v) throw new Error('usePlatformAuth must be used inside PlatformAuthProvider');
  return v;
}
