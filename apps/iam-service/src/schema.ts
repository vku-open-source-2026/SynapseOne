// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * IAM Drizzle schema — tables/indexes are versioned migrations.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    /** tenant = customer organization; platform = reserved staff organization. */
    kind: text('kind').notNull().default('tenant'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug), index('idx_organizations_kind').on(t.kind)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_org_id_slug_key').on(t.orgId, t.slug),
    index('idx_accounts_org').on(t.orgId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    externalSub: text('external_sub'),
    email: text('email').notNull(),
    displayName: text('display_name'),
    /** scrypt hash, null for OIDC-only / passwordless users. */
    passwordHash: text('password_hash'),
    emailVerified: boolean('email_verified').notNull().default(false),
    active: boolean('active').notNull().default(true),
    passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
    /** Org administrator (AWS "root"-like): full access inside its own org. */
    isOrgAdmin: boolean('is_org_admin').notNull().default(false),
    /** Consecutive failed password / second-factor attempts (login lockout). */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_org_id_email_key').on(t.orgId, t.email),
    uniqueIndex('idx_users_external_sub').on(t.externalSub).where(sql`${t.externalSub} is not null`),
    uniqueIndex('idx_users_org_email_lower').on(t.orgId, sql`lower(${t.email})`),
    index('idx_users_org').on(t.orgId),
    index('idx_users_email_lower').on(sql`lower(${t.email})`),
    index('idx_users_created_at').on(t.createdAt.desc()),
  ],
);

/** Single-use password reset / email verification tokens (hashed at rest). */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull().default('reset'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('password_reset_tokens_token_hash_key').on(t.tokenHash),
    index('password_reset_tokens_user_idx').on(t.userId),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    description: text('description').default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('roles_account_id_slug_key').on(t.accountId, t.slug),
    index('idx_roles_account').on(t.accountId),
  ],
);

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    description: text('description').default(''),
    document: jsonb('document').$type<Record<string, any>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('policies_account_id_slug_key').on(t.accountId, t.slug),
    index('idx_policies_account').on(t.accountId),
  ],
);

export const rolePolicies = pgTable(
  'role_policies',
  {
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    policyId: uuid('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.policyId] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    name: text('name').notNull().default(''),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_key').on(t.keyHash),
    index('idx_api_keys_prefix').on(t.keyPrefix),
    index('idx_api_keys_expiry').on(t.expiresAt).where(sql`${t.revokedAt} is null`),
    index('idx_api_keys_account').on(t.accountId),
  ],
);

export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    description: text('description').default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('service_accounts_account_id_slug_key').on(t.accountId, t.slug),
    index('idx_service_accounts_account').on(t.accountId),
  ],
);

/** Roles granted to a service account (machine identity), like user_roles. */
export const serviceAccountRoles = pgTable(
  'service_account_roles',
  {
    serviceAccountId: uuid('service_account_id').notNull().references(() => serviceAccounts.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.serviceAccountId, t.roleId] })],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash_key').on(t.tokenHash),
    index('idx_refresh_expiry').on(t.expiresAt).where(sql`${t.revokedAt} is null`),
    index('idx_refresh_tokens_user').on(t.userId),
  ],
);

/** Legacy workflow metadata table (kept for backward compatibility). */
export const legacyWorkflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    definition: jsonb('definition').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workflows_account_id_slug_key').on(t.accountId, t.slug),
    index('idx_workflows_account').on(t.accountId),
  ],
);

/** Request/feature usage events written by the gateway (batched, best-effort).
 *  Rows are tenant-scoped by org_id; account/user ids are optional because
 *  API-key and anonymous traffic has no user principal. */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    requestId: text('request_id').notNull().default(''),
    feature: text('feature').notNull(),
    route: text('route').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull().default(''),
    status: integer('status').notNull(),
    durationMs: integer('duration_ms').notNull(),
    authKind: text('auth_kind').notNull().default('unknown'),
    orgId: uuid('org_id'),
    accountId: uuid('account_id'),
    userId: uuid('user_id'),
    // AI/inference metering (#26): tokens attributed per request/model.
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    model: text('model'),
    error: text('error'),
  },
  (t) => [
    index('idx_usage_time').on(t.createdAt.desc()),
    index('idx_usage_org_time').on(t.orgId, t.createdAt.desc()),
    index('idx_usage_feature_time').on(t.feature, t.createdAt.desc()),
    index('idx_usage_status').on(t.status),
    index('idx_usage_model_time').on(t.model, t.createdAt.desc()),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull().default('user'),
    actorId: text('actor_id').notNull().default(''),
    action: text('action').notNull(),
    resource: text('resource').notNull().default(''),
    decision: boolean('decision').notNull(),
    /** Tenant attribution column (indexed) for platform/tenant audit queries. */
    orgId: uuid('org_id'),
    context: jsonb('context').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('idx_audit_actor').on(t.actorId, t.createdAt.desc()),
    index('idx_audit_time').on(t.createdAt.desc()),
    index('idx_audit_action').on(t.action, t.decision),
    index('idx_audit_org_time').on(t.orgId, t.createdAt.desc()),
  ],
);

/** SCIM provisioning tokens (#48): scoped, org-bound, hashed at rest. */
export const scimTokens = pgTable(
  'scim_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    description: text('description').notNull().default(''),
    scopes: jsonb('scopes').$type<string[]>().notNull().default(sql`'["scim:read","scim:write"]'::jsonb`),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('scim_tokens_hash_key').on(t.tokenHash), index('idx_scim_tokens_org').on(t.orgId)],
);

/** SCIM groups with an explicit, audited role mapping. */
export const scimGroups = pgTable(
  'scim_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id'),
    displayName: text('display_name').notNull(),
    externalId: text('external_id'),
    members: jsonb('members').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    roles: jsonb('roles').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scim_groups_org_name_key').on(t.orgId, t.displayName),
    index('idx_scim_groups_org').on(t.orgId),
  ],
);

/** TOTP second factor: AES-256-GCM sealed secret, hashed recovery codes. */
export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  secretEnc: text('secret_enc').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  recoveryHashes: jsonb('recovery_hashes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** Last accepted TOTP time step (replay protection). */
  lastStep: integer('last_step'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
});

/** Human-operated platform administrators (cross-tenant control plane).
 *  This is deliberately separate from users.is_org_admin (tenant-scoped). */
export const platformAdmins = pgTable(
  'platform_admins',
  {
    userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('auditor'),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    reason: text('reason').notNull().default(''),
  },
  (t) => [index('idx_platform_admins_role').on(t.role), index('idx_platform_admins_revoked').on(t.revokedAt)],
);

/** One-time step-up proofs. A step-up JWT is bound to the issuing platform
 *  session (sid), one action, and a jti consumed exactly once. */
export const platformStepUps = pgTable(
  'platform_step_ups',
  {
    jti: uuid('jti').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionJti: uuid('session_jti').notNull(),
    action: text('action').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_platform_step_ups_user').on(t.userId, t.expiresAt.desc()),
    index('idx_platform_step_ups_expiry').on(t.expiresAt),
  ],
);
