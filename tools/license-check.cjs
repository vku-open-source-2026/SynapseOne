#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * SynapseOne dependency license gate + CycloneDX SBOM generator.
 *
 * Covers every ecosystem that ships in a first-party image:
 *   - npm workspaces (installed tree, hoisted/nested aware)
 *   - Cargo workspaces (live `cargo metadata`, or a validated pinned inventory)
 *   - Python service environments (installed distribution metadata)
 *   - first-party container provenance (Dockerfile/label/notice checks)
 *
 * Policy is permissive-only. Strong/weak copyleft, source-available and
 * unknown licenses fail the gate. Two bundled, unmodified weak-copyleft
 * runtime packages are explicit, reviewed exceptions (certifi MPL-2.0 and
 * tqdm MPL-2.0 AND MIT); they are printed on every run.
 *
 * Usage:
 *   node tools/license-check.cjs [--sbom out.cdx.json] [--bundle licenses]
 *       [--inventory out.json] [--notices out.txt]
 *       [--python python3[,python3.12]] [--require-python]
 *       [--cargo-inventory third-party/cargo-inventory.json]
 *       [--write-cargo-inventory third-party/cargo-inventory.json]
 *       [--allow pkg@version,...]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}
function flag(name) {
  return args.includes(`--${name}`);
}
function multiOption(name) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) out.push(args[index + 1]);
  }
  return out;
}

const bundleDir = option('bundle');
const sbomOut = option('sbom') || (bundleDir ? path.join(bundleDir, 'sbom', 'synapseone.cdx.json') : null);
const inventoryOut = option('inventory') || (bundleDir ? path.join(bundleDir, 'inventory.json') : null);
const noticesOut = option('notices') || (bundleDir ? path.join(bundleDir, 'THIRD-PARTY-NOTICES.generated.txt') : null);
const cargoInventoryPath = option('cargo-inventory') || path.join(ROOT, 'third-party', 'cargo-inventory.json');
const writeCargoInventory = option('write-cargo-inventory');
const pythonExecutables = multiOption('python').flatMap((value) => value.split(',')).filter(Boolean);
const pythonExpect = (option('python-expect') || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const allow = new Set(
  (option('allow') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'Artistic-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'BSL-1.0',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CDLA-Permissive-2.0',
  'CNRI-Python',
  'curl',
  'ISC',
  'JSON',
  'libpng-2.0',
  'MIT',
  'MIT-0',
  'NCSA',
  'OpenSSL',
  'PostgreSQL',
  'PSF-2.0',
  'Python-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'WTFPL',
  'X11',
  'Zlib',
]);

// Reviewed exceptions for unmodified runtime libraries whose only copyleft
// obligation is file-level (MPL-2.0). They are recorded in NOTICE and
// licenses/THIRD-PARTY-NOTICES.txt; everything else must be permissive.
const REVIEWED_EXCEPTIONS = new Map([
  ['certifi', 'MPL-2.0 CA bundle, unmodified; MPL text shipped in licenses/MPL-2.0.txt'],
  ['tqdm', 'MPL-2.0 AND MIT progress bar; MPL text shipped in licenses/MPL-2.0.txt'],
]);

const TOOL_LICENSES = new Map([
  ['pip', 'MIT'],
  ['setuptools', 'MIT'],
  ['wheel', 'MIT'],
]);

const FIRST_PARTY = new Set(['synapseone', 'synapseone-sdk']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findLicenseFiles(directory, depth = 0) {
  const found = [];
  if (!directory || !fs.existsSync(directory)) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(entry.name)) {
      try {
        if (fs.statSync(full).size <= 2 * 1024 * 1024) found.push(full);
      } catch {
        /* ignore unreadable files */
      }
    } else if (entry.isDirectory() && depth < 2 && /^(?:licen[cs]es?|copying|notices?)$/i.test(entry.name)) {
      found.push(...findLicenseFiles(full, depth + 1));
    }
  }
  return found;
}

function licenseOf(pkg) {
  if (!pkg) return 'UNKNOWN';
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((entry) => (typeof entry === 'string' ? entry : entry.type)).filter(Boolean).join(' OR ');
  }
  if (Array.isArray(pkg.license)) return pkg.license.join(' OR ');
  return 'UNKNOWN';
}

