// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const { loadTunnelConfig, setConnectorId } = require('./config');
const { createLogger } = require('./logger');
const { runConnector } = require('./runtime');

const HELP = `Usage: synapseone tunnel run [connector-id] [options]

Run the Synapse Tunnel outbound-only connector in this installed CLI.
No inbound listener or separate connector binary is required.

Options:
  --token-file <path>       Connector token file (0600 recommended; preferred)
  --token <token>           Connector token (discouraged: visible in ps/history)
  --server-url <url>        Tunnel ingress URL (default http://127.0.0.1:4016)
  --reconnect-delay-ms <n>  Initial reconnect delay, 100-30000 (default 1000)
  -h, --help                Show this help

Environment:
  SYNAPSETUNNEL_CONNECTOR_TOKEN  Connector token (preferred over SYNAPSETUNNEL_TOKEN)
  SYNAPSETUNNEL_TOKEN            Legacy connector token fallback
  SYNAPSETUNNEL_SERVER_URL       Tunnel ingress URL
  SYNAPSETUNNEL_WS_PATH          WebSocket path (default /_synapse/tunnel/connect)
  SYNAPSETUNNEL_RECONNECT_DELAY_MS
  SYNAPSETUNNEL_LOG_LEVEL        debug, info, warn, or error (default info)

connector-id is an optional display-only UUID; the bearer token selects the server connector.
Stop cleanly with SIGINT (Ctrl-C) or SIGTERM.
`;

function tunnelArgs(options) {
  const args = [];
  for (const [flag, key] of [
    ['--token-file', 'tokenFile'],
    ['--token', 'token'],
    ['--server-url', 'serverUrl'],
    ['--reconnect-delay-ms', 'reconnectDelayMs'],
  ]) {
    if (options[key] !== undefined) args.push(flag, String(options[key]));
  }
  return args;
}

async function runTunnelCommand(options = {}) {
  const args = options.args || [];
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const env = options.env || process.env;
  const [subcommand, ...rest] = args;

  if (subcommand === undefined || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    stdout.write(HELP);
    return;
  }
  if (subcommand !== 'run') throw new Error('usage: synapseone tunnel run [connector-id] [options]');
  if (rest.includes('--help') || rest.includes('-h')) {
    stdout.write(HELP);
    return;
  }
  if (rest.length > 1) throw new Error('tunnel run accepts at most one display-only connector-id');
  if (rest.some((arg) => arg.startsWith('-'))) throw new Error('Unknown tunnel option');

  const loaded = loadTunnelConfig(env, tunnelArgs(options));
  const config = setConnectorId(loaded, rest[0]);
  const logger = createLogger(config.logLevel, stderr);
  if (config.permissiveTokenFileMode) {
    logger.warn('tunnel_token_file_permissions', { recommendation: 'chmod 600 the token file' });
  }

  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) logger.info('tunnel_stopping');
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runConnector(config, logger, controller.signal);
    logger.info('tunnel_stopped');
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

module.exports = { HELP, runTunnelCommand };
