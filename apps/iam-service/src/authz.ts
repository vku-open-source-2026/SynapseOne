// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Principal-level authorization (AWS-style), used by the gateway's central
 * enforcement point. Combines three layers, all of which must allow:
 *
 *   1. Credential scopes  — an API key / service-account token is a "session
 *      policy": its scopes are action patterns that cap what it may do.
 *   2. Identity policies  — policies attached to the roles of the owning user
 *      or service account (explicit Deny > Allow > default deny).
 *   3. Org administrators — AWS "root"-like: allowed unless an attached
 *      policy explicitly denies the action.
 *
 * Legacy credentials without an identity (account-level API keys, service
 * accounts that hold no roles) are bounded by their scopes alone, which keeps
 * existing integrations working once enforcement is switched on.
 */
import type { PolicyDoc } from './db';
import { getUserById, policiesForServiceAccount, policiesForUser, getServiceAccount, rolesForServiceAccount } from './db';
import { evaluatePolicies, matchPattern, type ConditionContext } from './policy';
import { findApiKeyById } from './tokens';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PrincipalKind = 'user' | 'service-account' | 'apikey';

export interface PrincipalInput {
  kind: PrincipalKind;
  /** user id / service-account id (JWT `sub`). */
  sub?: string;
  org?: string;
  account?: string;
  /** Scopes carried by the presented credential (JWT claim). */
  scopes?: string[];
  /** API-key id (gateway resolves it from /v1/keys/verify). */
  keyId?: string;
}

export type DecisionReason =
  | 'org-admin'
  | 'policy-allow'
  | 'scope-only'
  | 'explicit-deny'
  | 'implicit-deny'
  | 'scope-deny'
  | 'unknown-principal';

export interface Decision {
  allowed: boolean;
  reason: DecisionReason;
  /** Identity the decision was evaluated for (user/SA id, or key id). */
  principal: string;
  /** Owning org / account of that identity (audit attribution). */
  org?: string;
  account?: string;
}

/** Verbs that the gateway scope grammar (`*:read`, `<service>:read`) treats as reads. */
const READ_VERBS = new Set(['read', 'get', 'list', 'describe']);

/** Gateway scope grammar (apps/gateway/src/scopes.ts): `*:read`, `*:write`,
 *  `<service>:read|write|*` or a concrete lower-case verb, matched against an
 *  IAM action `<service>:<Verb>` case-insensitively. */
function gatewayScopeAllows(scope: string, action: string): boolean {
  const [sSvc, sVerb] = scope.toLowerCase().split(':');
  const [aSvc, aVerb] = action.toLowerCase().split(':');
  if (!sVerb || !aVerb) return false;
  if (sSvc !== '*' && sSvc !== aSvc) return false;
  if (sVerb === '*' || sVerb === aVerb) return true;
  if (sVerb === 'read') return READ_VERBS.has(aVerb);
  if (sVerb === 'write') return !READ_VERBS.has(aVerb);
  return false;
}

/** Does any scope cover `action`? Accepts IAM action patterns (`*`, `base:*`,
 *  `base:Read`) and the gateway scope grammar (`*:read`, `base:write`). */
export function scopesAllow(scopes: string[] | undefined, action: string): boolean {
  return (scopes || []).some((s) => matchPattern(s, action) || gatewayScopeAllows(s, action));
}

// ---------- AWS-style managed policies ----------

export const MANAGED_POLICIES: Record<string, { description: string; document: PolicyDoc }> = {
  AdministratorAccess: {
    description: 'Full access to every SynapseOne service and resource.',
    document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] },
  },
  PowerUserAccess: {
    description: 'Full access to data and workflow services; no identity/access management.',
    document: {
      Version: '2026-01-01',
      Statement: [
        { Effect: 'Allow', Action: '*', Resource: '*' },
        { Effect: 'Deny', Action: 'iam:*', Resource: '*' },
      ],
    },
  },
  ReadOnlyAccess: {
    description: 'Read-only access to every service.',
    document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: ['*:Read', '*:Get', '*:List', '*:Describe'], Resource: '*' }] },
  },
  StorageFullAccess: {
    description: 'Full access to SynapseOne object storage.',
    document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: 'storage:*', Resource: '*' }] },
  },
  StorageReadOnlyAccess: {
    description: 'Download and list objects in SynapseOne object storage.',
    document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: 'storage:Read', Resource: '*' }] },
  },
  DataFullAccess: {
    description: 'Full access to the core data cluster (Base, Faststore, Queue, Stream, Storage).',
    document: {
      Version: '2026-01-01',
      Statement: [{ Effect: 'Allow', Action: ['base:*', 'faststore:*', 'queue:*', 'stream:*', 'storage:*'], Resource: '*' }],
    },
  },
};

