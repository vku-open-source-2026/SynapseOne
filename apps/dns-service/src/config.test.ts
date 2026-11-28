// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DATA_FILE, isProductionEnvironment, loadConfig } from './config';
import { ServiceError } from './errors';

function configError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof ServiceError && error.status === 503 && error.code === 'configuration_error');
}

test('configuration defaults and explicit local insecure mode', () => {
  const config = loadConfig({ NODE_ENV: 'test', SYNAPSEDNS_ALLOW_INSECURE: 'true' });
  assert.equal(config.dnsHost, '0.0.0.0');
  assert.equal(config.dnsPort, 53);
  assert.equal(config.apiHost, '0.0.0.0');
  assert.equal(config.apiPort, 4014);
  assert.equal(config.dataFile, DEFAULT_DATA_FILE);
  assert.equal(config.allowInsecure, true);
  assert.equal(config.production, false);
  assert.equal(config.internalSecret, undefined);
  configError(() => loadConfig({ NODE_ENV: 'test' }));
});

test('the optional internal gateway secret is normalized and validated', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SYNAPSEDNS_ALLOW_INSECURE: 'true',
    SYNAPSEONE_INTERNAL_SECRET: '  internal-test-secret  ',
  });
  assert.equal(config.internalSecret, 'internal-test-secret');
  assert.equal(loadConfig({ NODE_ENV: 'test', SYNAPSEDNS_ALLOW_INSECURE: 'true', SYNAPSEONE_INTERNAL_SECRET: '   ' }).internalSecret, undefined);
  configError(() => loadConfig({
    NODE_ENV: 'test',
    SYNAPSEDNS_ALLOW_INSECURE: 'true',
    SYNAPSEONE_INTERNAL_SECRET: 'bad\nsecret',
  }));
});

test('a configured token is enforced even when insecure mode is explicitly enabled', () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    SYNAPSEDNS_ADMIN_TOKEN: 'local-token',
    SYNAPSEDNS_ALLOW_INSECURE: 'true',
    SYNAPSEDNS_DATA_FILE: ':memory:',
  });
  assert.equal(config.adminToken, 'local-token');
  assert.equal(config.memoryStore, true);
  assert.equal(config.dataFile, undefined);
});

test('production recognizes environment aliases and fails closed', () => {
  assert.equal(isProductionEnvironment({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionEnvironment({ SYNAPSEONE_ENV: 'PROD' }), true);
  assert.equal(isProductionEnvironment({ APP_ENV: 'production' }), true);
  assert.equal(isProductionEnvironment({ SYNAPSEONE_ENV: '', APP_ENV: 'production' }), true);
  assert.equal(isProductionEnvironment({ NODE_ENV: 'test' }), false);

  const token = 'x'.repeat(32);
  const config = loadConfig({ NODE_ENV: 'production', SYNAPSEDNS_ADMIN_TOKEN: token });
  assert.equal(config.production, true);
  assert.equal(config.adminToken, token);
  configError(() => loadConfig({ NODE_ENV: 'production' }));
  configError(() => loadConfig({ NODE_ENV: 'production', SYNAPSEDNS_ADMIN_TOKEN: 'too-short' }));
  configError(() => loadConfig({ NODE_ENV: 'production', SYNAPSEDNS_ADMIN_TOKEN: token, SYNAPSEDNS_ALLOW_INSECURE: 'true' }));
  configError(() => loadConfig({ NODE_ENV: 'production', SYNAPSEDNS_ADMIN_TOKEN: token, SYNAPSEDNS_DATA_FILE: ':memory:' }));
});

test('ports and log levels are validated', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SYNAPSEDNS_ALLOW_INSECURE: 'true',
    SYNAPSEDNS_DNS_PORT: '1053',
    SYNAPSEDNS_API_PORT: '0',
    SYNAPSEDNS_LOG_LEVEL: 'DEBUG',
  });
  assert.equal(config.dnsPort, 1053);
  assert.equal(config.apiPort, 0);
  assert.equal(config.logLevel, 'debug');
  configError(() => loadConfig({ NODE_ENV: 'test', SYNAPSEDNS_ALLOW_INSECURE: 'true', SYNAPSEDNS_DNS_PORT: '65536' }));
  configError(() => loadConfig({ NODE_ENV: 'test', SYNAPSEDNS_ALLOW_INSECURE: 'true', SYNAPSEDNS_API_PORT: '1.5' }));
  configError(() => loadConfig({ NODE_ENV: 'test', SYNAPSEDNS_ALLOW_INSECURE: 'true', SYNAPSEDNS_LOG_LEVEL: 'verbose' }));
});
