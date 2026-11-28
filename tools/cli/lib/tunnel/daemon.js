// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeServerUrl, normalizeUpstreamUrl, validateConnectorToken } = require('./validation');

const DEFAULT_BIN = path.resolve(__dirname, '..', '..', 'bin', 'synapseone.js');

function tunnelDir(env = process.env) {
  return env.SYNAPSEONE_TUNNEL_DIR || path.join(os.homedir(), '.synapseone', 'tunnels');
}

function sanitizeProfileName(name) {
  const cleaned = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'default';
  return cleaned;
}

function ensureTunnelDir(env = process.env) {
  const dir = tunnelDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
  return dir;
}

function profilePaths(name, env = process.env) {
  const safeName = sanitizeProfileName(name);
  const dir = tunnelDir(env);
  return {
    name: safeName,
    dir,
    metaFile: path.join(dir, `${safeName}.json`),
    tokenFile: path.join(dir, `${safeName}.token`),
    logFile: path.join(dir, `${safeName}.log`),
  };
}

function normalizeUpstreamInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Upstream port or URL is required');
  let candidate = raw;
  if (/^\d{1,5}$/.test(raw)) {
    const port = Number(raw);
    if (port < 1 || port > 65535) throw new Error('Invalid local port');
    candidate = `http://127.0.0.1:${port}`;
  } else if (/^:\d{1,5}$/.test(raw)) {
    const port = Number(raw.slice(1));
    if (port < 1 || port > 65535) throw new Error('Invalid local port');
    candidate = `http://127.0.0.1:${port}`;
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    candidate = `http://${raw}`;
  }
  return normalizeUpstreamUrl(candidate);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function writeSecureFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* non-POSIX */ }
}

function saveProfile(profile, token, env = process.env) {
  ensureTunnelDir(env);
  const paths = profilePaths(profile.name, env);
  if (token !== undefined) {
    if (!validateConnectorToken(token)) throw new Error('Invalid connector token');
    writeSecureFile(paths.tokenFile, `${token}\n`);
  }
  const record = {
    name: paths.name,
    connectorId: profile.connectorId || null,
    routeId: profile.routeId || null,
    hostname: profile.hostname || null,
    publicUrl: profile.publicUrl || null,
    upstreamUrl: profile.upstreamUrl || null,
    serverUrl: normalizeServerUrl(profile.serverUrl),
    pathPrefix: profile.pathPrefix || '',
    reconnectDelayMs: profile.reconnectDelayMs || 1000,
    tokenFile: profile.tokenFile || paths.tokenFile,
    logFile: profile.logFile || paths.logFile,
    pid: profile.pid ?? null,
    startedAt: profile.startedAt || null,
    stoppedAt: profile.stoppedAt || null,
    updatedAt: new Date().toISOString(),
  };
  writeSecureFile(paths.metaFile, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function readProfileFile(metaFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const running = isProcessRunning(parsed.pid);
    return {
      ...parsed,
      running,
      status: running ? 'running' : 'stopped',
    };
  } catch {
    return null;
  }
}

function listProfiles(env = process.env) {
  const dir = tunnelDir(env);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const profiles = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const record = readProfileFile(path.join(dir, entry));
    if (record) profiles.push(record);
  }
  profiles.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return profiles;
}

function findProfile(nameOrId, env = process.env) {
  const query = String(nameOrId || '').trim();
  if (!query) return null;
  const profiles = listProfiles(env);
  const safe = sanitizeProfileName(query);
  return profiles.find((p) => p.name === query || p.name === safe || p.connectorId === query || p.hostname === query.toLowerCase()) || null;
}

function removeProfile(nameOrId, env = process.env) {
  const profile = findProfile(nameOrId, env);
  if (!profile) return false;
  const paths = profilePaths(profile.name, env);
  for (const file of [paths.metaFile, paths.tokenFile, paths.logFile]) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
  return true;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailLines(filePath, count = 20) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ''));
    return lines.slice(-count);
  } catch {
    return [];
  }
}