// ---------- SPDX expression evaluation ----------

function normalizeLicense(raw) {
  if (!raw) return 'UNKNOWN';
  let value = String(raw).split('\n')[0].trim();
  if (!value) return 'UNKNOWN';
  value = value
    .replace(/[;,]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*(?=[A-Za-z0-9])/g, ' OR ')
    .replace(/\s+or\s+/gi, ' OR ')
    .replace(/\s+and\s+/gi, ' AND ');
  const aliases = [
    [/^mit license$/i, 'MIT'],
    [/^the mit license(?: \(mit\))?$/i, 'MIT'],
    [/^apache software license$/i, 'Apache-2.0'],
    [/^apache(?: software)?(?: license)?(?:,? version)? ?2\.0(?: license)?$/i, 'Apache-2.0'],
    [/^apache-2\.0$/i, 'Apache-2.0'],
    [/^3-clause bsd license$/i, 'BSD-3-Clause'],
    [/^bsd 3-clause license$/i, 'BSD-3-Clause'],
    [/^bsd 2-clause license$/i, 'BSD-2-Clause'],
    [/^2-clause bsd license$/i, 'BSD-2-Clause'],
    [/^bsd license$/i, 'BSD-3-Clause'],
    [/^bsd$/i, 'BSD-3-Clause'],
    [/^isc license(?: \(iscl\))?$/i, 'ISC'],
    [/^mpl(?: license)? 2\.0$/i, 'MPL-2.0'],
    [/^python software foundation license$/i, 'PSF-2.0'],
    [/^python-2\.0$/i, 'Python-2.0'],
  ];
  for (const [pattern, replacement] of aliases) {
    if (pattern.test(value)) return replacement;
  }
  return value;
}

function tokenize(expression) {
  return expression
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function acceptableExpression(expression) {
  const tokens = tokenize(expression);
  let index = 0;
  function allowedId(id) {
    return PERMISSIVE.has(id);
  }
  function parseOr() {
    let value = parseAnd();
    while (tokens[index] === 'OR') {
      index += 1;
      value = parseAnd() || value;
    }
    return value;
  }
  function parseAnd() {
    let value = parseFactor();
    while (tokens[index] === 'AND') {
      index += 1;
      const next = parseFactor();
      value = value && next;
    }
    return value;
  }
  function parseFactor() {
    const token = tokens[index];
    if (!token) return false;
    if (token === '(') {
      index += 1;
      const value = parseOr();
      if (tokens[index] !== ')') throw new Error(`unbalanced SPDX expression: ${expression}`);
      index += 1;
      return value;
    }
    index += 1;
    if (tokens[index] === 'WITH') {
      index += 1;
      const exception = tokens[index];
      index += 1;
      return allowedId(token) && ['LLVM-exception', 'Classpath-exception-2.0'].includes(exception);
    }
    return allowedId(token);
  }
  try {
    const result = parseOr();
    return index === tokens.length && result;
  } catch {
    return false;
  }
}

// ---------- npm ----------

function listNpmPackages(nodeModules, output) {
  let entries = [];
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      let scoped = [];
      try {
        scoped = fs.readdirSync(path.join(nodeModules, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        if (child.isDirectory()) output.push(path.join(nodeModules, entry.name, child.name));
      }
    } else {
      output.push(path.join(nodeModules, entry.name));
    }
  }
}

function installedNodeModules() {
  const roots = new Set([path.join(ROOT, 'node_modules')]);
  const workspacePatterns = readJson(path.join(ROOT, 'package.json'))?.workspaces || [];
  for (const pattern of workspacePatterns) {
    const base = path.join(ROOT, pattern.replace(/\/\*$/, ''));
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) roots.add(path.join(base, entry.name, 'node_modules'));
    }
  }
  const directories = [];
  const visited = new Set();
  const queue = [...roots];
  while (queue.length) {
    const nodeModules = queue.shift();
    if (visited.has(nodeModules)) continue;
    visited.add(nodeModules);
    const before = directories.length;
    listNpmPackages(nodeModules, directories);
    for (let index = before; index < directories.length; index += 1) {
      queue.push(path.join(directories[index], 'node_modules'));
    }
  }
  return directories;
}

