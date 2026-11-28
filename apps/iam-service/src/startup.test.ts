// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * IAM production startup must never listen after a failed schema migration or
 * fail-open MFA configuration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const appScript = `require(${JSON.stringify(path.join(__dirname, 'index.js'))}).createApp(); process.stdout.write('app-created');`;
const productionEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/synapseone',
  SYNAPSEONE_INTERNAL_SECRET: 'iam-startup-test-secret',
  IAM_JWT_SECRET: 'iam-startup-test-jwt-secret-at-least-32-characters',
  IAM_ALLOW_DEV_LOGIN: 'false',
  IAM_ALLOW_OIDC_DEMO_CALLBACK: 'false',
  IAM_SENSITIVE_MUTATION_MODE: 'enforce',
  PLATFORM_ADMIN_ENABLED: 'true',
  PLATFORM_ADMIN_REQUIRE_MFA: 'true',
  PLATFORM_ADMIN_REQUIRE_STEP_UP: 'true',
  SYNAPSEONE_MFA_ENABLED: 'true',
  OIDC_ISSUER: 'https://auth.example.com/',
  OIDC_CLIENT_ID: 'startup-test-client',
  OIDC_CLIENT_SECRET: 'startup-test-secret',
  OIDC_REDIRECT_URI: 'https://app.example.com/oidc/callback',
};

async function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout stderr=${stderr}`)); }, 20000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  return { code, stdout, stderr };
}

describe('iam production startup', () => {
  it('exits non-zero before listening when migrations fail', async () => {
    const { code, stdout, stderr } = await runNode([path.join(__dirname, 'index.js')], {
      ...productionEnv,
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/synapseone?connect_timeout=1',
      PLATFORM_ADMIN_ENABLED: 'false',
      PORT: '0',
    });
    assert.equal(code, 1, stderr);
    assert.equal(stdout.includes('listening'), false);
  });

  it('allows false platform MFA flags with one deployment-wide warning when global MFA is disabled', async () => {
    const { code, stdout, stderr } = await runNode(['-e', appScript], {
      ...productionEnv,
      PLATFORM_ADMIN_REQUIRE_MFA: 'false',
      PLATFORM_ADMIN_REQUIRE_STEP_UP: 'false',
      SYNAPSEONE_MFA_ENABLED: 'false',
    });
    assert.equal(code, 0, stderr);
    assert.equal(stdout.includes('app-created'), true);
    const warning = '[iam][security] SYNAPSEONE_MFA_ENABLED=false: local MFA and platform step-up are disabled deployment-wide.';
    assert.equal(stderr.split(warning).length - 1, 1, stderr);
  });

  it('still aborts production boot for either false platform MFA flag when global MFA is enabled', async () => {
    for (const flag of ['PLATFORM_ADMIN_REQUIRE_MFA', 'PLATFORM_ADMIN_REQUIRE_STEP_UP'] as const) {
      const { code, stdout, stderr } = await runNode(['-e', appScript], {
        ...productionEnv,
        [flag]: 'false',
      });
      assert.equal(code, 1, `${flag}: ${stderr}`);
      assert.match(stderr, new RegExp(`${flag} must be true`));
      assert.equal(stdout.includes('app-created'), false);
      assert.equal(stderr.includes('SYNAPSEONE_MFA_ENABLED=false'), false);
    }
  });
});
