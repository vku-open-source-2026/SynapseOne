// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/** Shared service registry for Docs and the Console services sidebar. */
export const SERVICE_CATALOG = [
  {
    id: 'gateway', docsTab: 'gateway', group: 'platform', label: 'Gateway & Ops',
    consoleRoute: '/api-docs', activePaths: ['/api-docs'], port: '8080', prefix: '/, /health, /ready, /metrics',
    category: 'Platform', desc: 'Single public API entry point, routing, auth, scopes and readiness',
    keywords: ['gateway', 'ops', 'health', 'ready', 'metrics', 'proxy', 'routes'],
    iconColor: 'from-slate-400 to-slate-600', bgGradient: 'linear-gradient(135deg, #94a3b8 0%, #475569 100%)', shadowColor: 'rgba(100, 116, 139, 0.28)',
  },
  {
    id: 'dns', docsTab: 'dns', group: 'platform', label: 'SynapseDNS',
    consoleRoute: '/dns', activePaths: ['/dns'], port: '53 / 4014', prefix: '/v1/zones',
    category: 'Networking & Edge', desc: 'Standalone authoritative UDP/TCP DNS with zone and record management',
    keywords: ['synapsedns', 'dns', 'authoritative', 'udp', 'tcp', 'zone', 'record', 'nameserver', 'soa', 'ns', 'mx', 'txt', 'edge', 'standalone'],
    iconColor: 'from-cyan-400 to-sky-600', bgGradient: 'linear-gradient(135deg, #22d3ee 0%, #0284c7 100%)', shadowColor: 'rgba(6, 182, 212, 0.28)',
  },
  {
    id: 'tunnel', docsTab: 'tunnel', group: 'platform', label: 'Synapse Tunnel',
    consoleRoute: '/tunnel', activePaths: ['/tunnel'], port: '4015 / 4016', prefix: '/v1/connectors, /v1/routes',
    category: 'Networking & Edge', desc: 'Standalone HTTP/SSE reverse tunnels through an outbound-only connector',
    keywords: ['synapse tunnel', 'tunnel', 'reverse tunnel', 'http', 'sse', 'ingress', 'connector', 'control plane', 'edge', 'standalone'],
    iconColor: 'from-violet-400 to-indigo-600', bgGradient: 'linear-gradient(135deg, #a78bfa 0%, #4f46e5 100%)', shadowColor: 'rgba(139, 92, 246, 0.28)',
  },
  {
    id: 'iam', docsTab: 'iam', group: 'platform', label: 'IAM & Auth',
    consoleRoute: '/orgs', activePaths: ['/orgs', '/accounts', '/users', '/roles', '/policies', '/keys', '/service-accounts', '/authorize', '/audit', '/security'], port: '4001', prefix: '/v1/auth, /v1/orgs, /v1/accounts, …',
    category: 'Identity & Access', desc: 'Organizations, accounts, users, roles, policies, keys, OIDC, MFA, audit and usage',
    keywords: ['iam', 'auth', 'identity', 'org', 'account', 'user', 'role', 'policy', 'api key', 'oidc', 'mfa', 'scim'],
    iconColor: 'from-emerald-400 to-teal-600', bgGradient: 'linear-gradient(135deg, #34d399 0%, #0f766e 100%)', shadowColor: 'rgba(16, 185, 129, 0.28)',
  },
  {
    id: 'workflow', docsTab: 'workflow', group: 'platform', label: 'SynapseFlow',
    consoleRoute: '/workflows', activePaths: ['/workflows'], port: '4002', prefix: '/v1/workflows, /v1/templates, /v1/executions',
    category: 'Automation & AI Agents', desc: 'Visual pipelines, AI agents, decision routing and DAGs',
    keywords: ['synapseflow', 'workflow', 'ai agent', 'decision', 'dag', 'automation', 'cron', 'trigger', 'pipeline', 'execution'],
    iconColor: 'from-amber-400 to-amber-500', bgGradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', shadowColor: 'rgba(245, 158, 11, 0.28)',
  },
  {
    id: 'runner', docsTab: 'runner', group: 'platform', label: 'Runner Engine',
    consoleRoute: '/runner-engine', activePaths: ['/runner-engine', '/workflow-runners'], port: '—', prefix: '/v1/workflow-runners, /v1/runner, /v1/inference-jobs',
    category: 'Automation & AI Agents', desc: 'Queue-backed platform or self-hosted workflow and inference workers',
    keywords: ['runner', 'runner engine', 'worker', 'self-hosted', 'queue', 'docker', 'api key', 'hybrid', 'workflow', 'inference', 'connector'],
    iconColor: 'from-orange-400 to-amber-500', bgGradient: 'linear-gradient(135deg, #fb923c 0%, #d97706 100%)', shadowColor: 'rgba(251, 146, 60, 0.28)',
  },
  {
    id: 'ai', docsTab: 'ai', group: 'platform', label: 'AI Assistant',
    consoleRoute: '/api-docs', activePaths: ['/api-docs'], port: '4003', prefix: '/v1/ai',
    category: 'AI & Inference', desc: 'Guidance-only API documentation assistant; suggests requests but never executes them',
    keywords: ['ai', 'assistant', 'agent', 'docs', 'guidance', 'openrouter'],
    iconColor: 'from-violet-400 to-purple-600', bgGradient: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)', shadowColor: 'rgba(139, 92, 246, 0.28)',
  },
  {
    id: 'inference', docsTab: 'inference', group: 'platform', label: 'SynapseInference',
    consoleRoute: '/inference', activePaths: ['/inference'], port: '4008', prefix: '/v1/inference',
    category: 'AI & Inference', desc: 'LLM proxy, local embeddings and Decision-2.0 routing',
    keywords: ['inference', 'ai', 'llm', 'embedding', 'decision', 'openrouter', 'routing', 'model'],
    iconColor: 'from-violet-500 to-purple-600', bgGradient: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)', shadowColor: 'rgba(139, 92, 246, 0.28)',
  },
  {
    id: 'lds', docsTab: 'lds', group: 'data', label: 'SynapseLDS',
    consoleRoute: '/lds', activePaths: ['/lds'], port: '4004', prefix: '/v1/lds',
    category: 'Linked Data', desc: 'NGSI-LD datasources, entity schemas and open-data licenses',
    keywords: ['lds', 'linked data', 'ngsi-ld', 'datasource', 'license', 'schema', 'entities'],
    iconColor: 'from-purple-500 to-indigo-500', bgGradient: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)', shadowColor: 'rgba(139, 92, 246, 0.28)',
  },
  {
    id: 'base', docsTab: 'base', group: 'data', label: 'SynapseBase',
    consoleRoute: '/base', activePaths: ['/base'], port: '4005', prefix: '/v1/base',
    category: 'Document Database', desc: 'JSON documents with object ↔ data mapping, queries, vector, graph and GIS',
    keywords: ['base', 'document', 'database', 'json', 'nosql', 'mapping', 'query', 'collections', 'vector', 'graph', 'gis'],
    iconColor: 'from-blue-500 to-indigo-600', bgGradient: 'linear-gradient(135deg, #3b82f6 0%, #4338ca 100%)', shadowColor: 'rgba(59, 130, 246, 0.28)',
  },
  {
    id: 'search', docsTab: 'search', group: 'data', label: 'Search',
    consoleRoute: '/search', activePaths: ['/search'], port: '—', prefix: '/v1/search',
    category: 'Document Database', desc: 'Tenant-scoped full-text, semantic and hybrid search over Base documents',
    keywords: ['search', 'full-text', 'semantic', 'hybrid', 'facets', 'index', 'reindex', 'base'],
    iconColor: 'from-indigo-400 to-blue-600', bgGradient: 'linear-gradient(135deg, #818cf8 0%, #2563eb 100%)', shadowColor: 'rgba(99, 102, 241, 0.28)',
  },
  {
    id: 'faststore', docsTab: 'faststore', group: 'data', label: 'Synapse Faststore',
    consoleRoute: '/faststore', activePaths: ['/faststore'], port: '4006', prefix: '/v1/faststore',
    category: 'Cache & KV Store', desc: 'Redis-backed cache, counters, hashes, collections and distributed locks',
    keywords: ['faststore', 'cache', 'redis', 'key-value', 'kv', 'ttl', 'counter', 'hash', 'lock'],
    iconColor: 'from-cyan-400 to-blue-500', bgGradient: 'linear-gradient(135deg, #06b6d4 0%, #2563eb 100%)', shadowColor: 'rgba(6, 182, 212, 0.28)',
  },
  {
    id: 'queue', docsTab: 'queue', group: 'data', label: 'SynapseQueue',
    consoleRoute: '/queue', activePaths: ['/queue'], port: '4007', prefix: '/v1/queue',
    category: 'Message Queue', desc: 'At-least-once message queues, leases, retries and dead letters',
    keywords: ['queue', 'message', 'broker', 'dlq', 'dead letter', 'visibility', 'lease', 'pubsub'],
    iconColor: 'from-emerald-400 to-teal-500', bgGradient: 'linear-gradient(135deg, #10b981 0%, #0d9488 100%)', shadowColor: 'rgba(16, 185, 129, 0.28)',
  },
  {
    id: 'stream', docsTab: 'stream', group: 'data', label: 'SynapseStream',
    consoleRoute: '/stream', activePaths: ['/stream'], port: '4009', prefix: '/v1/stream',
    category: 'Event Streaming', desc: 'Distributed event log, consumer groups and time-range replay',
    keywords: ['stream', 'streaming', 'events', 'consumer group', 'replay', 'telemetry', 'topic', 'log'],
    iconColor: 'from-amber-500 to-rose-500', bgGradient: 'linear-gradient(135deg, #f59e0b 0%, #f43f5e 100%)', shadowColor: 'rgba(244, 63, 94, 0.28)',
  },
  {
    id: 'ocs', docsTab: 'ocs', group: 'data', label: 'SynapseOCS',
    consoleRoute: '/ocs', activePaths: ['/ocs'], port: '4010', prefix: '/v1/ocs, /v1/storage',
    category: 'Object Cloud Storage', desc: 'Buckets, objects, signed URLs, multipart upload and tenant quotas',
    keywords: ['ocs', 'object storage', 'bucket', 's3', 'file', 'upload', 'download', 'presign', 'multipart'],
    iconColor: 'from-sky-400 to-blue-600', bgGradient: 'linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%)', shadowColor: 'rgba(14, 165, 233, 0.28)',
  },
  {
    id: 'notifications', docsTab: 'notifications', group: 'data', label: 'SynapseNotifications',
    consoleRoute: '/notifications', activePaths: ['/notifications'], port: '4011', prefix: '/v1/notifications',
    category: 'Messaging', desc: 'Tenant notification outbox, templates, preferences, delivery and cancellation',
    keywords: ['notifications', 'email', 'sms', 'push', 'webhook', 'outbox', 'delivery', 'unsubscribe'],
    iconColor: 'from-rose-400 to-pink-600', bgGradient: 'linear-gradient(135deg, #fb7185 0%, #db2777 100%)', shadowColor: 'rgba(244, 63, 94, 0.28)',
  },
  {
    id: 'warehouse', docsTab: 'warehouse', group: 'analytics', label: 'Synapse Warehouse',
    consoleRoute: '/warehouse', activePaths: ['/warehouse'], port: '4012', prefix: '/v1/warehouse',
    category: 'OLAP & ETL', desc: 'DuckDB datasets, read-only SQL, batch and stream ETL jobs',
    keywords: ['warehouse', 'olap', 'duckdb', 'sql', 'dataset', 'etl', 'analytics', 'batch', 'stream', 'rollup'],
    iconColor: 'from-lime-500 to-emerald-600', bgGradient: 'linear-gradient(135deg, #84cc16 0%, #059669 100%)', shadowColor: 'rgba(16, 185, 129, 0.28)',
  },
  {
    id: 'lakehouse', docsTab: 'lakehouse', group: 'analytics', label: 'Synapse Lakehouse',
    consoleRoute: '/lakehouse', activePaths: ['/lakehouse'], port: '4013', prefix: '/v1/lakehouse',
    category: 'OLAP & ETL', desc: 'Apache Iceberg tables, snapshots, schema evolution and object storage',
    keywords: ['lakehouse', 'iceberg', 'parquet', 'snapshot', 'time travel', 'schema evolution', 'catalog', 's3', 'analytics', 'table'],
    iconColor: 'from-teal-400 to-cyan-600', bgGradient: 'linear-gradient(135deg, #2dd4bf 0%, #0891b2 100%)', shadowColor: 'rgba(20, 184, 166, 0.28)',
  },
];

export const CLIENT_TABS = [
  { id: 'javascript', group: 'clients' },
  { id: 'python', group: 'clients' },
  { id: 'go', group: 'clients' },
  { id: 'rust', group: 'clients' },
  { id: 'cli', group: 'clients' },
];

export const DOC_GROUPS = ['start', 'platform', 'data', 'analytics', 'clients'];

export const DOC_TABS = [
  { id: 'overview', group: 'start' },
  ...SERVICE_CATALOG.map(({ id, group }) => ({ id, group })),
  ...CLIENT_TABS,
];

export function getService(id) {
  return SERVICE_CATALOG.find((service) => service.id === id);
}

export function matchesService(service, pathname) {
  return service.activePaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
