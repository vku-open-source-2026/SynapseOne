// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Synapse IAM client: auth/OIDC, orgs/accounts/users, roles/policies,
 * API keys, service accounts and usage analytics.
 *
 * Access it through `new SynapseOneClient(...).iam` or build it with an
 * HttpClient directly.
 */

import { HttpClient, RequestOptions } from './_http';

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
  orgSlug?: string;
}

export interface PasswordLoginInput {
  email: string;
  password: string;
  orgSlug?: string;
}

export interface Session {
  id: string;
  created_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface ExchangeInput {
  userId: string;
  accountId?: string;
  orgId?: string;
  scopes?: string[];
  audience?: string;
  ttlSeconds?: number;
}

export interface DelegatedToken {
  accessToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  delegated: true;
  userId: string;
  orgId: string;
  accountId: string;
  scopes: string[];
  audience?: string;
}

export class IamService {
  constructor(private readonly http: HttpClient) {}

  // ---- auth ----
  /** Passwordless dev login (IAM_ALLOW_DEV_LOGIN; disabled in production). */
  login(email: string, orgSlug = 'acme') {
    return this.http.req<{ accessToken: string; refreshToken: string; user: any }>('/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ email, orgSlug }),
    });
  }
  /** First-party registration (email + password). */
  register(input: RegisterInput) {
    return this.http.req<{ accessToken: string; refreshToken: string; user: any; emailVerificationToken?: string }>('/v1/auth/register', {
      method: 'POST', body: JSON.stringify(input),
    });
  }
  /** First-party email+password login (works in production). */
  loginWithPassword(input: PasswordLoginInput) {
    return this.http.req<{ accessToken: string; refreshToken: string; user: any }>('/v1/auth/login', {
      method: 'POST', body: JSON.stringify(input),
    });
  }
  changePassword(currentPassword: string, newPassword: string) {
    return this.http.req<{ ok: boolean; revokedSessions: number }>('/v1/auth/password/change', {
      method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
    });
  }
  /** Request a reset token. The response is always 202 (no account enumeration).
   *  In non-production, `resetToken` is returned when no mailer is configured. */
  requestPasswordReset(email: string, orgSlug = 'acme') {
    return this.http.req<{ ok: boolean; resetToken?: string }>('/v1/auth/password/forgot', {
      method: 'POST', body: JSON.stringify({ email, orgSlug }),
    });
  }
  resetPassword(token: string, newPassword: string) {
    return this.http.req<{ ok: boolean; revokedSessions: number }>('/v1/auth/password/reset', {
      method: 'POST', body: JSON.stringify({ token, newPassword }),
    });
  }
  verifyEmail(token: string) {
    return this.http.req<{ ok: boolean; emailVerified: boolean }>('/v1/auth/email/verify', {
      method: 'POST', body: JSON.stringify({ token }),
    });
  }
  requestEmailVerification() {
    return this.http.req<{ ok: boolean; emailVerified?: boolean; emailVerificationToken?: string }>('/v1/auth/email/verify/request', {
      method: 'POST', body: JSON.stringify({}),
    });
  }
  listSessions(): Promise<Session[]> { return this.http.req('/v1/auth/sessions'); }
  revokeSession(id: string) {
    return this.http.req(`/v1/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  /**
   * Delegated token exchange (Tier 2 → Tier 1). The client must present a
   * service-account Bearer token or an API key; a user JWT is refused.
   */
  exchangeToken(input: ExchangeInput, opts: RequestOptions = {}): Promise<DelegatedToken> {
    return this.http.req<DelegatedToken>('/v1/auth/exchange', {
      method: 'POST', body: JSON.stringify(input),
    }, opts);
  }
  refresh(refreshToken: string) {
    return this.http.req<{ accessToken: string; refreshToken: string }>('/v1/auth/refresh', {
      method: 'POST', body: JSON.stringify({ refreshToken }),
    });
  }
  logout(refreshToken: string) {
    return this.http.req('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  }
  logoutAll(refreshToken: string) {
    return this.http.req<{ ok: boolean; revoked: number }>('/v1/auth/logout-all', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  }
  verify() { return this.http.req('/v1/auth/verify'); }
  me() { return this.http.req('/v1/auth/me'); }
  oidcConfig() { return this.http.req('/v1/auth/oidc/config'); }
  oidcStart(org = 'acme') { return this.http.req(`/v1/auth/oidc/start?org=${encodeURIComponent(org)}`); }
  oidcCallback(code: string, state: string) {
    return this.http.req<{ accessToken: string; refreshToken: string; user: any }>('/v1/auth/oidc/callback', {
      method: 'POST', body: JSON.stringify({ code, state }),
    });
  }

  // ---- orgs/accounts/users ----
  listOrgs(): Promise<any[]> { return this.http.req('/v1/orgs'); }
  createOrg(slug: string, displayName: string) {
    return this.http.req('/v1/orgs', { method: 'POST', body: JSON.stringify({ slug, displayName }) });
  }
  listAccounts(orgId: string) { return this.http.req(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`); }
  listUsers(orgId: string) { return this.http.req(`/v1/orgs/${encodeURIComponent(orgId)}/users`); }
  createUser(orgId: string, email: string, displayName?: string) {
    return this.http.req(`/v1/orgs/${encodeURIComponent(orgId)}/users`, { method: 'POST', body: JSON.stringify({ email, displayName }) });
  }
  createAccount(orgId: string, slug: string, displayName: string) {
    return this.http.req(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`, { method: 'POST', body: JSON.stringify({ slug, displayName }) });
  }
  userPolicies(userId: string) { return this.http.req(`/v1/users/${encodeURIComponent(userId)}/policies`); }

  // ---- roles / policies ----
  createRole(accountId: string, slug: string, description = '') {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/roles`, { method: 'POST', body: JSON.stringify({ slug, description }) });
  }
  listRoles(accountId: string) { return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/roles`); }
  deleteRole(roleId: string) { return this.http.req(`/v1/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' }); }
  listPolicies(accountId: string) { return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/policies`); }
  deletePolicy(policyId: string) { return this.http.req(`/v1/policies/${encodeURIComponent(policyId)}`, { method: 'DELETE' }); }
  createPolicy(accountId: string, slug: string, document: any, description = '') {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/policies`, { method: 'POST', body: JSON.stringify({ slug, document, description }) });
  }
  authorize(userId: string, action: string, resource: string, context?: Record<string, unknown>) {
    return this.http.req<{ allowed: boolean }>('/v1/authorize', { method: 'POST', body: JSON.stringify({ userId, action, resource, context }) });
  }
  attachPolicy(roleId: string, policyId: string) {
    return this.http.req(`/v1/roles/${encodeURIComponent(roleId)}/attach`, { method: 'POST', body: JSON.stringify({ policyId }) });
  }
  detachPolicy(roleId: string, policyId: string) {
    return this.http.req(`/v1/roles/${encodeURIComponent(roleId)}/policies/${encodeURIComponent(policyId)}`, { method: 'DELETE' });
  }
  rolePolicies(roleId: string) {
    return this.http.req(`/v1/roles/${encodeURIComponent(roleId)}/policies`);
  }
  assignRole(userId: string, roleId: string) {
    return this.http.req(`/v1/users/${encodeURIComponent(userId)}/assign`, { method: 'POST', body: JSON.stringify({ roleId }) });
  }
  unassignRole(userId: string, roleId: string) {
    return this.http.req(`/v1/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
  }
  userRoles(userId: string) {
    return this.http.req(`/v1/users/${encodeURIComponent(userId)}/roles`);
  }
  simulate(documents: any[], action: string, resource: string, context?: Record<string, unknown>) {
    return this.http.req<{ allowed: boolean }>('/v1/authorize/dry-run', { method: 'POST', body: JSON.stringify({ documents, action, resource, context }) });
  }
  /**
   * Read the tenant-scoped audit trail. Accepts the legacy `(limit, actor)`
   * form or a filter object with action/resource/time/pagination (#32).
   */
  listAudit(
    limitOrFilter: number | {
      limit?: number;
      offset?: number;
      actor?: string;
      allowed?: boolean;
      action?: string;
      resource?: string;
      from?: string | Date;
      to?: string | Date;
    } = 50,
    actor?: string,
  ) {
    const f = typeof limitOrFilter === 'number' ? { limit: limitOrFilter, actor } : limitOrFilter;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(f || {})) {
      if (v !== undefined && v !== null && String(v) !== '') qs.set(k, v instanceof Date ? v.toISOString() : String(v));
    }
    const s = qs.toString();
    return this.http.req(`/v1/audit${s ? `?${s}` : ''}`);
  }

  // ---- API keys ----
  /**
   * Create an API key. Scopes default to least-privilege read access
   * (`*:read`); pass `['*']` explicitly for a full administrator key.
   */
  createApiKey(
    accountId: string,
    name = 'default',
    scopes: string[] = ['*:read'],
    opts: { userId?: string; expiresInSeconds?: number } = {},
  ) {
    return this.http.req<{ apiKey: string }>(`/v1/accounts/${encodeURIComponent(accountId)}/keys`, {
      method: 'POST',
      body: JSON.stringify({ name, scopes, ...opts }),
    });
  }
  revokeApiKey(keyId: string) {
    return this.http.req(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  }
  listApiKeys(accountId: string) {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/keys`);
  }
  verifyApiKey(apiKey: string) {
    return this.http.req(`/v1/keys/verify`, { method: 'POST', body: JSON.stringify({ apiKey }) });
  }
  /** Rotate a key: returns the new secret once; the old key stays valid for `graceSeconds` (0 = revoke now). */
  rotateApiKey(keyId: string, graceSeconds = 0) {
    return this.http.req<{ id: string; apiKey: string; prefix: string; rotatedFrom: string; oldKeyExpiresAt: string }>(
      `/v1/keys/${encodeURIComponent(keyId)}/rotate`,
      { method: 'POST', body: JSON.stringify({ graceSeconds }) },
    );
  }

