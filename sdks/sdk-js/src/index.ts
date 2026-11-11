// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * synapseone JavaScript SDK — works in Node 18+ and browsers (fetch-based).
 *
 * The SDK is split per service:
 *   client.iam        auth/OIDC, orgs/accounts/users, roles, policies,
 *                     API keys, service accounts, usage analytics
 *   client.workflow   templates, workflow CRUD/lifecycle, executions, test runs,
 *                     credentials, public inbound webhooks
 *   client.ai         API assistant (natural language -> endpoint + body)
 *   client.lds        LDS datasources/attributes/records/entities/licenses
 *   client.base       SynapseBase collections/documents/queries/mapping
 *   client.faststore  Synapse Faststore cache/KV, collections, locks
 *   client.queue      SynapseQueue publish/consume/ack, dead letters
 *   client.warehouse  Synapse Warehouse datasets, read-only SQL, batch/stream ETL
 *   client.inference  LLM proxy, embeddings, decision + semantic routing
 *
 * The old flat methods still work but emit a DeprecationWarning pointing at the
 * namespaced replacement (e.g. `client.listTemplates()` ->
 * `client.workflow.listTemplates()`).
 */

import { HttpClient, SynapseOneClientOptions, warnDeprecated } from './_http';
import { IamService } from './iam';
import { WorkflowService } from './workflow';
import { LdsAttributeInput, LdsDatasourceInput, LdsEntitiesQuery, LdsIngestResult, LdsService } from './lds';
import { BaseService } from './base';
import { FaststoreService } from './faststore';
import { QueueService } from './queue';
import { StreamService } from './stream';
import { WarehouseService } from './warehouse';
import { InferenceService } from './inference';
import { AiService } from './ai';
import { HealthService } from './health';
import { StorageService } from './storage';
import { SearchService } from './search';
import { OcsService } from './ocs';
import { NotificationsService } from './notifications';

export * from './_http';
export * from './iam';
export * from './workflow';
export * from './ai';
export * from './lds';
export * from './base';
export * from './faststore';
export * from './queue';
export * from './stream';
export * from './warehouse';
export * from './inference';
export * from './health';
export * from './storage';
export * from './search';
export * from './ocs';
export * from './notifications';

/** Legacy flat LDS signatures (the namespaced service drops the `lds` prefix). */
export interface LdsLegacyMethods {
  ldsLicenses(): Promise<any[]>;
  ldsDatasources(query?: { orgId?: string; accountId?: string }): Promise<any[]>;
  ldsCreateDatasource(input: LdsDatasourceInput): Promise<any>;
  ldsDatasource(id: string): Promise<any>;
  ldsUpdateDatasource(id: string, patch: Partial<LdsDatasourceInput>): Promise<any>;
  ldsDeleteDatasource(id: string): Promise<{ ok: boolean }>;
  ldsAttributes(id: string): Promise<any[]>;
  ldsSetAttributes(id: string, attributes: LdsAttributeInput[]): Promise<any[]>;
  ldsIngest(id: string, records: Record<string, unknown> | Record<string, unknown>[]): Promise<LdsIngestResult>;
  ldsEntities(id: string, query?: LdsEntitiesQuery): Promise<any[]>;
  ldsEntity(id: string, entityId: string): Promise<any>;
  ldsStats(id: string): Promise<any>;
}

export class SynapseOneClient {
  readonly http: HttpClient;
  readonly iam: IamService;
  readonly workflow: WorkflowService;
  readonly ai: AiService;
  readonly lds: LdsService;
  readonly base: BaseService;
  readonly faststore: FaststoreService;
  readonly queue: QueueService;
  readonly stream: StreamService;
  readonly warehouse: WarehouseService;
  readonly inference: InferenceService;
  readonly storage: StorageService;
  /** Tenant-scoped search over Base documents (#46). */
  readonly search: SearchService;
  /** SynapseOCS bucket/object API; `storage` remains the default-bucket alias. */
  readonly ocs: OcsService;
  readonly notifications: NotificationsService;
  readonly health: HealthService;
  readonly readiness: HealthService;

  constructor(opts: SynapseOneClientOptions = {}) {
    this.http = new HttpClient(opts);
    this.iam = new IamService(this.http);
    this.workflow = new WorkflowService(this.http);
    this.ai = new AiService(this.http);
    this.lds = new LdsService(this.http);
    this.base = new BaseService(this.http);
    this.faststore = new FaststoreService(this.http);
    this.queue = new QueueService(this.http);
    this.stream = new StreamService(this.http);
    this.warehouse = new WarehouseService(this.http);
    this.inference = new InferenceService(this.http);
    this.storage = new StorageService(this.http);
    this.search = new SearchService(this.http);
    this.ocs = new OcsService(this.http);
    this.notifications = new NotificationsService(this.http);
    this.health = new HealthService(this.http);
    // Alias: `client.readiness.ready()` reads naturally; same instance.
    this.readiness = this.health;
  }

