// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadTunnelConfig, setConnectorId, websocketUrl } = require('../lib/tunnel/config');

const TOKEN = `st_${'a'.repeat(43)}`;

function config(env = {}, args = []) {
  return loadTunnelConfig({ SYNAPSETUNNEL_CONNECTOR_TOKEN: TOKEN, ...env }, args);
}

describe('tunnel configuration', () => {
  it('uses the local ingress, default ws path, and bounded defaults', () => {
    const loaded = config();
    assert.equal(loaded.serverUrl, 'http://127.0.0.1:4016/');
    assert.equal(loaded.wsPath, '/_synapse/tunnel/connect');
    assert.equal(loaded.reconnectDelayMs, 1000);
    assert.equal(loaded.wsMaxPayloadBytes, 1048576);
    assert.equal(loaded.logLevel, 'info');
    assert.equal(websocketUrl(loaded), 'ws://127.0.0.1:4016/_synapse/tunnel/connect');
  });

  it('accepts both token environment names with the connector-specific name first', () => {
    const other = `st_${'b'.repeat(43)}`;
    assert.equal(loadTunnelConfig({ SYNAPSETUNNEL_TOKEN: TOKEN }).token, TOKEN);
    assert.equal(loadTunnelConfig({ SYNAPSETUNNEL_TOKEN: other, SYNAPSETUNNEL_CONNECTOR_TOKEN: TOKEN }).token, TOKEN);
  });

  it('lets explicit flags override the environment and maps HTTPS to WSS', () => {
    const loaded = config(
      { SYNAPSETUNNEL_SERVER_URL: 'http://127.0.0.1:9999', SYNAPSETUNNEL_WS_PATH: '/custom/connect' },
      ['--server-url', 'https://tunnel.example.test/base', '--reconnect-delay-ms=250'],
    );
    assert.equal(loaded.serverUrl, 'https://tunnel.example.test/base');
    assert.equal(loaded.reconnectDelayMs, 250);
    assert.equal(websocketUrl(loaded), 'wss://tunnel.example.test/custom/connect');
  });

  it('reads a newline-terminated token file and prefers it over argv/env tokens', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-config-'));
    const file = path.join(directory, 'token');
    fs.writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    try {
      const loaded = config({}, ['--token', 'not-used', `--token-file=${file}`]);
      assert.equal(loaded.token, TOKEN);
      assert.equal(loaded.permissiveTokenFileMode, false);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('warns about a group/world-readable token file without exposing its contents', (t) => {
    if (process.platform === 'win32') return t.skip('POSIX file modes are not available');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-config-'));
    const file = path.join(directory, 'token');
    fs.writeFileSync(file, TOKEN, { mode: 0o600 });
    fs.chmodSync(file, 0o644);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    assert.equal(config({}, ['--token-file', file]).permissiveTokenFileMode, true);
  });

  it('rejects missing or malformed tokens without echoing them', () => {
    const secret = 'st_definitely-secret-but-invalid';
    assert.throws(() => loadTunnelConfig({}, []), /valid connector token/i);
    assert.throws(() => loadTunnelConfig({ SYNAPSETUNNEL_CONNECTOR_TOKEN: secret }, []), (error) => {
      assert.equal(error.message.includes(secret), false);
      return /valid connector token/i.test(error.message);
    });
    assert.throws(() => loadTunnelConfig({ SYNAPSETUNNEL_CONNECTOR_TOKEN: TOKEN }, ['--token-file']), /Missing value/);
  });

  it('rejects unsafe or malformed server URLs and websocket paths', () => {
    for (const url of [
      'not a url',
      'ftp://tunnel.example.test',
      'https://user:password@tunnel.example.test',
      'https://tunnel.example.test/?token=secret',
      'https://tunnel.example.test/#fragment',
    ]) {
      assert.throws(() => config({ SYNAPSETUNNEL_SERVER_URL: url }), /Invalid connector server URL/, url);
    }
    for (const wsPath of ['connect', '/connect?token=x', '/connect#fragment', '/has space', '']) {
      if (wsPath === '') {
        // Empty means unset and therefore selects the default.
        assert.equal(config({ SYNAPSETUNNEL_WS_PATH: wsPath }).wsPath, '/_synapse/tunnel/connect');
      } else {
        assert.throws(() => config({ SYNAPSETUNNEL_WS_PATH: wsPath }), /Invalid SYNAPSETUNNEL_WS_PATH/, wsPath);
      }
    }
  });

  it('validates integers and clamps reconnect/ws limits to service bounds', () => {
    assert.equal(config({ SYNAPSETUNNEL_RECONNECT_DELAY_MS: '1' }).reconnectDelayMs, 100);
    assert.equal(config({}, ['--reconnect-delay-ms', '999999']).reconnectDelayMs, 30000);
    assert.equal(config({ SYNAPSETUNNEL_WS_MAX_PAYLOAD_BYTES: '1' }).wsMaxPayloadBytes, 65536);
    assert.equal(config({ SYNAPSETUNNEL_WS_MAX_PAYLOAD_BYTES: '99999999' }).wsMaxPayloadBytes, 16777216);
    assert.throws(() => config({}, ['--reconnect-delay-ms', '1.5']), /must be an integer/);
    assert.throws(() => config({ SYNAPSETUNNEL_LOG_LEVEL: 'verbose' }), /SYNAPSETUNNEL_LOG_LEVEL/);
    assert.throws(() => config({}, ['--unknown']), /Unknown tunnel option/);
  });

  it('keeps connector id display-only and validates its UUID shape', () => {
    const id = randomUUID();
    const other = randomUUID();
    const loaded = setConnectorId(config(), id);
    assert.equal(loaded.connectorId, id);
    assert.equal(loaded.token, TOKEN);
    assert.notEqual(loaded.connectorId, other);
    assert.throws(() => setConnectorId(config(), 'not-a-uuid'), /Invalid connector id/);
  });
});
