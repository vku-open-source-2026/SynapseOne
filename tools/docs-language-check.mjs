#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Validate reciprocal language links, local Markdown targets and feature coverage. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative as relativePath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const english = [
  'README.md', 'api.md', 'platform-superadmin.md', 'configuration.md',
  'database-performance.md', 'agents/services.md', 'org-quota-api-key-ui.md',
];
let failed = false;
const fail = (message) => { failed = true; console.error(`docs-language-check: ${message}`); };

function localLinks(file, text) {
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|tel:|#)/i.test(target)) continue;
    const path = target.split('#')[0];
    if (!path) continue;
    const resolved = resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(resolved)) fail(`${file}: broken local link ${target}`);
    else if (!statSync(resolved).isFile() && !statSync(resolved).isDirectory()) fail(`${file}: invalid link target ${target}`);
  }
}

for (const relative of english) {
  const enPath = join(root, 'docs', relative);
  const viPath = join(root, 'docs', 'vi', relative);
  if (!existsSync(enPath) || !existsSync(viPath)) {
    fail(`missing pair docs/${relative} / docs/vi/${relative}`);
    continue;
  }
  const en = readFileSync(enPath, 'utf8');
  const vi = readFileSync(viPath, 'utf8');
  const enLink = relativePath(dirname(enPath), viPath);
  const viLink = relativePath(dirname(viPath), enPath);
  if (!en.includes(`[Tiếng Việt](${enLink})`)) fail(`docs/${relative}: missing Vietnamese switch link`);
  if (!vi.includes(`[English](${viLink})`)) fail(`docs/vi/${relative}: missing English switch link`);
  if (vi.length < 500) fail(`docs/vi/${relative}: translation is unexpectedly short`);
  localLinks(enPath, en);
  localLinks(viPath, vi);
}

const featureEn = readFileSync(join(root, 'docs', 'org-quota-api-key-ui.md'), 'utf8');
const featureVi = readFileSync(join(root, 'docs', 'vi', 'org-quota-api-key-ui.md'), 'utf8');
for (const term of ['requestsPer5h', 'UTC', 'Valkey', 'Retry-After', 'rollback', 'metadata', '/quotas', '0017', '0018', '0019', '0020', 'MCP', 'not rerunnable', '/internal/workflow/execution/check', 'hackathon_registrations', 'successor']) {
  if (!featureEn.toLowerCase().includes(term.toLowerCase())) fail(`English feature guide missing ${term}`);
}
for (const term of ['Requests/5h', 'UTC-day', 'Valkey', 'Retry-After', 'rollback', 'metadata', '/quotas', '0017', '0018', '0019', '0020', 'MCP', 'không thể chạy lại', '/internal/workflow/execution/check', 'hackathon_registrations', 'key kế nhiệm', 'dùng chung']) {
  if (!featureVi.toLowerCase().includes(term.toLowerCase())) fail(`Vietnamese feature guide missing ${term}`);
}
localLinks(join(root, 'docs', 'org-quota-api-key-ui.md'), featureEn);
localLinks(join(root, 'docs', 'vi', 'org-quota-api-key-ui.md'), featureVi);

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const changelogViPath = join(root, 'docs', 'vi', 'CHANGELOG.md');
if (!existsSync(changelogViPath) || !changelog.includes('[Tiếng Việt](docs/vi/CHANGELOG.md)')) fail('changelog language pair missing');
else localLinks(changelogViPath, readFileSync(changelogViPath, 'utf8'));

if (failed) process.exit(1);
console.log('docs-language-check: OK (language pairs, feature coverage and local link targets)');