  /** Shallow gateway health. */
  getHealth(opts?: import('./_http').RequestOptions) { return this.health.health(opts); }
  /** Aggregate readiness; returns the payload on 503 unless `throwOnDegraded`. */
  getReady(opts?: import('./health').ReadyOptions) { return this.health.ready(opts); }
  /** Projected `{ok, tier1, upstreams}` status for Tier-2 readiness endpoints. */
  getStatus(opts?: import('./health').ReadyOptions) { return this.health.status(opts); }

  get baseUrl(): string { return this.http.baseUrl; }
  setToken(t: string): void { this.http.setToken(t); }
  setApiKey(k: string): void { this.http.setApiKey(k); }
  setTenant(t: string | undefined): void { this.http.setTenant(t); }

  /** Generic escape hatch (forward-compat with endpoints added after this SDK). */
  call(method: string, path: string, body?: unknown) {
    return this.http.call(method, path, body);
  }
}

// The legacy flat methods are installed at runtime; this merge teaches the
// type system about them so existing call sites keep compiling.
export interface SynapseOneClient extends Pick<IamService, keyof IamService>, Pick<WorkflowService, keyof WorkflowService>, LdsLegacyMethods {}

const IAM_METHODS = [
  'login', 'register', 'loginWithPassword', 'changePassword', 'requestPasswordReset',
  'resetPassword', 'verifyEmail', 'requestEmailVerification', 'listSessions', 'revokeSession',
  'exchangeToken', 'refresh', 'logout', 'logoutAll', 'verify', 'me',
  'oidcConfig', 'oidcStart', 'oidcCallback',
  'listOrgs', 'createOrg', 'listAccounts', 'listUsers', 'createUser',
  'createAccount', 'userPolicies',
  'createRole', 'listRoles', 'deleteRole', 'listPolicies', 'deletePolicy',
  'createPolicy', 'authorize', 'attachPolicy', 'detachPolicy', 'rolePolicies',
  'assignRole', 'unassignRole', 'userRoles', 'simulate', 'listAudit',
  'createApiKey', 'revokeApiKey', 'listApiKeys', 'verifyApiKey',
  'createServiceAccount', 'listServiceAccounts', 'serviceAccountToken',
  'usageSummary', 'usageEvents',
] as const;

const WORKFLOW_METHODS = [
  'listTemplates', 'getTemplate',
  'listWorkflows', 'getWorkflow', 'createWorkflowFromTemplate',
  'createWorkflow', 'updateWorkflow', 'deleteWorkflow',
  'activateWorkflow', 'deactivateWorkflow', 'executeWorkflow',
  'getExecution', 'listExecutions', 'testRun',
  'createCredential', 'listCredentials', 'getCredential', 'deleteCredential',
  'rotateCredential', 'triggerWebhook',
] as const;

const LDS_METHODS: ReadonlyArray<readonly [string, string]> = [
  ['ldsLicenses', 'licenses'],
  ['ldsDatasources', 'datasources'],
  ['ldsCreateDatasource', 'createDatasource'],
  ['ldsDatasource', 'datasource'],
  ['ldsUpdateDatasource', 'updateDatasource'],
  ['ldsDeleteDatasource', 'deleteDatasource'],
  ['ldsAttributes', 'attributes'],
  ['ldsSetAttributes', 'setAttributes'],
  ['ldsIngest', 'ingest'],
  ['ldsEntities', 'entities'],
  ['ldsEntity', 'entity'],
  ['ldsStats', 'stats'],
];

function defineLegacy(service: 'iam' | 'workflow' | 'lds', legacy: string, target: string): void {
  Object.defineProperty(SynapseOneClient.prototype, legacy, {
    value: function (this: any, ...args: unknown[]) {
      warnDeprecated(`client.${legacy}`, `client.${service}.${target}`);
      return this[service][target](...args);
    },
    configurable: true,
    writable: true,
  });
}

for (const name of IAM_METHODS) defineLegacy('iam', name, name);
for (const name of WORKFLOW_METHODS) defineLegacy('workflow', name, name);
for (const [legacy, target] of LDS_METHODS) defineLegacy('lds', legacy, target);

/**
 * @deprecated Use {@link SynapseOneClient}. Kept for the SynapseDX -> SynapseOne
 * rebrand window; this is the same class, not a subclass.
 */
export { SynapseOneClient as SynapseDXClient };
