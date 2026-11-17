// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * IAM production startup must never listen after a failed schema migration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

describe('iam production startup', () => {
  it('exits non-zero before listening when migrations fail', async () => {
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/synapseone?connect_timeout=1',
        SYNAPSEONE_INTERNAL_SECRET: 'iam-startup-test-secret',
        IAM_ALLOW_DEV_LOGIN: 'false',
        IAM_ALLOW_OIDC_DEMO_CALLBACK: 'false',
        PLATFORM_ADMIN_ENABLED: 'false',
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout stderr=${stderr}`)); }, 20000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 1, stderr);
    assert.equal(stdout.includes('listening'), false);
  });
});