  // ---- org administrators & managed policies ----
  setOrgAdmin(userId: string, isOrgAdmin: boolean) {
    return this.http.req(`/v1/users/${encodeURIComponent(userId)}/org-admin`, { method: 'PUT', body: JSON.stringify({ isOrgAdmin }) });
  }
  managedPolicies() {
    return this.http.req<Array<{ name: string; description: string; document: any }>>('/v1/managed-policies');
  }
  /** Instantiate an AWS-style managed policy (e.g. `ReadOnlyAccess`) in an account. */
  createManagedPolicy(accountId: string, slug: string, managed: string, description?: string) {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/policies`, {
      method: 'POST', body: JSON.stringify({ slug, managed, ...(description ? { description } : {}) }),
    });
  }

  // ---- service accounts ----
  createServiceAccount(accountId: string, slug: string, description = '') {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/service-accounts`, { method: 'POST', body: JSON.stringify({ slug, description }) });
  }
  listServiceAccounts(accountId: string) { return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/service-accounts`); }
  // scopes omitted -> the server delegates the caller's own scopes (never
  // widens to '*'). Pass an explicit list to narrow the minted token.
  serviceAccountToken(saId: string, scopes?: string[]) {
    return this.http.req<{ accessToken: string }>(`/v1/service-accounts/${encodeURIComponent(saId)}/token`, {
      method: 'POST',
      body: JSON.stringify(scopes === undefined ? {} : { scopes }),
    });
  }

  serviceAccountRoles(saId: string) {
    return this.http.req(`/v1/service-accounts/${encodeURIComponent(saId)}/roles`);
  }
  assignServiceAccountRole(saId: string, roleId: string) {
    return this.http.req(`/v1/service-accounts/${encodeURIComponent(saId)}/roles`, { method: 'POST', body: JSON.stringify({ roleId }) });
  }
  unassignServiceAccountRole(saId: string, roleId: string) {
    return this.http.req(`/v1/service-accounts/${encodeURIComponent(saId)}/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
  }

  // ---- usage & telemetry ----
  usageSummary(filter?: {
    from?: string | Date;
    to?: string | Date;
    feature?: string;
    accountId?: string;
    actor?: string;
    method?: string;
    status?: number;
    statusClass?: string;
  }) {
    const qs = new URLSearchParams();
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        if (v !== undefined && v !== null && String(v) !== '') {
          qs.set(k, v instanceof Date ? v.toISOString() : String(v));
        }
      }
    }
    const s = qs.toString();
    return this.http.req<any>(`/v1/usage/summary${s ? `?${s}` : ''}`);
  }

  usageEvents(filter?: {
    from?: string | Date;
    to?: string | Date;
    feature?: string;
    accountId?: string;
    actor?: string;
    method?: string;
    status?: number;
    statusClass?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const qs = new URLSearchParams();
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        if (v !== undefined && v !== null && String(v) !== '') {
          qs.set(k, v instanceof Date ? v.toISOString() : String(v));
        }
      }
    }
    const s = qs.toString();
    return this.http.req<any>(`/v1/usage/events${s ? `?${s}` : ''}`);
  }
}
