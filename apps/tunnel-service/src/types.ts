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
  tokenHash: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicConnector {
  id: string;
  name: string;
  upstreamUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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

export interface StoreData {
  version: 1;
  connectors: ConnectorRecord[];
  routes: RouteRecord[];
}

export type HeaderMap = Record<string, string[]>;

export interface ConnectorStatus {
  connected: boolean;
  connectedAt?: string;
}
