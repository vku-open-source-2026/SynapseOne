// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_TABS, DOC_GROUPS, DOC_TABS, SERVICE_CATALOG, matchesService } from './service-catalog.js';
import { en } from '../locales/en.js';
import { vi } from '../locales/vi.js';

const REQUIRED_SERVICES = [
  'gateway', 'iam', 'workflow', 'runner', 'ai', 'inference', 'lds', 'base', 'search',
  'faststore', 'queue', 'stream', 'ocs', 'notifications', 'warehouse', 'lakehouse',
];

function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
  }
  return typeof value;
}

test('service catalog covers every platform service and client guide', () => {
  assert.deepEqual(SERVICE_CATALOG.map((service) => service.id), REQUIRED_SERVICES);
  assert.deepEqual(CLIENT_TABS.map((tab) => tab.id), ['javascript', 'python', 'go', 'rust', 'cli']);
  assert.deepEqual(DOC_TABS.map((tab) => tab.id), ['overview', ...REQUIRED_SERVICES, 'javascript', 'python', 'go', 'rust', 'cli']);
  assert.equal(new Set(DOC_TABS.map((tab) => tab.id)).size, DOC_TABS.length);
  assert.ok(DOC_TABS.every((tab) => DOC_GROUPS.includes(tab.group)));
});

test('every service has a valid Console route, Docs target and active route matcher', () => {
  for (const service of SERVICE_CATALOG) {
    assert.ok(service.consoleRoute.startsWith('/'), `${service.id} Console route`);
    assert.equal(service.docsTab, service.id, `${service.id} Docs target`);
    assert.ok(service.activePaths.length > 0, `${service.id} active paths`);
    assert.equal(matchesService(service, service.consoleRoute), true, `${service.id} active route`);
    assert.equal(matchesService(service, '/not-a-service-route'), false, `${service.id} inactive route`);
  }
});

test('English and Vietnamese Docs/service locale shapes stay in parity', () => {
  assert.deepEqual(shape(en.docsPage), shape(vi.docsPage));
  assert.deepEqual(shape(en.services), shape(vi.services));
  for (const service of SERVICE_CATALOG) {
    assert.ok(en.docsPage.tabs[service.id], `${service.id} English tab`);
    assert.ok(vi.docsPage.tabs[service.id], `${service.id} Vietnamese tab`);
    assert.ok(en.docsPage.guides[service.id], `${service.id} English guide`);
    assert.ok(vi.docsPage.guides[service.id], `${service.id} Vietnamese guide`);
    assert.ok(en.docsPage.serviceDocs[service.id], `${service.id} English service doc`);
    assert.ok(vi.docsPage.serviceDocs[service.id], `${service.id} Vietnamese service doc`);
    assert.ok(en.services[service.id]?.label, `${service.id} English sidebar label`);
    assert.ok(vi.services[service.id]?.label, `${service.id} Vietnamese sidebar label`);
  }
});
