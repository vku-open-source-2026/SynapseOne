#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
'use strict';

/*
 * Client SDKs version independently from the platform, but all four languages
 * must ship the same API generation. Optionally verify a release tag:
 *
 *   node tools/sdk-version-check.cjs sdk-v0.10.2
 *   node tools/sdk-version-check.cjs sdk-rust-v0.10.2
 *   node tools/sdk-version-check.cjs sdks/sdk-go/v0.10.2
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const cargoVersion = (file) => {
  const match = read(file).match(/^version\s*=\s*"([^"]+)"/m);
  return match && match[1];
};

const errors = [];
const goModule = 'github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go';
const goMod = read('sdks/sdk-go/go.mod');
if (!new RegExp(`^module\\s+${goModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(goMod)) {
  errors.push(`sdks/sdk-go/go.mod: module must be ${goModule}`);
}
if (!/^go\s+1\.22\s*$/m.test(goMod)) {
  errors.push('sdks/sdk-go/go.mod: Go 1.22 is the supported release baseline');
}

const manifests = [
  { language: 'JavaScript/TypeScript', file: 'sdks/sdk-js/package.json', version: () => json('sdks/sdk-js/package.json').version },
  { language: 'Python', file: 'sdks/sdk-python/pyproject.toml', version: () => {
    const match = read('sdks/sdk-python/pyproject.toml').match(/^version\s*=\s*"([^"]+)"/m);
    return match && match[1];
  } },
  { language: 'Go', file: 'sdks/sdk-go/VERSION', version: () => read('sdks/sdk-go/VERSION').trim() },
  { language: 'Rust', file: 'sdks/sdk-rust/Cargo.toml', version: () => cargoVersion('sdks/sdk-rust/Cargo.toml') },
];

const versions = new Map();
for (const manifest of manifests) {
  const version = manifest.version();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push(`${manifest.file}: invalid or missing SDK version (${version || 'missing'})`);
    continue;
  }
  versions.set(manifest.language, version);
}

const unique = [...new Set(versions.values())];
if (unique.length > 1) {
  errors.push(`SDK version drift: ${[...versions].map(([language, version]) => `${language}=${version}`).join(', ')}`);
}

const tag = process.argv[2];
if (tag) {
  const prefixes = ['sdk-v', 'sdk-rust-v', 'sdks/sdk-go/v'];
  const prefix = prefixes.find((candidate) => tag.startsWith(candidate));
  if (!prefix) {
    errors.push(`unsupported SDK tag ${tag}; expected one of ${prefixes.join(', ')}`);
  } else {
    const version = tag.slice(prefix.length);
    if (!/^\d+\.\d+\.\d+$/.test(version) || unique[0] !== version) {
      errors.push(`tag ${tag} does not match SDK version ${unique[0] || 'missing'}`);
    }
  }
}

if (errors.length) {
  console.error('[sdk-version-check] release identity drift:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`[sdk-version-check] JavaScript, Python, Go and Rust SDKs report ${unique[0]}${tag ? ` (${tag})` : ''}`);
