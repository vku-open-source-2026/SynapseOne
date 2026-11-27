#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Static deployability gate for infra/k8s/base/all.yaml.
 *
 * It does not talk to a cluster. It verifies the things that broke the base:
 *   - every image matches the release naming convention and version;
 *   - every secretKeyRef resolves in secrets.example.yaml;
 *   - each service has the production-required environment;
 *   - readiness probes use the dependency-aware endpoint where one exists;
 *   - every in-cluster HTTP URL points at a Service in the manifest;
 *   - the manifest covers every first-party image the release publishes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  yaml = require(path.join(ROOT, 'apps', 'gateway', 'node_modules', 'js-yaml'));
}

const errors = [];
const allPath = path.join(ROOT, 'infra', 'k8s', 'base', 'all.yaml');
const secretsPath = path.join(ROOT, 'infra', 'k8s', 'base', 'secrets.example.yaml');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const docs = yaml.loadAll(fs.readFileSync(allPath, 'utf8')).filter(Boolean);
const secrets = yaml.load(fs.readFileSync(secretsPath, 'utf8'));
const secretKeys = new Set(Object.keys(secrets.stringData || {}));

const deployments = new Map();
const services = new Set();
for (const doc of docs) {
  if (doc.kind === 'Deployment') deployments.set(doc.metadata.name, doc);
  if (doc.kind === 'Service') services.add(doc.metadata.name);
}

// Services provided by the cluster operator / external charts. The README
// requires these names in the same namespace (or equivalent endpoints).
const externalDependencies = new Set(['postgres', 'valkey', 's3', 'authentik']);
const serviceNames = new Set([...services, ...externalDependencies]);

const imageService = new Map([
  ['iam', 'iam'],
  ['gateway', 'gateway'],
  ['workflow', 'workflow'],
  ['ai', 'ai'],
  ['lds', 'lds'],
  ['base', 'base'],
  ['faststore', 'faststore'],
  ['queue', 'queue'],
  ['stream', 'stream'],
  ['warehouse', 'warehouse'],
  ['lakehouse', 'lakehouse'],
  ['inference', 'inference'],
  ['ocs', 'ocs'],
  ['notifications', 'notifications'],
  ['console', 'console'],
]);

const requiredEnv = {
  iam: ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'IAM_JWT_SECRET', 'SYNAPSEONE_INTERNAL_SECRET', 'WAREHOUSE_SERVICE_URL'],
  gateway: [
    'IAM_SERVICE_URL',
    'WORKFLOW_SERVICE_URL',
    'LDS_SERVICE_URL',
    'BASE_SERVICE_URL',
    'QUEUE_SERVICE_URL',
    'WAREHOUSE_SERVICE_URL',
    'LAKEHOUSE_SERVICE_URL',
    'IAM_JWT_SECRET',
    'SYNAPSEONE_INTERNAL_SECRET',
  ],
  workflow: [
    'DATABASE_URL',
    'DATABASE_DIRECT_URL',
    'QUEUE_SERVICE_URL',
    'SYNAPSEONE_INTERNAL_SECRET',
    'SYNAPSEONE_CREDENTIAL_KEY',
    'SYNAPSEONE_IAM_API_KEY',
  ],
  lds: ['DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET'],
  base: ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'SYNAPSEONE_INTERNAL_SECRET'],
  notifications: ['DATABASE_URL', 'NOTIFICATIONS_QUEUE_URL', 'SYNAPSEONE_INTERNAL_SECRET'],
  warehouse: ['WAREHOUSE_DATA_DIR', 'SYNAPSEONE_INTERNAL_SECRET'],
  lakehouse: [
    'LAKEHOUSE_CATALOG_URI',
    'LAKEHOUSE_WAREHOUSE',
    'LAKEHOUSE_S3_ENDPOINT',
    'LAKEHOUSE_S3_ACCESS_KEY',
    'LAKEHOUSE_S3_SECRET_KEY',
    'SYNAPSEONE_INTERNAL_SECRET',
  ],
  inference: ['OPENROUTER_API_KEY', 'SYNAPSEONE_INTERNAL_SECRET'],
  ocs: ['STORAGE_BACKEND', 'STORAGE_S3_ACCESS_KEY', 'STORAGE_S3_SECRET_KEY', 'SYNAPSEONE_INTERNAL_SECRET'],
};

const readinessPath = {
  iam: '/ready',
  workflow: '/ready',
  gateway: '/ready',
};

function envEntries(deployment) {
  const container = deployment.spec?.template?.spec?.containers?.[0];
  return container?.env || [];
}

for (const [name, deployment] of deployments) {
  const container = deployment.spec?.template?.spec?.containers?.[0];
  if (!container) {
    errors.push(`${name}: deployment has no container`);
    continue;
  }
  const image = String(container.image || '');
  const match = image.match(/^ghcr\.io\/[a-z0-9-]+\/synapseone-([a-z-]+):(\d+\.\d+\.\d+)$/);
  if (!match) {
    errors.push(`${name}: image ${image || '<missing>'} does not match ghcr.io/<owner>/synapseone-<service>:<semver>`);
  } else {
    if (match[1] !== imageService.get(name)) {
      errors.push(`${name}: image service suffix ${match[1]} does not match deployment`);
    }
    if (match[2] !== version) errors.push(`${name}: image tag ${match[2]} != workspace version ${version}`);
  }

  for (const env of envEntries(deployment)) {
    const ref = env.valueFrom?.secretKeyRef;
    if (!ref || ref.optional === true) continue;
    if (!secretKeys.has(ref.key)) errors.push(`${name}: secretKeyRef ${ref.key} is missing from secrets.example.yaml`);
  }

  const present = new Set(envEntries(deployment).map((env) => env.name));
  for (const key of requiredEnv[name] || []) {
    if (!present.has(key)) errors.push(`${name}: required production env ${key} is missing`);
  }

  const probe = container.readinessProbe?.httpGet;
  if (!probe) {
    errors.push(`${name}: readinessProbe is missing`);
  } else if (readinessPath[name] && probe.path !== readinessPath[name]) {
    errors.push(`${name}: readinessProbe must use ${readinessPath[name]}, found ${probe.path}`);
  }

  if (['iam', 'workflow', 'lakehouse', 'inference'].includes(name) && !container.startupProbe) {
    errors.push(`${name}: startupProbe is missing`);
  }

  // In-cluster plain-HTTP dependency URLs must resolve to a Service in the
  // manifest (or a documented external chart).
  for (const env of envEntries(deployment)) {
    if (typeof env.value !== 'string') continue;
    for (const matchUrl of env.value.matchAll(/http:\/\/([a-z0-9-]+):\d+/g)) {
      const host = matchUrl[1];
      if (!serviceNames.has(host)) {
        errors.push(`${name}: ${env.name} points at undefined in-cluster Service ${host}`);
      }
    }
  }
}

for (const expected of imageService.keys()) {
  if (!deployments.has(expected)) errors.push(`missing Deployment for first-party service ${expected}`);
  if (!services.has(expected)) errors.push(`missing Service for first-party service ${expected}`);
}

if (errors.length) {
  console.error('k8s-manifest-check: FAILED');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `k8s-manifest-check: OK (${deployments.size} deployments, ${services.size} services, ` +
    `${secretKeys.size} example secret keys, version ${version})`,
);
