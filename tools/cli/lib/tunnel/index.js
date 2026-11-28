// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const fs = require('node:fs');
const { loadTunnelConfig, setConnectorId } = require('./config');
const {
  findProfile,
  listProfiles,
  normalizeUpstreamInput,
  profilePaths,
  readDaemonLogs,
  removeProfile,
  sanitizeProfileName,
  saveProfile,
  startDaemon,
  stopDaemon,
} = require('./daemon');
const { createLogger } = require('./logger');
const { runConnector } = require('./runtime');
const { normalizeServerUrl, validateConnectorId, validateConnectorToken } = require('./validation');

const HELP = `Usage: synapseone tunnel <command> [options]

Expose local HTTP/SSE services through Synapse Tunnel (Cloudflare + ngrok workflow).
Outbound-only WebSocket connector — no inbound firewall port or separate binary required.

Commands:
  http <port|url>           Expose a local service with an instant *.synapsetunnel.site URL
  start [name|port|url]     Start a tunnel in the background (daemon mode)
  stop [name|id | --all]    Stop a running background tunnel daemon
  restart [name|id]         Restart a background tunnel daemon
  status [name|id]          Show status and PIDs of local background tunnel daemons
  logs <name|id> [-f]       Show or follow logs of a background tunnel daemon
  list                      List remote organization tunnels, routes, and domain quota
  quota                     Show organization tunnel domain quota (5 max, unlimited Tier 2/3)
  create <name>             Provision a named tunnel + subdomain/hostname (use -d to start)
  delete <name|id>          Stop daemon, delete remote tunnel + routes, and remove local profile
  rotate-token <name|id>    Rotate connector token and update local profile
  run [connector-id]        Run the outbound-only connector in the foreground (or -d for daemon)

Quick / Daemon Options:
  --subdomain <label>       Claim <label>.synapsetunnel.site (omit for auto-generated)
  --hostname <host>         Use a custom hostname (e.g. app.example.com)
  --path-prefix <prefix>    Optional URL path prefix (e.g. /api)
  --upstream <port|url>     Local target port or URL (e.g. 3000 or http://localhost:3000)
  --port <port>             Local port shorthand (same as --upstream <port>)
  --name <name>             Local profile / tunnel name
  -d, --daemon              Run in the background as a detached daemon
  --all                     Stop all background tunnel daemons (with 'stop')
  -f, --follow              Follow log output (with 'logs')
  --lines <n>               Number of log lines to show (default 50)

Connector Runtime Options:
  --token-file <path>       Connector token file (0600 recommended; preferred)
  --token <token>           Connector token (discouraged: visible in ps/history)
  --server-url <url>        Tunnel ingress URL (default http://127.0.0.1:4016 for 'run')
  --reconnect-delay-ms <n>  Initial reconnect delay, 100-30000 (default 1000)
  -h, --help                Show this help

Environment:
  SYNAPSETUNNEL_CONNECTOR_TOKEN  Connector token (preferred over SYNAPSETUNNEL_TOKEN)
  SYNAPSETUNNEL_TOKEN            Legacy connector token fallback
  SYNAPSETUNNEL_SERVER_URL       Tunnel ingress URL
  SYNAPSETUNNEL_WS_PATH          WebSocket path (default /_synapse/tunnel/connect)
  SYNAPSETUNNEL_RECONNECT_DELAY_MS
  SYNAPSETUNNEL_LOG_LEVEL        debug, info, warn, or error (default info)
  SYNAPSEONE_TUNNEL_DIR          Override ~/.synapseone/tunnels daemon state directory

connector-id is an optional display-only UUID; the bearer token selects the server connector.
Stop foreground sessions cleanly with SIGINT (Ctrl-C) or SIGTERM.
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

function parseShortFlags(rawArgs) {
  const positional = [];
  let daemon = false;
  let follow = false;
  for (const arg of rawArgs) {
    if (arg === '-d') daemon = true;
    else if (arg === '-f') follow = true;
    else positional.push(arg);
  }
  return { positional, daemon, follow };
}

function requireApi(options) {
  if (typeof options.apiCall !== 'function') {
    throw new Error('Gateway API client is not configured for this tunnel command');
  }
  return options.apiCall;
}

function formatQuota(quota) {
  if (!quota) return 'unknown';
  if (quota.unlimited) return `${quota.usedDomains} used (unlimited — Tier 2/3 or platform)`;
  return `${quota.usedDomains}/${quota.maxDomains} domains used (${quota.remainingDomains} remaining)`;
}

function printJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printBanner(stdout, details) {
  const lines = [
    'Synapse Tunnel',
    `  Name:        ${details.name}`,
    `  Public URL:  ${details.publicUrl || '—'}`,
    `  Forwarding:  ${details.publicUrl || details.hostname || 'ingress'} -> ${details.upstreamUrl || 'configured upstream'}`,
    `  Server URL:  ${details.serverUrl}`,
  ];
  if (details.pid) lines.push(`  Daemon PID:  ${details.pid}`);
  if (details.logFile) lines.push(`  Logs:        ${details.logFile}`);
  if (details.quota) lines.push(`  Quota:       ${formatQuota(details.quota)}`);
  if (details.pid) {
    lines.push(`  Manage:      synapseone tunnel status ${details.name} | logs ${details.name} | stop ${details.name}`);
  } else {
    lines.push('  Press Ctrl-C to stop (or pass -d / --daemon to run in background).');
  }
  stdout.write(`${lines.join('\n')}\n`);
}

async function resolveDefaultServerUrl(options, env) {
  if (options.serverUrl) return normalizeServerUrl(options.serverUrl);
  if (env.SYNAPSETUNNEL_SERVER_URL) return normalizeServerUrl(env.SYNAPSETUNNEL_SERVER_URL);
  if (typeof options.apiCall === 'function') {
    try {
      const cfg = await options.apiCall('GET', '/v1/tunnel/v1/config');
      if (cfg?.publicOrigin) return normalizeServerUrl(cfg.publicOrigin);
      if (cfg?.baseDomain) return normalizeServerUrl(`https://${cfg.baseDomain}`);
    } catch {
      /* fallback below when offline or token-only */
    }
  }
  return 'https://synapsetunnel.site/';
}