function lockMetadata() {
  const lock = readJson(path.join(ROOT, 'package-lock.json'));
  const map = new Map();
  for (const [packagePath, entry] of Object.entries(lock?.packages || {})) {
    if (!packagePath.startsWith('node_modules/') || !entry.version) continue;
    const name = packagePath.split('node_modules/').pop();
    map.set(`${name}@${entry.version}`, {
      dev: Boolean(entry.dev),
      license: entry.license,
      resolved: entry.resolved,
    });
  }
  return map;
}

function scanNpm() {
  const lock = lockMetadata();
  const components = new Map();
  for (const directory of installedNodeModules()) {
    if (path.resolve(directory) === ROOT) continue;
    const pkg = readJson(path.join(directory, 'package.json'));
    if (!pkg || !pkg.name) continue;
    const key = `${pkg.name}@${pkg.version || '?'}`;
    const locked = lock.get(key);
    const existing = components.get(key) || {
      ecosystem: 'npm',
      name: pkg.name,
      version: pkg.version || '?',
      license: licenseOf(pkg) !== 'UNKNOWN' ? licenseOf(pkg) : locked?.license || 'UNKNOWN',
      runtime: !(locked?.dev ?? false),
      firstParty: false,
      paths: new Set(),
      licenseFiles: new Set(),
      source: locked?.resolved || '',
    };
    existing.paths.add(path.relative(ROOT, directory));
    for (const file of findLicenseFiles(directory)) existing.licenseFiles.add(file);
    components.set(key, existing);
  }
  return [...components.values()];
}

// ---------- Cargo ----------

const CARGO_MANIFESTS = [
  'apps/ai-service/Cargo.toml',
  'apps/base-service/Cargo.toml',
  'apps/faststore-service/Cargo.toml',
  'apps/gateway/Cargo.toml',
  'apps/lds-service/Cargo.toml',
  'apps/notifications-service/Cargo.toml',
  'apps/ocs-service/Cargo.toml',
  'apps/queue-service/Cargo.toml',
  'apps/stream-service/Cargo.toml',
  'apps/warehouse-service/Cargo.toml',
  'sdks/sdk-rust/Cargo.toml',
];

