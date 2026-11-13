// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import './env-compat';
import express from 'express';
import cors from 'cors';
import expressRateLimit from 'express-rate-limit';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createHmac } from 'crypto';
import { z } from 'zod';
import {
  createOrganization, createOrganizationWithAdmin, listOrganizations, getOrgBySlug,
  createAccount, listAccounts, upsertUser, listUsers, getUserById, findUserByOrgEmail,
  createRole, createPolicy,
  attachPolicy, assignRole, detachPolicy, unassignRole, policiesForUser, useDb, deleteRole, deletePolicy,
  createServiceAccount, listServiceAccounts, getServiceAccount,
  listRoles, listPolicies, logAudit, listAudit, queryAudit, purgeAudit,
  getRoleById, getPolicyById, getAccountById, accountsForUser, getOrgById,
  policiesForRole, rolesForUser, ensureTables,
  setUserPassword, markEmailVerified, storeOneTimeToken, consumeOneTimeToken,
  setUserActive, updateUserProfile, publicUser,
  setOrgAdmin, orgHasAdmin, assignRoleToServiceAccount, unassignRoleFromServiceAccount, rolesForServiceAccount,
  getPlatformAdmin, listPlatformAdmins, grantPlatformAdmin, revokePlatformAdmin, countActivePlatformOwners,
  registerPlatformStepUp, consumePlatformStepUp,
  listPlatformOrganizations, getPlatformOrganization, listPlatformUsers, getPlatformOverviewCounts, platformAuditStats,
  type PlatformAdmin, type User,
} from './db';
import {
  createScimToken, listScimTokens, revokeScimToken, verifyScimToken,
  listScimGroups, getScimGroup, createScimGroup, updateScimGroup, deleteScimGroup,
  toScimUser, toScimGroup, parseScimFilter, matchesScimFilter,
} from './scim';
import { evaluatePolicies, validatePolicyDocument } from './policy';
import {
  signAccess, newRefreshToken, storeRefresh, consumeRefresh, revokeRefresh, revokeAllRefresh,
  consumeAndRevokeRefresh, findRefreshOwner, refreshExpiry, revokeApiKey, createApiKeyRecord,
  verifyApiKey, verifyAccess, listApiKeys, findApiKeyById, signDelegated,
  listRefreshSessions, revokeRefreshById, revokeApiKeysForUser, rotateApiKey,
  signPlatformAccess, verifyPlatformAccess, signPlatformStepUp, verifyPlatformStepUp,
} from './tokens';
import {
  beginTotpEnrolment, checkSecondFactor, clearLoginFailures, enableTotp, getMfa, lockRemaining, mfaEnabled,
  otpauthUrl, recordLoginFailure, regenerateRecoveryCodes, removeMfa, signMfaChallenge, verifyMfaChallenge,
  TOTP_DIGITS, TOTP_PERIOD,
} from './mfa';
import { decideForPrincipal, managedPolicyList, MANAGED_POLICIES, type PrincipalInput } from './authz';
import { secretsEqual, hashCandidates, withTransaction } from './db';
import { ingestUsageEvents, listUsageEvents, purgeUsage, usageSummary, type UsageFilter } from './usage';
import { assertOidcConfig, isPublicHttpsUrl, createOidcState, exchangeCode, authorizationEndpoint, oidcSettings, OidcError } from './oidc';
import {
  hashPassword, verifyPassword, passwordPolicyError, newOneTimeToken,
  resetTokenExpiry, verifyTokenExpiry, inviteTokenExpiry, PASSWORD_MAX,
} from './passwords';

dotenv.config();
const PORT = Number(process.env.PORT || 4001);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * Production detection. `NODE_ENV=production` is the documented switch, but a
 * deployment that forgets it (the prod compose overlay/Helm values are the only
 * places that set it) would silently fall back to dev behaviour — including
 * echoing password-reset/verification tokens in API responses. Accept the
 * common environment aliases so a live stack fails closed even then.
 */
const IS_PROD = (() => {
  if (process.env.NODE_ENV === 'production') return true;
  const env = (process.env.SYNAPSEONE_ENV ?? process.env.SYNAPSEDX_ENV ?? process.env.APP_ENV ?? process.env.ENVIRONMENT ?? '').trim().toLowerCase();
  return env === 'production' || env === 'prod';
})();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean { return UUID_RE.test(s || ''); }
/** Linear-time email sanity check (avoids CodeQL's polynomial-regex alert). */
function validScimEmail(value: string): boolean {
  if (!value || value.length > 320 || /\s/.test(value)) return false;
  const at = value.indexOf('@');
  const dot = value.lastIndexOf('.');
  return at > 0 && dot > at + 1 && dot < value.length - 1 && value.indexOf('@', at + 1) === -1;
}
function firstHeader(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] || '') : (v || '');
}
/** Strip control chars / angle brackets to blunt stored-XSS via display names. */
function sanitizeName(s: string, max = 200): string {
  return String(s || '').trim().replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, max);
}
/** Cap caller-supplied audit context (DoS via 1mb JSON body full of context). */
function capContext(ctx: any, maxBytes = 8192): any {
  if (!ctx || typeof ctx !== 'object') return {};
  try {
    let raw = JSON.stringify(ctx);
    if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return ctx;
    const out: any = {};
    for (const [k, v] of Object.entries(ctx)) {
      if (Buffer.byteLength(JSON.stringify(out), 'utf8') > maxBytes) break;
      const vs = String(JSON.stringify(v) || '').slice(0, 512);
      try { out[String(k).slice(0, 64)] = JSON.parse(vs); } catch { out[String(k).slice(0, 64)] = vs.slice(0, 512); }
    }
    return out;
  } catch { return {}; }
}
function noStore(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store');
}
/** Tenant membership of the caller: account ids they may act for.
 *  Prefers the gateway-stamped header (verified principal) — but ONLY when
 *  the internal secret is configured (prod): without it, direct callers could
 *  spoof any x-synapseone-* header, so stamped values are ignored and the
 *  presented credential is always verified directly. Null = unresolvable. */
async function resolveCallerAccounts(req: express.Request, trustStamped: boolean): Promise<string[] | null> {
  if (trustStamped) {
    const stamped = firstHeader((req.headers['x-synapseone-account'] ?? req.headers['x-synapsedx-account']) as any);
    if (stamped) return [stamped];
  }
  const h = firstHeader(req.headers.authorization as any);
  if (h.startsWith('Bearer ')) {
    try {
      const claims = verifyAccess(h.slice(7));
      if (claims.account) return [claims.account];
      if (claims.sub) return await accountsForUser(claims.sub);
      return [];
    } catch {
      return null;
    }
  }
  const apiKey = firstHeader(req.headers['x-api-key'] as any);
  if (apiKey) {
    try {
      const rec = await verifyApiKey(apiKey);
      return rec?.account_id ? [rec.account_id] : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Owning org of the caller (same stamped-trust rule as accounts).
 *  Service-account (machine) tokens are strictly account-bound → null. */
async function resolveCallerOrg(req: express.Request, trustStamped: boolean): Promise<string | null> {
  if (trustStamped) {
    const so = firstHeader((req.headers['x-synapseone-org'] ?? req.headers['x-synapsedx-org']) as any);
    if (so) return so;
  }
  const h = firstHeader(req.headers.authorization as any);
  if (h.startsWith('Bearer ')) {
    try {
      const claims = verifyAccess(h.slice(7));
      if (claims.kind === 'service-account') return null;
      if (!claims.sub) return null;
      const user = await getUserById(claims.sub);
      return user?.org_id || null;
    } catch {
      return null;
    }
  }
  const apiKey = firstHeader(req.headers['x-api-key'] as any);
  if (apiKey) {
    try {
      const rec = await verifyApiKey(apiKey);
      if (!rec?.account_id) return null;
      const acc = await getAccountById(rec.account_id);
      return acc?.org_id || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** User id of the caller (same stamped-trust rule as org). Service-account
 *  tokens and API keys are machine identities → null. */
async function resolveCallerUser(req: express.Request, trustStamped: boolean): Promise<string | null> {
  if (trustStamped) {
    const su = firstHeader((req.headers['x-synapseone-user'] ?? req.headers['x-synapsedx-user']) as any);
    if (su) return su;
  }
  const h = firstHeader(req.headers.authorization as any);
  if (h.startsWith('Bearer ')) {
    try {
      const claims = verifyAccess(h.slice(7));
      if (claims.kind === 'service-account') return null;
      return claims.sub || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** A user JWT must still map to an active account. Disabling or deleting a
 *  user must invalidate existing access tokens before their natural expiry. */
async function claimsUserActive(claims: any): Promise<boolean> {
  if (!claims || claims.kind === 'service-account') return true;
  if (!claims.sub) return false;
  const user = await getUserById(String(claims.sub));
  return !!user && user.active !== false;
}

/** May the caller act for `accountId`? Role-based account membership first,
 *  then same-org fallback (login JWTs carry org but no account, and fresh
 *  users hold no roles yet — without this the bootstrap flow could never mint
 *  its first token). Tenant boundary stays the org. Machine
 *  (service-account) tokens are account-bound: no org fallback. */
async function canActForAccount(req: express.Request, trustStamped: boolean, accountId: string): Promise<boolean> {
  const accounts = await resolveCallerAccounts(req, trustStamped);
  if (accounts && accounts.includes(accountId)) return true;
  const org = await resolveCallerOrg(req, trustStamped);
  if (!org) return false;
  const acc = await getAccountById(accountId);
  return !!acc && acc.org_id === org;
}

/** Bootstrap rule: the first user of an organization becomes its
 *  administrator (AWS root-like). Later users start with no permissions and
 *  are granted roles/managed policies by an admin. */
async function bootstrapOrgAdmin(user: User): Promise<User> {
  if (user.is_org_admin) return user;
  const org = await getOrgById(user.org_id);
  if (org?.kind === 'platform') return user;
  if (await orgHasAdmin(user.org_id)) return user;
  return (await setOrgAdmin(user.id, true)) || user;
}

/** Is the caller an administrator of `orgId`? Machine identities never are. */
async function callerIsOrgAdmin(req: express.Request, trustStamped: boolean, orgId: string): Promise<boolean> {
  const uid = await resolveCallerUser(req, trustStamped);
  if (!uid) return false;
  const u = await getUserById(uid);
  return !!u && u.org_id === orgId && !!u.is_org_admin;
}

/** May the caller act for `orgId`? Same stamped-trust rule; service-account
 *  tokens are account-scoped, never org-scoped. */
async function canActForOrg(req: express.Request, trustStamped: boolean, orgId: string): Promise<boolean> {
  const org = await resolveCallerOrg(req, trustStamped);
  return !!org && org === orgId;
}

/** Sensitive IAM mutations (roles, policies, users, keys, service accounts)
 *  need more than tenant membership. The default is audit for a safe rollout;
 *  production should set enforce. The bootstrap rule still makes the first
 *  user of an org an org admin, so a fresh tenant remains manageable. */
function sensitiveMutationMode(): 'off' | 'audit' | 'enforce' {
  const raw = String(process.env.IAM_SENSITIVE_MUTATION_MODE || 'audit').trim().toLowerCase();
  return raw === 'off' || raw === 'enforce' ? raw : 'audit';
}

async function requireSensitiveMutation(
  req: express.Request,
  res: express.Response,
  trustStamped: boolean,
  orgId: string,
  action: string,
): Promise<boolean> {
  const mode = sensitiveMutationMode();
  if (mode === 'off') return true;
  if (await callerIsOrgAdmin(req, trustStamped, orgId)) return true;
  if (mode === 'audit') {
    const actor = await resolveCallerUser(req, trustStamped);
    await logAudit({
      actor_type: actor ? 'user' : 'service',
      actor_id: actor || '',
      action: `${action}:would-deny`,
      resource: String(req.path || ''),
      decision: false,
      context: { org: orgId, mode, method: req.method, route: req.path },
    }).catch(() => undefined);
    return true;
  }
  res.status(403).json({
    error: 'org_admin_required',
    message: 'only an organization administrator can perform this operation',
  });
  return false;
}

async function orgForAccount(accountId: string): Promise<string | null> {
  const acc = await getAccountById(accountId);
  return acc?.org_id || null;
}

function platformFeatureEnabled(): boolean {
  return (process.env.PLATFORM_ADMIN_ENABLED ?? (IS_PROD ? 'false' : 'true')) === 'true';
}

const PLATFORM_ROLE_RANK: Record<string, number> = { auditor: 1, operator: 2, owner: 3 };
const PLATFORM_STEP_UP_ACTIONS = new Set([
  'org:create',
  'org:account:create',
  'user:org-admin',
  'user:reset-mfa',
  'user:invite',
  'user:revoke-sessions',
  'user:disable',
  'admin:grant',
  'admin:revoke',
]);

async function currentPlatformAdmin(
  req: express.Request,
  res: express.Response,
  minRole: 'auditor' | 'operator' | 'owner' = 'auditor',
): Promise<{ claims: any; admin: PlatformAdmin; user: User } | null> {
  if (!platformFeatureEnabled()) {
    res.status(404).json({ error: 'not_found', message: 'platform administration is disabled' });
    return null;
  }
  const h = firstHeader(req.headers.authorization as any);
  if (!h.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'platform administrator Bearer token required' });
    return null;
  }
  let claims: any;
  try {
    claims = verifyPlatformAccess(h.slice(7));
  } catch {
    await auditPlatformDenied(req, '', null, 'platform:access', 'invalid_platform_token');
    res.status(403).json({ error: 'platform_admin_required', message: 'a platform administrator token is required' });
    return null;
  }
  const admin = await getPlatformAdmin(String(claims.sub || ''));
  if (!admin || admin.revoked_at) {
    await auditPlatformDenied(req, String(claims.sub || ''), null, 'platform:access', 'admin_revoked_or_missing');
    res.status(403).json({ error: 'platform_admin_inactive', message: 'platform administrator access has been revoked' });
    return null;
  }
  const user = await getUserById(String(claims.sub));
  if (!user || user.active === false) {
    await auditPlatformDenied(req, String(claims.sub || ''), user?.org_id || null, 'platform:access', 'account_inactive');
    res.status(403).json({ error: 'platform_admin_inactive', message: 'platform administrator account is inactive' });
    return null;
  }
  const org = await getOrgById(user.org_id);
  if (!org || (org.kind || 'tenant') !== 'platform') {
    await auditPlatformDenied(req, user.id, user.org_id, 'platform:access', 'platform_org_required');
    res.status(403).json({ error: 'platform_admin_org_required', message: 'platform administrators must belong to the platform organization' });
    return null;
  }
  const requireMfa = (process.env.PLATFORM_ADMIN_REQUIRE_MFA ?? 'true') === 'true';
  if (requireMfa && !(await mfaEnabled(user.id))) {
    await auditPlatformDenied(req, user.id, user.org_id, 'platform:access', 'mfa_not_enabled');
    res.status(403).json({ error: 'platform_mfa_required', message: 'enable TOTP MFA before using the platform console' });
    return null;
  }
  if ((PLATFORM_ROLE_RANK[admin.role] || 0) < (PLATFORM_ROLE_RANK[minRole] || 0)) {
    await auditPlatformDenied(req, user.id, user.org_id, 'platform:access', 'role_required');
    res.status(403).json({ error: 'platform_role_required', message: `platform ${minRole} role required` });
    return null;
  }
  return { claims, admin, user };
}

async function requirePlatformStepUp(
  req: express.Request,
  res: express.Response,
  ctx: { claims: any; user: User },
  action: string,
): Promise<boolean> {
  if ((process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP ?? 'true') !== 'true') return true;
  const token = firstHeader(req.headers['x-platform-step-up'] as any);
  const sessionJti = String(ctx.claims?.jti || '');
  const claims = token ? verifyPlatformStepUp(token, ctx.user.id, action, sessionJti) : null;
  if (!claims) {
    await auditPlatformDenied(req, ctx.user.id, ctx.user.org_id, action, 'step_up_required');
    res.status(403).json({ error: 'platform_step_up_required', message: 'fresh TOTP step-up verification is required for this action' });
    return false;
  }
  const consumed = await consumePlatformStepUp({
    jti: String(claims.jti),
    userId: ctx.user.id,
    sessionJti,
    action,
  });
  if (!consumed) {
    await auditPlatformDenied(req, ctx.user.id, ctx.user.org_id, action, 'step_up_replayed_or_expired');
    res.status(403).json({ error: 'platform_step_up_required', message: 'this step-up proof was already used, expired, or belongs to another session' });
    return false;
  }
  return true;
}

/** Retry a privileged audit insert, then fail closed. Used by platform and
 *  tenant administrative mutations so a lost audit row is never silent. */
async function writeAuditStrict(entry: Parameters<typeof logAudit>[0]): Promise<void> {
  let lastError: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await logAudit(entry);
      return;
    } catch (e: any) {
      lastError = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  console.error('[iam][audit] privileged audit write failed:', entry.action, lastError?.message || lastError);
  throw Object.assign(new Error('privileged audit write failed'), {
    status: 503,
    code: 'audit_write_failed',
  });
}

/** Privileged platform actions must never silently succeed without their
 *  audit row. Retry transient DB failures, then fail closed with 503. */
async function auditPlatformAction(
  req: express.Request,
  actorId: string,
  action: string,
  targetOrgId?: string | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const entry = {
    actor_type: 'platform-admin',
    actor_id: actorId,
    action,
    resource: String(req.path || ''),
    decision: true,
    org_id: targetOrgId || null,
    context: {
      platformAdmin: true,
      ...(targetOrgId ? { targetOrg: targetOrgId } : {}),
      requestId: firstHeader(req.headers['x-request-id'] as any) || '',
      ...extra,
    },
  };
  await writeAuditStrict(entry);
}

/** Denied platform-plane attempts are security events too. A denied request
 *  remains denied even if the audit sink is degraded; log loudly for alerting. */
async function auditPlatformDenied(
  req: express.Request,
  actorId: string,
  targetOrgId: string | null | undefined,
  action: string,
  reason: string,
): Promise<void> {
  try {
    await logAudit({
      actor_type: 'user',
      actor_id: actorId || '',
      action,
      resource: String(req.path || ''),
      decision: false,
      org_id: targetOrgId || null,
      context: {
        platformAdmin: false,
        reason,
        requestId: firstHeader(req.headers['x-request-id'] as any) || '',
      },
    });
  } catch (e: any) {
    console.error('[iam][audit] denied-action audit write failed:', action, reason, e?.message || e);
  }
}

/** Issue a one-time activation code for a passwordless invited account. */
async function issueInvite(user: User): Promise<string | null> {
  if (user.password_hash) return null;
  const token = newOneTimeToken('invite');
  await storeOneTimeToken(user.id, token.hash, 'invite', inviteTokenExpiry());
  return token.value;
}

function parsePlatformRange(req: express.Request, res: express.Response, defaultHours = 24): { from: Date; to: Date } | null {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - defaultHours * 3600_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    res.status(400).json({ error: 'invalid_time', message: 'from/to must be valid ISO timestamps' });
    return null;
  }
  const span = to.getTime() - from.getTime();
  if (span <= 0 || span > 366 * 86_400_000) {
    res.status(400).json({ error: 'invalid_time', message: 'time range must be positive and at most 366 days' });
    return null;
  }
  return { from, to };
}

/** Optional OIDC org allowlist (#9): comma-separated slugs. Empty = any slug
 *  is allowed (membership rules below still apply). */
function oidcAllowedOrgs(): string[] {
  return (process.env.OIDC_ALLOWED_ORGS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Resolve the org + user for an OIDC identity (#9). A brand-new slug is
 *  self-service (the org is created for the first login), but joining an
 *  EXISTING org requires an existing membership (user row for that email):
 *  an IdP login can never auto-join another tenant by guessing its slug.
 *  Returns a typed failure for the fail-closed paths. */
async function resolveOidcIdentity(
  slug: string,
  email: string,
  displayName?: string,
  externalSub?: string,
): Promise<{ user: import('./db').User } | { error: 'org_not_allowed' | 'org_membership_required' | 'reserved_org_slug'; message: string }> {
  const allowed = oidcAllowedOrgs();
  if (allowed.length && !allowed.includes(slug)) {
    return { error: 'org_not_allowed', message: `organization '${slug}' is not in OIDC_ALLOWED_ORGS` };
  }
  let org = await getOrgBySlug(slug);
  if (!org) {
    if (slug.toLowerCase() === (process.env.PLATFORM_ORG_SLUG || 'synapseone-platform').toLowerCase()) {
      return { error: 'reserved_org_slug', message: 'This organization slug is reserved for platform administration.' };
    }
    try {
      org = await createOrganization(slug, slug);
    } catch (e: any) {
      // Lost a concurrent-create race → fall back to the membership rule.
      org = await getOrgBySlug(slug);
      if (!org) throw e;
    }
    return { user: await upsertUser(org.id, email, displayName, externalSub) };
  }
  const existing = await findUserByOrgEmail(org.id, email);
  if (!existing) {
    return {
      error: 'org_membership_required',
      message: 'Your IdP identity is not a member of this organization. Ask an admin to invite you, or start a new organization.',
    };
  }
  // Member re-login: refresh display name/external sub from the IdP claims.
  return { user: await upsertUser(org.id, email, displayName, externalSub) };
}
export function isDevLoginEnabled(): boolean {
  if (IS_PROD) return false; // fail-closed in production regardless of env
  return (process.env.IAM_ALLOW_DEV_LOGIN || 'true') === 'true';
}
export function isDemoCallbackEnabled(): boolean {
  if (IS_PROD) return false;
  return (process.env.IAM_ALLOW_OIDC_DEMO_CALLBACK || 'true') === 'true';
}

/** First-party registration is opt-out; production operators can disable it. */
export function isRegistrationEnabled(): boolean {
  return (process.env.IAM_REGISTRATION_ENABLED ?? 'true') !== 'false';
}

/** Whether self-service registration may create a brand-new organization. */
export function registrationAllowsNewOrgs(): boolean {
  return (process.env.IAM_REGISTRATION_ALLOW_NEW_ORGS ?? 'true') !== 'false';
}

/** Dev-only convenience: return reset/verification tokens in the response
 *  (there is no mailer wired by default). Opt-in: a deployment must set
 *  `IAM_EXPOSE_LIFECYCLE_TOKENS=true` explicitly, so an unset/typo'd env can
 *  never hand a reset token to an unauthenticated caller. Forced off in prod. */
export function exposesLifecycleTokens(): boolean {
  if (IS_PROD) return false;
  return process.env.IAM_EXPOSE_LIFECYCLE_TOKENS === 'true';
}

/** Issue an access+refresh pair for a user (login/register/refresh). */
async function issueSession(user: { id: string; email: string; org_id: string }): Promise<{ accessToken: string; expiresIn: number; refreshToken: string; user: unknown }> {
  const { token, expiresIn } = signAccess({ sub: user.id, email: user.email, org: user.org_id });
  const rt = newRefreshToken();
  await storeRefresh(user.id, rt.hash, refreshExpiry());
  return { accessToken: token, expiresIn, refreshToken: rt.value, user: publicUser(user as User) };
}

function sendLocked(res: express.Response, seconds: number) {
  res.setHeader('Retry-After', String(seconds));
  return res.status(429).json({
    error: 'account_locked',
    message: 'Too many failed sign-in attempts. Try again later or ask an administrator to unlock the account.',
    retryAfter: seconds,
  });
}

function sendMfaChallenge(res: express.Response, userId: string, method: string) {
  noStore(res);
  return res.status(401).json({
    error: 'mfa_required',
    message: 'Enter the code from your authenticator app',
    ...signMfaChallenge(userId, method),
    methods: ['totp', 'recovery'],
  });
}

/** Self-service MFA calls need a real user session (not a key or delegated token). */
async function requireUserCaller(req: express.Request, res: express.Response): Promise<User | null> {
  const h = firstHeader(req.headers.authorization as any);
  if (!h.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
    return null;
  }
  let claims: any;
  try {
    claims = verifyAccess(h.slice(7));
  } catch {
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }
  if (claims.kind && claims.kind !== 'user') {
    res.status(403).json({ error: 'mfa_requires_user', message: 'Only a signed-in user can manage their own MFA' });
    return null;
  }
  const user = await getUserById(claims.sub);
  if (!user) {
    res.status(404).json({ error: 'user_not_found' });
    return null;
  }
  return user;
}

/** Resolve the security subject of an org-admin action on another user. */
async function orgAdminTarget(req: express.Request, res: express.Response, trustStamped: boolean): Promise<User | null> {
  if (!isUuid(req.params.userId)) {
    res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    return null;
  }
  const user = await getUserById(req.params.userId);
  if (!user) {
    res.status(404).json({ error: 'user_not_found' });
    return null;
  }
  if (!(await canActForOrg(req, trustStamped, user.org_id))) {
    res.status(403).json({ error: 'forbidden', message: 'user belongs to another tenant' });
    return null;
  }
  if (!(await callerIsOrgAdmin(req, trustStamped, user.org_id))) {
    res.status(403).json({ error: 'org_admin_required', message: 'only an organization administrator can do this' });
    return null;
  }
  return user;
}

/** Resolve a service identity from a Bearer service-account token or API key.
 *  User JWTs cannot call the delegated-exchange endpoint. */
async function resolveServiceIdentity(req: express.Request): Promise<
  { ok: true; kind: 'service-account' | 'apikey'; id: string; accountId: string; orgId: string | null; scopes: string[] }
  | { ok: false; error: string; status: number; message: string }
> {
  const h = firstHeader(req.headers.authorization as any);
  if (h.startsWith('Bearer ')) {
    let claims: any;
    try {
      claims = verifyAccess(h.slice(7));
    } catch {
      return { ok: false, error: 'invalid_token', status: 401, message: 'Bearer token is invalid or expired' };
    }
    if (claims.kind !== 'service-account') {
      return {
        ok: false,
        error: 'exchange_requires_service_credential',
        status: 403,
        message: 'Only a service-account token or API key may exchange for a delegated user token',
      };
    }
    if (!claims.account) {
      return { ok: false, error: 'service_account_unbound', status: 403, message: 'Service account has no account binding' };
    }
    const acc = await getAccountById(claims.account);
    return {
      ok: true,
      kind: 'service-account',
      id: String(claims.sub || ''),
      accountId: claims.account,
      orgId: acc?.org_id || null,
      scopes: Array.isArray(claims.scopes) ? claims.scopes : [],
    };
  }
  const apiKey = firstHeader(req.headers['x-api-key'] as any);
  if (apiKey) {
    const rec = await verifyApiKey(apiKey);
    if (!rec) return { ok: false, error: 'invalid_api_key', status: 401, message: 'API key is invalid or expired' };
    const acc = await getAccountById(rec.account_id);
    return {
      ok: true,
      kind: 'apikey',
      id: `apikey:${rec.account_id}`,
      accountId: rec.account_id,
      orgId: acc?.org_id || null,
      scopes: rec.scopes || [],
    };
  }
  return {
    ok: false,
    error: 'credential_required',
    status: 401,
    message: 'Provide a service-account Bearer token or an X-API-Key',
  };
}

function scopesSubset(requested: string[], caller: string[]): boolean {
  if (caller.includes('*')) return true;
  return requested.every((s) => caller.includes(s));
}

/** Effective scopes of the caller: the stamped header (trusted only with the
 *  internal secret) or the verified credential itself. */
async function resolveCallerScopes(req: express.Request, trustStamped: boolean): Promise<string[]> {
  const stamped = firstHeader((req.headers['x-synapseone-scopes'] ?? req.headers['x-synapsedx-scopes']) as any);
  if (trustStamped && stamped) return stamped.split(',').map((s) => s.trim()).filter(Boolean);
  const h = firstHeader(req.headers.authorization as any);
  if (h.startsWith('Bearer ')) {
    try {
      return verifyAccess(h.slice(7)).scopes || [];
    } catch {
      return [];
    }
  }
  const apiKey = firstHeader(req.headers['x-api-key'] as any);
  if (apiKey) {
    try {
      return (await verifyApiKey(apiKey))?.scopes || [];
    } catch {
      return [];
    }
  }
  return [];
}
/** Tiny in-memory rate limiter (no Redis dep): per-IP token bucket. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref?.();
  void timer;
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = String(req.ip || req.socket?.remoteAddress || 'anon').slice(0, 64);
    const now = Date.now();
    const cur = hits.get(ip);
    if (!cur || cur.reset < now) { hits.set(ip, { n: 1, reset: now + windowMs }); return next(); }
    cur.n++;
    if (cur.n > max) return res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down' });
    return next();
  };
}

const USAGE_MAX_RANGE_MS = 366 * 86_400_000;
type UsageQueryFilter = Omit<UsageFilter, 'orgId'>;

/** Parse + validate the shared usage query parameters (summary + events). */
function parseUsageFilter(req: express.Request): { filter?: UsageQueryFilter; error?: string } {
  const now = Date.now();
  const toRaw = typeof req.query.to === 'string' ? req.query.to : '';
  const fromRaw = typeof req.query.from === 'string' ? req.query.from : '';
  const to = toRaw ? new Date(toRaw) : new Date(now);
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 86_400_000);
  if (!Number.isFinite(to.getTime()) || !Number.isFinite(from.getTime())) {
    return { error: 'from/to must be valid ISO timestamps' };
  }
  if (from.getTime() >= to.getTime()) return { error: 'from must be before to' };
  if (to.getTime() - from.getTime() > USAGE_MAX_RANGE_MS) {
    return { error: 'range must be at most 366 days' };
  }

  const filter: UsageQueryFilter = { from, to };
  if (req.query.feature !== undefined) {
    const feature = String(req.query.feature).trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(feature)) return { error: 'feature must match ^[a-z0-9-]{1,64}$' };
    filter.feature = feature;
  }
  if (req.query.accountId !== undefined) {
    const accountId = String(req.query.accountId);
    if (!isUuid(accountId)) return { error: 'accountId must be a UUID' };
    filter.accountId = accountId;
  }
  if (req.query.actor !== undefined) {
    const actor = String(req.query.actor);
    if (!isUuid(actor)) return { error: 'actor must be a UUID' };
    filter.actor = actor;
  }
  if (req.query.method !== undefined) {
    const method = String(req.query.method).trim().toUpperCase();
    if (!/^[A-Z]{1,16}$/.test(method)) return { error: 'method must be a valid HTTP method' };
    filter.method = method;
  }
  if (req.query.status !== undefined) {
    const status = Number(req.query.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return { error: 'status must be an integer 100..599' };
    }
    filter.status = status;
  }
  if (req.query.statusClass !== undefined) {
    const cls = String(req.query.statusClass).trim().toLowerCase();
    if (!/^[2-5]xx$/.test(cls)) return { error: 'statusClass must be one of 2xx..5xx' };
    filter.statusClass = Number(cls[0]);
  }
  if (req.query.q !== undefined) {
    const q = String(req.query.q).trim().slice(0, 200);
    if (q) filter.q = q;
  }
  if (req.query.limit !== undefined) {
    const limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return { error: 'limit must be an integer 1..200' };
    }
    filter.limit = limit;
  }
  if (req.query.offset !== undefined) {
    const offset = Number(req.query.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      return { error: 'offset must be an integer 0..100000' };
    }
    filter.offset = offset;
  }
  return { filter };
}

export function createApp(): express.Express {
  // Fail-closed production guards (checked at boot, before serving anything).
  if (IS_PROD) {
    if ((process.env.IAM_ALLOW_DEV_LOGIN || 'false') === 'true') {
      throw new Error('[iam] IAM_ALLOW_DEV_LOGIN=true is forbidden in production (passwordless mint). Set false.');
    }
    if ((process.env.IAM_ALLOW_OIDC_DEMO_CALLBACK || 'false') === 'true') {
      throw new Error('[iam] IAM_ALLOW_OIDC_DEMO_CALLBACK=true is forbidden in production (impersonation). Set false.');
    }
    if (!process.env.SYNAPSEONE_INTERNAL_SECRET) {
      throw new Error('[iam] SYNAPSEONE_INTERNAL_SECRET must be set in production (else :4001 is reachable directly).');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('[iam] DATABASE_URL must be set in production (in-memory fallback would split-brain).');
    }
    if (platformFeatureEnabled()) {
      if ((process.env.PLATFORM_ADMIN_REQUIRE_MFA ?? 'true') !== 'true') {
        throw new Error('[iam] PLATFORM_ADMIN_REQUIRE_MFA must be true when the platform console is enabled in production.');
      }
      if ((process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP ?? 'true') !== 'true') {
        throw new Error('[iam] PLATFORM_ADMIN_REQUIRE_STEP_UP must be true when the platform console is enabled in production.');
      }
      const slug = process.env.PLATFORM_ORG_SLUG || 'synapseone-platform';
      if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
        throw new Error('[iam] PLATFORM_ORG_SLUG must match ^[a-z0-9-]{1,64}$.');
      }
      for (const [name, value] of [
        ['PLATFORM_BOOTSTRAP_SECRET', process.env.PLATFORM_BOOTSTRAP_SECRET],
        ['PLATFORM_RECOVERY_SECRET', process.env.PLATFORM_RECOVERY_SECRET],
      ] as const) {
        if (value && value.length < 32) throw new Error(`[iam] ${name} must be at least 32 characters.`);
      }
    }
    // OIDC must be browser-reachable: public HTTPS issuer + redirect (issue #21).
    assertOidcConfig();
  }
  const app = express();
  app.disable('x-powered-by');
  // Baseline security headers (no extra dep; API-only service).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if ((process.env.HSTS_ENABLED || 'false') === 'true') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use(cors((() => {
    const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.length) {
      if (!IS_PROD) console.warn('[iam][security] CORS_ORIGIN not set — allowing all origins (dev default). Set it in production.');
      return undefined;
    }
    return { origin: origins } as any;
  })()));
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  // Echo/propagate x-request-id (gateway sets it; direct callers get one generated
  // here so every response is traceable). Sanitized like the gateway.
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  app.use(express.json({ limit: '1mb' }));

  // Defense-in-depth: IAM KHÔNG tin gateway một cách mù quáng.
  // - SYNAPSEONE_INTERNAL_SECRET (khi được set ở cả gateway + iam): mọi /v1/* (trừ
  //   /health và /v1/auth/*) phải mang header x-synapseone-internal khớp secret.
  //   Chặn truy cập trực tiếp vào :4001 vượt mặt gateway khi secret đã cấu hình.
  // - Kể cả khi secret chưa set (dev), các route còn lại vẫn tự verify Bearer/API key.
  const INTERNAL_SECRET = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[iam][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default). Set it in production so only the gateway can reach IAM.');
  }
  // Stamped x-synapseone-* headers are trusted ONLY when the secret is set:
  // without it, direct callers could spoof any tenant header (dev default).
  const TRUST_STAMPED = INTERNAL_SECRET.length > 0;

  /**
   * True when the request carries an end-user credential or gateway-stamped
   * principal headers. Internal-only ingest/verify endpoints must never be
   * reachable with these: the gateway forwards the original Authorization and
   * stamps the internal secret on every proxied request, so an ordinary
   * tenant could otherwise forge audit/usage rows or probe API keys.
   */
  function hasEndUserCredential(req: express.Request): boolean {
    if (firstHeader(req.headers.authorization as any)) return true;
    if (firstHeader(req.headers['x-api-key'] as any)) return true;
    for (const h of ['x-synapseone-user', 'x-synapseone-org', 'x-synapseone-account', 'x-synapseone-kind']) {
      if (firstHeader(req.headers[h] as any)) return true;
      const legacy = h.replace('x-synapseone-', 'x-synapsedx-');
      if (firstHeader(req.headers[legacy] as any)) return true;
    }
    return false;
  }
