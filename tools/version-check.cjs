#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Release identity drift gate (#82): the workspace version, every service
 * package/Cargo manifest, the Kubernetes image tags and the reported runtime
 * version constant must agree. Health output uses package metadata (or
 * SYNAPSEONE_BUILD_VERSION at runtime), so a stale manifest silently breaks
 * release traceability.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[version-check] root package.json version is invalid: ${version}`);
  process.exit(1);
}
const errors = [];

for (const entry of fs.readdirSync(path.join(root, 'apps'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(root, 'apps', entry.name);
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== version) errors.push(`${path.relative(root, pkgPath)}: ${pkg.version} != ${version}`);
  }
  const cargoPath = path.join(dir, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    const cargo = fs.readFileSync(cargoPath, 'utf8');
    const match = cargo.match(/^version = "([^"]+)"/m);
    if (match && match[1] !== version) errors.push(`${path.relative(root, cargoPath)}: ${match[1]} != ${version}`);
    const mainPath = path.join(dir, 'src', 'main.rs');
    if (fs.existsSync(mainPath)) {
      const source = fs.readFileSync(mainPath, 'utf8');
      if (/(?:const|static)\s+VERSION\s*:\s*&str\s*=\s*"0\.\d+\.\d+"/.test(source)) {
        errors.push(`${path.relative(root, mainPath)}: hardcoded VERSION constant (use env!("CARGO_PKG_VERSION"))`);
      }
    }
  }
}

// Python inference reports its version in health output; keep it on the same
// release identity as the rest of the stack.
const inferencePkg = path.join(root, 'apps', 'inference-service', 'src', '__init__.py');
if (fs.existsSync(inferencePkg)) {
  const source = fs.readFileSync(inferencePkg, 'utf8');
  const match = source.match(/^__version__\s*=\s*["']([^"']+)["']/m);
  if (!match || match[1] !== version) {
    errors.push(`${path.relative(root, inferencePkg)}: ${match ? match[1] : 'missing __version__'} != ${version}`);
  }
}

// Lakehouse is Python too; its health/metrics version must track the platform.
const lakehouseVersion = path.join(root, 'apps', 'lakehouse-service', 'src', 'main.py');
if (fs.existsSync(lakehouseVersion)) {
  const source = fs.readFileSync(lakehouseVersion, 'utf8');
  const match = source.match(/^VERSION\s*=\s*["']([^"']+)["']/m);
  if (!match || match[1] !== version) {
    errors.push(`${path.relative(root, lakehouseVersion)}: ${match ? match[1] : 'missing VERSION'} != ${version}`);
  }
}

const k8s = path.join(root, 'infra', 'k8s', 'base', 'all.yaml');
if (fs.existsSync(k8s)) {
  for (const line of fs.readFileSync(k8s, 'utf8').split('\n')) {
    const match = line.match(/image:\s*ghcr\.io\/synapseone\/[a-z-]+:([0-9]+\.[0-9]+\.[0-9]+)/);
    if (match && match[1] !== version) errors.push(`${path.relative(root, k8s)}: image tag ${match[1]} != ${version}`);
  }
}

if (errors.length) {
  console.error('[version-check] release identity drift:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`[version-check] all service manifests report ${version}`);
