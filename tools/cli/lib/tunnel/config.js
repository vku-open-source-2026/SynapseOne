// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const fs = require('node:fs');
const {
  normalizeServerUrl,
  normalizeWsPath,
  validateConnectorId,
  validateConnectorToken,
} = require('./validation');

const VALUE_FLAGS = new Set(['--token', '--token-file', '--server-url', '--reconnect-delay-ms']);

function integer(value, name, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return Math.min(max, Math.max(min, parsed));
}

function readTokenFile(file) {
  let stat;
  let token;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a regular file');
    token = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    const code = error && error.code ? ` (${error.code})` : '';
    throw new Error(`Unable to read --token-file${code}`);
  }
  return {
    token,
    permissiveMode: process.platform !== 'win32' && (stat.mode & 0o077) !== 0,
  };
}

function optionValue(args, index) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${args[index]}`);
  return value;
}

function loadTunnelConfig(env = process.env, args = []) {
  let token = env.SYNAPSETUNNEL_CONNECTOR_TOKEN || env.SYNAPSETUNNEL_TOKEN || '';
  let tokenFile;
  let serverUrl = env.SYNAPSETUNNEL_SERVER_URL || 'http://127.0.0.1:4016';
  let reconnectDelayMs = integer(env.SYNAPSETUNNEL_RECONNECT_DELAY_MS, 'SYNAPSETUNNEL_RECONNECT_DELAY_MS', 1000, 100, 30000);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!VALUE_FLAGS.has(name)) throw new Error('Unknown tunnel option');
    const value = equals >= 0 ? arg.slice(equals + 1) : optionValue(args, index);
    if (equals < 0) index += 1;
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === '--token') token = value;
    if (name === '--token-file') tokenFile = value;
    if (name === '--server-url') serverUrl = value;
    if (name === '--reconnect-delay-ms') {
      reconnectDelayMs = integer(value, '--reconnect-delay-ms', reconnectDelayMs, 100, 30000);
    }
  }

  let permissiveTokenFileMode = false;
  if (tokenFile) {
    const file = readTokenFile(tokenFile);
    token = file.token;
    permissiveTokenFileMode = file.permissiveMode;
  }
  if (!validateConnectorToken(token)) throw new Error('A valid connector token is required (use --token-file or SYNAPSETUNNEL_CONNECTOR_TOKEN)');

  return {
    token,
    serverUrl: normalizeServerUrl(serverUrl),
    wsPath: normalizeWsPath(env.SYNAPSETUNNEL_WS_PATH || '/_synapse/tunnel/connect'),
    wsMaxPayloadBytes: integer(env.SYNAPSETUNNEL_WS_MAX_PAYLOAD_BYTES, 'SYNAPSETUNNEL_WS_MAX_PAYLOAD_BYTES', 1048576, 65536, 16777216),
    reconnectDelayMs,
    logLevel: readLogLevel(env.SYNAPSETUNNEL_LOG_LEVEL),
    connectorId: undefined,
    permissiveTokenFileMode,
  };
}

function readLogLevel(value) {
  const level = (value || 'info').trim().toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error('SYNAPSETUNNEL_LOG_LEVEL must be debug, info, warn, or error');
  return level;
}

function setConnectorId(config, connectorId) {
  if (connectorId !== undefined && !validateConnectorId(connectorId)) throw new Error('Invalid connector id');
  return { ...config, connectorId };
}

function websocketUrl(config) {
  const base = new URL(config.serverUrl);
  const url = new URL(config.wsPath, base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

module.exports = {
  loadTunnelConfig,
  setConnectorId,
  websocketUrl,
};