async function resolveConnectorIdForRemote(apiCall, nameOrId, env) {
  const local = findProfile(nameOrId, env);
  if (local?.connectorId) return { connectorId: local.connectorId, local };
  if (validateConnectorId(nameOrId)) return { connectorId: nameOrId, local };
  const data = await apiCall('GET', '/v1/tunnel/v1/connectors');
  const connectors = data?.connectors || [];
  const matches = connectors.filter((c) => c.name === nameOrId || c.id === nameOrId);
  if (matches.length === 1) return { connectorId: matches[0].id, local };
  if (matches.length > 1) throw new Error(`Multiple connectors named '${nameOrId}'; specify the connector UUID`);
  throw new Error(`Tunnel '${nameOrId}' not found`);
}

async function runForeground(config, logger, stdout, bannerDetails) {
  if (bannerDetails) printBanner(stdout, bannerDetails);
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

async function handleRun(rest, options, env, stdout, stderr) {
  const { positional, daemon } = parseShortFlags(rest);
  if (positional.length > 1) throw new Error('tunnel run accepts at most one display-only connector-id');
  if (positional.some((arg) => arg.startsWith('-'))) throw new Error('Unknown tunnel option');
  for (const forbidden of ['subdomain', 'hostname', 'upstream', 'port', 'pathPrefix', 'all', 'follow', 'lines']) {
    if (options[forbidden] !== undefined) throw new Error('Unknown tunnel option');
  }

  const loaded = loadTunnelConfig(env, tunnelArgs(options));
  const config = setConnectorId(loaded, positional[0]);

  if (daemon || options.daemon) {
    const profileName = options.name || config.connectorId || 'default';
    const started = await startDaemon({
      name: profileName,
      connectorId: config.connectorId || null,
      serverUrl: config.serverUrl,
      reconnectDelayMs: config.reconnectDelayMs,
      tokenFile: options.tokenFile,
    }, {
      env,
      binPath: options.binPath,
      token: options.tokenFile ? undefined : config.token,
    });
    if (options.json) printJson(stdout, started);
    else printBanner(stdout, started);
    return;
  }

  const logger = createLogger(config.logLevel, stderr);
  if (config.permissiveTokenFileMode) {
    logger.warn('tunnel_token_file_permissions', { recommendation: 'chmod 600 the token file' });
  }
  await runForeground(config, logger, stdout, null);
}

async function provisionQuickTunnel(targetInput, options, env) {
  const apiCall = requireApi(options);
  const upstreamUrl = normalizeUpstreamInput(targetInput);
  const body = {
    upstreamUrl,
    ...(options.name ? { name: String(options.name).trim() } : {}),
    ...(options.subdomain ? { subdomain: String(options.subdomain).trim() } : {}),
    ...(options.hostname ? { hostname: String(options.hostname).trim() } : {}),
    ...(options.pathPrefix ? { pathPrefix: String(options.pathPrefix).trim() } : {}),
  };
  const provisioned = await apiCall('POST', '/v1/tunnel/v1/quick', body);
  const serverUrl = options.serverUrl
    ? normalizeServerUrl(options.serverUrl)
    : normalizeServerUrl(provisioned.serverUrl || `https://${provisioned.baseDomain || 'synapsetunnel.site'}`);
  const profileName = sanitizeProfileName(
    options.name || options.subdomain || provisioned.connector?.name || provisioned.route?.hostname?.split('.')[0] || 'tunnel',
  );
  const saved = saveProfile({
    name: profileName,
    connectorId: provisioned.connector.id,
    routeId: provisioned.route.id,
    hostname: provisioned.route.hostname,
    publicUrl: provisioned.publicUrl,
    upstreamUrl: provisioned.connector.upstreamUrl,
    serverUrl,
    pathPrefix: provisioned.route.pathPrefix || '',
    reconnectDelayMs: options.reconnectDelayMs ? Number(options.reconnectDelayMs) : 1000,
  }, provisioned.token, env);
  return { provisioned, saved };
}

async function handleHttpOrCreate(subcommand, rest, options, env, stdout, stderr) {
  const { positional, daemon } = parseShortFlags(rest);
  const runAsDaemon = Boolean(daemon || options.daemon);
  let targetInput;
  if (subcommand === 'create') {
    if (!options.name && positional[0]) options.name = positional[0];
    targetInput = options.upstream || options.port || positional[1];
  } else {
    targetInput = options.upstream || options.port || positional[0];
  }
  if (!targetInput) {
    throw new Error(`usage: synapseone tunnel ${subcommand} <port|url> [--subdomain <label>] [--hostname <host>] [--name <name>] [-d|--daemon]`);
  }
  const { provisioned, saved } = await provisionQuickTunnel(targetInput, options, env);

  if (runAsDaemon) {
    const started = await startDaemon(saved, { env, binPath: options.binPath });
    if (options.json) printJson(stdout, { ...started, reused: provisioned.reused, quota: provisioned.quota });
    else printBanner(stdout, { ...started, quota: provisioned.quota });
    return;
  }

  if (subcommand === 'create') {
    if (options.json) printJson(stdout, { ...saved, reused: provisioned.reused, quota: provisioned.quota });
    else {
      stdout.write(`Tunnel provisioned: ${saved.publicUrl} -> ${saved.upstreamUrl}\n`);
      stdout.write(`Start in background: synapseone tunnel start ${saved.name}\n`);
      stdout.write(`Run in foreground:   synapseone tunnel run ${saved.connectorId} --token-file ${saved.tokenFile} --server-url ${saved.serverUrl}\n`);
    }
    return;
  }

  const config = setConnectorId(
    loadTunnelConfig(env, ['--token-file', saved.tokenFile, '--server-url', saved.serverUrl]),
    saved.connectorId,
  );
  const logger = createLogger(config.logLevel, stderr);
  await runForeground(config, logger, stdout, { ...saved, quota: provisioned.quota });
}

async function handleStart(rest, options, env, stdout) {
  const { positional } = parseShortFlags(rest);
  const target = positional[0];

  // Case 1: Port or URL passed (e.g. `tunnel start 3000` or `--port 3000` / `--upstream http://localhost:3000`)
  const explicitTarget = options.upstream || options.port || (target && (/^:?\d{1,5}$/.test(target) || /:\/\//.test(target) || /^localhost(?::|$)/i.test(target)) ? target : undefined);
  if (explicitTarget && !options.token && !options.tokenFile) {
    const { provisioned, saved } = await provisionQuickTunnel(explicitTarget, options, env);
    const started = await startDaemon(saved, { env, binPath: options.binPath });
    if (options.json) printJson(stdout, { ...started, reused: provisioned.reused, quota: provisioned.quota });
    else printBanner(stdout, { ...started, quota: provisioned.quota });
    return;
  }

  // Case 2: Explicit token / token-file (or env token) provided
  const envToken = env.SYNAPSETUNNEL_CONNECTOR_TOKEN || env.SYNAPSETUNNEL_TOKEN;
  if (options.token || options.tokenFile || (!target && envToken)) {
    const serverUrl = await resolveDefaultServerUrl(options, env);
    let token = options.token || envToken;
    if (options.tokenFile) token = fs.readFileSync(options.tokenFile, 'utf8').trim();
    if (!validateConnectorToken(token)) throw new Error('A valid connector token is required');
    const name = options.name || target || 'default';
    const connectorId = target && validateConnectorId(target) ? target : undefined;
    const started = await startDaemon({
      name,
      connectorId: connectorId || null,
      hostname: options.hostname || (options.subdomain ? `${options.subdomain}.synapsetunnel.site` : null),
      publicUrl: options.hostname ? `https://${options.hostname}` : (options.subdomain ? `https://${options.subdomain}.synapsetunnel.site` : null),
      upstreamUrl: explicitTarget ? normalizeUpstreamInput(explicitTarget) : null,
      serverUrl,
      reconnectDelayMs: options.reconnectDelayMs ? Number(options.reconnectDelayMs) : 1000,
    }, { env, binPath: options.binPath, token });
    if (options.json) printJson(stdout, started);
    else printBanner(stdout, started);
    return;
  }

  // Case 3: Start from saved local profile
  const profiles = listProfiles(env);
  let profile = target ? findProfile(target, env) : (profiles.length === 1 ? profiles[0] : null);
  if (!profile) {
    throw new Error(
      target
        ? `Tunnel profile '${target}' not found. Run 'synapseone tunnel start <port> --subdomain <label>' or pass --token.`
        : 'Specify a saved tunnel name, local port (e.g. 3000), or --token to start in background',
    );
  }
  const serverUrl = options.serverUrl ? normalizeServerUrl(options.serverUrl) : profile.serverUrl;
  const started = await startDaemon({ ...profile, serverUrl }, { env, binPath: options.binPath });
  if (options.json) printJson(stdout, started);
  else printBanner(stdout, started);
}

async function handleStop(rest, options, env, stdout) {
  const { positional } = parseShortFlags(rest);
  const all = Boolean(options.all);
  const target = positional[0];
  if (!all && !target) throw new Error('usage: synapseone tunnel stop <name|id> | synapseone tunnel stop --all');
  const results = await stopDaemon(target, { env, all });
  if (options.json) return printJson(stdout, { stopped: results });
  if (!results.length) {
    stdout.write('No local tunnel daemons found.\n');
    return;
  }
  for (const item of results) {
    stdout.write(`${item.name}: ${item.wasRunning ? `stopped (pid ${item.pid})` : 'already stopped'}\n`);
  }
}

async function handleRestart(rest, options, env, stdout) {
  const { positional } = parseShortFlags(rest);
  const target = positional[0];
  if (!target) throw new Error('usage: synapseone tunnel restart <name|id>');
  const profile = findProfile(target, env);
  if (!profile) throw new Error(`Tunnel profile '${target}' not found`);
  await stopDaemon(profile.name, { env });
  const started = await startDaemon(profile, { env, binPath: options.binPath });
  if (options.json) printJson(stdout, started);
  else printBanner(stdout, started);
}

async function handleStatus(rest, options, env, stdout) {
  const { positional } = parseShortFlags(rest);
  const query = positional[0];
  const all = listProfiles(env);
  const filtered = query ? all.filter((p) => p.name === query || p.name === sanitizeProfileName(query) || p.connectorId === query || p.hostname === query) : all;
  if (options.json) return printJson(stdout, { tunnels: filtered });
  if (!filtered.length) {
    stdout.write('No local tunnel profiles found. Start one with: synapseone tunnel start 3000 --subdomain myapp\n');
    return;
  }
  for (const p of filtered) {
    stdout.write(`${p.name.padEnd(18)} ${p.status.padEnd(9)} pid=${String(p.pid || '-').padEnd(8)} ${p.publicUrl || p.hostname || '-'} -> ${p.upstreamUrl || '-'}\n`);
  }
}

async function handleLogs(rest, options, env, stdout) {
  const { positional, follow } = parseShortFlags(rest);
  const target = positional[0];
  if (!target) throw new Error('usage: synapseone tunnel logs <name|id> [--lines N] [-f|--follow]');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await readDaemonLogs(target, {
      env,
      stdout,
      lines: options.lines,
      follow: Boolean(follow || options.follow),
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function handleList(options, env, stdout) {
  const apiCall = requireApi(options);
  const [connData, routeData, quota] = await Promise.all([
    apiCall('GET', '/v1/tunnel/v1/connectors'),
    apiCall('GET', '/v1/tunnel/v1/routes'),
    apiCall('GET', '/v1/tunnel/v1/quota'),
  ]);
  const localProfiles = listProfiles(env);
  const payload = {
    connectors: connData?.connectors || [],
    routes: routeData?.routes || [],
    quota,
    localDaemons: localProfiles,
  };
  if (options.json) return printJson(stdout, payload);
  stdout.write(`Domain Quota: ${formatQuota(quota)}\n`);
  if (!payload.connectors.length) {
    stdout.write('No remote tunnels found.\n');
    return;
  }
  for (const c of payload.connectors) {
    const routes = payload.routes.filter((r) => r.connectorId === c.id);
    const local = localProfiles.find((p) => p.connectorId === c.id);
    const hosts = routes.map((r) => `${r.hostname}${r.pathPrefix || ''}`).join(', ') || '—';
    const localState = local ? `daemon=${local.status}${local.pid ? `(${local.pid})` : ''}` : 'daemon=none';
    stdout.write(`${c.name.padEnd(18)} ${c.connected ? 'connected   ' : 'disconnected'}  ${hosts} -> ${c.upstreamUrl}  [${localState}]  (${c.id})\n`);
  }
}

async function handleQuota(options, stdout) {
  const apiCall = requireApi(options);
  const quota = await apiCall('GET', '/v1/tunnel/v1/quota');
  if (options.json) return printJson(stdout, quota);
  stdout.write(`Base Domain: ${quota.baseDomain}\n`);
  stdout.write(`Usage:       ${formatQuota(quota)}\n`);
  if (quota.domains?.length) {
    stdout.write(`Domains:\n${quota.domains.map((d) => `  - ${d}`).join('\n')}\n`);
  }
}

async function handleDelete(rest, options, env, stdout) {
  const { positional } = parseShortFlags(rest);
  const target = positional[0];
  if (!target) throw new Error('usage: synapseone tunnel delete <name|id>');
  const apiCall = requireApi(options);
  const { connectorId, local } = await resolveConnectorIdForRemote(apiCall, target, env);
  if (local?.running) await stopDaemon(local.name, { env });
  await apiCall('DELETE', `/v1/tunnel/v1/connectors/${encodeURIComponent(connectorId)}?force=true`);
  if (local) removeProfile(local.name, env);
  if (options.json) return printJson(stdout, { deleted: true, connectorId });
  stdout.write(`Deleted tunnel ${connectorId}\n`);
}

async function handleRotateToken(rest, options, env, stdout) {
  const { positional } = parseShortFlags(rest);
  const target = positional[0];
  if (!target) throw new Error('usage: synapseone tunnel rotate-token <name|id>');
  const apiCall = requireApi(options);
  const { connectorId, local } = await resolveConnectorIdForRemote(apiCall, target, env);
  const data = await apiCall('POST', `/v1/tunnel/v1/connectors/${encodeURIComponent(connectorId)}/rotate-token`);
  if (local) {
    saveProfile(local, data.token, env);
  }
  if (options.json) return printJson(stdout, data);
  stdout.write(`Rotated token for ${connectorId}:\n${data.token}\n`);
  if (local) stdout.write(`Updated local token file: ${profilePaths(local.name, env).tokenFile}\n`);
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
  if (rest.includes('--help') || rest.includes('-h')) {
    stdout.write(HELP);
    return;
  }

  switch (subcommand) {
    case 'run':
      return handleRun(rest, options, env, stdout, stderr);
    case 'http':
    case 'quick':
    case 'expose':
    case 'create':
      return handleHttpOrCreate(subcommand, rest, options, env, stdout, stderr);
    case 'start':
    case 'daemon':
      return handleStart(rest, options, env, stdout);
    case 'stop':
      return handleStop(rest, options, env, stdout);
    case 'restart':
      return handleRestart(rest, options, env, stdout);
    case 'status':
    case 'ps':
      return handleStatus(rest, options, env, stdout);
    case 'logs':
      return handleLogs(rest, options, env, stdout);
    case 'list':
    case 'ls':
      return handleList(options, env, stdout);
    case 'quota':
      return handleQuota(options, stdout);
    case 'delete':
    case 'rm':
      return handleDelete(rest, options, env, stdout);
    case 'rotate-token':
      return handleRotateToken(rest, options, env, stdout);
    default:
      throw new Error('usage: synapseone tunnel <http|start|stop|restart|status|logs|list|quota|create|delete|rotate-token|run> [options]');
  }
}

module.exports = { HELP, runTunnelCommand };
