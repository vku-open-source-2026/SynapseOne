// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { baseUrl } from './api.js';

export const SESSION_INVALID = new Set([
  'invalid_token',
  'unauthorized',
  'platform_session_required',
  'platform_admin_required',
  'platform_admin_inactive',
  'platform_admin_org_required',
  'platform_session_requires_user',
  'platform_session_revoked',
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

export function isInvalidPlatformSession(error) {
  const code = error?.code || error?.body?.error;
  return (error?.status === 401 || error?.status === 403) && SESSION_INVALID.has(code);
}

export async function fetchPlatform(token, path, { method = 'GET', body, stepUpToken } = {}) {
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
  if (!res.ok) throw new PlatformError(res.status, path, json);
  return json;
}

export function mergePlatformSession(current, profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(source, key);
  return {
    ...current,
    mfaRequired: source.mfaRequired !== false,
    stepUpRequired: source.stepUpRequired !== false,
    ...(has('mfa') ? { mfa: source.mfa } : {}),
    ...(has('role') ? { role: source.role } : {}),
    ...(has('user') ? { user: source.user } : {}),
  };
}

export function needsPlatformSessionRevalidation(restoredToken, currentToken, revalidatedToken) {
  return !!restoredToken && restoredToken === currentToken && revalidatedToken !== restoredToken;
}
