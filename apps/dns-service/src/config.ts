// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { ServiceError } from './errors';
import type { LogLevel } from './logger';

export const SERVICE_NAME = 'synapsedns';
export const SERVICE_VERSION = '0.9.0';
export const DEFAULT_DATA_FILE = './data/synapsedns.json';

export interface ServiceConfig {
  production: boolean;
  dnsHost: string;
  dnsPort: number;
  apiHost: string;
  apiPort: number;
  dataFile?: string;
  memoryStore: boolean;
  adminToken?: string;
  internalSecret?: string;
  allowInsecure: boolean;
  logLevel: LogLevel;
  shutdownTimeoutMs: number;
}

type Environment = Record<string, string | undefined>;

export function isProductionEnvironment(env: Environment): boolean {
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') return true;
  const deployment = [env.SYNAPSEONE_ENV, env.SYNAPSEDX_ENV, env.APP_ENV, env.ENVIRONMENT]
    .map((value) => value?.trim().toLowerCase())
    .find((value) => value === 'production' || value === 'prod');
  return deployment !== undefined;
}

function port(env: Environment, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ServiceError(503, 'configuration_error', `${name} must be an integer from 0 to 65535`);
  }
  return value;
}

function host(env: Environment, name: string, fallback: string): string {
  const value = (env[name] ?? fallback).trim();
  if (!value || /[\s/]/.test(value)) {
    throw new ServiceError(503, 'configuration_error', `${name} must be a bind address without a path`);
  }
  return value;
}

function clampInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ServiceError(503, 'configuration_error', 'SYNAPSEDNS_SHUTDOWN_TIMEOUT_MS must be an integer');
  return Math.min(max, Math.max(min, value));
}

export function loadConfig(env: Environment = process.env): ServiceConfig {
  const production = isProductionEnvironment(env);
  const allowInsecure = env.SYNAPSEDNS_ALLOW_INSECURE?.trim().toLowerCase() === 'true';
  const adminToken = env.SYNAPSEDNS_ADMIN_TOKEN?.trim() || undefined;
  const internalSecret = env.SYNAPSEONE_INTERNAL_SECRET?.trim() || undefined;
  const dataFile = env.SYNAPSEDNS_DATA_FILE?.trim() || DEFAULT_DATA_FILE;
  const memoryStore = dataFile === ':memory:';

  if (production && allowInsecure) {
    throw new ServiceError(503, 'configuration_error', 'SYNAPSEDNS_ALLOW_INSECURE is forbidden in production');
  }
  if (production && memoryStore) {
    throw new ServiceError(503, 'configuration_error', 'The in-memory store is forbidden in production');
  }
  if (production && (!adminToken || adminToken.length < 32)) {
    throw new ServiceError(503, 'configuration_error', 'SYNAPSEDNS_ADMIN_TOKEN with at least 32 characters is required in production');
  }
  if (!production && !adminToken && !allowInsecure) {
    throw new ServiceError(503, 'configuration_error', 'Set SYNAPSEDNS_ADMIN_TOKEN, or explicitly set SYNAPSEDNS_ALLOW_INSECURE=true outside production');
  }
  if (adminToken && /[\r\n]/.test(adminToken)) {
    throw new ServiceError(503, 'configuration_error', 'SYNAPSEDNS_ADMIN_TOKEN must be a single line');
  }
  if (internalSecret && /[\r\n]/.test(internalSecret)) {
    throw new ServiceError(503, 'configuration_error', 'SYNAPSEONE_INTERNAL_SECRET must be a single line');
  }

  const logLevel = (env.SYNAPSEDNS_LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ServiceError(503, 'configuration_error', 'SYNAPSEDNS_LOG_LEVEL must be debug, info, warn, or error');
  }

  return {
    production,
    dnsHost: host(env, 'SYNAPSEDNS_DNS_HOST', '0.0.0.0'),
    dnsPort: port(env, 'SYNAPSEDNS_DNS_PORT', 53),
    apiHost: host(env, 'SYNAPSEDNS_API_HOST', '0.0.0.0'),
    apiPort: port(env, 'SYNAPSEDNS_API_PORT', 4014),
    dataFile: memoryStore ? undefined : dataFile,
    memoryStore,
    adminToken,
    internalSecret,
    allowInsecure,
    logLevel: logLevel as LogLevel,
    shutdownTimeoutMs: clampInteger(env.SYNAPSEDNS_SHUTDOWN_TIMEOUT_MS, 15_000, 1_000, 60_000),
  };
}