function cargoMetadata(manifest) {
  const cargo = process.env.CARGO || 'cargo';
  return JSON.parse(
    execFileSync(cargo, ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

function cargoComponentsFromMetadata(metadata, workspace) {
  return metadata.packages.map((pkg) => ({
    ecosystem: 'cargo',
    name: pkg.name,
    version: pkg.version,
    license: pkg.license || 'UNKNOWN',
    runtime: true,
    firstParty: !pkg.source,
    paths: [path.dirname(pkg.manifest_path)],
    licenseFiles: pkg.source ? findLicenseFiles(path.dirname(pkg.manifest_path)) : [],
    source: pkg.source || pkg.repository || '',
    checksum: pkg.checksum || '',
    workspaces: [workspace],
  }));
}

function parseCargoLock(file) {
  const text = fs.readFileSync(file, 'utf8');
  const packages = [];
  for (const block of text.split(/\[\[package\]\]/).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^source\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version && source) packages.push({ name, version, source });
  }
  return packages;
}

function loadCargoInventory(file) {
  const inventory = readJson(file);
  if (!inventory) return null;
  const components = Array.isArray(inventory) ? inventory : inventory.components;
  return Array.isArray(components) ? components : null;
}

function validateCargoInventoryAgainstLocks(components) {
  const keys = new Set(components.map((component) => `${component.name}@${component.version}`));
  const errors = [];
  for (const manifest of CARGO_MANIFESTS) {
    const lock = path.join(ROOT, path.dirname(manifest), 'Cargo.lock');
    if (!fs.existsSync(lock)) continue;
    for (const pkg of parseCargoLock(lock)) {
      if (!keys.has(`${pkg.name}@${pkg.version}`)) {
        errors.push(`Cargo inventory is stale: ${pkg.name}@${pkg.version} (${path.relative(ROOT, lock)}) is missing`);
      }
    }
  }
  return errors;
}

function scanCargo() {
  const live = [];
  const liveErrors = [];
  let usedLive = false;
  try {
    for (const manifest of CARGO_MANIFESTS) {
      live.push(...cargoComponentsFromMetadata(cargoMetadata(manifest), path.dirname(manifest)));
    }
    usedLive = true;
  } catch (error) {
    liveErrors.push(String(error.stderr || error.message || error).split('\n')[0]);
  }
  const empty = live.length === 0;
  if (!empty && !usedLive) liveErrors.length = 0;
  if (usedLive) {
    const merged = mergeComponents(live);
    if (writeCargoInventory) {
      fs.mkdirSync(path.dirname(path.resolve(ROOT, writeCargoInventory)), { recursive: true });
      fs.writeFileSync(
        path.resolve(ROOT, writeCargoInventory),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), components: merged }, null, 2)}\n`,
      );
    }
    return { components: merged, errors: [] };
  }
  const inventory = loadCargoInventory(cargoInventoryPath);
  if (!inventory) {
    return {
      components: [],
      errors: [
        `cargo metadata failed (${liveErrors[0] || 'cargo not found'}) and no cargo inventory exists at ${path.relative(ROOT, cargoInventoryPath)}`,
      ],
    };
  }
  const errors = validateCargoInventoryAgainstLocks(inventory);
  return {
    components: inventory.map((component) => ({
      ...component,
      ecosystem: 'cargo',
      runtime: component.runtime !== false,
      firstParty: Boolean(component.firstParty),
      paths: component.paths || (component.path ? [component.path] : []),
      licenseFiles: component.licenseFiles || [],
      workspaces: component.workspaces || [],
    })),
    errors,
  };
}

// ---------- Python ----------

function scanPython() {
  if (pythonExecutables.length === 0) {
    if (flag('require-python')) {
      return { components: [], errors: ['--require-python was set but no --python interpreter was provided'] };
    }
    console.log('license-check: Python ecosystem not scanned (pass --python <exe> --require-python in CI)');
    return { components: [], errors: [] };
  }
  const components = [];
  const errors = [];
  for (const executable of pythonExecutables) {
    try {
      const output = execFileSync(executable, [path.join(__dirname, 'python-license-inventory.py')], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(output);
      for (const component of parsed.components || []) {
        const firstParty = FIRST_PARTY.has(component.name.toLowerCase());
        let license = normalizeLicense(component.license);
        if (license === 'UNKNOWN' && TOOL_LICENSES.has(component.name.toLowerCase())) {
          license = TOOL_LICENSES.get(component.name.toLowerCase());
        }
        components.push({
          ecosystem: 'python',
          name: component.name,
          version: component.version,
          license,
          runtime: true,
          firstParty,
          paths: [component.path].filter(Boolean),
          licenseFiles: component.licenseFiles || [],
          source: component.source || '',
          environments: [executable],
        });
      }
    } catch (error) {
      errors.push(`Python inventory failed for ${executable}: ${String(error.stderr || error.message || error).split('\n')[0]}`);
    }
  }
  const merged = mergeComponents(components);
  const installed = new Set(merged.map((component) => component.name.toLowerCase()));
  for (const expected of pythonExpect) {
    if (!installed.has(expected)) {
      errors.push(
        `Python environment ${pythonExecutables.join(', ')} is missing required project dependency ${expected}; ` +
          'install the service requirements before running the license gate',
      );
    }
  }
  return { components: merged, errors };
}

// ---------- merge / policy ----------

function mergeComponents(components) {
  const merged = new Map();
  for (const component of components) {
    const key = `${component.ecosystem}:${component.name}@${component.version}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...component,
        paths: new Set(component.paths || []),
        licenseFiles: new Set(component.licenseFiles || []),
        workspaces: new Set(component.workspaces || []),
        environments: new Set(component.environments || []),
      });
      continue;
    }
    if (component.license && component.license !== 'UNKNOWN' && existing.license === 'UNKNOWN') {
      existing.license = component.license;
    }
    existing.runtime ||= component.runtime;
    existing.firstParty ||= component.firstParty;
    existing.source ||= component.source;
    existing.checksum ||= component.checksum;
    for (const item of component.paths || []) existing.paths.add(item);
    for (const item of component.licenseFiles || []) existing.licenseFiles.add(item);
    for (const item of component.workspaces || []) existing.workspaces.add(item);
    for (const item of component.environments || []) existing.environments.add(item);
  }
  return [...merged.values()].map((component) => ({
    ...component,
    paths: [...component.paths].sort(),
    licenseFiles: [...component.licenseFiles].sort(),
    workspaces: [...component.workspaces].sort(),
    environments: [...component.environments].sort(),
  }));
}

