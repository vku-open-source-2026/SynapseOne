// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { mfaEnabled } from './site.js';
import { en } from '../locales/en.js';
import { vi } from '../locales/vi.js';

function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
  return typeof value;
}

function readRuntimeConfig(source) {
  const context = { window: {} };
  runInNewContext(source, context);
  return context.window.SYNAPSEONE_CONFIG;
}

test('MFA runtime configuration defaults to enabled and accepts boolean flags', async (t) => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  t.after(() => {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  });

  await t.test('missing runtime config uses the default', () => {
    delete globalThis.window;
    assert.equal(mfaEnabled(), true);
  });

  await t.test('older runtime config without MFA_ENABLED stays enabled', () => {
    globalThis.window = { SYNAPSEONE_CONFIG: { APP_URL: 'https://cloud.example.test' } };
    assert.equal(mfaEnabled(), true);
  });

  await t.test('runtime booleans are authoritative', () => {
    globalThis.window = { SYNAPSEONE_CONFIG: { MFA_ENABLED: false } };
    assert.equal(mfaEnabled(), false);
    globalThis.window.SYNAPSEONE_CONFIG.MFA_ENABLED = true;
    assert.equal(mfaEnabled(), true);
  });

  await t.test('string values are parsed without treating the string false as truthy', () => {
    globalThis.window = { SYNAPSEONE_CONFIG: { MFA_ENABLED: ' FALSE ' } };
    assert.equal(mfaEnabled(), false);
    globalThis.window.SYNAPSEONE_CONFIG.MFA_ENABLED = 'true';
    assert.equal(mfaEnabled(), true);
  });

  await t.test('invalid values fail open to the secure default', () => {
    globalThis.window = { SYNAPSEONE_CONFIG: { MFA_ENABLED: 'unexpected' } };
    assert.equal(mfaEnabled(), true);
  });
});

test('public config and container entrypoint emit a boolean MFA flag', async (t) => {
  const publicConfig = readFileSync(new URL('../../public/config.js', import.meta.url), 'utf8');
  await t.test('local runtime config enables MFA by default', () => {
    assert.equal(readRuntimeConfig(publicConfig).MFA_ENABLED, true);
  });

  const entrypoint = readFileSync(new URL('../../docker-entrypoint.sh', import.meta.url), 'utf8');
  const tempDir = mkdtempSync(new URL('../.mfa-entrypoint-', import.meta.url));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const configPath = `${tempDir}/config.js`;
  const scriptPath = `${tempDir}/entrypoint.sh`;
  writeFileSync(scriptPath, entrypoint.replaceAll('/usr/share/nginx/html/config.js', configPath));

  const runEntrypoint = ({ primary, legacy, source = publicConfig } = {}) => {
    writeFileSync(configPath, source);
    const env = { ...process.env };
    delete env.SYNAPSEONE_MFA_ENABLED;
    delete env.SYNAPSEDX_MFA_ENABLED;
    if (primary !== undefined) env.SYNAPSEONE_MFA_ENABLED = primary;
    if (legacy !== undefined) env.SYNAPSEDX_MFA_ENABLED = legacy;
    const result = spawnSync('sh', [scriptPath, 'true'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(configPath, 'utf8');
  };

  for (const [label, values, expected] of [
    ['unset', {}, true],
    ['false', { primary: 'false' }, false],
    ['true', { primary: 'true' }, true],
    ['invalid', { primary: 'not-a-boolean' }, true],
    ['whitespace-trimmed false', { primary: '  false  ' }, false],
    ['legacy fallback', { legacy: '  FALSE  ' }, false],
    ['primary precedence', { primary: 'true', legacy: 'false' }, true],
    ['empty primary fallback', { primary: '', legacy: 'false' }, false],
  ]) {
    await t.test(`${label} environment value becomes ${expected}`, () => {
      assert.equal(readRuntimeConfig(runEntrypoint(values)).MFA_ENABLED, expected);
    });
  }

  await t.test('rewrites an existing boolean value idempotently', () => {
    let source = publicConfig.replace('MFA_ENABLED: true', 'MFA_ENABLED:false');
    source = runEntrypoint({ primary: 'true' }, source);
    assert.equal(readRuntimeConfig(source).MFA_ENABLED, true);
    source = runEntrypoint({ primary: 'false' }, source);
    assert.equal(readRuntimeConfig(source).MFA_ENABLED, false);
    source = runEntrypoint({ primary: 'false' }, source);
    assert.equal(readRuntimeConfig(source).MFA_ENABLED, false);
  });
});

test('MFA-related English and Vietnamese copy keep key parity', () => {
  assert.deepEqual(shape(en.security), shape(vi.security));
  assert.deepEqual(shape(en.platform), shape(vi.platform));
});