/** Fire-and-forget mutation audit trail (#32), scoped to the caller's org. */
async function auditMutation(req: express.Request, action: string, resource: string, extra: Record<string, unknown> = {}): Promise<void> {
  const [org, user] = await Promise.all([
    resolveCallerOrg(req, TRUST_STAMPED),
    resolveCallerUser(req, TRUST_STAMPED),
  ]);
  await writeAuditStrict({
    actor_type: user ? 'user' : 'service',
    actor_id: user || '',
    action,
    resource,
    decision: true,
    context: { ...(org ? { org } : {}), ...(user ? { callerUser: user } : {}), ...extra },
  });
}

  // Audit retention (opt-in): hourly purge of rows older than N days.
  // Default 0 = disabled (zero behavior change); prod sets e.g. 180.
  const RETENTION_DAYS = (() => {
    const n = Number(process.env.AUDIT_RETENTION_DAYS || 0);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 3650) : 0;
  })();
  if (RETENTION_DAYS > 0) {
    const sweep = () => {
      purgeAudit(RETENTION_DAYS).then(
        (n) => {
          if (n > 0) console.log(`[iam] audit retention: purged ${n} rows older than ${RETENTION_DAYS}d`);
        },
        (e) => console.error('[iam] audit retention failed:', e?.message || e),
      );
    };
    setInterval(sweep, 60 * 60 * 1000).unref?.();
    setTimeout(sweep, 30_000).unref?.();
  }
  // Usage telemetry is high-volume: default retention 30 days (0 disables).
  const USAGE_RETENTION_DAYS = (() => {
    const n = Number(process.env.USAGE_RETENTION_DAYS ?? 30);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 3650) : 0;
  })();
  if (USAGE_RETENTION_DAYS > 0) {
    const sweep = () => {
      purgeUsage(USAGE_RETENTION_DAYS).then(
        (n) => {
          if (n > 0) console.log(`[iam] usage retention: purged ${n} rows older than ${USAGE_RETENTION_DAYS}d`);
        },
        (e) => console.error('[iam] usage retention failed:', e?.message || e),
      );
    };
    setInterval(sweep, 60 * 60 * 1000).unref?.();
    setTimeout(sweep, 45_000).unref?.();
  }
  const PUBLIC_PREFIXES = ['/v1/auth/'];
  const PUBLIC_EXACT = new Set(['/v1/auth']);
  app.use(((async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const p = req.path;
    if (p === '/health' || PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((x) => p.startsWith(x))) return next();
    // Gateway telemetry + data-plane audit ingest: authenticated by the shared
    // internal secret in the handler itself (no end-user credential).
    if (p === '/v1/usage/ingest' || p === '/v1/audit/ingest') return next();
    // SCIM carries its own scoped bearer token (never a user session).
    if (p.startsWith('/scim/')) return next();
    // Gateway-only endpoints (central authorization). There is no gateway
    // route for /internal/*, so clients cannot reach them through the edge;
    // the shared secret authenticates the gateway itself.
    if (p.startsWith('/internal/')) {
      if (INTERNAL_SECRET) {
        const got = firstHeader((req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal']) as any);
        if (!got || !secretsEqual(got, INTERNAL_SECRET)) {
          return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
        }
      }
      return next();
    }
    if (INTERNAL_SECRET) {
      const got = firstHeader((req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal']) as any);
      if (!got || !secretsEqual(got, INTERNAL_SECRET)) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
      }
      // Defense-in-depth: internal secret alone is NOT enough — also require a
      // valid caller credential (gateway forwards the original Authorization).
      // /v1/keys/verify is the sole exception (gateway calls it with internal only).
      if (p === '/v1/keys/verify') return next();
      const h = firstHeader(req.headers.authorization as any);
      if (h.startsWith('Bearer ')) {
        try {
          const claims = verifyAccess(h.slice(7));
          if (!(await claimsUserActive(claims))) {
            return res.status(401).json({ error: 'account_deactivated', message: 'This account has been deactivated.' });
          }
          return next();
        } catch { /* fall through */ }
      }
      const apiKey = firstHeader(req.headers['x-api-key'] as any);
      if (apiKey) {
        verifyApiKey(apiKey).then(
          (rec) => (rec ? next() : res.status(401).json({ error: 'invalid_api_key' })),
          () => res.status(503).json({ error: 'iam_unavailable', message: 'credential store unreachable' }),
        );
        return;
      }
      return res.status(401).json({ error: 'unauthorized', message: 'Provide Bearer JWT or X-API-Key' });
    }
    // Dev fallback (no internal secret): verify caller credential directly.
    const h = firstHeader(req.headers.authorization as any);
    if (h.startsWith('Bearer ')) {
      try {
        const claims = verifyAccess(h.slice(7));
        if (!(await claimsUserActive(claims))) {
          return res.status(401).json({ error: 'account_deactivated', message: 'This account has been deactivated.' });
        }
        return next();
      } catch { /* fall through to apikey */ }
    }
    const apiKey = firstHeader(req.headers['x-api-key'] as any);
    if (apiKey) {
      verifyApiKey(apiKey).then(
        (rec) => (rec ? next() : res.status(401).json({ error: 'invalid_api_key' })),
        () => res.status(503).json({ error: 'iam_unavailable', message: 'credential store unreachable' }),
      );
      return;
    }
    // /v1/keys/verify is gateway-internal: in dev (no secret) still allow it so
    // GATEWAY_VERIFY_APIKEY=true keeps working without extra config.
    if (p === '/v1/keys/verify') return next();
    return res.status(401).json({ error: 'unauthorized', message: 'Provide Bearer JWT or X-API-Key' });
  })) as any);

  // Bọc mọi async handler: Express 4 không catch async throw (treo request /
  // unhandledRejection khi lỗi DB như slug trùng). Map unique-violation → 409.
  for (const m of ['get', 'post', 'put', 'delete', 'patch'] as const) {
    const orig = ((app as any)[m] as Function).bind(app);
    (app as any)[m] = (path: string, ...handlers: any[]) =>
      orig(
        path,
        ...handlers.map((h: any) =>
          typeof h === 'function' && h.length < 4
            ? (req: express.Request, res: express.Response, next: express.NextFunction) =>
                Promise.resolve(h(req, res, next)).catch(next)
            : h,
        ),
      );
  }

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'iam', version: VERSION, ...(IS_PROD ? {} : { db: useDb() ? 'postgres' : 'memory' }), time: new Date().toISOString() }));

  if (isDevLoginEnabled()) {
    console.warn('[iam][security] IAM_ALLOW_DEV_LOGIN=true — passwordless dev login ENABLED (any email gets a token). Set false in production.');
  }
  if (isDemoCallbackEnabled()) {
    console.warn('[iam][security] IAM_ALLOW_OIDC_DEMO_CALLBACK=true — OIDC callback trusts caller-supplied email (impersonation possible). Set false in production.');
  }

  // Brute-force guard for credential endpoints (in-memory; edge WAF still required in prod).
  const authLimiter = rateLimit(
    Math.max(1, Number(process.env.IAM_AUTH_RATE_LIMIT_PER_MIN) || 60),
    60_000,
  );
  // `/v1/auth/verify` is a machine-to-machine token check that Tier-2 calls on
  // every write. Keep the brute-force ceiling for credential endpoints while
  // letting verification use the internal-service traffic path.
  app.use('/v1/auth/', ((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path === '/verify') return next();
    return authLimiter(req, res, next);
  }) as any);
  // SCIM is machine-to-machine but still needs a brute-force / abuse ceiling.
  const scimLimiter = rateLimit(120, 60_000);
  app.use('/scim/', scimLimiter as any);
  // Per-route ceiling for second-factor and account-recovery endpoints
  // (per-user lockout in mfa.ts is the primary brute-force defence).
  const mfaLimiter = expressRateLimit({
    windowMs: 60_000,
    limit: Math.max(1, Number(process.env.IAM_MFA_RATE_LIMIT_PER_MIN) || 60),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many requests, slow down' },
  });
  // Same ceiling on password/dev sign-in (per-user lockout lives in mfa.ts).
  const loginLimiter = expressRateLimit({
    windowMs: 60_000,
    limit: Math.max(1, Number(process.env.IAM_LOGIN_RATE_LIMIT_PER_MIN) || 60),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many sign-in attempts, slow down' },
  });

  // ---------- OIDC discovery (Authentik, Keycloak, or any OIDC IdP) ----------
  app.get('/v1/auth/oidc/config', (_req, res) => {
    const cfg = oidcSettings();
    res.json({
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      provider: cfg.provider,
      codeExchange: true,
      // Whether a browser can actually reach the configured IdP (public HTTPS).
      // Local development may use an http://localhost IdP; production must not.
      issuerPublic: isPublicHttpsUrl(cfg.issuer),
      ssoAvailable: isPublicHttpsUrl(cfg.issuer) || process.env.NODE_ENV !== 'production',
      demoCallback: isDemoCallbackEnabled(),
      note: 'Federated OIDC upstream. IAM keeps the shadow user + org/account/role/policy authorization.',
    });
  });

  app.get('/v1/auth/oidc/start', async (req, res) => {
    const cfg = oidcSettings();
    if (process.env.NODE_ENV === 'production' && !isPublicHttpsUrl(cfg.issuer)) {
      return res.status(503).json({
        error: 'sso_unavailable',
        message: 'SSO is not available: the configured issuer is not a public HTTPS URL.',
      });
    }
    const org = typeof req.query.org === 'string' ? req.query.org.trim().toLowerCase() : '';
    if (!/^[a-z0-9-]{1,64}$/.test(org)) {
      return res.status(400).json({
        error: 'oidc_org_required',
        message: 'Choose an organization before signing in with SSO.',
      });
    }
    const allowed = oidcAllowedOrgs();
    if (allowed.length && !allowed.includes(org)) {
      return res.status(403).json({ error: 'org_not_allowed', message: `organization '${org}' is not allowed for SSO` });
    }
    // Signed state binds org + nonce + encrypted PKCE verifier + 10-minute expiry.
    const { state, nonce, codeChallenge } = createOidcState(org);
    try {
      // Use the IdP's discovery document instead of guessing `<issuer>/authorize`;
      // this validates the endpoint (https + issuer origin in production).
      const endpoint = await authorizationEndpoint(cfg.issuer);
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        scope: 'openid email profile',
        redirect_uri: cfg.redirectUri,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      const sep = endpoint.includes('?') ? '&' : '?';
      res.json({ authorizeUrl: `${endpoint}${sep}${params.toString()}`, state, nonce });
    } catch (e: any) {
      if (e instanceof OidcError) {
        return res.status(e.status).json({ error: e.code, message: e.message, issuer: cfg.issuer });
      }
      res.status(502).json({ error: 'oidc_discovery_failed', message: e?.message || String(e), issuer: cfg.issuer });
    }
  });

  // Callback: two modes.
  // 1. Real Authorization Code flow (`code` + signed `state`): exchanged at the
  //    IdP token endpoint and the ID token is signature-verified against the
  //    IdP JWKS. Works in every environment, including production.
  // 2. Demo email callback (dev only): trusts the caller-supplied email, hence
  //    impersonation-prone. Disable in production with
  //    IAM_ALLOW_OIDC_DEMO_CALLBACK=false.
  app.post('/v1/auth/oidc/callback', async (req, res) => {
    try {
      const demoAllowed = isDemoCallbackEnabled();
      const { email, sub, displayName, orgSlug, code, state } = (req.body || {}) as any;
      if (typeof code === 'string' && code) {
        if (typeof state !== 'string' || !state) {
          return res.status(400).json({ error: 'oidc_state_required', message: 'Signed `state` from /v1/auth/oidc/start is required with `code`.' });
        }
        try {
          const id = await exchangeCode(code, state);
          // #9: new org → self-service; existing org → membership required.
          const resolved = await resolveOidcIdentity(id.org, id.email, id.displayName, id.sub);
          if ('error' in resolved) {
            return res.status(403).json({ error: resolved.error, message: resolved.message });
          }
          const user = await bootstrapOrgAdmin(resolved.user);
          if (user.active === false) return res.status(403).json({ error: 'account_deactivated', message: 'This account has been deactivated.' });
          // Do not silently bypass local MFA assurance. Users with an enrolled
          // TOTP factor must complete it even when the upstream IdP signed them in.
          if (await mfaEnabled(user.id)) {
            const left = await lockRemaining(user.id);
            if (left > 0) return sendLocked(res, left);
            return sendMfaChallenge(res, user.id, 'oidc');
          }
          const { token, expiresIn } = signAccess({ sub: user.id, email: user.email, org: user.org_id });
          const rt = newRefreshToken();
          await storeRefresh(user.id, rt.hash, refreshExpiry());
          await logAudit({
            actor_type: 'user', actor_id: user.id, action: 'iam:auth:login', resource: `user:${user.id}`,
            decision: true, context: { org: user.org_id, method: 'oidc', provider: oidcSettings().provider },
          }).catch(() => undefined);
          noStore(res);
          return res.json({ accessToken: token, expiresIn, refreshToken: rt.value, user: publicUser(user) });
        } catch (e: any) {
          if (e instanceof OidcError) {
            return res.status(e.status).json({ error: e.code, message: e.message });
          }
          throw e;
        }
      }
      if (!demoAllowed) {
        return res.status(501).json({
          error: 'oidc_code_required',
          message: 'Demo email callback is disabled (IAM_ALLOW_OIDC_DEMO_CALLBACK=false). Provide an authorization `code` (+ signed `state`) for real IdP exchange.',
        });
      }
      const schema = z.object({
        email: z.string().trim().toLowerCase().email().max(320),
        orgSlug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/).nullish(),
      });
      const parsed = schema.safeParse({ email, orgSlug });
      if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
      const normEmail = parsed.data.email;
      const slug = parsed.data.orgSlug || 'acme';
      const safeName = sanitizeName(typeof displayName === 'string' && displayName.trim() ? displayName : normEmail);
      const safeSub = sanitizeName(typeof sub === 'string' && sub.trim() ? sub : normEmail, 320);
      // #9: same membership rule as the real code flow (no auto-join of an
      // existing org by email alone).
      const resolved = await resolveOidcIdentity(slug, normEmail, safeName, safeSub);
      if ('error' in resolved) {
        return res.status(403).json({ error: resolved.error, message: resolved.message });
      }
      const user = await bootstrapOrgAdmin(resolved.user);
      if (user.active === false) return res.status(403).json({ error: 'account_deactivated', message: 'This account has been deactivated.' });
      if (await mfaEnabled(user.id)) return sendMfaChallenge(res, user.id, 'oidc');
      const { token, expiresIn } = signAccess({ sub: user.id, email: user.email, org: user.org_id });
      const rt = newRefreshToken();
      await storeRefresh(user.id, rt.hash, refreshExpiry());
      noStore(res);
      res.json({ accessToken: token, expiresIn, refreshToken: rt.value, user: publicUser(user) });
    } catch (e: any) {
      res.status(500).json({ error: 'oidc_callback_failed', message: e.message });
    }
  });

  // Login supports three paths:
  //  1. email + password (first-party credential; works in production),
  //  2. email only when IAM_ALLOW_DEV_LOGIN=true (dev/test passwordless),
  //  3. OIDC code exchange (see /v1/auth/oidc/callback).
  // ---------- SCIM 2.0 provisioning (#48) ----------
  async function scimContext(req: express.Request, res: express.Response, write = false) {
    const h = firstHeader(req.headers.authorization as any);
    if (!h.startsWith('Bearer ')) {
      res.status(401).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'SCIM bearer token required', status: '401' });
      return null;
    }
    const token = await verifyScimToken(h.slice(7));
    if (!token) {
      res.status(401).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'invalid or expired SCIM token', status: '401' });
      return null;
    }
    if (write && !token.scopes.includes('scim:write')) {
      res.status(403).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'scim:write scope required', status: '403' });
      return null;
    }
    return token;
  }

  function scimList(resources: any[], startIndex: number, count: number, total?: number) {
    const totalResults = total ?? resources.length;
    const start = Math.max(1, startIndex);
    const page = resources.slice(start - 1, start - 1 + count);
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults,
      startIndex: start,
      itemsPerPage: page.length,
      Resources: page,
    };
  }

  function scimError(res: express.Response, status: number, detail: string, scimType?: string) {
    res.status(status).json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      detail, status: String(status), ...(scimType ? { scimType } : {}),
    });
  }

  async function scimUserView(user: any, orgId: string) {
    const groups = await listScimGroups(orgId);
    return toScimUser(user, groups);
  }

  app.get('/scim/v2/Users', async (req, res) => {
    const token = await scimContext(req, res);
    if (!token) return;
    const users = await listUsers(token.orgId);
    const filter = parseScimFilter((req.query as any).filter);
    if ((req.query as any).filter && !filter) return scimError(res, 400, 'unsupported filter', 'invalidFilter');
    const groups = await listScimGroups(token.orgId);
    const views = users.map((u) => toScimUser(u, groups)).filter((v) => matchesScimFilter(v, filter));
    const startIndex = Number((req.query as any).startIndex) || 1;
    const count = Math.min(Math.max(Number((req.query as any).count) || 100, 1), 1000);
    res.setHeader('cache-control', 'no-store');
    res.json(scimList(views, startIndex, count));
  });

  app.get('/scim/v2/Users/:id', async (req, res) => {
    const token = await scimContext(req, res);
    if (!token) return;
    if (!isUuid(req.params.id)) return scimError(res, 404, 'user not found');
    const user = await getUserById(req.params.id);
    if (!user || user.org_id !== token.orgId) return scimError(res, 404, 'user not found');
    res.json(await scimUserView(user, token.orgId));
  });

  app.post('/scim/v2/Users', async (req, res) => {
    const token = await scimContext(req, res, true);
    if (!token) return;
    const b = (req.body || {}) as any;
    const email = String(b.userName || b.emails?.[0]?.value || '').trim().toLowerCase();
    if (!validScimEmail(email)) return scimError(res, 400, 'userName must be an email', 'invalidValue');
    if (await findUserByOrgEmail(token.orgId, email)) return scimError(res, 409, 'user already exists', 'uniqueness');
    const user = await upsertUser(token.orgId, email, sanitizeName(b.displayName || b.name?.formatted || email), b.externalId ? String(b.externalId).slice(0, 256) : undefined);
    if (b.externalId) await updateUserProfile(user.id, { externalSub: String(b.externalId).slice(0, 256) });
    if (b.active === false) await setUserActive(user.id, false);
    const fresh = await getUserById(user.id);
    await auditMutation(req, 'iam:scim:user:create', `user:${user.id}`, { org: token.orgId, email, tokenId: token.id });
    res.status(201).setHeader('location', `/scim/v2/Users/${user.id}`);
    res.json(await scimUserView(fresh || user, token.orgId));
  });

  app.put('/scim/v2/Users/:id', async (req, res) => {
    const token = await scimContext(req, res, true);
    if (!token) return;
    if (!isUuid(req.params.id)) return scimError(res, 404, 'user not found');
    const user = await getUserById(req.params.id);
    if (!user || user.org_id !== token.orgId) return scimError(res, 404, 'user not found');
    const b = (req.body || {}) as any;
    const email = String(b.userName || b.emails?.[0]?.value || user.email).trim().toLowerCase();
    if (email !== user.email) return scimError(res, 409, 'userName is immutable; use deactivate + create', 'mutability');
    const displayName = b.displayName || b.name?.formatted;
    if (displayName !== undefined || b.externalId !== undefined || b.active !== undefined) {
      await updateUserProfile(user.id, {
        ...(displayName !== undefined ? { displayName: sanitizeName(displayName) } : {}),
        ...(b.externalId !== undefined ? { externalSub: b.externalId ? String(b.externalId).slice(0, 256) : null } : {}),
      });
      if (b.active !== undefined) {
        const active = b.active !== false;
        await setUserActive(user.id, active);
        if (!active) {
          await revokeAllRefresh(user.id);
          await revokeApiKeysForUser(user.id);
        }
      }
      await auditMutation(req, 'iam:scim:user:replace', `user:${user.id}`, { org: token.orgId, tokenId: token.id });
    }
    const fresh = await getUserById(user.id);
    res.json(await scimUserView(fresh || user, token.orgId));
  });

  app.patch('/scim/v2/Users/:id', async (req, res) => {
    const token = await scimContext(req, res, true);
    if (!token) return;
    if (!isUuid(req.params.id)) return scimError(res, 404, 'user not found');
    const user = await getUserById(req.params.id);
    if (!user || user.org_id !== token.orgId) return scimError(res, 404, 'user not found');
    const ops = (req.body || {}).Operations;
    if (!Array.isArray(ops) || !ops.length) return scimError(res, 400, 'Operations[] required', 'invalidSyntax');
    let displayName: string | undefined;
    let externalSub: string | null | undefined;
    let active: boolean | undefined;
    for (const op of ops.slice(0, 50)) {
      const verb = String(op?.op || '').toLowerCase();
      const path = String(op?.path || '').toLowerCase();
      if (verb === 'replace' || verb === 'add') {
        if (path === 'active' || (!path && op?.value && typeof op.value === 'object' && 'active' in op.value)) {
          const value = path ? op.value : op.value.active;
          if (typeof value !== 'boolean') return scimError(res, 400, 'active must be boolean', 'invalidValue');
          active = value;
        } else if (path === 'displayname' || path === 'name.formatted') {
          displayName = sanitizeName(op.value);
        } else if (path === 'externalid') {
          externalSub = op.value ? String(op.value).slice(0, 256) : null;
        } else {
          return scimError(res, 400, `unsupported patch path '${op?.path || '(none)'}'`, 'invalidPath');
        }
      } else if (verb === 'remove' && path === 'active') {
        return scimError(res, 400, 'active is required', 'invalidPath');
      } else {
        return scimError(res, 400, `unsupported operation '${op?.op}'`, 'invalidSyntax');
      }
    }
    if (displayName !== undefined || externalSub !== undefined) {
      await updateUserProfile(user.id, { ...(displayName !== undefined ? { displayName } : {}), ...(externalSub !== undefined ? { externalSub } : {}) });
    }
    if (active !== undefined) {
      await setUserActive(user.id, active);
      if (!active) {
        await revokeAllRefresh(user.id);
        await revokeApiKeysForUser(user.id);
      }
    }
    await auditMutation(req, 'iam:scim:user:patch', `user:${user.id}`, { org: token.orgId, tokenId: token.id, active });
    const fresh = await getUserById(user.id);
    res.json(await scimUserView(fresh || user, token.orgId));
  });

  app.delete('/scim/v2/Users/:id', async (req, res) => {
    const token = await scimContext(req, res, true);
    if (!token) return;
    if (!isUuid(req.params.id)) return scimError(res, 404, 'user not found');
    const user = await getUserById(req.params.id);
    if (!user || user.org_id !== token.orgId) return scimError(res, 404, 'user not found');
    await setUserActive(user.id, false);
    const revokedSessions = await revokeAllRefresh(user.id);
    const revokedKeys = await revokeApiKeysForUser(user.id);
    await auditMutation(req, 'iam:scim:user:deactivate', `user:${user.id}`, { org: token.orgId, tokenId: token.id, revokedSessions, revokedKeys });
    res.status(204).end();
  });

  // ---- SCIM Groups ----
  async function scimGroupView(group: any): Promise<any> {
    const view = toScimGroup(group);
    view.members = await Promise.all(group.members.map(async (id: string) => {
      const user = await getUserById(id);
      return { value: id, ...(user ? { display: user.email } : {}) };
    }));
    return view;
  }

  async function applyGroupRoles(orgId: string, group: any, memberIds: string[]): Promise<void> {
    if (!group.account_id || !group.roles?.length) return;
    const roles = await listRoles(group.account_id);
    for (const userId of memberIds) {
      const user = await getUserById(userId);
      if (!user || user.org_id !== orgId) continue;
      for (const slug of group.roles) {
        const role = roles.find((r) => r.slug === slug);
        if (role) await assignRole(userId, role.id);
      }
    }
  }

  async function revokeGroupRoles(orgId: string, group: any, memberIds: string[]): Promise<void> {
    if (!group.account_id || !group.roles?.length) return;
    const roles = await listRoles(group.account_id);
    for (const userId of memberIds) {
      const user = await getUserById(userId);
      if (!user || user.org_id !== orgId) continue;
      for (const slug of group.roles) {
        const role = roles.find((r) => r.slug === slug);
        if (role) await unassignRole(userId, role.id);
      }
    }
  }

  app.get('/scim/v2/Groups', async (req, res) => {
    const token = await scimContext(req, res);
    if (!token) return;
    const groups = await listScimGroups(token.orgId);
    const filter = parseScimFilter((req.query as any).filter);
    if ((req.query as any).filter && !filter) return scimError(res, 400, 'unsupported filter', 'invalidFilter');
    const views = await Promise.all(groups.map(scimGroupView));
    const filtered = views.filter((v) => matchesScimFilter(v, filter));
    res.json(scimList(filtered, Number((req.query as any).startIndex) || 1, Math.min(Math.max(Number((req.query as any).count) || 100, 1), 1000)));
  });

  app.get('/scim/v2/Groups/:id', async (req, res) => {
    const token = await scimContext(req, res);
    if (!token) return;
    const group = isUuid(req.params.id) ? await getScimGroup(token.orgId, req.params.id) : null;
    if (!group) return scimError(res, 404, 'group not found');
    res.json(await scimGroupView(group));
  });

  app.post('/scim/v2/Groups', async (req, res) => {
    const token = await scimContext(req, res, true);
    if (!token) return;
    const b = (req.body || {}) as any;
    const displayName = sanitizeName(b.displayName, 200);
    if (!displayName) return scimError(res, 400, 'displayName required', 'invalidValue');
    const existing = (await listScimGroups(token.orgId)).find((g) => g.display_name.toLowerCase() === displayName.toLowerCase());
    if (existing) return scimError(res, 409, 'group already exists', 'uniqueness');
    const accounts = await listAccounts(token.orgId);
    const accountId = b.accountId ? String(b.accountId) : accounts[0]?.id || null;
    if (accountId && !accounts.some((a) => a.id === accountId)) return scimError(res, 400, 'accountId is outside the tenant', 'invalidValue');
    const roles = Array.isArray(b.roles) ? b.roles.map(String).slice(0, 20) : [];
    if (roles.length) {
      const available = accountId ? await listRoles(accountId) : [];
      const unknown = roles.filter((slug: string) => !available.some((r) => r.slug === slug));
      if (unknown.length) return scimError(res, 400, `unknown roles: ${unknown.join(', ')}`, 'invalidValue');
    }
    const members = Array.isArray(b.members) ? b.members.map((m: any) => String(m?.value || m)).filter(Boolean).slice(0, 5000) : [];
    const group = await createScimGroup(token.orgId, {
      displayName, accountId, externalId: b.externalId ? String(b.externalId).slice(0, 256) : null, members, roles,
    });
    await applyGroupRoles(token.orgId, group, members);
    await auditMutation(req, 'iam:scim:group:create', `group:${group.id}`, { org: token.orgId, tokenId: token.id, roles });
    res.status(201).setHeader('location', `/scim/v2/Groups/${group.id}`);
    res.json(await scimGroupView(group));
  });

  app.patch('/scim/v2/Groups/:id', async (req, res) => {
    const token = await scimContext(req, res, true);
    if (!token) return;
    const group = isUuid(req.params.id) ? await getScimGroup(token.orgId, req.params.id) : null;
    if (!group) return scimError(res, 404, 'group not found');
    const ops = (req.body || {}).Operations;
    if (!Array.isArray(ops) || !ops.length) return scimError(res, 400, 'Operations[] required', 'invalidSyntax');
    let members = [...group.members];
    let displayName = group.display_name;
    let roles = [...group.roles];
    for (const op of ops.slice(0, 50)) {
      const verb = String(op?.op || '').toLowerCase();
      const path = String(op?.path || '').toLowerCase();
      const values = Array.isArray(op?.value) ? op.value.map((v: any) => String(v?.value || v)).filter(Boolean) : [];
      if (path === 'members' && (verb === 'add' || verb === 'replace')) {
        if (verb === 'replace') members = values;
        else for (const id of values) if (!members.includes(id)) members.push(id);
      } else if (path === 'members' && verb === 'remove') {
        const target = op?.value ? String(op.value?.value || op.value) : '';
        members = target ? members.filter((id) => id !== target) : [];
      } else if (path === 'displayname' && verb === 'replace') {
        displayName = sanitizeName(op.value, 200);
      } else if (path === 'roles' && verb === 'replace') {
        roles = Array.isArray(op.value) ? op.value.map(String).slice(0, 20) : [];
      } else {
        return scimError(res, 400, `unsupported patch path '${op?.path || '(none)'}'`, 'invalidPath');
      }
    }
    const before = new Set(group.members);
    const after = new Set(members);
    const added = members.filter((id) => !before.has(id));
    const removed = group.members.filter((id) => !after.has(id));
    const updated = await updateScimGroup(token.orgId, group.id, { members, displayName, roles });
    if (!updated) return scimError(res, 404, 'group not found');
    if (roles.length !== group.roles.length) await revokeGroupRoles(token.orgId, group, group.members);
    await applyGroupRoles(token.orgId, updated, added);
    await revokeGroupRoles(token.orgId, group, removed);
    await auditMutation(req, 'iam:scim:group:patch', `group:${group.id}`, { org: token.orgId, tokenId: token.id, added, removed });
    res.json(await scimGroupView(updated));
  });

  app.delete('/scim/v2/Groups/:id', async (req, res) => {
    const token = await scimContext(req, res, true);
    if (!token) return;
    const group = isUuid(req.params.id) ? await getScimGroup(token.orgId, req.params.id) : null;
    if (!group) return scimError(res, 404, 'group not found');
    await revokeGroupRoles(token.orgId, group, group.members);
    await deleteScimGroup(token.orgId, group.id);
    await auditMutation(req, 'iam:scim:group:delete', `group:${group.id}`, { org: token.orgId, tokenId: token.id });
    res.status(204).end();
  });

  // ---- SCIM token lifecycle ----
  app.post('/v1/scim/tokens', async (req, res) => {
    const org = await resolveCallerOrg(req, TRUST_STAMPED);
    if (!org) return res.status(403).json({ error: 'org_required', message: 'SCIM tokens are org-scoped' });
    if (!(await requireSensitiveMutation(req, res, TRUST_STAMPED, org, 'iam:scim:token:create'))) return;
    const b = (req.body || {}) as any;
    const scopes = Array.isArray(b.scopes)
      ? b.scopes.map(String).filter((s: string) => s === 'scim:read' || s === 'scim:write')
      : ['scim:read', 'scim:write'];
    if (!scopes.length) return res.status(400).json({ error: 'invalid_scopes' });
    const created = await createScimToken({
      orgId: org, description: b.description ? String(b.description).slice(0, 300) : '',
      scopes, createdBy: await resolveCallerUser(req, TRUST_STAMPED),
      ttlSeconds: b.ttlSeconds === undefined ? null : Number(b.ttlSeconds),
    });
    await auditMutation(req, 'iam:scim:token:create', `scim-token:${created.record.id}`, { org, scopes });
    res.status(201).json({
      id: created.record.id, token: created.token, orgId: org, scopes,
      expiresAt: created.record.expires_at,
      hint: 'Store this token now; it is never shown again.',
    });
  });

  app.get('/v1/scim/tokens', async (req, res) => {
    const org = await resolveCallerOrg(req, TRUST_STAMPED);
    if (!org) return res.status(403).json({ error: 'org_required' });
    if (!(await requireSensitiveMutation(req, res, TRUST_STAMPED, org, 'iam:scim:token:list'))) return;
    res.setHeader('cache-control', 'no-store');
    res.json({ items: await listScimTokens(org) });
  });

  app.delete('/v1/scim/tokens/:id', async (req, res) => {
    const org = await resolveCallerOrg(req, TRUST_STAMPED);
    if (!org) return res.status(403).json({ error: 'org_required' });
    if (!(await requireSensitiveMutation(req, res, TRUST_STAMPED, org, 'iam:scim:token:revoke'))) return;
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const ok = await revokeScimToken(org, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    await auditMutation(req, 'iam:scim:token:revoke', `scim-token:${req.params.id}`, { org });
    res.json({ ok: true });
  });

  app.post('/v1/auth/login', loginLimiter, async (req, res) => {
    const schema = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      password: z.string().max(PASSWORD_MAX).optional(),
      orgSlug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/).nullish(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const { email, password, orgSlug } = parsed.data;
    const slug = orgSlug || 'acme';

    if (password !== undefined) {
      const org = await getOrgBySlug(slug);
      const user = org ? await findUserByOrgEmail(org.id, email) : null;
      if (user) {
        const left = await lockRemaining(user.id);
        if (left > 0) return sendLocked(res, left);
      }
      // Constant-ish work for unknown users; never reveal whether the account exists.
      const ok = user ? await verifyPassword(password, user.password_hash) : false;
      if (user && user.active === false) {
        return res.status(403).json({ error: 'account_deactivated', message: 'This account has been deactivated by an administrator.' });
      }
      if (!user || !ok) {
        const lockedFor = user ? await recordLoginFailure(user.id) : 0;
        await logAudit({
          actor_type: 'user', actor_id: user?.id || '', action: 'iam:auth:login', resource: `org:${org?.id || slug}`,
          decision: false, context: { method: 'password', email, ...(org ? { org: org.id } : {}), ...(lockedFor ? { lockedForSeconds: lockedFor } : {}) },
        }).catch(() => undefined);
        return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect' });
      }
      // Second factor: the password alone never yields a session. Failures
      // keep counting until the whole login succeeds.
      if (await mfaEnabled(user.id)) return sendMfaChallenge(res, user.id, 'pwd');
      await clearLoginFailures(user.id);
      const session = await issueSession(user);
      await logAudit({
        actor_type: 'user', actor_id: user.id, action: 'iam:auth:login', resource: `org:${user.org_id}`,
        decision: true, context: { method: 'password', org: user.org_id },
      }).catch(() => undefined);
      noStore(res);
      return res.json(session);
    }

    if (!isDevLoginEnabled()) {
      return res.status(403).json({
        error: 'dev_login_disabled',
        message: 'Passwordless dev login is disabled. Use email+password or the OIDC flow.',
      });
    }
    const existingOrg = await getOrgBySlug(slug);
    if (!existingOrg && slug.toLowerCase() === (process.env.PLATFORM_ORG_SLUG || 'synapseone-platform').toLowerCase()) {
      return res.status(403).json({ error: 'reserved_org_slug', message: 'This organization slug is reserved for platform administration.' });
    }
    const org = existingOrg || (await createOrganization(slug, slug));
    const user = await bootstrapOrgAdmin(await upsertUser(org.id, email, email));
    if (user.active === false) {
      return res.status(403).json({ error: 'account_deactivated', message: 'This account has been deactivated by an administrator.' });
    }
    if (await mfaEnabled(user.id)) {
      const left = await lockRemaining(user.id);
      if (left > 0) return sendLocked(res, left);
      return sendMfaChallenge(res, user.id, 'dev');
    }
    const session = await issueSession(user);
    noStore(res);
    res.json(session);
  });

  // ---------- Multi-factor authentication (TOTP) ----------
  // Step 2 of a login that returned 401 mfa_required.
  app.post('/v1/auth/mfa/verify', mfaLimiter, async (req, res) => {
    const parsed = z.object({
      mfaToken: z.string().min(1).max(4096),
      code: z.string().trim().max(16).nullish(),
      recoveryCode: z.string().trim().max(32).nullish(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const { mfaToken, code, recoveryCode } = parsed.data;
    if (!code && !recoveryCode) return res.status(400).json({ error: 'invalid_body', message: 'code or recoveryCode required' });
    const challenge = verifyMfaChallenge(mfaToken);
    if (!challenge) return res.status(401).json({ error: 'invalid_mfa_token', message: 'The sign-in challenge expired. Sign in again.' });
    const user = await getUserById(challenge.sub);
    if (!user) return res.status(401).json({ error: 'invalid_mfa_token' });
    if (user.active === false) {
      return res.status(403).json({ error: 'account_deactivated', message: 'This account has been deactivated by an administrator.' });
    }
    const left = await lockRemaining(user.id);
    if (left > 0) return sendLocked(res, left);
    const result = await checkSecondFactor(user.id, { code, recoveryCode });
    if (!result.ok) {
      const lockedFor = await recordLoginFailure(user.id);
      await logAudit({
        actor_type: 'user', actor_id: user.id, action: 'iam:auth:mfa', resource: `user:${user.id}`,
        decision: false, context: { org: user.org_id, method: recoveryCode ? 'recovery' : 'totp', ...(lockedFor ? { lockedForSeconds: lockedFor } : {}) },
      }).catch(() => undefined);
      return res.status(401).json({ error: 'invalid_mfa_code', message: 'The verification code is incorrect' });
    }
    await clearLoginFailures(user.id);
    const session = await issueSession(user);
    await logAudit({
      actor_type: 'user', actor_id: user.id, action: 'iam:auth:login', resource: `org:${user.org_id}`,
      decision: true, context: { method: challenge.amr[0] || 'pwd', mfa: result.method, org: user.org_id, recoveryCodesRemaining: result.remainingRecovery },
    }).catch(() => undefined);
    noStore(res);
    res.json({ ...session, mfa: { method: result.method, recoveryCodesRemaining: result.remainingRecovery } });
  });

  app.get('/v1/auth/mfa', mfaLimiter, async (req, res) => {
    const caller = await requireUserCaller(req, res);
    if (!caller) return;
    const rec = await getMfa(caller.id);
    noStore(res);
    res.json({
      enabled: !!rec?.enabled,
      pending: !!rec && !rec.enabled,
      methods: rec?.enabled ? ['totp', 'recovery'] : [],
      recoveryCodesRemaining: rec?.enabled ? rec.recovery_hashes.length : 0,
      enabledAt: rec?.enabled_at ?? null,
    });
  });

  app.post('/v1/auth/mfa/totp/setup', mfaLimiter, async (req, res) => {
    const caller = await requireUserCaller(req, res);
    if (!caller) return;
    const started = await beginTotpEnrolment(caller.id);
    if (!started) return res.status(409).json({ error: 'mfa_already_enabled', message: 'Disable the current authenticator before enrolling a new one' });
    noStore(res);
    res.json({ secret: started.secret, otpauthUrl: otpauthUrl(started.secret, caller.email), period: TOTP_PERIOD, digits: TOTP_DIGITS, algorithm: 'SHA1' });
  });

  app.post('/v1/auth/mfa/totp/enable', mfaLimiter, async (req, res) => {
    const caller = await requireUserCaller(req, res);
    if (!caller) return;
    const parsed = z.object({ code: z.string().trim().max(16) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: 'code required' });
    const rec = await getMfa(caller.id);
    if (!rec) return res.status(409).json({ error: 'mfa_not_started', message: 'Call /v1/auth/mfa/totp/setup first' });
    if (rec.enabled) return res.status(409).json({ error: 'mfa_already_enabled' });
    const check = await checkSecondFactor(caller.id, { code: parsed.data.code }, false);
    if (!check.ok) return res.status(400).json({ error: 'invalid_mfa_code', message: 'The verification code is incorrect' });
    const recoveryCodes = await enableTotp(caller.id);
    await logAudit({
      actor_type: 'user', actor_id: caller.id, action: 'iam:mfa:enable', resource: `user:${caller.id}`,
      decision: true, context: { org: caller.org_id, method: 'totp' },
    }).catch(() => undefined);
    noStore(res);
    res.json({ enabled: true, recoveryCodes });
  });

  app.post('/v1/auth/mfa/recovery-codes', mfaLimiter, async (req, res) => {
    const caller = await requireUserCaller(req, res);
    if (!caller) return;
    const parsed = z.object({ code: z.string().trim().max(16) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: 'code required' });
    if (!(await mfaEnabled(caller.id))) return res.status(409).json({ error: 'mfa_not_enabled' });
    const check = await checkSecondFactor(caller.id, { code: parsed.data.code });
    if (!check.ok) return res.status(401).json({ error: 'invalid_mfa_code', message: 'The verification code is incorrect' });
    const recoveryCodes = await regenerateRecoveryCodes(caller.id);
    await logAudit({
      actor_type: 'user', actor_id: caller.id, action: 'iam:mfa:recovery-codes', resource: `user:${caller.id}`,
      decision: true, context: { org: caller.org_id },
    }).catch(() => undefined);
    noStore(res);
    res.json({ recoveryCodes });
  });

  app.post('/v1/auth/mfa/disable', mfaLimiter, async (req, res) => {
    const caller = await requireUserCaller(req, res);
    if (!caller) return;
    const parsed = z.object({
      code: z.string().trim().max(16).nullish(),
      recoveryCode: z.string().trim().max(32).nullish(),
    }).safeParse(req.body);
    if (!parsed.success || (!parsed.data.code && !parsed.data.recoveryCode)) {
      return res.status(400).json({ error: 'invalid_body', message: 'code or recoveryCode required' });
    }
    if (!(await mfaEnabled(caller.id))) {
      await removeMfa(caller.id); // drop an unfinished enrolment
      return res.json({ enabled: false });
    }
    const check = await checkSecondFactor(caller.id, parsed.data);
    if (!check.ok) return res.status(401).json({ error: 'invalid_mfa_code', message: 'The verification code is incorrect' });
    await removeMfa(caller.id);
    await logAudit({
      actor_type: 'user', actor_id: caller.id, action: 'iam:mfa:disable', resource: `user:${caller.id}`,
      decision: true, context: { org: caller.org_id },
    }).catch(() => undefined);
    res.json({ enabled: false });
  });

  // ---------- First-party credential lifecycle (#22) ----------
  app.post('/v1/auth/register', async (req, res) => {
    if (!isRegistrationEnabled()) {
      return res.status(403).json({ error: 'registration_disabled', message: 'Self-service registration is disabled. Ask an admin to invite you or use OIDC.' });
    }
    const schema = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      password: z.string().min(1).max(PASSWORD_MAX),
      displayName: z.string().trim().max(200).nullish(),
      orgSlug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/).nullish(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const { email, password, displayName, orgSlug } = parsed.data;
    const policyErr = passwordPolicyError(password, email);
    if (policyErr) return res.status(400).json({ error: 'weak_password', message: policyErr });
    const slug = orgSlug || 'acme';

    let org = await getOrgBySlug(slug);
    if (!org) {
      if (slug.toLowerCase() === (process.env.PLATFORM_ORG_SLUG || 'synapseone-platform').toLowerCase()) {
        return res.status(403).json({ error: 'reserved_org_slug', message: 'This organization slug is reserved for platform administration.' });
      }
      if (!registrationAllowsNewOrgs()) {
        return res.status(403).json({ error: 'unknown_org', message: 'Organization does not exist and self-service org creation is disabled' });
      }
      try {
        org = await createOrganization(slug, slug);
      } catch (e: any) {
        org = await getOrgBySlug(slug);
        if (!org) throw e;
      }
    } else {
      // Joining an EXISTING org requires a one-time invite code. Membership
      // grants org-wide access, so an email+slug guess must never be enough.
      const existing = await findUserByOrgEmail(org.id, email);
      if (!existing) {
        return res.status(403).json({
          error: 'org_membership_required',
          message: 'Your email is not invited to this organization. Ask an admin to invite you.',
        });
      }
      if (existing.password_hash) {
        return res.status(409).json({ error: 'account_exists', message: 'An account with this email already has a password. Sign in or reset it.' });
      }
      return res.status(403).json({
        error: 'invite_required',
        message: 'Use the one-time activation code from your administrator.',
      });
    }
    const existing = await findUserByOrgEmail(org.id, email);
    if (existing?.password_hash) {
      return res.status(409).json({ error: 'account_exists', message: 'An account with this email already has a password. Sign in or reset it.' });
    }
    const user = await bootstrapOrgAdmin(await upsertUser(org.id, email, displayName || email));
    await setUserPassword(user.id, await hashPassword(password));
    const verify = newOneTimeToken('verify');
    await storeOneTimeToken(user.id, verify.hash, 'verify', verifyTokenExpiry());
    const session = await issueSession(user);
    await logAudit({
      actor_type: 'user', actor_id: user.id, action: 'iam:user:register', resource: `org:${org.id}`,
      decision: true, context: { org: org.id, email },
    }).catch(() => undefined);
    noStore(res);
    res.status(201).json({
      ...session,
      user: { ...(session.user as any), email_verified: false },
      ...(exposesLifecycleTokens() ? { emailVerificationToken: verify.value } : {}),
    });
  });

  /** Activate an invited account with a one-time invite code. The code is
   *  generated by a platform admin (or org admin) and returned exactly once. */
  app.post('/v1/auth/invite/accept', async (req, res) => {
    const schema = z.object({
      token: z.string().trim().min(10).max(512),
      password: z.string().min(1).max(PASSWORD_MAX),
      displayName: z.string().trim().max(200).nullish(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    let userId: string | null = null;
    for (const hash of hashCandidates(parsed.data.token)) {
      userId = await consumeOneTimeToken(hash, 'invite');
      if (userId) break;
    }
    if (!userId) {
      return res.status(400).json({ error: 'invalid_invite_token', message: 'This activation code is invalid, expired or already used.' });
    }
    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (user.active === false) return res.status(403).json({ error: 'account_deactivated' });
    if (user.password_hash) return res.status(409).json({ error: 'account_exists', message: 'This account already has a password.' });
    const policyErr = passwordPolicyError(parsed.data.password, user.email);
    if (policyErr) return res.status(400).json({ error: 'weak_password', message: policyErr });
    await setUserPassword(user.id, await hashPassword(parsed.data.password));
    if (parsed.data.displayName) await updateUserProfile(user.id, { displayName: sanitizeName(parsed.data.displayName) });
    const fresh = (await getUserById(user.id)) || user;
    const session = await issueSession(fresh);
    await logAudit({
      actor_type: 'user', actor_id: user.id, action: 'iam:user:invite-accept', resource: `user:${user.id}`,
      decision: true, context: { org: user.org_id },
    }).catch(() => undefined);
    noStore(res);
    return res.status(201).json(session);
  });

  app.post('/v1/auth/password/change', async (req, res) => {
    const h = firstHeader(req.headers.authorization as any);
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
    let claims: any;
    try {
      claims = verifyAccess(h.slice(7));
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    if (claims.kind && claims.kind !== 'user') {
      return res.status(403).json({ error: 'password_change_requires_user', message: 'Only a user account can change a password' });
    }
    const schema = z.object({ currentPassword: z.string().max(PASSWORD_MAX), newPassword: z.string().max(PASSWORD_MAX) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const user = await getUserById(claims.sub);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (!user.password_hash) {
      return res.status(409).json({ error: 'password_not_set', message: 'This account has no password (OIDC or dev login). Use reset to set one.' });
    }
    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Current password is incorrect' });
    }
    const policyErr = passwordPolicyError(parsed.data.newPassword, user.email);
    if (policyErr) return res.status(400).json({ error: 'weak_password', message: policyErr });
    await setUserPassword(user.id, await hashPassword(parsed.data.newPassword));
    const revoked = await revokeAllRefresh(user.id);
    await logAudit({
      actor_type: 'user', actor_id: user.id, action: 'iam:password:change', resource: `user:${user.id}`,
      decision: true, context: { org: user.org_id, revokedSessions: revoked },
    }).catch(() => undefined);
    noStore(res);
    res.json({ ok: true, revokedSessions: revoked });
  });

  app.post('/v1/auth/password/forgot', async (req, res) => {
    const schema = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      orgSlug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/).nullish(),
    });
    const parsed = schema.safeParse(req.body);
    // Always 202: never reveal whether the account exists.
    if (!parsed.success) return res.status(202).json({ ok: true });
    const org = await getOrgBySlug(parsed.data.orgSlug || 'acme');
    const user = org ? await findUserByOrgEmail(org.id, parsed.data.email) : null;
    let token: string | undefined;
    if (user?.password_hash) {
      const t = newOneTimeToken('reset');
      await storeOneTimeToken(user.id, t.hash, 'reset', resetTokenExpiry());
      token = t.value;
      await logAudit({
        actor_type: 'user', actor_id: user.id, action: 'iam:password:forgot', resource: `user:${user.id}`,
        decision: true, context: { org: user.org_id },
      }).catch(() => undefined);
    }
    noStore(res);
    res.status(202).json({ ok: true, ...(token && exposesLifecycleTokens() ? { resetToken: token } : {}) });
  });

  app.post('/v1/auth/password/reset', async (req, res) => {
    const schema = z.object({
      token: z.string().min(10).max(512),
      newPassword: z.string().min(1).max(PASSWORD_MAX),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    let userId: string | null = null;
    for (const hash of hashCandidates(parsed.data.token)) {
      userId = await consumeOneTimeToken(hash, 'reset');
      if (userId) break;
    }
    if (!userId) return res.status(400).json({ error: 'invalid_reset_token', message: 'Reset token is invalid, expired or already used' });
    const user = await getUserById(userId);
    if (!user) return res.status(400).json({ error: 'invalid_reset_token' });
    const policyErr = passwordPolicyError(parsed.data.newPassword, user.email);
    if (policyErr) return res.status(400).json({ error: 'weak_password', message: policyErr });
    await setUserPassword(user.id, await hashPassword(parsed.data.newPassword));
    const revoked = await revokeAllRefresh(user.id);
    await logAudit({
      actor_type: 'user', actor_id: user.id, action: 'iam:password:reset', resource: `user:${user.id}`,
      decision: true, context: { org: user.org_id, revokedSessions: revoked },
    }).catch(() => undefined);
    noStore(res);
    res.json({ ok: true, revokedSessions: revoked });
  });

  app.post('/v1/auth/email/verify', async (req, res) => {
    const token = typeof (req.body || {}).token === 'string' ? (req.body || {}).token : '';
    if (!token) return res.status(400).json({ error: 'token_required' });
    let userId: string | null = null;
    for (const hash of hashCandidates(token)) {
      userId = await consumeOneTimeToken(hash, 'verify');
      if (userId) break;
    }
    if (!userId) return res.status(400).json({ error: 'invalid_verify_token', message: 'Verification token is invalid, expired or already used' });
    await markEmailVerified(userId);
    noStore(res);
    res.json({ ok: true, emailVerified: true });
  });

  app.post('/v1/auth/email/verify/request', async (req, res) => {
    const h = firstHeader(req.headers.authorization as any);
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
    let claims: any;
    try {
      claims = verifyAccess(h.slice(7));
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    const user = await getUserById(claims.sub);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (user.email_verified) return res.json({ ok: true, emailVerified: true });
    const t = newOneTimeToken('verify');
    await storeOneTimeToken(user.id, t.hash, 'verify', verifyTokenExpiry());
    noStore(res);
    res.json({ ok: true, ...(exposesLifecycleTokens() ? { emailVerificationToken: t.value } : {}) });
  });

  app.get('/v1/auth/sessions', async (req, res) => {
    const h = firstHeader(req.headers.authorization as any);
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
    let claims: any;
    try {
      claims = verifyAccess(h.slice(7));
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    const sessions = await listRefreshSessions(claims.sub);
    noStore(res);
    res.json(sessions);
  });

  app.delete('/v1/auth/sessions/:id', async (req, res) => {
    const h = firstHeader(req.headers.authorization as any);
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
    let claims: any;
    try {
      claims = verifyAccess(h.slice(7));
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const ok = await revokeRefreshById(claims.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'session_not_found' });
    res.json({ ok: true });
  });

  /**
   * Delegated token exchange (issue #22): a Tier-2 service credential gets a
   * short-lived token bound to one user/org/account, with an audience and a
   * scopes subset. Cross-tenant targets are refused and every exchange is
   * audit-logged.
   */
  app.post('/v1/auth/exchange', async (req, res) => {
    const caller = await resolveServiceIdentity(req);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error, message: caller.message });
    const schema = z.object({
      userId: z.string().uuid(),
      accountId: z.string().uuid().nullish(),
      orgId: z.string().uuid().nullish(),
      scopes: z.array(z.string().min(1).max(200)).max(100).optional(),
      audience: z.string().min(1).max(200).nullish(),
      ttlSeconds: z.number().int().min(60).max(3600).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const { userId, accountId, orgId, scopes: requested, audience, ttlSeconds } = parsed.data;

    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });

    // Target tenant binding: the caller's account/org decides what is reachable.
    const account = await getAccountById(accountId || caller.accountId);
    if (!account) return res.status(404).json({ error: 'account_not_found' });
    if (caller.orgId && account.org_id !== caller.orgId) {
      return res.status(403).json({ error: 'cross_tenant', message: 'Target account belongs to another organization' });
    }
    if (orgId && orgId !== account.org_id) {
      return res.status(403).json({ error: 'cross_tenant', message: 'orgId does not match the target account' });
    }
    if (user.org_id !== account.org_id) {
      return res.status(403).json({ error: 'cross_tenant', message: 'Target user belongs to another organization' });
    }

    const scopes = requested === undefined ? caller.scopes.slice() : requested;
    if (!scopesSubset(scopes, caller.scopes)) {
      return res.status(403).json({ error: 'scope_escalation', message: 'Cannot delegate scopes the caller does not hold' });
    }

    const { token, expiresIn } = signDelegated({
      userId: user.id,
      org: user.org_id,
      account: account.id,
      scopes,
      actor: caller.id,
      actorKind: caller.kind,
      audience: audience || undefined,
      ttlSeconds,
    });
    await logAudit({
      actor_type: caller.kind,
      actor_id: caller.id,
      action: 'iam:token:exchange',
      resource: `user:${user.id}`,
      decision: true,
      context: {
        org: user.org_id,
        callerOrg: caller.orgId || user.org_id,
        account: account.id,
        targetUser: user.id,
        scopes,
        ...(audience ? { audience } : {}),
        ttlSeconds: expiresIn,
      },
    }).catch(() => undefined);
    noStore(res);
    res.json({
      accessToken: token,
      expiresIn,
      tokenType: 'Bearer',
      delegated: true,
      userId: user.id,
      orgId: user.org_id,
      accountId: account.id,
      scopes,
      ...(audience ? { audience } : {}),
    });
  });

  // Refresh xoay vòng NGUYÊN TỬ: consume+revoke 1 bước → replay/race đều rớt.
  // Reuse signal: RT đã dùng rồi mà dùng lại → 401 + log để monitoring phát hiện
  // đánh cắp (không auto-revoke cả family để tránh giết nhầm winner trong race
  // hợp lệ; caller nghi ngờ gọi /v1/auth/logout-all).
  app.post('/v1/auth/refresh', async (req, res) => {
    const { refreshToken } = (req.body || {}) as any;
    if (!refreshToken) return res.status(400).json({ error: 'invalid_refresh_token', message: 'refreshToken required' });
    const rec = await consumeAndRevokeRefresh(refreshToken);
    if (!rec) {
      const owner = await findRefreshOwner(refreshToken).catch(() => null);
      if (owner) console.warn(`[iam][security] refresh reuse detected for user ${owner.user_id} — possible theft, recommend logout-all`);
      return res.status(401).json({ error: 'invalid_refresh' });
    }
    const rt = newRefreshToken();
    await storeRefresh(rec.user_id, rt.hash, refreshExpiry());
    const user = await getUserById(rec.user_id).catch(() => null);
    const { token, expiresIn } = signAccess(user ? { sub: user.id, email: user.email, org: user.org_id } : { sub: rec.user_id });
    noStore(res);
    res.json({ accessToken: token, expiresIn, refreshToken: rt.value });
  });

  // Logout: thu hồi refresh token.
  app.post('/v1/auth/logout', async (req, res) => {
    const { refreshToken } = (req.body || {}) as any;
    if (!refreshToken) return res.status(400).json({ error: 'invalid_refresh_token', message: 'refreshToken required' });
    await revokeRefresh(refreshToken);
    res.json({ ok: true });
  });

  // Logout mọi nơi: dùng refreshToken còn hiệu lực để chứng minh sở hữu,
  // rồi thu hồi TẤT CẢ session của chính user đó (không nhận userId tùy ý).
  app.post('/v1/auth/logout-all', async (req, res) => {
    const { refreshToken } = (req.body || {}) as any;
    if (!refreshToken) return res.status(400).json({ error: 'invalid_refresh_token', message: 'refreshToken required' });
    const rec = await consumeRefresh(refreshToken);
    if (!rec) return res.status(401).json({ error: 'invalid_refresh' });
    const revoked = await revokeAllRefresh(rec.user_id);
    res.json({ ok: true, revoked });
  });

  // Who-am-I: user record của chính Bearer token.
  app.get('/v1/auth/me', async (req, res) => {
    const h = firstHeader(req.headers.authorization as any);
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
    try {
      const decoded: any = verifyAccess(h.slice(7));
      const user = await getUserById(decoded.sub);
      if (!user) return res.status(404).json({ error: 'user_not_found' });
      if (user.active === false) return res.status(401).json({ error: 'account_deactivated', message: 'This account has been deactivated.' });
      res.json({ user: publicUser(user), kind: decoded.kind || 'user' });
    } catch (e: any) {
      return res.status(401).json({ error: 'invalid_token', message: e.message });
    }
  });

  app.get('/v1/auth/verify', async (req, res) => {    const h = firstHeader(req.headers.authorization as any);
    const apiKey = firstHeader(req.headers['x-api-key'] as any);
    if (h.startsWith('Bearer ')) {
      try {
        const decoded = verifyAccess(h.slice(7));
        return res.json({ valid: true, type: 'jwt', claims: decoded });
      } catch (e: any) {
        return res.status(401).json({ valid: false, message: e.message });
      }
    }
    if (apiKey) {
      const rec = await verifyApiKey(apiKey);
      if (!rec) return res.status(401).json({ valid: false });
      return res.json({ valid: true, type: 'apikey', ...rec });
    }
    return res.status(400).json({ error: 'credential_required', message: 'provide Bearer or X-API-Key' });
  });

  // ---------- Organizations ----------
  // Read scoped to the caller's own org (#7): an authenticated principal must
  // not enumerate other tenants. Callers without an org (machine tokens) get [].
  app.get('/v1/orgs', async (req, res) => {
    const org = await resolveCallerOrg(req, TRUST_STAMPED);
    const all = await listOrganizations();
    res.json(org ? all.filter((o) => o.id === org) : []);
  });
  app.post('/v1/orgs', async (req, res) => {
    try {
      const schema = z.object({
        slug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/),
        displayName: z.string().trim().min(2).max(200),
      });
      const b = schema.parse(req.body);
      const allowDirect = (process.env.IAM_ALLOW_DIRECT_ORG_CREATE ?? (IS_PROD ? 'false' : 'true')) === 'true';
      if (!allowDirect) {
        return res.status(403).json({
          error: 'platform_org_create_required',
          message: 'organization creation is managed by a platform administrator',
        });
      }
      const created = await createOrganization(sanitizeName(b.slug, 64), sanitizeName(b.displayName));
      await auditMutation(req, 'iam:org:create', `org:${created.id}`, { slug: created.slug });
      res.status(201).json(created);
    } catch (e: any) {
      if (e?.code === 'reserved_org_slug' || e?.status === 403) {
        return res.status(403).json({ error: 'reserved_org_slug', message: 'This organization slug is reserved for platform administration.' });
      }
      if (e?.code === '23505' || e?.status === 409) {
        return res.status(409).json({ error: 'conflict', message: 'organization slug exists' });
      }
      res.status(400).json({ error: 'invalid_body', message: e.message });
    }
  });

  // ---------- Accounts ----------
  app.get('/v1/orgs/:orgId/accounts', async (req, res) => {
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id', message: 'orgId must be a UUID' });
    if (!(await getOrgById(req.params.orgId))) return res.status(404).json({ error: 'org_not_found' });
    // Tenant guard (#7) — same as the write route.
    if (!(await canActForOrg(req, TRUST_STAMPED, req.params.orgId))) {
      return res.status(403).json({ error: 'forbidden', message: 'organization belongs to another tenant' });
    }
    res.json(await listAccounts(req.params.orgId));
  });
  app.post('/v1/orgs/:orgId/accounts', async (req, res) => {
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id', message: 'orgId must be a UUID' });
    try {
      const schema = z.object({
        slug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/),
        displayName: z.string().trim().min(2).max(200),
      });
      const b = schema.parse(req.body);
      if (!(await getOrgById(req.params.orgId))) return res.status(404).json({ error: 'org_not_found' });
      if (!(await canActForOrg(req, TRUST_STAMPED, req.params.orgId))) {
        return res.status(403).json({ error: 'forbidden', message: 'organization belongs to another tenant' });
      }
      if (!(await requireSensitiveMutation(req, res, TRUST_STAMPED, req.params.orgId, 'iam:account:create'))) return;
      const created = await createAccount(req.params.orgId, b.slug, sanitizeName(b.displayName));
      await auditMutation(req, 'iam:account:create', `account:${created.id}`, { org: req.params.orgId, slug: created.slug });
      res.status(201).json(created);
    } catch (e: any) {
      if (e?.code === '23505' || e?.status === 409) {
        return res.status(409).json({ error: 'conflict', message: 'account slug exists' });
      }
      res.status(400).json({ error: 'invalid_body', message: e.message });
    }
  });

  // ---------- Users ----------
  app.post('/v1/orgs/:orgId/users', async (req, res) => {
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id', message: 'orgId must be a UUID' });
    const schema = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      // nullish (not just optional): SDKs often serialize missing fields as
      // explicit null (e.g. Python display_name=None) — accept both.
      displayName: z.string().trim().max(200).nullish(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    if (!(await getOrgById(req.params.orgId))) return res.status(404).json({ error: 'org_not_found' });
    const { email, displayName } = parsed.data;
    if (!(await canActForOrg(req, TRUST_STAMPED, req.params.orgId))) {
      return res.status(403).json({ error: 'forbidden', message: 'organization belongs to another tenant' });
    }
    if (!(await requireSensitiveMutation(req, res, TRUST_STAMPED, req.params.orgId, 'iam:user:create'))) return;
    const created = await upsertUser(req.params.orgId, email, displayName ? sanitizeName(displayName) : undefined);
    const inviteToken = await issueInvite(created);
    await auditMutation(req, 'iam:user:create', `user:${created.id}`, { org: req.params.orgId, email, inviteIssued: !!inviteToken });
    res.status(201).json({ ...publicUser(created), inviteToken });
  });

  app.get('/v1/orgs/:orgId/users', async (req, res) => {
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id', message: 'orgId must be a UUID' });
    if (!(await getOrgById(req.params.orgId))) return res.status(404).json({ error: 'org_not_found' });
    // Tenant guard (#7) — same as the write route.
    if (!(await canActForOrg(req, TRUST_STAMPED, req.params.orgId))) {
      return res.status(403).json({ error: 'forbidden', message: 'organization belongs to another tenant' });
    }
    res.json(await listUsers(req.params.orgId));
  });

  // ---------- Roles & Policies (AWS-style) ----------
  const SLUG_RE = /^[a-z0-9-]{1,64}$/;
  app.post('/v1/accounts/:accountId/roles', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    const { slug, description } = (req.body || {}) as any;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{1,64}$' });
    }
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    if (description != null && (typeof description !== 'string' || description.length > 500)) {
      return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
    }
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    const orgId = await orgForAccount(req.params.accountId);
    if (!orgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, orgId, 'iam:role:create'))) return;
    const created = await createRole(req.params.accountId, slug, sanitizeName(description || ''));
    await auditMutation(req, 'iam:role:create', `role:${created.id}`, { account: req.params.accountId, slug });
    res.status(201).json(created);
  });

  app.get('/v1/accounts/:accountId/roles', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    // Tenant guard (#7) — same as the write route.
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    res.json(await listRoles(req.params.accountId));
  });

  // Policies attached to one role (management UI + attach verification).
  app.get('/v1/roles/:roleId/policies', async (req, res) => {
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    const role = await getRoleById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    // Tenant guard (#7): policy documents are tenant data.
    if (!(await canActForAccount(req, TRUST_STAMPED, role.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'role belongs to another tenant' });
    }
    res.json(await policiesForRole(req.params.roleId));
  });

  app.delete('/v1/roles/:roleId', async (req, res) => {    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    const role = await getRoleById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, role.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'role belongs to another tenant' });
    }
    const orgId = await orgForAccount(role.account_id);
    if (!orgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, orgId, 'iam:role:delete'))) return;
    const ok = await deleteRole(req.params.roleId);
    if (!ok) return res.status(404).json({ error: 'role_not_found' });
    await auditMutation(req, 'iam:role:delete', `role:${req.params.roleId}`, { account: role.account_id });
    res.json({ ok: true });
  });

  app.post('/v1/accounts/:accountId/policies', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    const { slug, description, managed } = (req.body || {}) as any;
    let { document } = (req.body || {}) as any;
    // `managed: "ReadOnlyAccess"` instantiates a managed policy in this account.
    if (managed != null) {
      if (typeof managed !== 'string' || !Object.prototype.hasOwnProperty.call(MANAGED_POLICIES, managed)) {
        return res.status(400).json({ error: 'invalid_managed_policy', message: `managed must be one of ${Object.keys(MANAGED_POLICIES).join(', ')}` });
      }
      if (document) return res.status(400).json({ error: 'invalid_body', message: 'send either document or managed, not both' });
      document = MANAGED_POLICIES[managed].document;
    }
    if (!slug || !document) return res.status(400).json({ error: 'slug+document required' });
    if (typeof slug !== 'string' || !/^[a-z0-9-]{1,64}$/.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{1,64}$' });
    }
    const docErr = validatePolicyDocument(document);
    if (docErr) return res.status(400).json({ error: 'invalid_document', message: docErr });
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    const orgId = await orgForAccount(req.params.accountId);
    if (!orgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, orgId, 'iam:policy:create'))) return;
    const desc = description || (managed ? `${managed} (managed): ${MANAGED_POLICIES[managed].description}` : '');
    const created = await createPolicy(req.params.accountId, slug, sanitizeName(desc), document);
    await auditMutation(req, 'iam:policy:create', `policy:${created.id}`, { account: req.params.accountId, slug, ...(managed ? { managed } : {}) });
    res.status(201).json(created);
  });

  app.get('/v1/accounts/:accountId/policies', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    // Tenant guard (#7) — same as the write route.
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    res.json(await listPolicies(req.params.accountId));
  });

  app.delete('/v1/policies/:policyId', async (req, res) => {
    if (!isUuid(req.params.policyId)) return res.status(400).json({ error: 'invalid_id', message: 'policyId must be a UUID' });
    const pol = await getPolicyById(req.params.policyId);
    if (!pol) return res.status(404).json({ error: 'policy_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, pol.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'policy belongs to another tenant' });
    }
    const orgId = await orgForAccount(pol.account_id);
    if (!orgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, orgId, 'iam:policy:delete'))) return;
    const ok = await deletePolicy(req.params.policyId);
    if (!ok) return res.status(404).json({ error: 'policy_not_found' });
    await auditMutation(req, 'iam:policy:delete', `policy:${req.params.policyId}`, { account: pol.account_id });
    res.json({ ok: true });
  });

  app.post('/v1/roles/:roleId/attach', async (req, res) => {
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    if (!req.body?.policyId) return res.status(400).json({ error: 'invalid_policyId', message: 'policyId required' });
    if (typeof req.body.policyId !== 'string' || !isUuid(req.body.policyId)) {
      return res.status(400).json({ error: 'invalid_policyId', message: 'policyId must be a UUID' });
    }
    const [role, pol] = await Promise.all([getRoleById(req.params.roleId), getPolicyById(req.body.policyId)]);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    if (!pol) return res.status(404).json({ error: 'policy_not_found' });
    // Cross-tenant guard: a policy from account A must never land on a role in account B.
    if (role.account_id !== pol.account_id) {
      return res.status(403).json({ error: 'cross_account', message: 'policy and role belong to different accounts' });
    }
    if (!(await canActForAccount(req, TRUST_STAMPED, role.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'role belongs to another tenant' });
    }
    const orgId = await orgForAccount(role.account_id);
    if (!orgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, orgId, 'iam:policy:attach'))) return;
    await attachPolicy(req.params.roleId, req.body.policyId);
    await auditMutation(req, 'iam:policy:attach', `role:${req.params.roleId}`, { policyId: req.body.policyId, account: role.account_id });
    res.json({ ok: true });
  });
  app.delete('/v1/roles/:roleId/policies/:policyId', async (req, res) => {
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    if (!isUuid(req.params.policyId)) return res.status(400).json({ error: 'invalid_id', message: 'policyId must be a UUID' });
    const role = await getRoleById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    const pol = await getPolicyById(req.params.policyId);
    if (!pol) return res.status(404).json({ error: 'policy_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, role.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'role belongs to another tenant' });
    }
    const orgId = await orgForAccount(role.account_id);
    if (!orgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, orgId, 'iam:policy:detach'))) return;
    await detachPolicy(req.params.roleId, req.params.policyId);
    await auditMutation(req, 'iam:policy:detach', `role:${req.params.roleId}`, { policyId: req.params.policyId, account: role.account_id });
    res.json({ ok: true });
  });
  app.post('/v1/users/:userId/assign', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    if (!req.body?.roleId) return res.status(400).json({ error: 'invalid_roleId', message: 'roleId required' });
    if (typeof req.body.roleId !== 'string' || !isUuid(req.body.roleId)) {
      return res.status(400).json({ error: 'invalid_roleId', message: 'roleId must be a UUID' });
    }
    const [user, role] = await Promise.all([getUserById(req.params.userId), getRoleById(req.body.roleId)]);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    // Cross-tenant guard: the role's account must live in the user's org.
    const acc = await getAccountById(role.account_id);
    if (!acc || acc.org_id !== user.org_id) {
      return res.status(403).json({ error: 'cross_org', message: "role's account is outside the user's organization" });
    }
    if (!(await canActForOrg(req, TRUST_STAMPED, user.org_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'user belongs to another tenant' });
    }
    if (!(await requireSensitiveMutation(req, res, TRUST_STAMPED, user.org_id, 'iam:role:assign'))) return;
    await assignRole(req.params.userId, req.body.roleId);
    await auditMutation(req, 'iam:role:assign', `user:${req.params.userId}`, { roleId: req.body.roleId, org: user.org_id });
    res.json({ ok: true });
  });
  app.delete('/v1/users/:userId/roles/:roleId', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    const user = await getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const role = await getRoleById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    if (!(await canActForOrg(req, TRUST_STAMPED, user.org_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'user belongs to another tenant' });
    }
    if (!(await requireSensitiveMutation(req, res, TRUST_STAMPED, user.org_id, 'iam:role:unassign'))) return;
    await unassignRole(req.params.userId, req.params.roleId);
    await auditMutation(req, 'iam:role:unassign', `user:${req.params.userId}`, { roleId: req.params.roleId, org: user.org_id });
    res.json({ ok: true });
  });

  // ---------- Authorize (policy evaluation) ----------
  // context: caller cung cấp thêm (vd {hour, sourceIp}); server luôn ép
  // user/org/email từ DB (caller không override được) để Condition đáng tin.
  // Central enforcement (gateway → IAM). Decides for the verified principal the
  // gateway authenticated; deny decisions are audited. Gateway-only route.
  const principalSchema = z.object({
    principal: z.object({
      kind: z.enum(['user', 'service-account', 'apikey']),
      // Any verified JWT subject; non-UUID subjects resolve to unknown-principal (deny), never 400.
      sub: z.string().min(1).max(128).nullish(),
      org: z.string().max(128).nullish(),
      account: z.string().max(128).nullish(),
      scopes: z.array(z.string().min(1).max(200)).max(100).nullish(),
      keyId: z.string().uuid().nullish(),
    }),
    action: z.string().min(1).max(512),
    resource: z.string().min(1).max(2048),
    context: z.record(z.string(), z.unknown()).nullish(),
  });
  app.post('/internal/authorize', async (req, res) => {
    const parsed = principalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const { principal, action, resource, context } = parsed.data;
    const p: PrincipalInput = {
      kind: principal.kind,
      sub: principal.sub || undefined,
      org: principal.org || undefined,
      account: principal.account || undefined,
      scopes: principal.scopes || undefined,
      keyId: principal.keyId || undefined,
    };
    const d = await decideForPrincipal(p, action, resource, capContext(context));
    if (!d.allowed) {
      // Attribute the row to the identity's own tenant so org-scoped
      // GET /v1/audit shows the denial to that org's admins.
      const account = d.account || p.account;
      const org = d.org || p.org || (account && isUuid(account) ? (await getAccountById(account))?.org_id : undefined);
      await logAudit({
        actor_type: p.kind, actor_id: d.principal, action, resource, decision: false,
        context: { reason: d.reason, enforcement: 'gateway', ...(org ? { org } : {}), ...(account ? { account } : {}) },
      }).catch(() => undefined);
    }
    noStore(res);
    res.json(d);
  });

  // AWS-style managed policies (read-only catalog; copy one into an account
  // with POST /v1/accounts/:accountId/policies {slug, managed}).
  app.get('/v1/managed-policies', (_req, res) => {
    res.json(managedPolicyList());
  });

  app.post('/v1/authorize', async (req, res) => {
    const { userId, action, resource, context } = (req.body || {}) as any;
    if (!userId || !action || !resource) return res.status(400).json({ error: 'userId+action+resource required' });
    if (typeof userId !== 'string' || !isUuid(userId)) return res.status(400).json({ error: 'invalid_userId', message: 'userId must be a UUID' });
    if (typeof action !== 'string' || action.length > 512 || typeof resource !== 'string' || resource.length > 2048) {
      return res.status(400).json({ error: 'invalid_action_resource', message: 'action ≤512 chars, resource ≤2048 chars' });
    }
    const docs = await policiesForUser(userId);
    const user = await getUserById(userId);
    const callerOrg = await resolveCallerOrg(req, TRUST_STAMPED);
    const callerUser = await resolveCallerUser(req, TRUST_STAMPED);
    // Target-tenant guard (#23): never evaluate (or audit-log) a user outside
    // the caller's organization. Machine credentials have no org → refused.
    if (!callerOrg) {
      return res.status(403).json({ error: 'forbidden', message: 'authorize requires an organization context' });
    }
    if (!user || user.org_id !== callerOrg) {
      return res.status(403).json({ error: 'cross_tenant', message: 'target user belongs to another tenant' });
    }
    const ctx = { ...capContext(context), user: userId, org: user.org_id, email: user.email };
    const verdict = evaluatePolicies(docs, { action, resource }, ctx);
    // Audit rows are scoped to the CALLER's org, never the target's (#23).
    await logAudit({
      actor_type: 'user', actor_id: userId, action, resource, decision: verdict.allowed,
      context: { ...ctx, callerOrg, ...(callerUser ? { callerUser } : {}) },
    }).catch(() => undefined);
    res.json({ allowed: verdict.allowed, matchedBy: verdict.matchedBy, evaluatedPolicies: docs.length });
  });

  // Dry-run simulator (không cần user): đánh giá documents inline, như AWS IAM Policy Simulator.
  app.post('/v1/authorize/dry-run', async (req, res) => {
    const { documents, action, resource, context } = (req.body || {}) as any;
    if (!Array.isArray(documents) || !action || !resource) {
      return res.status(400).json({ error: 'documents[]+action+resource required' });
    }
    if (documents.length > 20) return res.status(400).json({ error: 'too_many_documents', message: 'max 20 documents per dry-run' });
    if (typeof action !== 'string' || action.length > 512 || typeof resource !== 'string' || resource.length > 2048) {
      return res.status(400).json({ error: 'invalid_action_resource', message: 'action ≤512 chars, resource ≤2048 chars' });
    }
    for (const d of documents) {
      const docErr = validatePolicyDocument(d);
      if (docErr) return res.status(400).json({ error: 'invalid_document', message: docErr });
    }
    const capped = capContext(context);
    const verdict = evaluatePolicies(documents, { action, resource }, capped);
    // Dry-run rows belong to the caller's org (#7): no userId target exists,
    // so record caller identity for the audit view and its scoping filter.
    const callerOrg = await resolveCallerOrg(req, TRUST_STAMPED);
    const callerUser = await resolveCallerUser(req, TRUST_STAMPED);
    await logAudit({
      actor_type: 'dry-run', actor_id: callerUser || '', action, resource, decision: verdict.allowed,
      context: { ...capped, ...(callerOrg ? { callerOrg } : {}), ...(callerUser ? { callerUser } : {}) },
    }).catch(() => undefined);
    res.json({ allowed: verdict.allowed, matchedBy: verdict.matchedBy, evaluatedPolicies: documents.length });
  });

  // Audit log (đọc). Tenant-scoped (#7): only rows that targeted the caller's
  // org (context.org) or were triggered by the caller's org (context.callerOrg,
  // dry-runs). Callers without an org (machine tokens) see nothing.
  app.get('/v1/audit/export', async (req, res) => {
    const rawLimit = Number(req.query.limit || 10_000);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 10_000) {
      return res.status(400).json({ error: 'invalid_limit', message: 'limit must be an integer 1..10000' });
    }
    const actor = (req.query.actor as string) || undefined;
    if (actor !== undefined && !isUuid(actor)) return res.status(400).json({ error: 'invalid_actor', message: 'actor must be a UUID' });
    const action = typeof req.query.action === 'string' && req.query.action.trim() ? req.query.action.trim().slice(0, 200) : undefined;
    const resource = typeof req.query.resource === 'string' && req.query.resource.trim() ? req.query.resource.trim().slice(0, 512) : undefined;
    const parseTime = (v: unknown): Date | undefined | 'invalid' => {
      if (v === undefined || v === '') return undefined;
      const d = new Date(String(v));
      return Number.isFinite(d.getTime()) ? d : 'invalid';
    };
    const from = parseTime(req.query.from);
    const to = parseTime(req.query.to);
    if (from === 'invalid' || to === 'invalid') {
      return res.status(400).json({ error: 'invalid_time', message: 'from/to must be valid ISO timestamps' });
    }
    const org = await resolveCallerOrg(req, TRUST_STAMPED);
    if (!org) return res.status(403).json({ error: 'org_required', message: 'an organization-scoped credential is required' });
    if (!(await callerIsOrgAdmin(req, TRUST_STAMPED, org))) {
      return res.status(403).json({ error: 'org_admin_required', message: 'audit access requires an organization administrator' });
    }
    const rows: any[] = [];
    for (let offset = 0; offset < rawLimit; offset += 200) {
      const page = await queryAudit({
        limit: Math.min(200, rawLimit - offset), offset, actor, orgId: org, action, resource, from, to,
      });
      rows.push(...page);
      if (page.length < 200) break;
    }
    const ndjson = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
    const secret = process.env.AUDIT_EXPORT_SECRET || process.env.SYNAPSEONE_INTERNAL_SECRET || 'dev-audit-export-secret';
    const digest = createHmac('sha256', secret).update(ndjson).digest('hex');
    noStore(res);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="audit-${org}.ndjson"`);
    res.setHeader('x-audit-digest', `hmac-sha256=${digest}`);
    res.setHeader('x-audit-count', String(rows.length));
    res.send(ndjson);
  });

  app.get('/v1/audit', async (req, res) => {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'invalid_limit', message: 'limit must be an integer 1..200' });
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      return res.status(400).json({ error: 'invalid_offset', message: 'offset must be an integer 0..100000' });
    }
    const actor = (req.query.actor as string) || undefined;
    if (actor !== undefined && !isUuid(actor)) return res.status(400).json({ error: 'invalid_actor', message: 'actor must be a UUID' });
    const rawAllowed = req.query.allowed;
    const allowed = rawAllowed === undefined ? undefined : String(rawAllowed).toLowerCase() === 'true';
    if (rawAllowed !== undefined && !['true', 'false'].includes(String(rawAllowed).toLowerCase())) {
      return res.status(400).json({ error: 'invalid_allowed', message: 'allowed must be true or false' });
    }
    const action = typeof req.query.action === 'string' && req.query.action.trim() ? req.query.action.trim().slice(0, 200) : undefined;
    const resource = typeof req.query.resource === 'string' && req.query.resource.trim() ? req.query.resource.trim().slice(0, 512) : undefined;
    const parseTime = (v: unknown): Date | undefined | 'invalid' => {
      if (v === undefined || v === '') return undefined;
      const d = new Date(String(v));
      return Number.isFinite(d.getTime()) ? d : 'invalid';
    };
    const from = parseTime(req.query.from);
    const to = parseTime(req.query.to);
    if (from === 'invalid' || to === 'invalid') {
      return res.status(400).json({ error: 'invalid_time', message: 'from/to must be valid ISO timestamps' });
    }
    const org = await resolveCallerOrg(req, TRUST_STAMPED);
    if (!org) return res.status(403).json({ error: 'org_required', message: 'audit access requires an organization' });
    if (!(await callerIsOrgAdmin(req, TRUST_STAMPED, org))) {
      return res.status(403).json({ error: 'org_admin_required', message: 'audit access requires an organization administrator' });
    }
    noStore(res);
    res.json(await queryAudit({ limit, offset, actor, allowed, orgId: org, action, resource, from, to }));
  });

  // ---------- API keys ----------
  app.post('/v1/accounts/:accountId/keys', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    const { userId, name, scopes, expiresInSeconds } = (req.body || {}) as any;
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    // Format checks first (400); existence checks (404) after the body 400s.
    if (userId != null && (typeof userId !== 'string' || !isUuid(userId))) {
      return res.status(400).json({ error: 'invalid_userId', message: 'userId must be a UUID' });
    }
    const keyName = name || 'default';
    if (typeof keyName !== 'string' || keyName.length === 0 || keyName.length > 100) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 chars' });
    }
    // Least privilege by default: an omitted scope list is read-only, never '*'.
    const keyScopes: string[] = scopes ?? ['*:read'];
    if (!Array.isArray(keyScopes) || keyScopes.length === 0 || keyScopes.length > 100 ||
        keyScopes.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 200)) {
      return res.status(400).json({ error: 'invalid_scopes', message: 'scopes must be 1..100 non-empty strings ≤200 chars' });
    }
    if (expiresInSeconds != null && (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 315360000)) {
      return res.status(400).json({ error: 'invalid_expiry', message: 'expiresInSeconds must be 1..315360000' });
    }
    if (userId != null && !(await getUserById(userId))) return res.status(404).json({ error: 'user_not_found' });
    const exp = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    const keyOrgId = await orgForAccount(req.params.accountId);
    if (!keyOrgId) return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    const callerUserId = await resolveCallerUser(req, TRUST_STAMPED);
    // Account-level keys (no user owner) are administrative. Self-bound keys
    // are allowed for ordinary members; binding another user is checked below.
    if (!userId && !(await requireSensitiveMutation(req, res, TRUST_STAMPED, keyOrgId, 'iam:key:create-account'))) return;
    // Scope narrowing (#23): a credential can never mint authority it lacks.
    const callerScopes = await resolveCallerScopes(req, TRUST_STAMPED);
    if (!scopesSubset(keyScopes, callerScopes)) {
      return res.status(403).json({ error: 'scope_escalation', message: 'Cannot mint scopes the caller does not hold' });
    }
    // An optional userId binding must live in the key's account org, and an
    // owner other than the caller is an administrator-only operation. This
    // prevents a member from minting a key that inherits an org admin's
    // policies (privilege escalation).
    let ownerTarget: User | null = null;
    if (userId != null) {
      ownerTarget = await getUserById(userId);
      const acc = await getAccountById(req.params.accountId);
      if (!ownerTarget || !acc || ownerTarget.org_id !== acc.org_id) {
        return res.status(403).json({ error: 'cross_tenant', message: 'userId is outside the account organization' });
      }
      if (!callerUserId) {
        return res.status(403).json({ error: 'user_owner_required', message: 'only a user session can bind an API key to a user' });
      }
      if (userId !== callerUserId && !(await callerIsOrgAdmin(req, TRUST_STAMPED, ownerTarget.org_id))) {
        return res.status(403).json({ error: 'key_owner_forbidden', message: 'only an organization administrator can create a key for another user' });
      }    }
    const k = await createApiKeyRecord(req.params.accountId, userId || null, keyName, keyScopes, exp);
    await logAudit({
      actor_type: 'user', actor_id: (await resolveCallerUser(req, TRUST_STAMPED)) || '',
      action: 'iam:key:create', resource: `account:${req.params.accountId}`,
      decision: true,
      context: { org: keyOrgId, account: req.params.accountId, keyId: k.id, scopes: keyScopes, ownerUserId: userId || null },
    }).catch(() => undefined);
    res.status(201).json({ id: k.id, apiKey: k.value, prefix: k.prefix, warning: 'Save this apiKey now — it is shown only once.' });
  });

  app.get('/v1/accounts/:accountId/keys', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    // Tenant binding (same as SA-token mint): key metadata may only be
    // enumerated by callers of the owning tenant.
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    res.json(await listApiKeys(req.params.accountId));
  });

  app.post('/v1/keys/verify', async (req, res) => {
    if (hasEndUserCredential(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'internal endpoint: end-user credentials are not accepted' });
    }
    const rec = await verifyApiKey((req.body || {}).apiKey || '');
    if (!rec) return res.status(401).json({ valid: false });
    // Include the owning org: the gateway uses this for usage attribution (#28).
    const acc = rec.account_id ? await getAccountById(rec.account_id) : null;
    res.json({ valid: true, ...rec, ...(acc?.org_id ? { org_id: acc.org_id } : {}) });
  });

  app.delete('/v1/keys/:id', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid_id', message: 'key id must be a UUID' });
    const rec = await findApiKeyById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'key_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, rec.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'key belongs to another tenant' });
    }
    const keyOrgId = await orgForAccount(rec.account_id);
    if (!keyOrgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, keyOrgId, 'iam:key:revoke'))) return;
    const ok = await revokeApiKey(req.params.id);
    if (!ok) return res.status(404).json({ error: 'key_not_found' });
    await auditMutation(req, 'iam:key:revoke', `key:${req.params.id}`, { account: rec.account_id });
    res.json({ ok: true });
  });

  // Rotate: cấp key mới cùng owner/scopes, key cũ còn sống `graceSeconds`
  // (mặc định 0 = thu hồi ngay; tối đa 7 ngày) để deploy không gián đoạn.
  app.post('/v1/keys/:id/rotate', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid_id', message: 'key id must be a UUID' });
    const grace = (req.body || {}).graceSeconds ?? 0;
    if (!Number.isInteger(grace) || grace < 0 || grace > 604800) {
      return res.status(400).json({ error: 'invalid_grace', message: 'graceSeconds must be an integer 0..604800' });
    }
    const rec = await findApiKeyById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'key_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, rec.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'key belongs to another tenant' });
    }
    const keyOrgId = await orgForAccount(rec.account_id);
    if (!keyOrgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, keyOrgId, 'iam:key:rotate'))) return;
    const next = await rotateApiKey(req.params.id, grace);
    if (!next) return res.status(409).json({ error: 'key_inactive', message: 'revoked or expired keys cannot be rotated' });
    noStore(res);
    res.status(201).json({
      id: next.id, apiKey: next.value, prefix: next.prefix,
      rotatedFrom: req.params.id, oldKeyExpiresAt: next.oldKeyExpiresAt,
      warning: 'Save this apiKey now — it is shown only once.',
    });
  });

  // ---------- Service accounts (machine identity) ----------
  app.post('/v1/accounts/:accountId/service-accounts', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    const { slug, description } = (req.body || {}) as any;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{1,64}$' });
    }
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    if (description != null && (typeof description !== 'string' || description.length > 500)) {
      return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
    }
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    const saOrgId = await orgForAccount(req.params.accountId);
    if (!saOrgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, saOrgId, 'iam:service-account:create'))) return;
    const created = await createServiceAccount(req.params.accountId, slug, sanitizeName(description || ''));
    await auditMutation(req, 'iam:service-account:create', `service-account:${created.id}`, { account: req.params.accountId, slug });
    res.status(201).json(created);
  });

  app.get('/v1/accounts/:accountId/service-accounts', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    // Tenant guard (#7) — same as the write route.
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    res.json(await listServiceAccounts(req.params.accountId));
  });

  // Cấp JWT cho service account (kind=service-account, mang account scope).
  // Hardening (#8): scopes are never silently widened.
  //  - omitted → the caller's own scopes (may be [], i.e. a token with no
  //    authority — never '*' derived from thin air);
  //  - explicit → must be a subset of the caller's scopes unless the caller
  //    holds '*' (a limited credential can only delegate what it has);
  //  - callers whose scopes are empty can never mint '*'.
  // Tenant binding: the caller must belong to the SA's account — otherwise any
  // authenticated principal could mint tokens for any account's SA.
  app.post('/v1/service-accounts/:id/token', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid_id', message: 'service account id must be a UUID' });
    // Caller scopes: stamped header only when trusted — otherwise derive from
    // the verified credential itself (dev callers can't spoof their way to '*').
    let callerScopes: string[] = [];
    const stamped = firstHeader((req.headers['x-synapseone-scopes'] ?? req.headers['x-synapsedx-scopes']) as any);
    if (TRUST_STAMPED && stamped) {
      callerScopes = stamped.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      const h = firstHeader(req.headers.authorization as any);
      if (h.startsWith('Bearer ')) {
        try {
          callerScopes = verifyAccess(h.slice(7)).scopes || [];
        } catch {
          callerScopes = [];
        }
      } else {
        const apiKey = firstHeader(req.headers['x-api-key'] as any);
        if (apiKey) {
          try {
            callerScopes = (await verifyApiKey(apiKey))?.scopes || [];
          } catch {
            callerScopes = [];
          }
        }
      }
    }
    const requested = (req.body || {}).scopes;
    const scopes: string[] = requested === undefined || requested === null ? callerScopes.slice() : requested;
    if (!Array.isArray(scopes) || scopes.length > 100 ||
        scopes.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 200)) {
      return res.status(400).json({ error: 'invalid_scopes', message: 'scopes must be up to 100 non-empty strings ≤200 chars' });
    }
    const sa = await getServiceAccount(req.params.id);
    if (!sa) return res.status(404).json({ error: 'service_account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, sa.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'service account belongs to another tenant' });
    }
    const saOrgId = await orgForAccount(sa.account_id);
    if (!saOrgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, saOrgId, 'iam:service-account:token'))) return;
    const callerHasWildcard = callerScopes.includes('*');
    if (!callerHasWildcard && scopes.some((s) => !callerScopes.includes(s))) {
      return res.status(403).json({ error: 'scope_escalation', message: 'Cannot mint scopes the caller does not hold' });
    }
    const { token, expiresIn } = signAccess({ sub: sa.id, account: sa.account_id, scopes, kind: 'service-account' });
    await auditMutation(req, 'iam:token:mint', `service-account:${sa.id}`, { account: sa.account_id, scopes });
    noStore(res);
    res.json({ accessToken: token, expiresIn, serviceAccount: sa });
  });

  // Service-account roles: quyền của machine identity đến từ role/policy như
  // user (role phải cùng account với SA). SA chưa có role → chỉ giới hạn bởi scopes.
  async function saForCaller(req: express.Request, res: express.Response) {
    if (!isUuid(req.params.id)) { res.status(400).json({ error: 'invalid_id', message: 'service account id must be a UUID' }); return null; }
    const sa = await getServiceAccount(req.params.id);
    if (!sa) { res.status(404).json({ error: 'service_account_not_found' }); return null; }
    if (!(await canActForAccount(req, TRUST_STAMPED, sa.account_id))) {
      res.status(403).json({ error: 'forbidden', message: 'service account belongs to another tenant' });
      return null;
    }
    return sa;
  }
  app.get('/v1/service-accounts/:id/roles', async (req, res) => {
    const sa = await saForCaller(req, res);
    if (!sa) return;
    res.json(await rolesForServiceAccount(sa.id));
  });
  app.post('/v1/service-accounts/:id/roles', async (req, res) => {
    const roleId = (req.body || {}).roleId;
    if (typeof roleId !== 'string' || !isUuid(roleId)) return res.status(400).json({ error: 'invalid_roleId', message: 'roleId must be a UUID' });
    const sa = await saForCaller(req, res);
    if (!sa) return;
    const role = await getRoleById(roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    if (role.account_id !== sa.account_id) {
      return res.status(403).json({ error: 'cross_account', message: "role must belong to the service account's account" });
    }
    const saOrgId = await orgForAccount(sa.account_id);
    if (!saOrgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, saOrgId, 'iam:service-account:role:assign'))) return;
    await assignRoleToServiceAccount(sa.id, roleId);
    await auditMutation(req, 'iam:service-account:role:assign', `service-account:${sa.id}`, { roleId, account: sa.account_id });
    res.json({ ok: true });
  });
  app.delete('/v1/service-accounts/:id/roles/:roleId', async (req, res) => {
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    const sa = await saForCaller(req, res);
    if (!sa) return;
    const saOrgId = await orgForAccount(sa.account_id);
    if (!saOrgId || !(await requireSensitiveMutation(req, res, TRUST_STAMPED, saOrgId, 'iam:service-account:role:unassign'))) return;
    const ok = await unassignRoleFromServiceAccount(sa.id, req.params.roleId);
    if (!ok) return res.status(404).json({ error: 'assignment_not_found' });
    await auditMutation(req, 'iam:service-account:role:unassign', `service-account:${sa.id}`, { roleId: req.params.roleId, account: sa.account_id });
    res.json({ ok: true });
  });

  // Org administrators: only an existing admin of the same org may grant or
  // revoke; the last admin cannot demote themself (org would be unmanageable).
  app.put('/v1/users/:userId/org-admin', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    const flag = (req.body || {}).isOrgAdmin;
    if (typeof flag !== 'boolean') return res.status(400).json({ error: 'invalid_body', message: 'isOrgAdmin (boolean) required' });
    const user = await getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (!(await canActForOrg(req, TRUST_STAMPED, user.org_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'user belongs to another tenant' });
    }
    if (!(await callerIsOrgAdmin(req, TRUST_STAMPED, user.org_id))) {
      return res.status(403).json({ error: 'org_admin_required', message: 'only an organization administrator can change administrators' });
    }
    if (!flag && user.is_org_admin) {
      const admins = (await listUsers(user.org_id)).filter((u) => u.is_org_admin && u.active !== false);
      if (admins.length <= 1) return res.status(409).json({ error: 'last_admin', message: 'an organization needs at least one active administrator' });
    }
    const reason = typeof (req.body || {}).reason === 'string' ? String((req.body || {}).reason).slice(0, 500) : '';
    const updated = await setOrgAdmin(user.id, flag);
    await auditMutation(req, 'iam:user:org-admin', `user:${user.id}`, {
      org: user.org_id,
      targetUserId: user.id,
      oldValue: !!user.is_org_admin,
      newValue: flag,
      ...(reason ? { reason } : {}),
    });
    res.json(updated ? publicUser(updated) : { ok: true });
  });

  // Lost authenticator: an org administrator removes the user's second
  // factor (the user enrols again) and clears any login lockout.
  app.delete('/v1/users/:userId/mfa', mfaLimiter, async (req, res) => {
    const user = await orgAdminTarget(req, res, TRUST_STAMPED);
    if (!user) return;
    const removed = await removeMfa(user.id);
    await clearLoginFailures(user.id);
    await auditMutation(req, 'iam:mfa:reset', `user:${user.id}`, { org: user.org_id, removed });
    res.json({ ok: true, removed });
  });

  app.post('/v1/users/:userId/unlock', mfaLimiter, async (req, res) => {
    const user = await orgAdminTarget(req, res, TRUST_STAMPED);
    if (!user) return;
    await clearLoginFailures(user.id);
    await auditMutation(req, 'iam:user:unlock', `user:${user.id}`, { org: user.org_id });
    res.json({ ok: true });
  });

  // Liệt kê policy của user (hữu ích khi debug authorize).
  app.get('/v1/users/:userId/policies', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    const user = await getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    // Tenant guard (#7): policy documents of another org's user are off-limits.
    if (!(await canActForOrg(req, TRUST_STAMPED, user.org_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'user belongs to another tenant' });
    }
    res.json(await policiesForUser(req.params.userId));
  });

  // Roles assigned to one user (management UI + assign verification).
  app.get('/v1/users/:userId/roles', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    const user = await getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    // Tenant guard (#7) — same as assign/unassign.
    if (!(await canActForOrg(req, TRUST_STAMPED, user.org_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'user belongs to another tenant' });
    }
    res.json(await rolesForUser(req.params.userId));
  });

  // ---------- Data-plane mutation audit ingest (#32) ----------
  // Internal services post one event per write. Tenant identity comes from the
  // gateway-stamped headers those services received; the shared internal secret
  // authenticates the producer. Context is sanitised so a producer cannot spoof
  // the org/callerOrg scoping keys or smuggle unbounded payloads.
  const AUDIT_RESERVED_CONTEXT = new Set(['org', 'callerOrg', 'account', 'actor', 'actorId']);
  const AUDIT_SENSITIVE_KEY = /(pass|secret|token|key|credential|auth|email|phone|session)/i;
  function sanitizeAuditContext(input: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
      if (count >= 20) break;
      const key = String(rawKey).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
      if (!key || AUDIT_RESERVED_CONTEXT.has(key)) continue;
      if (AUDIT_SENSITIVE_KEY.test(key)) {
        out[key] = '***';
        count++;
        continue;
      }
      if (rawValue === null || ['string', 'number', 'boolean'].includes(typeof rawValue)) {
        out[key] = typeof rawValue === 'string' ? rawValue.slice(0, 256) : rawValue;
        count++;
        continue;
      }
      // One level of nesting (the audit client sends `params: {id, collection}`).
      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        const nested: Record<string, string> = {};
        let nestedCount = 0;
        for (const [nk, nv] of Object.entries(rawValue as Record<string, unknown>)) {
          if (nestedCount >= 20) break;
          const cleanKey = String(nk).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
          if (!cleanKey || ['string', 'number', 'boolean'].includes(typeof nv) === false && nv !== null) continue;
          nested[cleanKey] = AUDIT_SENSITIVE_KEY.test(cleanKey) ? '***' : String(nv ?? '').slice(0, 128);
          nestedCount++;
        }
        out[key] = nested;
        count++;
      }
    }
    return out;
  }

  const auditIngestSchema = z.object({
    events: z.array(z.object({
      actorType: z.enum(['user', 'service', 'apikey', 'anonymous']),
      actorId: z.string().max(320).optional().default(''),
      orgId: z.string().max(128).regex(/^[A-Za-z0-9._:@+-]*$/).nullish(),
      accountId: z.string().max(128).regex(/^[A-Za-z0-9._:@+-]*$/).nullish(),
      action: z.string().min(1).max(200),
      resource: z.string().max(512).optional().default(''),
      result: z.enum(['allowed', 'denied', 'error']),
      statusCode: z.number().int().min(100).max(599),
      requestId: z.string().max(128).optional().default(''),
      context: z.record(z.string(), z.unknown()).optional(),
    })).min(1).max(200),
  });
  app.post('/v1/audit/ingest', async (req, res) => {
    if (INTERNAL_SECRET) {
      const got = firstHeader((req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal']) as any);
      if (!got || !secretsEqual(got, INTERNAL_SECRET)) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
      }
    }
    if (hasEndUserCredential(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'internal endpoint: end-user credentials are not accepted' });
    }
    const parsed = auditIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    }
    let accepted = 0;
    for (const e of parsed.data.events) {
      const org = e.orgId || null;
      await logAudit({
        actor_type: e.actorType,
        actor_id: e.actorId || '',
        action: e.action,
        resource: e.resource || '',
        // `decision` is the historical boolean; `result` keeps denied vs error.
        decision: e.result === 'allowed',
        org_id: org,
        context: {
          ...(org ? { org } : {}),
          ...(e.accountId ? { account: e.accountId } : {}),
          ...(e.requestId ? { requestId: e.requestId } : {}),
          result: e.result,
          statusCode: e.statusCode,
          ...sanitizeAuditContext(e.context),
        },
      }).catch(() => undefined);
      accepted++;
    }
    noStore(res);
    res.status(202).json({ ok: true, accepted });
  });

  // ---------- Usage analytics (gateway request telemetry) ----------
  // Machine-to-machine ingest. The general auth gate is bypassed for this path
  // (the gateway has no user credential); the shared internal secret is the
  // authenticator. Without a configured secret this is dev-only (IAM is only
  // reachable on the internal network / published localhost dev port).
  const usageIngestSchema = z.object({
    events: z
      .array(
        z.object({
          createdAt: z.string().max(64).optional(),
          requestId: z.string().max(128).optional(),
          feature: z.string().regex(/^[a-z0-9-]{1,64}$/),
          route: z.string().min(1).max(200),
          method: z.string().min(1).max(16),
          path: z.string().max(2000).optional(),
          status: z.number().int().min(100).max(599),
          durationMs: z.number().int().min(0).max(3_600_000),
          authKind: z.string().max(32).optional(),
          orgId: z.string().uuid().nullish(),
          accountId: z.string().uuid().nullish(),
          userId: z.string().uuid().nullish(),
          promptTokens: z.number().int().min(0).max(100_000_000).nullish(),
          completionTokens: z.number().int().min(0).max(100_000_000).nullish(),
          totalTokens: z.number().int().min(0).max(200_000_000).nullish(),
          model: z.string().max(200).nullish(),
          error: z.string().max(500).nullish(),
        }),
      )
      .min(1)
      .max(500),
  });
  app.post('/v1/usage/ingest', async (req, res) => {
    if (INTERNAL_SECRET) {
      const got = firstHeader((req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal']) as any);
      if (!got || !secretsEqual(got, INTERNAL_SECRET)) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
      }
    }
    if (hasEndUserCredential(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'internal endpoint: end-user credentials are not accepted' });
    }
    const parsed = usageIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    }
    const accepted = await ingestUsageEvents(parsed.data.events);
    noStore(res);
    res.status(202).json({ ok: true, accepted });
  });

  app.get('/v1/usage/summary', async (req, res) => {
    const org = await resolveCallerOrg(req, TRUST_STAMPED);
    if (!org) {
      return res.status(403).json({ error: 'forbidden', message: 'usage analytics requires an organization context' });
    }
    const parsed = parseUsageFilter(req);
    if (!parsed.filter) {
      return res.status(400).json({ error: 'invalid_query', message: parsed.error });
    }
    noStore(res);
    res.json(await usageSummary({ ...parsed.filter, orgId: org }));
  });

  app.get('/v1/usage/events', async (req, res) => {
    const org = await resolveCallerOrg(req, TRUST_STAMPED);
    if (!org) {
      return res.status(403).json({ error: 'forbidden', message: 'usage analytics requires an organization context' });
    }
    const parsed = parseUsageFilter(req);
    if (!parsed.filter) {
      return res.status(400).json({ error: 'invalid_query', message: parsed.error });
    }
    noStore(res);
    res.json(await listUsageEvents({ ...parsed.filter, orgId: org }));
  });

  // ---------- Platform Super Admin control plane ----------
  // These routes are served by IAM but only accept a dedicated platform-admin
  // token (kind=platform-admin, aud=synapseone-platform-admin). They never
  // accept tenant JWTs, API keys, or service-account tokens as a platform
  // session. The gateway route lives at /v1/platform.

  app.post('/v1/platform/session', mfaLimiter, async (req, res) => {
    if (!platformFeatureEnabled()) return res.status(404).json({ error: 'not_found' });
    const h = firstHeader(req.headers.authorization as any);
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized', message: 'user Bearer token required' });
    let claims: any;
    try { claims = verifyAccess(h.slice(7)); } catch { return res.status(401).json({ error: 'invalid_token' }); }
    if (claims.kind && claims.kind !== 'user') {
      await auditPlatformDenied(req, String(claims.sub || ''), null, 'platform:session:exchange', 'non_user_credential');
      return res.status(403).json({ error: 'platform_session_requires_user', message: 'sign in as a user before opening the platform console' });
    }
    const user = await getUserById(claims.sub);
    if (!user || user.active === false) {
      await auditPlatformDenied(req, String(claims.sub || ''), user?.org_id || null, 'platform:session:exchange', 'account_inactive');
      return res.status(403).json({ error: 'platform_admin_inactive' });
    }
    const admin = await getPlatformAdmin(user.id);
    if (!admin || admin.revoked_at) {
      await auditPlatformDenied(req, user.id, user.org_id, 'platform:session:exchange', 'not_platform_admin');
      return res.status(403).json({ error: 'platform_admin_required' });
    }
    const org = await getOrgById(user.org_id);
    if (!org || (org.kind || 'tenant') !== 'platform') {
      await auditPlatformDenied(req, user.id, user.org_id, 'platform:session:exchange', 'platform_org_required');
      return res.status(403).json({ error: 'platform_admin_org_required' });
    }
    const requireMfa = (process.env.PLATFORM_ADMIN_REQUIRE_MFA ?? 'true') === 'true';
    if (requireMfa && !(await mfaEnabled(user.id))) {
      await auditPlatformDenied(req, user.id, user.org_id, 'platform:session:exchange', 'mfa_not_enabled');
      return res.status(403).json({ error: 'platform_mfa_required', message: 'enable TOTP MFA before using the platform console' });
    }
    // Proof of a fresh second factor for THIS session: do not treat
    // user_mfa.enabled as evidence that the current login completed MFA.
    if (requireMfa) {
      const locked = await lockRemaining(user.id);
      if (locked > 0) return res.status(429).json({ error: 'account_locked', message: 'too many failed verification attempts', retryAfter: locked });
      const parsed = z.object({
        code: z.string().trim().max(16).nullish(),
        recoveryCode: z.string().trim().max(32).nullish(),
      }).safeParse(req.body);
      if (!parsed.success || (!parsed.data.code && !parsed.data.recoveryCode)) {
        await auditPlatformDenied(req, user.id, user.org_id, 'platform:session:exchange', 'fresh_mfa_required');
        return res.status(403).json({ error: 'platform_mfa_required', message: 'enter a fresh authenticator code to open the platform console' });
      }
      const check = await checkSecondFactor(user.id, parsed.data);
      if (!check.ok) {
        const lockedFor = await recordLoginFailure(user.id);
        await auditPlatformDenied(req, user.id, user.org_id, 'platform:session:exchange', 'invalid_mfa_code');
        return res.status(401).json({
          error: 'invalid_mfa_code',
          message: 'The verification code is incorrect',
          ...(lockedFor ? { lockedForSeconds: lockedFor } : {}),
        });
      }
    }
    const session = signPlatformAccess({ userId: user.id, role: admin.role });
    await auditPlatformAction(req, user.id, 'platform:session:exchange', user.org_id, { role: admin.role });
    noStore(res);
    return res.json({
      accessToken: session.token,
      expiresIn: session.expiresIn,
      role: admin.role,
      user: publicUser(user),
      mfa: { enabled: requireMfa ? true : await mfaEnabled(user.id) },
      mfaRequired: requireMfa,
      stepUpRequired: (process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP ?? 'true') === 'true',
    });
  });

  app.post('/v1/platform/step-up', mfaLimiter, async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    const parsed = z.object({
      code: z.string().trim().max(16).nullish(),
      recoveryCode: z.string().trim().max(32).nullish(),
      action: z.string().trim().max(64),
    }).safeParse(req.body);
    if (!parsed.success || (!parsed.data.code && !parsed.data.recoveryCode)) {
      return res.status(400).json({ error: 'invalid_body', message: 'code or recoveryCode required' });
    }
    if (!PLATFORM_STEP_UP_ACTIONS.has(parsed.data.action)) {
      return res.status(400).json({ error: 'invalid_step_up_action', message: 'unknown step-up action' });
    }
    const sessionJti = String(ctx.claims?.jti || '');
    if (!sessionJti) return res.status(403).json({ error: 'platform_session_required', message: 'obtain a fresh platform session' });
    const locked = await lockRemaining(ctx.user.id);
    if (locked > 0) return res.status(429).json({ error: 'account_locked', message: 'too many failed verification attempts', retryAfter: locked });
    const result = await checkSecondFactor(ctx.user.id, { code: parsed.data.code, recoveryCode: parsed.data.recoveryCode });
    if (!result.ok) {
      const lockedFor = await recordLoginFailure(ctx.user.id);
      await auditPlatformDenied(req, ctx.user.id, ctx.user.org_id, parsed.data.action, 'invalid_step_up_code');
      return res.status(401).json({
        error: 'invalid_mfa_code',
        message: 'The verification code is incorrect',
        ...(lockedFor ? { lockedForSeconds: lockedFor } : {}),
      });
    }
    const step = signPlatformStepUp({
      userId: ctx.user.id,
      role: ctx.admin.role,
      sessionJti,
      action: parsed.data.action,
    });
    await registerPlatformStepUp({
      jti: step.jti,
      userId: ctx.user.id,
      sessionJti,
      action: parsed.data.action,
      expiresAt: new Date(Date.now() + step.expiresIn * 1000),
    });
    await auditPlatformAction(req, ctx.user.id, 'platform:step-up', ctx.user.org_id, { action: parsed.data.action });
    noStore(res);
    return res.json({ stepUpToken: step.token, expiresIn: step.expiresIn, action: parsed.data.action });
  });

  app.get('/v1/platform/me', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    noStore(res);
    res.json({
      user: publicUser(ctx.user),
      role: ctx.admin.role,
      mfa: { enabled: await mfaEnabled(ctx.user.id) },
      mfaRequired: (process.env.PLATFORM_ADMIN_REQUIRE_MFA ?? 'true') === 'true',
      stepUpRequired: (process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP ?? 'true') === 'true',
      platformOrgId: ctx.user.org_id,
    });
  });

  app.get('/v1/platform/overview', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    const range = parsePlatformRange(req, res, 24);
    if (!range) return;
    const [counts, usage, audit] = await Promise.all([
      getPlatformOverviewCounts(),
      usageSummary({ from: range.from, to: range.to }),
      platformAuditStats(range.from, range.to),
    ]);
    noStore(res);
    res.json({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      tenancy: counts,
      usage: usage.totals,
      audit,
    });
  });

  app.get('/v1/platform/orgs', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'invalid_limit' });
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) return res.status(400).json({ error: 'invalid_offset' });
    const out = await listPlatformOrganizations({ q: String(req.query.q || ''), limit, offset });
    noStore(res);
    res.json({ ...out, limit, offset });
  });

  app.post('/v1/platform/orgs', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    const parsed = z.object({
      slug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/),
      displayName: z.string().trim().min(2).max(200),
      adminEmail: z.string().trim().toLowerCase().email().max(320),
      adminDisplayName: z.string().trim().max(200).nullish(),
      reason: z.string().trim().max(500).nullish(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const b = parsed.data;
    if (b.slug.toLowerCase() === (process.env.PLATFORM_ORG_SLUG || 'synapseone-platform').toLowerCase()) {
      return res.status(403).json({ error: 'reserved_org_slug', message: 'this slug is reserved for the platform organization' });
    }
    if (await getOrgBySlug(b.slug)) return res.status(409).json({ error: 'conflict', message: 'organization slug exists' });
    if (!(await requirePlatformStepUp(req, res, ctx, 'org:create'))) return;
    const result = await withTransaction(async () => {
      const { organization: created, admin } = await createOrganizationWithAdmin(
        sanitizeName(b.slug, 64),
        sanitizeName(b.displayName),
        b.adminEmail,
        b.adminDisplayName ? sanitizeName(b.adminDisplayName) : undefined,
      );
      const inviteToken = await issueInvite(admin);
      await auditPlatformAction(req, ctx.user.id, 'platform:org:create', created.id, {
        slug: created.slug,
        adminUserId: admin.id,
        adminEmail: b.adminEmail,
        ...(b.reason ? { reason: b.reason } : {}),
      });
      return { created, admin, inviteToken };
    });
    noStore(res);
    res.status(201).json({ organization: result.created, admin: publicUser(result.admin), inviteToken: result.inviteToken });
  });

  app.post('/v1/platform/orgs/:orgId/accounts', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id' });
    const parsed = z.object({
      slug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/),
      displayName: z.string().trim().min(2).max(200),
      reason: z.string().trim().max(500).nullish(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const org = await getOrgById(req.params.orgId);
    if (!org || (org.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'org_not_found' });
    if (!(await requirePlatformStepUp(req, res, ctx, 'org:account:create'))) return;
    try {
      const account = await withTransaction(async () => {
        const created = await createAccount(org.id, parsed.data.slug, sanitizeName(parsed.data.displayName));
        await auditPlatformAction(req, ctx.user.id, 'platform:org:account:create', org.id, {
          accountId: created.id,
          slug: created.slug,
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        });
        return created;
      });
      noStore(res);
      res.status(201).json(account);
    } catch (e: any) {
      if (e?.code === 'audit_write_failed' || e?.status === 503) throw e;
      if (e?.code === '23505' || e?.status === 409) return res.status(409).json({ error: 'conflict', message: 'account slug exists' });
      return res.status(400).json({ error: 'invalid_body', message: e.message });
    }
  });

  app.get('/v1/platform/orgs/:orgId', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id' });
    const out = await getPlatformOrganization(req.params.orgId);
    if (!out) return res.status(404).json({ error: 'org_not_found' });
    noStore(res);
    res.json(out);
  });

  app.get('/v1/platform/users', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'invalid_limit' });
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) return res.status(400).json({ error: 'invalid_offset' });
    const orgId = req.query.orgId === undefined ? undefined : String(req.query.orgId);
    if (orgId !== undefined && !isUuid(orgId)) return res.status(400).json({ error: 'invalid_orgId' });
    const active = req.query.active === undefined ? undefined : String(req.query.active) === 'true';
    const isOrgAdmin = req.query.isOrgAdmin === undefined ? undefined : String(req.query.isOrgAdmin) === 'true';
    const out = await listPlatformUsers({ q: String(req.query.q || ''), orgId, active, isOrgAdmin, limit, offset });
    noStore(res);
    res.json({ ...out, limit, offset });
  });

  app.get('/v1/platform/users/:userId', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const user = await getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const org = await getOrgById(user.org_id);
    if (!org || (org.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'user_not_found' });
    const [roles, policies, mfa, sessions] = await Promise.all([
      rolesForUser(user.id),
      policiesForUser(user.id),
      getMfa(user.id),
      listRefreshSessions(user.id),
    ]);
    const lockedForSeconds = await lockRemaining(user.id);
    noStore(res);
    res.json({
      user: { ...publicUser(user), passwordSet: !!user.password_hash },
      organization: org,
      roles,
      policies: policies.map((document, index) => ({ index, document })),
      mfa: { enabled: !!mfa?.enabled, recoveryCodesRemaining: mfa?.enabled ? mfa.recovery_hashes.length : 0 },
      lockedForSeconds,
      sessions: sessions.map((s) => ({ id: s.id, created_at: s.created_at, expires_at: s.expires_at, revoked_at: s.revoked_at })),
    });
  });

  app.post('/v1/platform/users/:userId/invite', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const target = await getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const targetOrg = await getOrgById(target.org_id);
    if (!targetOrg || (targetOrg.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'user_not_found' });
    if (target.active === false) return res.status(409).json({ error: 'account_deactivated' });
    if (target.password_hash) return res.status(409).json({ error: 'password_already_set' });
    if (!(await requirePlatformStepUp(req, res, ctx, 'user:invite'))) return;
    const inviteToken = await withTransaction(async () => {
      const token = await issueInvite(target);
      await auditPlatformAction(req, ctx.user.id, 'platform:user:invite', target.org_id, { targetUserId: target.id });
      return token;
    });
    noStore(res);
    res.json({ ok: true, inviteToken });
  });

  app.put('/v1/platform/users/:userId/org-admin', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const flag = (req.body || {}).isOrgAdmin;
    if (typeof flag !== 'boolean') return res.status(400).json({ error: 'invalid_body', message: 'isOrgAdmin (boolean) required' });
    const target = await getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const targetOrg = await getOrgById(target.org_id);
    if (!targetOrg || (targetOrg.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'user_not_found' });
    if (!(await requirePlatformStepUp(req, res, ctx, 'user:org-admin'))) return;
    if (!flag && target.is_org_admin) {
      const admins = (await listUsers(target.org_id)).filter((u) => u.is_org_admin && u.active !== false);
      if (admins.length <= 1) return res.status(409).json({ error: 'last_admin', message: 'an organization needs at least one active administrator' });
    }
    const reason = typeof (req.body || {}).reason === 'string' ? String((req.body || {}).reason).slice(0, 500) : '';
    const updated = await withTransaction(async () => {
      const u = await setOrgAdmin(target.id, flag);
      await auditPlatformAction(req, ctx.user.id, 'platform:user:org-admin', target.org_id, {
        targetUserId: target.id, oldValue: !!target.is_org_admin, newValue: flag, ...(reason ? { reason } : {}),
      });
      return u;
    });
    res.json(updated ? publicUser(updated) : { ok: true });
  });

  app.post('/v1/platform/users/:userId/reset-mfa', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const target = await getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const targetOrg = await getOrgById(target.org_id);
    if (!targetOrg || (targetOrg.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'user_not_found' });
    if (!(await requirePlatformStepUp(req, res, ctx, 'user:reset-mfa'))) return;
    const result = await withTransaction(async () => {
      const removed = await removeMfa(target.id);
      await clearLoginFailures(target.id);
      const revoked = await revokeAllRefresh(target.id);
      const revokedKeys = await revokeApiKeysForUser(target.id);
      await auditPlatformAction(req, ctx.user.id, 'platform:user:reset-mfa', target.org_id, { targetUserId: target.id, removed, revoked, revokedKeys });
      return { removed, revoked, revokedKeys };
    });
    res.json({ ok: true, ...result });
  });

  app.post('/v1/platform/users/:userId/unlock', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const target = await getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const targetOrg = await getOrgById(target.org_id);
    if (!targetOrg || (targetOrg.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'user_not_found' });
    await withTransaction(async () => {
      await clearLoginFailures(target.id);
      await auditPlatformAction(req, ctx.user.id, 'platform:user:unlock', target.org_id, { targetUserId: target.id });
    });
    res.json({ ok: true });
  });

  app.post('/v1/platform/users/:userId/revoke-sessions', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const target = await getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const targetOrg = await getOrgById(target.org_id);
    if (!targetOrg || (targetOrg.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'user_not_found' });
    if (!(await requirePlatformStepUp(req, res, ctx, 'user:revoke-sessions'))) return;
    const result = await withTransaction(async () => {
      const revoked = await revokeAllRefresh(target.id);
      const revokedKeys = await revokeApiKeysForUser(target.id);
      await auditPlatformAction(req, ctx.user.id, 'platform:user:revoke-sessions', target.org_id, { targetUserId: target.id, revoked, revokedKeys });
      return { revoked, revokedKeys };
    });
    res.json({ ok: true, ...result });
  });

  app.post('/v1/platform/users/:userId/disable', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const target = await getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const targetOrg = await getOrgById(target.org_id);
    if (!targetOrg || (targetOrg.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'user_not_found' });
    if (!(await requirePlatformStepUp(req, res, ctx, 'user:disable'))) return;
    const result = await withTransaction(async () => {
      await setUserActive(target.id, false);
      const revoked = await revokeAllRefresh(target.id);
      const revokedKeys = await revokeApiKeysForUser(target.id);
      await auditPlatformAction(req, ctx.user.id, 'platform:user:disable', target.org_id, { targetUserId: target.id, revoked, revokedKeys });
      return { revoked, revokedKeys };
    });
    res.json({ ok: true, ...result });
  });

  app.post('/v1/platform/users/:userId/enable', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'operator');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const target = await getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const targetOrg = await getOrgById(target.org_id);
    if (!targetOrg || (targetOrg.kind || 'tenant') !== 'tenant') return res.status(404).json({ error: 'user_not_found' });
    await withTransaction(async () => {
      await setUserActive(target.id, true);
      await auditPlatformAction(req, ctx.user.id, 'platform:user:enable', target.org_id, { targetUserId: target.id });
    });
    res.json({ ok: true });
  });

  app.get('/v1/platform/usage/summary', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    const parsed = parseUsageFilter(req);
    if (!parsed.filter) return res.status(400).json({ error: 'invalid_query', message: parsed.error });
    const orgId = req.query.orgId === undefined ? undefined : String(req.query.orgId);
    if (orgId !== undefined && !isUuid(orgId)) return res.status(400).json({ error: 'invalid_orgId' });
    noStore(res);
    res.json(await usageSummary({ ...parsed.filter, ...(orgId ? { orgId } : {}) }));
  });

  app.get('/v1/platform/usage/events', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    const parsed = parseUsageFilter(req);
    if (!parsed.filter) return res.status(400).json({ error: 'invalid_query', message: parsed.error });
    const orgId = req.query.orgId === undefined ? undefined : String(req.query.orgId);
    if (orgId !== undefined && !isUuid(orgId)) return res.status(400).json({ error: 'invalid_orgId' });
    noStore(res);
    res.json(await listUsageEvents({ ...parsed.filter, ...(orgId ? { orgId } : {}) }));
  });

  app.get('/v1/platform/audit', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'auditor');
    if (!ctx) return;
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'invalid_limit' });
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) return res.status(400).json({ error: 'invalid_offset' });
    const actor = typeof req.query.actor === 'string' && req.query.actor ? req.query.actor : undefined;
    if (actor && !isUuid(actor)) return res.status(400).json({ error: 'invalid_actor' });
    const orgId = typeof req.query.orgId === 'string' && req.query.orgId ? req.query.orgId : undefined;
    if (orgId && !isUuid(orgId)) return res.status(400).json({ error: 'invalid_orgId' });
    const rawAllowed = req.query.allowed;
    const allowed = rawAllowed === undefined ? undefined : String(rawAllowed).toLowerCase() === 'true';
    if (rawAllowed !== undefined && !['true', 'false'].includes(String(rawAllowed).toLowerCase())) {
      return res.status(400).json({ error: 'invalid_allowed' });
    }
    const action = typeof req.query.action === 'string' && req.query.action ? req.query.action.slice(0, 200) : undefined;
    const resource = typeof req.query.resource === 'string' && req.query.resource ? req.query.resource.slice(0, 512) : undefined;
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))) {
      return res.status(400).json({ error: 'invalid_time' });
    }
    noStore(res);
    res.json(await queryAudit({ limit, offset, actor, allowed, orgId, action, resource, from, to }));
  });

  app.get('/v1/platform/admins', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'owner');
    if (!ctx) return;
    const rows = await listPlatformAdmins();
    const items = await Promise.all(rows.map(async (a) => {
      const u = await getUserById(a.user_id);
      return { ...a, email: u?.email || '', display_name: u?.display_name || '', active: u?.active !== false };
    }));
    noStore(res);
    res.json({ items });
  });

  app.post('/v1/platform/admins', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'owner');
    if (!ctx) return;
    const role = String((req.body || {}).role || 'auditor');
    if (!['owner', 'operator', 'auditor'].includes(role)) return res.status(400).json({ error: 'invalid_role' });
    if (!(await requirePlatformStepUp(req, res, ctx, 'admin:grant'))) return;
    const email = typeof (req.body || {}).email === 'string' ? String((req.body || {}).email).trim().toLowerCase() : '';
    const userId = typeof (req.body || {}).userId === 'string' ? String((req.body || {}).userId) : '';
    if (email && !z.string().email().max(320).safeParse(email).success) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const platformOrg = await getOrgBySlug(process.env.PLATFORM_ORG_SLUG || 'synapseone-platform');
    if (!platformOrg || (platformOrg.kind || 'tenant') !== 'platform') {
      return res.status(409).json({ error: 'platform_org_missing', message: 'initialize the platform organization first' });
    }
    let target: User | null = null;
    if (userId) {
      if (!isUuid(userId)) return res.status(400).json({ error: 'invalid_userId' });
      target = await getUserById(userId);
      const org = target ? await getOrgById(target.org_id) : null;
      if (!target || !org || (org.kind || 'tenant') !== 'platform') {
        return res.status(403).json({ error: 'platform_user_required', message: 'platform administrators must be members of the platform organization' });
      }
    } else if (email) {
      target = await findUserByOrgEmail(platformOrg.id, email);
      if (!target) target = await upsertUser(platformOrg.id, email, email);
    } else {
      return res.status(400).json({ error: 'email_or_userId_required' });
    }
    if (target.active === false) {
      return res.status(409).json({ error: 'platform_user_inactive', message: 'the target platform account is inactive' });
    }
    const previous = await getPlatformAdmin(target.id);
    if (previous && !previous.revoked_at && previous.role === 'owner' && role !== 'owner'
        && (await countActivePlatformOwners()) <= 1) {
      await auditPlatformDenied(req, ctx.user.id, target.org_id, 'admin:grant', 'last_owner_demotion');
      return res.status(409).json({ error: 'last_owner', message: 'at least one platform owner must remain' });
    }
    const reason = typeof (req.body || {}).reason === 'string' ? String((req.body || {}).reason).slice(0, 500) : '';
    const result = await withTransaction(async () => {
      const admin = await grantPlatformAdmin({
        userId: target.id,
        role: role as PlatformAdmin['role'],
        grantedBy: ctx.user.id,
        reason,
      });
      const inviteToken = await issueInvite(target);
      await auditPlatformAction(req, ctx.user.id, 'platform:admin:grant', target.org_id, {
        targetUserId: target.id,
        oldRole: previous?.role || null,
        role,
        inviteIssued: !!inviteToken,
        ...(reason ? { reason } : {}),
      });
      return { admin, inviteToken };
    });
    res.status(201).json({ ...result.admin, email: target.email, display_name: target.display_name || '', inviteToken: result.inviteToken });
  });

  app.delete('/v1/platform/admins/:userId', async (req, res) => {
    const ctx = await currentPlatformAdmin(req, res, 'owner');
    if (!ctx) return;
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id' });
    const target = await getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const targetAdmin = await getPlatformAdmin(target.id);
    if (!targetAdmin || targetAdmin.revoked_at) return res.status(404).json({ error: 'platform_admin_not_found' });
    if (targetAdmin.role === 'owner' && target.active !== false && (await countActivePlatformOwners()) <= 1) {
      await auditPlatformDenied(req, ctx.user.id, target.org_id, 'admin:revoke', 'last_owner');
      return res.status(409).json({ error: 'last_owner', message: 'at least one platform owner must remain' });
    }
    if (!(await requirePlatformStepUp(req, res, ctx, 'admin:revoke'))) return;
    if (targetAdmin.role === 'owner' && target.active !== false && (await countActivePlatformOwners()) <= 1) {
      await auditPlatformDenied(req, ctx.user.id, target.org_id, 'admin:revoke', 'last_owner');
      return res.status(409).json({ error: 'last_owner', message: 'at least one platform owner must remain' });
    }
    const ok = await revokePlatformAdmin(target.id);
    if (!ok) {
      await auditPlatformDenied(req, ctx.user.id, target.org_id, 'admin:revoke', 'revoke_failed');
      return res.status(404).json({ error: 'platform_admin_not_found' });
    }
    const reason = typeof (req.body || {}).reason === 'string' ? String((req.body || {}).reason).slice(0, 500) : '';
    const result = await withTransaction(async () => {
      const revoked = await revokeAllRefresh(target.id);
      const revokedKeys = await revokeApiKeysForUser(target.id);
      await auditPlatformAction(req, ctx.user.id, 'platform:admin:revoke', target.org_id, {
        targetUserId: target.id,
        revoked,
        revokedKeys,
        previousRole: targetAdmin.role,
        ...(reason ? { reason } : {}),
      });
      return { revoked, revokedKeys };
    });
    res.json({ ok: true, ...result });
  });

  // One-time bootstrap, called directly over the internal network. No gateway
  // route exists. Requires PLATFORM_BOOTSTRAP_SECRET and an empty platform
  // administrator set.
  app.post('/internal/platform/bootstrap', async (req, res) => {
    const secret = process.env.PLATFORM_BOOTSTRAP_SECRET || '';
    if (!secret) return res.status(503).json({ error: 'bootstrap_disabled' });
    if (!secretsEqual(firstHeader(req.headers['x-platform-bootstrap-secret'] as any), secret)) {
      return res.status(401).json({ error: 'invalid_bootstrap_secret' });
    }
    const active = (await listPlatformAdmins()).filter((a) => !a.revoked_at);
    if (active.length) return res.status(409).json({ error: 'bootstrap_completed' });
    const parsed = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      displayName: z.string().trim().max(200).nullish(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const slug = process.env.PLATFORM_ORG_SLUG || 'synapseone-platform';
    let org = await getOrgBySlug(slug);
    if (org && (org.kind || 'tenant') !== 'platform') {
      return res.status(409).json({ error: 'platform_org_conflict', message: 'the reserved slug already belongs to a tenant organization' });
    }
    if (!org) org = await createOrganization(slug, 'SynapseOne Platform', 'platform');
    const user = await upsertUser(org.id, parsed.data.email, parsed.data.displayName ? sanitizeName(parsed.data.displayName) : undefined);
    if (user.active === false) await setUserActive(user.id, true);
    const admin = await grantPlatformAdmin({ userId: user.id, role: 'owner', grantedBy: user.id, reason: 'initial bootstrap' });
    const inviteToken = await issueInvite((await getUserById(user.id)) || user);
    await writeAuditStrict({
      actor_type: 'platform-bootstrap', actor_id: 'bootstrap', action: 'platform:bootstrap', resource: 'platform',
      decision: true, org_id: org.id, context: { platformAdmin: true, targetUserId: user.id, email: user.email },
    });
    noStore(res);
    res.status(201).json({ organization: org, user: publicUser(user), admin, inviteToken });
  });

  // Break-glass recovery for a platform administrator who lost their second
  // factor. Called directly over the internal network with a separate secret.
  app.post('/internal/platform/recovery', async (req, res) => {
    const secret = process.env.PLATFORM_RECOVERY_SECRET || '';
    if (!secret) return res.status(503).json({ error: 'recovery_disabled' });
    if (!secretsEqual(firstHeader(req.headers['x-platform-recovery-secret'] as any), secret)) {
      return res.status(401).json({ error: 'invalid_recovery_secret' });
    }
    const parsed = z.object({
      userId: z.string().uuid(),
      action: z.enum(['reset-mfa', 'revoke-sessions']),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const admin = await getPlatformAdmin(parsed.data.userId);
    if (!admin || admin.revoked_at) return res.status(404).json({ error: 'platform_admin_not_found' });
    const user = await getUserById(parsed.data.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    let result: any = { ok: true };
    if (parsed.data.action === 'reset-mfa') {
      result.removed = await removeMfa(user.id);
      await clearLoginFailures(user.id);
    } else {
      result.revoked = await revokeAllRefresh(user.id);
    }
    await writeAuditStrict({
      actor_type: 'platform-recovery', actor_id: 'recovery', action: `platform:recovery:${parsed.data.action}`,
      resource: `user:${user.id}`, decision: true, org_id: user.org_id,
      context: { platformAdmin: true, targetUserId: user.id, action: parsed.data.action },
    });
    noStore(res);
    res.json(result);
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Malformed JSON body (express.json SyntaxError): 400, not 500 — and never
    // leak the parse offset into logs clients can probe.
    if (err?.status === 400 || err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && /JSON/i.test(err.message))) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (err?.status === 413 || err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    }
    if (err?.code === 'audit_write_failed') {
      return res.status(503).json({ error: 'audit_write_failed', message: 'The administrative audit record could not be persisted; the request was not acknowledged.' });
    }
    if (err?.code === '23505' || err?.status === 409) {
      return res.status(409).json({ error: 'conflict', message: 'duplicate slug' });
    }
    // Malformed UUID in Postgres (invalid_text_representation): 400, not 500.
    if (err?.code === '22P02' || /invalid_text_representation|invalid input syntax for.*uuid/i.test(err?.message || '')) {
      return res.status(400).json({ error: 'invalid_id', message: 'malformed UUID' });
    }
    // Race check-then-insert (id bị xóa giữa chừng) → FK violation → 404, không 500.
    if (err?.code === '23503' || /foreign key|violates foreign/i.test(err?.message || '')) {
      return res.status(404).json({ error: 'invalid_reference', message: 'referenced id does not exist' });
    }
    console.error('[iam] unhandled:', err?.message || err);
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

if (require.main === module) {
  ensureTables().finally(() => {
    const app = createApp();
    const server = app.listen(PORT, () => console.log(`[iam] listening on :${PORT} db=${useDb() ? 'postgres' : 'memory'}`));
    const shutdown = () => {
      console.log('[iam] shutting down...');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}
