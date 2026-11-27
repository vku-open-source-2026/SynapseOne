// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const script = path.join(__dirname, 'sdk-version-check.cjs');
const version = require('../sdks/sdk-js/package.json').version;
const nextMajor = Number(version.split('.')[0]) + 1;
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('accepts the shared SDK version and each release tag convention', () => {
  for (const tag of [`sdk-v${version}`, `sdk-rust-v${version}`, `sdks/sdk-go/v${version}`]) {
    const result = run(tag);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes(`report ${version}`));
  }
});

test('rejects a tag that does not match the manifests', () => {
  const result = run(`sdk-v${nextMajor}.0.0`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match SDK version/);
});

test('rejects unknown tag conventions', () => {
  const result = run(`release-${version}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported SDK tag/);
});