export function managedPolicyList(): Array<{ name: string; description: string; document: PolicyDoc }> {
  return Object.entries(MANAGED_POLICIES).map(([name, p]) => ({ name, ...p }));
}

// ---------- Decision ----------

async function decideForUser(userId: string, action: string, resource: string, ctx: ConditionContext): Promise<Decision> {
  const user = await getUserById(userId);
  if (!user) return { allowed: false, reason: 'unknown-principal', principal: userId };
  const docs = await policiesForUser(userId);
  const verdict = evaluatePolicies(docs, { action, resource }, { ...ctx, user: user.id, org: user.org_id, email: user.email });
  const who = { principal: userId, org: user.org_id };
  if (verdict.matchedBy === 'Deny') return { allowed: false, reason: 'explicit-deny', ...who };
  if (user.is_org_admin) return { allowed: true, reason: 'org-admin', ...who };
  return verdict.allowed
    ? { allowed: true, reason: 'policy-allow', ...who }
    : { allowed: false, reason: 'implicit-deny', ...who };
}

async function decideForServiceAccount(saId: string, scopes: string[] | undefined, action: string, resource: string, ctx: ConditionContext): Promise<Decision> {
  const sa = await getServiceAccount(saId);
  if (!sa) return { allowed: false, reason: 'unknown-principal', principal: saId };
  const who = { principal: saId, account: sa.account_id };
  if (!scopesAllow(scopes, action)) return { allowed: false, reason: 'scope-deny', ...who };
  const roles = await rolesForServiceAccount(saId);
  if (!roles.length) return { allowed: true, reason: 'scope-only', ...who };
  const docs = await policiesForServiceAccount(saId);
  const verdict = evaluatePolicies(docs, { action, resource }, { ...ctx, serviceAccount: sa.id, account: sa.account_id });
  if (verdict.matchedBy === 'Deny') return { allowed: false, reason: 'explicit-deny', ...who };
  return verdict.allowed
    ? { allowed: true, reason: 'policy-allow', ...who }
    : { allowed: false, reason: 'implicit-deny', ...who };
}

/**
 * Decide whether `principal` may perform `action` on `resource`. Credential
 * data is always re-read from the store (key scopes/owner, user admin flag) —
 * the caller-supplied principal only names the identity.
 */
export async function decideForPrincipal(
  principal: PrincipalInput,
  action: string,
  resource: string,
  ctx: ConditionContext = {},
): Promise<Decision> {
  if (principal.kind === 'apikey') {
    if (!principal.keyId || !UUID_RE.test(principal.keyId)) return { allowed: false, reason: 'unknown-principal', principal: principal.keyId || '' };
    const key = await findApiKeyById(principal.keyId);
    const live = key && !key.revoked_at && !(key.expires_at && new Date(key.expires_at).getTime() < Date.now());
    if (!key || !live) return { allowed: false, reason: 'unknown-principal', principal: principal.keyId };
    const who = { principal: principal.keyId, account: key.account_id };
    if (!scopesAllow(key.scopes, action)) return { allowed: false, reason: 'scope-deny', ...who };
    // Owner-bound key: inherits (and is capped by) its user's permissions.
    if (key.user_id) {
      const d = await decideForUser(key.user_id, action, resource, ctx);
      return { ...d, ...who };
    }
    return { allowed: true, reason: 'scope-only', ...who };
  }
  if (!principal.sub) return { allowed: false, reason: 'unknown-principal', principal: '' };
  // Identities are UUIDs; anything else (e.g. a hand-minted test JWT) cannot
  // own policies — deny cleanly instead of hitting the store with a bad id.
  if (!UUID_RE.test(principal.sub)) return { allowed: false, reason: 'unknown-principal', principal: principal.sub };
  if (principal.kind === 'service-account') {
    return decideForServiceAccount(principal.sub, principal.scopes, action, resource, ctx);
  }
  // Interactive user tokens carry no scopes; a scoped user token is capped.
  if (principal.scopes && principal.scopes.length && !scopesAllow(principal.scopes, action)) {
    return { allowed: false, reason: 'scope-deny', principal: principal.sub };
  }
  return decideForUser(principal.sub, action, resource, ctx);
}