function validateComponents(components) {
  const errors = [];
  const exceptions = [];
  for (const component of components) {
    if (component.firstParty) continue;
    const key = `${component.name}@${component.version}`;
    if (allow.has(key) || allow.has(component.name)) continue;
    const license = normalizeLicense(component.license);
    if (!license || license === 'UNKNOWN') {
      errors.push(`${component.ecosystem} ${key}: missing/UNKNOWN license expression`);
      continue;
    }
    if (acceptableExpression(license)) continue;
    const exception = REVIEWED_EXCEPTIONS.get(component.name);
    if (exception) {
      exceptions.push(`${component.ecosystem} ${key}: ${license} — ${exception}`);
      continue;
    }
    errors.push(`${component.ecosystem} ${key}: non-permissive license ${license}`);
  }
  return { errors, exceptions };
}

// ---------- images / provenance ----------

const IMAGE_DOCKERFILES = [
  'apps/gateway/Dockerfile',
  'apps/iam-service/Dockerfile',
  'apps/workflow-service/Dockerfile',
  'apps/ai-service/Dockerfile',
  'apps/lds-service/Dockerfile',
  'apps/base-service/Dockerfile',
  'apps/faststore-service/Dockerfile',
  'apps/queue-service/Dockerfile',
  'apps/stream-service/Dockerfile',
  'apps/warehouse-service/Dockerfile',
  'apps/lakehouse-service/Dockerfile',
  'apps/inference-service/Dockerfile',
  'apps/ocs-service/Dockerfile',
  'apps/notifications-service/Dockerfile',
  'apps/console/Dockerfile',
  'apps/workflow-runner/Dockerfile',
  'infra/postgres/Dockerfile',
  'infra/prod/Dockerfile',
  'infra/pgbouncer/Dockerfile',
];

function releaseImages() {
  return readJson(path.join(__dirname, 'release-images.json')) || [];
}

