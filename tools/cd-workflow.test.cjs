// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cd = fs.readFileSync(path.join(root, '.github/workflows/cd.yml'), 'utf8');

test('main-channel image publishing keeps the repository root as Docker context', () => {
  assert.ok(
    cd.includes('-f "$CTX/Dockerfile" \\'),
    'publish must select the service Dockerfile explicitly',
  );
  assert.ok(
    cd.includes('-t "ghcr.io/$OWNER/synapseone-$SVC:main-$SHA" .'),
    'publish must build from the repository root',
  );
  assert.ok(
    !cd.includes('main-$SHA" "$CTX"'),
    'a service directory is not a valid context for repo-root Dockerfiles',
  );
});

test('published service Dockerfiles require repo-root sources and license files', () => {
  for (const [service, directory] of [
    ['gateway', 'apps/gateway'],
    ['iam', 'apps/iam-service'],
    ['workflow', 'apps/workflow-service'],
    ['console', 'apps/console'],
  ]) {
    const dockerfile = fs.readFileSync(path.join(root, directory, 'Dockerfile'), 'utf8');
    assert.ok(dockerfile.includes(`COPY ${directory}/`), `${service} must copy from its repo-root path`);
    assert.ok(dockerfile.includes('COPY LICENSE NOTICE THIRD-PARTY.md'), `${service} must copy root license files`);
  }
});