async function stopPid(pid, timeoutMs = 3000) {
  if (!isProcessRunning(pid)) return false;
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await delay(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await delay(100);
  return true;
}

async function startDaemon(profile, options = {}) {
  const env = options.env || process.env;
  const binPath = options.binPath || DEFAULT_BIN;
  ensureTunnelDir(env);
  const paths = profilePaths(profile.name, env);
  const existing = findProfile(paths.name, env);
  if (existing && existing.running && existing.pid) {
    await stopPid(existing.pid);
  }

  const saved = saveProfile({
    ...profile,
    name: paths.name,
    tokenFile: profile.tokenFile || paths.tokenFile,
    logFile: profile.logFile || paths.logFile,
    pid: null,
  }, options.token, env);

  if (!fs.existsSync(saved.tokenFile)) {
    throw new Error(`Connector token file not found for '${saved.name}'`);
  }

  const childArgs = [binPath, 'tunnel', 'run'];
  if (saved.connectorId) childArgs.push(saved.connectorId);
  childArgs.push('--token-file', saved.tokenFile, '--server-url', saved.serverUrl);
  if (saved.reconnectDelayMs) {
    childArgs.push('--reconnect-delay-ms', String(saved.reconnectDelayMs));
  }

  const childEnv = { ...env };
  delete childEnv.SYNAPSETUNNEL_CONNECTOR_TOKEN;
  delete childEnv.SYNAPSETUNNEL_TOKEN;
  delete childEnv.SYNAPSETUNNEL_SERVER_URL;

  const logFd = fs.openSync(saved.logFile, 'a', 0o600);
  let child;
  let exitedEarly = false;
  let earlyCode = null;
  try {
    child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
      windowsHide: true,
    });
    child.once('exit', (code) => {
      exitedEarly = true;
      earlyCode = code;
    });
    child.unref();
  } finally {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  }

  await delay(300);
  if (exitedEarly || !isProcessRunning(child.pid)) {
    const recent = tailLines(saved.logFile, 10).join('\n');
    throw new Error(`Tunnel daemon '${saved.name}' exited early (code=${earlyCode ?? 'unknown'})${recent ? `:\n${recent}` : ''}`);
  }

  const updated = saveProfile({
    ...saved,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
  }, undefined, env);
  return { ...updated, running: true, status: 'running' };
}

async function stopDaemon(nameOrId, options = {}) {
  const env = options.env || process.env;
  const targets = options.all
    ? listProfiles(env)
    : (() => {
        const found = findProfile(nameOrId, env);
        if (!found) throw new Error(`Tunnel profile '${nameOrId}' not found`);
        return [found];
      })();

  const results = [];
  for (const profile of targets) {
    const wasRunning = Boolean(profile.pid && isProcessRunning(profile.pid));
    if (wasRunning) await stopPid(profile.pid);
    saveProfile({
      ...profile,
      pid: null,
      stoppedAt: new Date().toISOString(),
    }, undefined, env);
    results.push({ name: profile.name, pid: profile.pid, stopped: true, wasRunning });
  }
  return results;
}

async function readDaemonLogs(nameOrId, options = {}) {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const lines = Number.isInteger(Number(options.lines)) && Number(options.lines) > 0 ? Number(options.lines) : 50;
  const profile = findProfile(nameOrId, env);
  if (!profile) throw new Error(`Tunnel profile '${nameOrId}' not found`);
  if (!fs.existsSync(profile.logFile)) {
    stdout.write(`No logs yet for '${profile.name}' (${profile.logFile})\n`);
    return;
  }
  const initial = tailLines(profile.logFile, lines);
  if (initial.length) stdout.write(`${initial.join('\n')}\n`);
  if (!options.follow) return;

  let offset = fs.statSync(profile.logFile).size;
  const signal = options.signal;
  while (!signal?.aborted) {
    await delay(250);
    if (signal?.aborted) break;
    try {
      const stat = fs.statSync(profile.logFile);
      if (stat.size > offset) {
        const fd = fs.openSync(profile.logFile, 'r');
        try {
          const length = stat.size - offset;
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, offset);
          stdout.write(buffer.toString('utf8'));
          offset = stat.size;
        } finally {
          fs.closeSync(fd);
        }
      } else if (stat.size < offset) {
        offset = stat.size;
      }
    } catch {
      break;
    }
  }
}

module.exports = {
  DEFAULT_BIN,
  findProfile,
  isProcessRunning,
  listProfiles,
  normalizeUpstreamInput,
  profilePaths,
  readDaemonLogs,
  removeProfile,
  sanitizeProfileName,
  saveProfile,
  startDaemon,
  stopDaemon,
  tunnelDir,
};
