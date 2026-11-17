// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Production startup is fail-closed: migrations must complete before listen,
 * and credential-backed workflow features require their keys at boot.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

function runNode(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`)); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe('workflow production startup', () => {
  it('exits non-zero before listening when the migration fails', async () => {
    const out = await runNode([path.join(__dirname, 'index.js')], {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/synapseone?connect_timeout=1',
      SYNAPSEONE_INTERNAL_SECRET: 'startup-test-secret',
      SYNAPSEONE_CREDENTIAL_KEY: 'a'.repeat(64),
      SYNAPSEONE_IAM_API_KEY: 'startup-iam-key',
      WORKFLOW_EXECUTION_MODE: 'inline',
      PORT: '0',
    });
    assert.equal(out.code, 1, out.stderr);
    assert.equal(out.stdout.includes('listening'), false);
  });

  it('rejects missing production credential configuration in createApp', async () => {
    const out = await runNode(['-e', `
      const { createApp } = require(${JSON.stringify(path.join(__dirname, 'index.js'))});
      try { createApp(); console.log('constructed'); }
      catch (e) { console.error(String(e && e.message || e)); process.exit(2); }
    `], {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/synapseone?connect_timeout=1',
      SYNAPSEONE_INTERNAL_SECRET: 'startup-test-secret',
      SYNAPSEONE_IAM_API_KEY: 'startup-iam-key',
      WORKFLOW_EXECUTION_MODE: 'inline',
    });
    assert.equal(out.code, 2, out.stderr);
    assert.match(out.stderr, /SYNAPSEONE_CREDENTIAL_KEY/);
  });
});
