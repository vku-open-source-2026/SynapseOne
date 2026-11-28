// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ServerConfig } from './config';
import { startTunnelService, type TunnelService } from './server';

const ADMIN_TOKEN = 'api-test-admin-token';
const INTERNAL_SECRET = 'api-test-internal-secret';
const ORG_A = 'org-a';
const ORG_B = 'org-b';

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    mode: 'api',
    isProduction: false,
    host: '127.0.0.1',
    apiPort: 0,
    ingressPort: 0,
    adminToken: ADMIN_TOKEN,
    internalSecret: INTERNAL_SECRET,
    allowInsecure: false,
    dataFile: null,
    wsPath: '/_synapse/tunnel/connect',
    wsMaxPayloadBytes: 1048576,
    maxRequestBytes: 1048576,
    maxResponseBytes: 1048576,
    requestTimeoutMs: 2000,
    maxConcurrentRequests: 100,
    defaultRateLimitPerMinute: 0,
    heartbeatIntervalMs: 1000,
    maxBufferedAmount: 4194304,
    trustProxy: false,
    publicScheme: 'http',
    publicOrigin: 'https://tunnel.example.com',
    logLevel: 'error',
    ...overrides,
  };
}

async function startService(t: TestContext, overrides: Partial<ServerConfig> = {}): Promise<TunnelService> {
  const service = await startTunnelService(config(overrides));
  t.after(() => service.close());
  return service;
}

interface Caller {
  authorization?: string;
  orgId?: string;
  ownerOrgId?: string;
}