function validateImageMaterial(images) {
  const errors = [];
  const listed = new Set(images.map((image) => image.dockerfile));
  for (const dockerfile of IMAGE_DOCKERFILES) {
    if (!listed.has(dockerfile)) errors.push(`${dockerfile}: not listed in tools/release-images.json`);
  }
  for (const image of images) {
    const file = path.join(ROOT, image.dockerfile);
    if (!fs.existsSync(file)) {
      errors.push(`${image.dockerfile}: missing Dockerfile`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (!/usr\/share\/licenses\/synapseone/.test(text)) {
      errors.push(`${image.dockerfile}: no /usr/share/licenses/synapseone notice bundle`);
    }
    if (!/COPY\s+LICENSE\s+NOTICE\s+THIRD-PARTY\.md/.test(text)) {
      errors.push(`${image.dockerfile}: does not copy root LICENSE/NOTICE/THIRD-PARTY.md`);
    }
    if (!/COPY\s+licenses\s/.test(text)) {
      errors.push(`${image.dockerfile}: does not copy the licenses/ bundle`);
    }
    if (!/org\.opencontainers\.image\.source/.test(text)) {
      errors.push(`${image.dockerfile}: missing org.opencontainers.image.source label`);
    }
    if (!/org\.opencontainers\.image\.revision/.test(text)) {
      errors.push(`${image.dockerfile}: missing org.opencontainers.image.revision label`);
    }
  }
  return errors;
}

// ---------- output ----------

function sourceCommit() {
  if (process.env.SOURCE_COMMIT) return process.env.SOURCE_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'UNSET';
  }
}

function formatLicense(component) {
  return normalizeLicense(component.license);
}

function displayPath(file) {
  if (!file) return '';
  const normalized = String(file).replace(/\\/g, '/');
  if (normalized.startsWith(`${ROOT}/`)) return normalized.slice(ROOT.length + 1);
  if (normalized.startsWith('/repo/')) return normalized.slice('/repo/'.length);
  if (normalized.includes('/site-packages/')) return `site-packages/${normalized.split('/site-packages/').pop()}`;
  if (normalized.includes('/.cargo/registry/')) return `~/.cargo/registry/${normalized.split('/.cargo/registry/').pop()}`;
  if (normalized.includes('/cargo/registry/')) return `~/.cargo/registry/${normalized.split('/cargo/registry/').pop()}`;
  if (!normalized.startsWith('/')) return normalized;
  return path.basename(normalized);
}

function cyclonedx(components, images, commit) {
  const projectVersion = readJson(path.join(ROOT, 'package.json'))?.version || '0.0.0';
  const dependencyComponents = components.map((component) => {
    const license = formatLicense(component);
    const purlName = encodeURIComponent(component.name);
    const namespace = component.ecosystem === 'npm' && component.name.startsWith('@')
      ? `pkg:npm/${purlName}@${component.version}`
      : `pkg:${component.ecosystem}/${purlName}@${component.version}`;
    return {
      type: 'library',
      'bom-ref': `${component.ecosystem}:${component.name}@${component.version}`,
      name: component.name,
      version: component.version,
      purl: namespace,
      licenses: license && license !== 'UNKNOWN' ? [{ expression: license }] : [],
      externalReferences: component.source && /^https?:/.test(component.source)
        ? [{ type: 'distribution', url: component.source }]
        : [],
      properties: [
        { name: 'synapseone:ecosystem', value: component.ecosystem },
        { name: 'synapseone:scope', value: component.runtime ? 'runtime' : 'development' },
        { name: 'synapseone:first-party', value: String(Boolean(component.firstParty)) },
        { name: 'synapseone:workspaces', value: (component.workspaces || []).join(',') },
        { name: 'synapseone:paths', value: (component.paths || []).slice(0, 10).join(',') },
        { name: 'synapseone:license-files', value: (component.licenseFiles || []).map((file) => path.basename(file)).join(',') },
        ...(component.checksum ? [{ name: 'synapseone:cargo-checksum', value: component.checksum }] : []),
      ],
    };
  });
  const imageComponents = images.map((image) => ({
    type: 'container',
    'bom-ref': `container:${image.name}`,
    name: `synapseone-${image.name}`,
    version: projectVersion,
    properties: [
      { name: 'synapseone:dockerfile', value: image.dockerfile },
      { name: 'synapseone:build-context', value: image.context || '.' },
      { name: 'synapseone:base-image', value: image.baseImage || 'unknown' },
      { name: 'synapseone:published', value: String(image.published !== false) },
      { name: 'synapseone:source-commit', value: commit },
      { name: 'synapseone:license-bundle', value: '/usr/share/licenses/synapseone' },
    ],
    externalReferences: [
      { type: 'build-system', url: `https://github.com/vku-open-source-2026/SynapseOne/blob/${commit}/${image.dockerfile}` },
    ],
  }));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: 'application', name: 'synapseone-license-check', version: '2' }] },
      component: {
        type: 'application',
        'bom-ref': 'synapseone',
        name: 'synapseone',
        version: projectVersion,
        licenses: [{ expression: 'Apache-2.0' }],
        externalReferences: [{ type: 'vcs', url: 'https://github.com/vku-open-source-2026/SynapseOne' }],
      },
      properties: [{ name: 'synapseone:source-commit', value: commit }],
    },
    components: [...dependencyComponents, ...imageComponents],
  };
}

