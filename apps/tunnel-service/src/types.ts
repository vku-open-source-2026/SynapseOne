// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

export interface ConnectorRecord {
  id: string;
  name: string;
  upstreamUrl: string;
  orgId: string | null;
  tokenHash: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicConnector {
  id: string;
  name: string;
  upstreamUrl: string;
  orgId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Authenticated management caller. A null organization denotes the platform administrator. */
export interface ManagementPrincipal {
  orgId: string | null;
}

export interface RouteRecord {
  id: string;
  name: string;
  hostname: string;
  pathPrefix: string;
  connectorId: string;
  enabled: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  rateLimitPerMinute?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoreSnapshot {
  version: 2;
  connectors: ConnectorRecord[];
  routes: RouteRecord[];
}

/** @deprecated Use StoreSnapshot. Retained as an alias for existing consumers. */
export type StoreData = StoreSnapshot;

export type HeaderMap = Record<string, string[]>;

export interface ConnectorStatus {
  connected: boolean;
  connectedAt?: string;
}

export interface DomainQuota {
  orgId: string | null;
  baseDomain: string;
  usedDomains: number;
  maxDomains: number | null;
  remainingDomains: number | null;
  unlimited: boolean;
  domains: string[];
}