function adminCaller(): Caller {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

function tenantCaller(orgId?: string, ownerOrgId?: string): Caller {
  return { orgId, ownerOrgId };
}

async function manage(
  service: TunnelService,
  caller: Caller,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (caller.authorization) headers.set('authorization', caller.authorization);
  if (caller.orgId !== undefined) headers.set('x-synapseone-org', caller.orgId);
  if (caller.ownerOrgId !== undefined) headers.set('x-synapseone-owner-org', caller.ownerOrgId);
  if (caller.orgId !== undefined || caller.ownerOrgId !== undefined) {
    headers.set('x-synapseone-internal', INTERNAL_SECRET);
  }
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${service.apiUrl}${path}`, { ...init, headers });
}

async function createConnector(
  service: TunnelService,
  caller: Caller,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; orgId: string | null; token: string }> {
  const response = await manage(service, caller, '/v1/connectors', {
    method: 'POST',
    body: JSON.stringify({ name, upstreamUrl: 'http://127.0.0.1:3000', ...extra }),
  });
  if (response.status !== 201) assert.fail(`Connector creation failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { connector: { id: string; orgId: string | null }; token: string };
  assert.match(payload.token, /^st_[A-Za-z0-9_-]{43}$/);
  return { id: payload.connector.id, orgId: payload.connector.orgId, token: payload.token };
}

async function createRoute(
  service: TunnelService,
  caller: Caller,
  connectorId: string,
  hostname: string,
): Promise<string> {
  const response = await manage(service, caller, '/v1/routes', {
    method: 'POST',
    body: JSON.stringify({ hostname, pathPrefix: '/api', connectorId }),
  });
  if (response.status !== 201) assert.fail(`Route creation failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { route: { id: string } };
  return payload.route.id;
}

async function connectorIds(service: TunnelService, caller: Caller): Promise<string[]> {
  const response = await manage(service, caller, '/v1/connectors');
  assert.equal(response.status, 200);
  const payload = await response.json() as { connectors: Array<{ id: string }> };
  return payload.connectors.map((connector) => connector.id).sort();
}

async function routeIds(service: TunnelService, caller: Caller): Promise<string[]> {
  const response = await manage(service, caller, '/v1/routes');
  assert.equal(response.status, 200);
  const payload = await response.json() as { routes: Array<{ id: string }> };
  return payload.routes.map((route) => route.id).sort();
}

test('management auth fails closed and supports the verified owner-org fallback', async (t) => {
  const service = await startService(t);

  const unauthenticated = await manage(service, {}, '/v1/config');
  assert.equal(unauthenticated.status, 401);
  const orgWithoutSecret = await fetch(`${service.apiUrl}/v1/config`, {
    headers: { 'x-synapseone-org': ORG_A },
  });
  assert.equal(orgWithoutSecret.status, 401);
  const ownerWithoutSecret = await fetch(`${service.apiUrl}/v1/config`, {
    headers: { 'x-synapseone-owner-org': ORG_A },
  });
  assert.equal(ownerWithoutSecret.status, 401);

  const wrongSecret = await fetch(`${service.apiUrl}/v1/config`, {
    headers: {
      'x-synapseone-internal': 'wrong-secret',
      'x-synapseone-owner-org': ORG_A,
    },
  });
  assert.equal(wrongSecret.status, 401);

  const missingOrg = await fetch(`${service.apiUrl}/v1/config`, {
    headers: { 'x-synapseone-internal': INTERNAL_SECRET },
  });
  assert.equal(missingOrg.status, 403);
  for (const orgId of ['', 'bad_org', 'org/name', 'a'.repeat(65)]) {
    const invalidOrg = await manage(service, tenantCaller(orgId), '/v1/config');
    assert.equal(invalidOrg.status, 403, `expected org ${JSON.stringify(orgId)} to be rejected`);
  }

  const primary = await manage(service, tenantCaller(ORG_A), '/v1/config');
  assert.equal(primary.status, 200);
  assert.deepEqual(await primary.json(), {
    publicOrigin: 'https://tunnel.example.com',
    connectorPath: '/_synapse/tunnel/connect',
    protocolVersion: 1,
  });

  const ownerFallback = await manage(service, tenantCaller(undefined, ORG_A), '/v1/config');
  assert.equal(ownerFallback.status, 200);
  const emptyPrimaryFallback = await manage(service, tenantCaller('', ORG_A), '/v1/config');
  assert.equal(emptyPrimaryFallback.status, 200);
  assert.equal((await manage(service, tenantCaller(undefined, 'bad_org'), '/v1/config')).status, 403);
  const fallbackConnector = await createConnector(service, tenantCaller(undefined, 'org-owner'), 'service account');
  assert.equal(fallbackConnector.orgId, 'org-owner');

  const invalidBearerWithGateway = await manage(service, {
    authorization: 'Bearer wrong-admin-token', orgId: ORG_A,
  }, '/v1/config');
  assert.equal(invalidBearerWithGateway.status, 200);
  const connectorBearer = await manage(service, { authorization: `Bearer ${fallbackConnector.token}` }, '/v1/config');
  assert.equal(connectorBearer.status, 401);

  const unavailable = await startService(t, {
    adminToken: undefined,
    internalSecret: undefined,
    allowInsecure: true,
  });
  const unavailableResponse = await manage(unavailable, tenantCaller(ORG_A), '/v1/config');
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), {
    error: 'internal_auth_unavailable',
    message: 'Internal management authentication is not configured',
  });
});

test('connector and route ownership is isolated while platform access remains unrestricted', async (t) => {
  const service = await startService(t);
  const admin = adminCaller();
  const tenantA = tenantCaller(ORG_A);
  const tenantB = tenantCaller(ORG_B);

  // The direct organization wins over owner-org, and a body orgId is ignored.
  const connectorA = await createConnector(service, tenantCaller(ORG_A, ORG_B), 'a', { orgId: ORG_B });
  assert.equal(connectorA.orgId, ORG_A);
  const connectorA2 = await createConnector(service, tenantA, 'a2');
  const connectorB = await createConnector(service, tenantB, 'b');
  const platformConnector = await createConnector(service, admin, 'platform', { orgId: ORG_A });
  assert.equal(platformConnector.orgId, null);

  const routeA = await createRoute(service, tenantA, connectorA.id, 'a.example.com');
  const routeB = await createRoute(service, tenantB, connectorB.id, 'b.example.com');
  const platformRoute = await createRoute(service, admin, platformConnector.id, 'platform.example.com');

  assert.deepEqual(await connectorIds(service, tenantA), [connectorA.id, connectorA2.id].sort());
  assert.deepEqual(await connectorIds(service, tenantB), [connectorB.id]);
  assert.deepEqual(await connectorIds(service, admin), [
    connectorA.id, connectorA2.id, connectorB.id, platformConnector.id,
  ].sort());
  assert.deepEqual(await routeIds(service, tenantA), [routeA]);
  assert.deepEqual(await routeIds(service, tenantB), [routeB]);
  assert.deepEqual(await routeIds(service, admin), [routeA, routeB, platformRoute].sort());

  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const response = await manage(service, tenantA, `/v1/connectors/${connectorB.id}`, {
      method,
      ...(method === 'PATCH' ? { body: JSON.stringify({ name: 'stolen' }) } : {}),
    });
    assert.equal(response.status, 404, `${method} must not reveal a foreign connector`);
    assert.equal((await response.json() as { error: string }).error, 'connector_not_found');
  }
  assert.equal((await manage(service, tenantA, `/v1/connectors/${platformConnector.id}`)).status, 404);

  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const response = await manage(service, tenantA, `/v1/routes/${routeB}`, {
      method,
      ...(method === 'PATCH' ? { body: JSON.stringify({ name: 'stolen' }) } : {}),
    });
    assert.equal(response.status, 404, `${method} must not reveal a foreign route`);
    assert.equal((await response.json() as { error: string }).error, 'route_not_found');
  }

  const foreignRouteCreate = await manage(service, tenantB, '/v1/routes', {
    method: 'POST',
    body: JSON.stringify({ hostname: 'foreign.example.com', connectorId: connectorA.id }),
  });
  assert.equal(foreignRouteCreate.status, 404);
  assert.equal((await foreignRouteCreate.json() as { error: string }).error, 'connector_not_found');

  const foreignConnectorMove = await manage(service, tenantB, `/v1/routes/${routeB}`, {
    method: 'PATCH',
    body: JSON.stringify({ connectorId: connectorA.id }),
  });
  assert.equal(foreignConnectorMove.status, 404);
  const unchangedRoute = await manage(service, tenantB, `/v1/routes/${routeB}`);
  assert.equal((await unchangedRoute.json() as { route: { connectorId: string } }).route.connectorId, connectorB.id);

  const ownRouteMove = await manage(service, tenantA, `/v1/routes/${routeA}`, {
    method: 'PATCH',
    body: JSON.stringify({ connectorId: connectorA2.id }),
  });
  assert.equal(ownRouteMove.status, 200);
  assert.deepEqual(await routeIds(service, tenantA), [routeA]);

  // A valid platform bearer ignores spoofed gateway headers and can manage every org.
  const spoofedAdmin = await manage(service, {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    orgId: ORG_B,
    ownerOrgId: ORG_A,
  }, '/v1/connectors');
  assert.equal(spoofedAdmin.status, 200);
  const platformPatch = await manage(service, admin, `/v1/connectors/${connectorB.id}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'platform updated' }),
  });
  assert.equal(platformPatch.status, 200);
  assert.equal((await manage(service, admin, `/v1/routes/${routeB}`, { method: 'DELETE' })).status, 204);
  assert.equal((await manage(service, admin, `/v1/connectors/${connectorB.id}`, { method: 'DELETE' })).status, 204);

  const platformCreatedRoute = await createRoute(service, admin, connectorA.id, 'platform-for-a.example.com');
  assert((await routeIds(service, tenantA)).includes(platformCreatedRoute));
  assert.equal((await manage(service, tenantA, `/v1/routes/${platformRoute}`)).status, 404);
  assert.equal((await manage(service, tenantA, `/v1/connectors/${connectorA2.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await manage(service, admin, `/v1/routes/${routeA}`, { method: 'DELETE' })).status, 204);
  assert.equal((await manage(service, admin, `/v1/routes/${platformCreatedRoute}`, { method: 'DELETE' })).status, 204);
  assert.equal((await manage(service, tenantA, `/v1/connectors/${connectorA2.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await manage(service, tenantB, `/v1/connectors/${connectorB.id}`)).status, 404);
});
