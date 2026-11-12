// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow Drizzle schema — tables/indexes are versioned migrations.
 */
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const workflows = pgTable(
  'synapseone_workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nodes: jsonb('nodes').$type<any[]>().notNull().default(sql`'[]'::jsonb`),
    connections: jsonb('connections').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    settings: jsonb('settings').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    active: boolean('active').notNull().default(false),
    orgId: text('org_id'),
    accountId: text('account_id'),
    ownerSub: text('owner_sub'),
    runAs: text('run_as'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_synapseone_workflows_active').on(t.active),
    index('idx_synapseone_workflows_tenant').on(t.orgId, t.accountId),
  ],
);

export const executions = pgTable(
  'synapseone_executions',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id').notNull(),
    workflowName: text('workflow_name').notNull().default(''),
    status: text('status').notNull().default('success'),
    input: jsonb('input').$type<any>().notNull().default(sql`'{}'::jsonb`),
    output: jsonb('output').$type<any>(),
    nodeRuns: jsonb('node_runs').$type<any[]>().notNull().default(sql`'[]'::jsonb`),
    error: text('error'),
    triggeredBy: text('triggered_by').notNull().default('manual'),
    principal: jsonb('principal').$type<Record<string, any> | null>(),
    actor: text('actor'),
    /** Queue dispatch metadata (queue execution mode). */
    queueName: text('queue_name'),
    runner: text('runner'),
    workerId: text('worker_id'),
    attempt: integer('attempt').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    workflowRevision: integer('workflow_revision'),
    resumeNode: text('resume_node'),
    resumeOutput: jsonb('resume_output').$type<any>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_synapseone_exec_workflow').on(t.workflowId, t.startedAt.desc()),
    index('idx_synapseone_exec_status').on(t.status, t.startedAt.desc()),
    index('idx_synapseone_exec_queue').on(t.status, t.queueName),
    index('idx_synapseone_exec_time').on(t.startedAt.desc()),
    index('idx_synapseone_exec_principal_org')
      .on(sql`(${t.principal}->>'org')`)
      .where(sql`${t.principal} is not null`),
    index('idx_synapseone_exec_principal_account')
      .on(sql`(${t.principal}->>'account')`)
      .where(sql`${t.principal} is not null`),
  ],
);

export const credentials = pgTable(
  'synapseone_credentials',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    orgId: text('org_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('bearer'),
    secretEnc: text('secret_enc').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('synapseone_credentials_account_id_name_key').on(t.accountId, t.name),
    index('idx_synapseone_credentials_account').on(t.accountId),
    index('idx_synapseone_credentials_org').on(t.orgId),
  ],
);

export const humanTasks = pgTable(
  'synapseone_human_tasks',
  {
    id: text('id').primaryKey(),
    executionId: text('execution_id'),
    workflowId: text('workflow_id'),
    nodeName: text('node_name').notNull().default(''),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('pending'),
    assignee: text('assignee'),
    candidateRoles: jsonb('candidate_roles').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    decisionSchema: jsonb('decision_schema').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    payload: jsonb('payload').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    decision: jsonb('decision').$type<Record<string, any> | null>(),
    note: text('note'),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedBy: text('completed_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    deadline: timestamp('deadline', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    orgId: text('org_id'),
    accountId: text('account_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_synapseone_human_tasks_status').on(t.status, t.createdAt.desc()),
    index('idx_synapseone_human_tasks_execution').on(t.executionId),
    index('idx_synapseone_human_tasks_tenant').on(t.orgId, t.accountId),
    index('idx_synapseone_human_tasks_deadline').on(t.status, t.deadline),
  ],
);

export const secrets = pgTable(
  'synapseone_secrets',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    accountId: text('account_id'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    scope: text('scope').notNull().default('tenant'),
    currentVersion: integer('current_version').notNull().default(1),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('synapseone_secrets_tenant_name_key').on(t.orgId, t.accountId, t.name),
    index('idx_synapseone_secrets_tenant').on(t.orgId, t.accountId),
  ],
);

export const secretVersions = pgTable(
  'synapseone_secret_versions',
  {
    id: text('id').primaryKey(),
    secretId: text('secret_id').notNull(),
    version: integer('version').notNull(),
    valueEnc: text('value_enc').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('synapseone_secret_versions_key').on(t.secretId, t.version),
    index('idx_synapseone_secret_versions_secret').on(t.secretId, t.version.desc()),
  ],
);

/**
 * Self-hosted workflow runners. A runner is a tenant-owned worker that
 * consumes a SynapseQueue workflow queue and executes DAGs with a SynapseOne
 * API key. The plaintext key is never stored here — only IAM key metadata.
 */
export const workflowRunners = pgTable(
  'synapseone_workflow_runners',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** custom | hybrid (platform workers are built into workflow-service). */
    mode: text('mode').notNull().default('custom'),
    queue: text('queue').notNull(),
    orgId: text('org_id'),
    accountId: text('account_id'),
    apiKeyId: text('api_key_id'),
    keyPrefix: text('key_prefix'),
    status: text('status').notNull().default('waiting'),
    version: text('version'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdBy: text('created_by'),
    metadata: jsonb('metadata').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_synapseone_runners_tenant').on(t.orgId, t.accountId),
    index('idx_synapseone_runners_queue').on(t.queue),
    index('idx_synapseone_runners_seen').on(t.lastSeenAt.desc()),
  ],
);

/**
 * One running connector process for a runner registration. A runner may have
 * several replicas (Cloudflare-connector style); each sends heartbeats with
 * its own instance id, hostname, version and concurrency.
 */
export const workflowRunnerInstances = pgTable(
  'synapseone_workflow_runner_instances',
  {
    id: text('id').primaryKey(),
    runnerId: text('runner_id').notNull(),
    hostname: text('hostname').notNull().default(''),
    version: text('version'),
    queue: text('queue').notNull().default(''),
    concurrency: integer('concurrency').notNull().default(1),
    status: text('status').notNull().default('connected'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_synapseone_runner_instances_runner').on(t.runnerId),
    index('idx_synapseone_runner_instances_seen').on(t.lastSeenAt.desc()),
  ],
);
