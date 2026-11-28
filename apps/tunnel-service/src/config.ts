// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { resolve } from 'path';
import type { LogLevel } from './logger';

export type ServerMode = 'combined' | 'api' | 'ingress';

export interface ServerConfig {
  mode: ServerMode;
  isProduction: boolean;
  host: string;
  apiPort: number;
  ingressPort: number;
  adminToken?: string;
  allowInsecure: boolean;
  dataFile: string | null;
  wsPath: string;
  wsMaxPayloadBytes: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  maxConcurrentRequests: number;
  defaultRateLimitPerMinute: number;
  heartbeatIntervalMs: number;
  maxBufferedAmount: number;
  trustProxy: boolean;
  publicScheme: 'http' | 'https';
  logLevel: LogLevel;
}

export interface ConnectorConfig {
  token: string;
  serverUrl: string;
  wsPath: string;
  wsMaxPayloadBytes: number;
  reconnectDelayMs: number;
  logLevel: LogLevel;
}

type Env = Record<string, string | undefined>;

export function isProductionEnvironment(env: Env = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  const environment = (env.SYNAPSEONE_ENV ?? env.SYNAPSEDX_ENV ?? env.APP_ENV ?? env.ENVIRONMENT ?? '').trim().toLowerCase();
  return environment === 'production' || environment === 'prod';
}

function readBoolean(env: Env, name: string, fallback = false): boolean {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

function readInteger(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return Math.min(max, Math.max(min, value));
}

function readLogLevel(env: Env): LogLevel {
  const value = (env.SYNAPSETUNNEL_LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  throw new Error('SYNAPSETUNNEL_LOG_LEVEL must be debug, info, warn, or error');
}

function readWsPath(env: Env): string {
  const value = env.SYNAPSETUNNEL_WS_PATH ?? '/_synapse/tunnel/connect';
  if (!value.startsWith('/') || value.length > 128 || /[?#\s]/.test(value)) throw new Error('Invalid SYNAPSETUNNEL_WS_PATH');
  return value;
}

export function loadServerConfig(mode: ServerMode = 'combined', env: Env = process.env): ServerConfig {
  const isProduction = isProductionEnvironment(env);
  const adminToken = env.SYNAPSETUNNEL_ADMIN_TOKEN || undefined;
  const allowInsecure = readBoolean(env, 'SYNAPSETUNNEL_ALLOW_INSECURE');
  if (isProduction && allowInsecure) throw new Error('SYNAPSETUNNEL_ALLOW_INSECURE is forbidden in production');
  if (!adminToken && !(allowInsecure && !isProduction)) throw new Error('SYNAPSETUNNEL_ADMIN_TOKEN is required');
  if (isProduction && adminToken && adminToken.length < 32) throw new Error('SYNAPSETUNNEL_ADMIN_TOKEN must contain at least 32 characters in production');

  const rawDataFile = env.SYNAPSETUNNEL_DATA_FILE ?? './data/synapse-tunnel.json';
  const dataFile = rawDataFile === 'memory' ? null : resolve(rawDataFile);
  if (isProduction && dataFile === null) throw new Error('Persistent SYNAPSETUNNEL_DATA_FILE is required in production');

  const publicScheme = (env.SYNAPSETUNNEL_PUBLIC_SCHEME ?? 'http').trim().toLowerCase();
  if (publicScheme !== 'http' && publicScheme !== 'https') throw new Error('SYNAPSETUNNEL_PUBLIC_SCHEME must be http or https');

  return {
    mode,
    isProduction,
    host: env.SYNAPSETUNNEL_HOST ?? '0.0.0.0',
    apiPort: readInteger(env, 'SYNAPSETUNNEL_API_PORT', readInteger(env, 'PORT', 4015, 0, 65535), 0, 65535),
    ingressPort: readInteger(env, 'SYNAPSETUNNEL_INGRESS_PORT', readInteger(env, 'INGRESS_PORT', 4016, 0, 65535), 0, 65535),
    adminToken,
    allowInsecure,
    dataFile,
    wsPath: readWsPath(env),
    wsMaxPayloadBytes: readInteger(env, 'SYNAPSETUNNEL_WS_MAX_PAYLOAD_BYTES', 1048576, 65536, 16777216),
    maxRequestBytes: readInteger(env, 'SYNAPSETUNNEL_MAX_REQUEST_BYTES', 10485760, 1024, 104857600),
    maxResponseBytes: readInteger(env, 'SYNAPSETUNNEL_MAX_RESPONSE_BYTES', 16777216, 1024, 104857600),
    requestTimeoutMs: readInteger(env, 'SYNAPSETUNNEL_REQUEST_TIMEOUT_MS', 30000, 100, 300000),
    maxConcurrentRequests: readInteger(env, 'SYNAPSETUNNEL_MAX_CONCURRENT_REQUESTS', 100, 1, 10000),
    defaultRateLimitPerMinute: readInteger(env, 'SYNAPSETUNNEL_RATE_LIMIT_PER_MINUTE', 600, 0, 1000000),
    heartbeatIntervalMs: readInteger(env, 'SYNAPSETUNNEL_HEARTBEAT_INTERVAL_MS', 30000, 1000, 120000),
    maxBufferedAmount: readInteger(env, 'SYNAPSETUNNEL_MAX_BUFFERED_BYTES', 4194304, 1048576, 67108864),
    trustProxy: readBoolean(env, 'SYNAPSETUNNEL_TRUST_PROXY'),
    publicScheme,
    logLevel: readLogLevel(env),
  };
}

export function loadConnectorConfig(env: Env = process.env, args: string[] = []): ConnectorConfig {
  let token = env.SYNAPSETUNNEL_CONNECTOR_TOKEN ?? env.SYNAPSETUNNEL_TOKEN ?? '';
  let serverUrl = env.SYNAPSETUNNEL_SERVER_URL ?? 'http://127.0.0.1:4016';
  let reconnectDelayMs = readInteger(env, 'SYNAPSETUNNEL_RECONNECT_DELAY_MS', 1000, 100, 30000);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') throw new Error('help');
    if (arg !== '--token' && arg !== '--server-url' && arg !== '--reconnect-delay-ms') throw new Error(`Unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    index += 1;
    if (arg === '--token') token = value;
    if (arg === '--server-url') serverUrl = value;
    if (arg === '--reconnect-delay-ms') {
      reconnectDelayMs = Number(value);
      if (!Number.isInteger(reconnectDelayMs)) throw new Error('Invalid reconnect delay');
      reconnectDelayMs = Math.min(30000, Math.max(100, reconnectDelayMs));
    }
  }
  if (!/^st_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('A valid connector token is required');
  let url: URL;
  try { url = new URL(serverUrl); } catch { throw new Error('Invalid connector server URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error('Invalid connector server URL');
  }
  return {
    token,
    serverUrl: url.href,
    wsPath: readWsPath(env),
    wsMaxPayloadBytes: readInteger(env, 'SYNAPSETUNNEL_WS_MAX_PAYLOAD_BYTES', 1048576, 65536, 16777216),
    reconnectDelayMs,
    logLevel: readLogLevel(env),
  };
}