function noticesText(components, commit) {
  const sections = [
    'SynapseOne complete dependency notice inventory',
    `Source commit: ${commit}`,
    'Generated from installed npm, Cargo and Python dependency metadata.',
    'Upstream license texts are unmodified. See THIRD-PARTY-NOTICES.txt for reviewed exceptions.',
  ];
  const seen = new Set();
  for (const component of components) {
    const header = [
      '',
      '='.repeat(78),
      `${component.ecosystem} ${component.name}@${component.version}`,
      `License expression: ${formatLicense(component)}`,
      `Scope: ${component.runtime ? 'runtime/production' : 'development-only'}`,
      `First-party: ${Boolean(component.firstParty)}`,
      `Workspaces: ${(component.workspaces || []).join(', ') || '-'}`,
      `Source: ${component.source || '-'}`,
    ].join('\n');
    const files = (component.licenseFiles || []).filter((file) => fs.existsSync(file));
    if (files.length === 0) {
      sections.push(`${header}\n[No separate license file retained in the installed package; see the registry expression and source URL.]`);
      continue;
    }
    for (const file of files) {
      let text = '';
      try {
        // Keep upstream wording intact but normalize insignificant trailing
        // whitespace so the generated bundle is clean in `git diff --check`.
        text = fs
          .readFileSync(file, 'utf8')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .split('\n')
          .map((line) => line.replace(/[ \t]+$/g, ''))
          .join('\n');
      } catch {
        continue;
      }
      const digest = createHash('sha256').update(text).digest('hex');
      if (seen.has(digest)) {
        sections.push(`${header}\nLicense file: ${path.basename(file)} (same text as an earlier component)`);
        continue;
      }
      seen.add(digest);
      sections.push(`${header}\nLicense file: ${path.basename(file)}\n\n${text}`);
    }
  }
  return `${sections.join('\n').replace(/\n+$/g, '')}\n`;
}

function writeFile(file, content) {
  const absolute = path.resolve(ROOT, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  console.log(`license-check: wrote ${path.relative(ROOT, absolute)}`);
}

function main() {
  const npm = scanNpm();
  const cargo = scanCargo();
  const python = scanPython();
  const components = mergeComponents([...npm, ...cargo.components, ...python.components]);
  const errors = [...cargo.errors, ...python.errors];
  if (npm.length === 0) {
    errors.push('npm workspace tree is empty; run `npm ci --workspaces` before the license gate');
  }
  if (cargo.components.length === 0) {
    errors.push('Cargo inventory is empty; run cargo metadata or provide third-party/cargo-inventory.json');
  }
  const policy = validateComponents(components);
  errors.push(...policy.errors);

  const images = releaseImages();
  errors.push(...validateImageMaterial(images));

  const commit = sourceCommit();
  const sbom = cyclonedx(components, images, commit);
  const inventory = {
    generatedAt: new Date().toISOString(),
    sourceCommit: commit,
    summary: {
      components: components.length,
      runtime: components.filter((component) => component.runtime).length,
      development: components.filter((component) => !component.runtime).length,
      ecosystems: components.reduce((summary, component) => {
        summary[component.ecosystem] = (summary[component.ecosystem] || 0) + 1;
        return summary;
      }, {}),
      images: images.length,
    },
    images,
    components: components.map((component) => ({
      ...component,
      paths: (component.paths || []).map(displayPath),
      licenseFiles: (component.licenseFiles || []).map(displayPath),
    })),
  };

  if (sbomOut) writeFile(sbomOut, `${JSON.stringify(sbom, null, 2)}\n`);
  if (inventoryOut) writeFile(inventoryOut, `${JSON.stringify(inventory, null, 2)}\n`);
  if (noticesOut) writeFile(noticesOut, noticesText(components, commit));

  const required = [
    'LICENSE',
    'NOTICE',
    'THIRD-PARTY.md',
    'licenses/SOURCE-OFFER.md',
    'licenses/THIRD-PARTY-NOTICES.txt',
    'licenses/MPL-2.0.txt',
  ];
  if (bundleDir) required.push(path.relative(ROOT, path.resolve(ROOT, bundleDir, 'sbom', 'synapseone.cdx.json')));
  for (const file of required) {
    if (!fs.existsSync(path.join(ROOT, file))) errors.push(`missing required distribution material: ${file}`);
  }

  const summary = inventory.summary;
  console.log(
    `license-check: ${summary.components} unique packages ` +
      `(${summary.runtime} runtime, ${summary.development} development; ` +
      `${Object.entries(summary.ecosystems).map(([name, count]) => `${name} ${count}`).join(', ')}); ` +
      `${summary.images} first-party images`,
  );
  for (const exception of policy.exceptions) console.log(`license-check: reviewed exception: ${exception}`);
  if (errors.length) {
    console.error('license-check: FAILED (fail-closed policy)');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('license-check: OK (permissive-only; notices and provenance complete)');
}

main();
