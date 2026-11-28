// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// SSR smoke test: render every route's default state and every Docs tab in en/vi.
// Catches module-eval crashes, missing providers (useScope outside ScopeProvider),
// unbound identifiers on default branches, and broken imports — without jsdom.
// State-dependent branches (modals, suggestion panels) are covered by reviews;
// data fetching never runs under renderToString (effects don't fire server-side).
// Run: npm run test:ssr (bundles with esbuild, then executes).
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth.jsx';
import App from './App.jsx';
import Docs from './pages/Docs.jsx';
import SynapseDNS from './pages/SynapseDNS.jsx';
import SynapseTunnel from './pages/SynapseTunnel.jsx';
import { LanguageProvider } from './lib/i18n.jsx';
import WorkflowEditor from './components/WorkflowEditor.jsx';
import { OrganizationTable } from './pages/Orgs.jsx';
import { keyStatus as apiKeyStatus, quotaFieldSource, organizationDetailKey } from './pages/admin/OrganizationDetail.jsx';
import { DOC_TABS, SERVICE_CATALOG } from './lib/service-catalog.js';
import { MobileServiceLinks } from './components/Topbar.jsx';
import ServicesSidebar from './components/ServicesSidebar.jsx';
import TenantKeyScopePicker from './components/TenantKeyScopePicker.jsx';
import { en } from './locales/en.js';
import { vi } from './locales/vi.js';

const ROUTES = [
  '/',
  '/login',
  '/register',
  '/about',
  '/hackathon',
  '/oidc/callback',
  '/dashboard',
  '/orgs',
  '/accounts',
  '/users',
  '/roles',
  '/policies',
  '/keys',
  '/service-accounts',
  '/quotas',
  '/workflows',
  '/runner-engine',
  '/workflow-runners',
  '/base',
  '/search',
  '/warehouse',
  '/lakehouse',
  '/queue',
  '/stream',
  '/ocs',
  '/notifications',
  '/inference',
  '/faststore',
  '/lds',
  '/authorize',
  '/audit',
  '/security',
  '/dns',
  '/tunnel',
  '/api-docs',
  '/docs',
  '/nope-not-a-route',
  '/admin/overview',
  '/admin/orgs',
  '/admin/users',
  '/admin/health',
  '/admin/dns',
  '/admin/tunnel',
  '/admin/usage',
  '/admin/quotas',
  '/admin/audit',
  '/admin/access',
  '/admin/hackathon',
  '/admin/not-a-route',
];

const SESSIONS = {
  anon: null,
  key: { apiKey: 'synapseone_test' },
};

const LEGACY_EDGE_REDIRECTS = new Set(['/admin/dns', '/admin/tunnel']);

const GUARDED = new Set([
  '/dashboard',
  '/orgs',
  '/accounts',
  '/users',
  '/roles',
  '/policies',
  '/keys',
  '/service-accounts',
  '/quotas',
  '/workflows',
  '/runner-engine',
  '/workflow-runners',
  '/base',
  '/search',
  '/warehouse',
  '/lakehouse',
  '/queue',
  '/stream',
  '/ocs',
  '/notifications',
  '/inference',
  '/faststore',
  '/lds',
  '/authorize',
  '/audit',
  '/security',
  '/dns',
  '/tunnel',
  '/admin/overview',
  '/admin/orgs',
  '/admin/users',
  '/admin/health',
  '/admin/usage',
  '/admin/quotas',
  '/admin/audit',
  '/admin/access',
  '/admin/hackathon',
  '/admin/not-a-route',
]);

let failures = 0;
for (const [label, session] of Object.entries(SESSIONS)) {
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k === 'synapseone.console.auth' && session ? JSON.stringify(session) : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  // Silent the expected console.error from ErrorBoundary probes (none expected).
  for (const path of ROUTES) {
    try {
      const html = renderToString(
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      // Anonymous hits on guarded routes render <Navigate> (empty in SSR) —
      // the client performs the redirect. Same for /login with a live session.
      // Everything else must produce HTML.
      const expectHtml = !LEGACY_EDGE_REDIRECTS.has(path)
        && (session || !GUARDED.has(path))
        && !(session && path === '/login');
      if (expectHtml && (typeof html !== 'string' || html.length === 0)) throw new Error('empty render');
      console.log(`ok [${label}] ${path} (${html.length} chars)`);
    } catch (e: any) {
      failures++;
      console.error(`FAIL [${label}] ${path}: ${e?.message || e}`);
    }
  }
}

(globalThis as any).localStorage = {
  getItem: (k: string) => (k === 'synapseone.lang' ? 'en' : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
for (const [name, Page, path, docsTab] of [
  ['SynapseDNS', SynapseDNS, '/dns', 'dns'],
  ['Synapse Tunnel', SynapseTunnel, '/tunnel', 'tunnel'],
] as const) {
  try {
    const html = renderToString(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <LanguageProvider><Page /></LanguageProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    if (!html.includes(name)) throw new Error('missing page heading');
    if (!html.includes('Organization-scoped service')) throw new Error('missing organization-scoped service copy');
    if (html.includes('Platform Administrator')) throw new Error('platform-admin copy leaked into tenant page');
    if (!html.includes(`href="/docs?tab=${docsTab}"`)) throw new Error('missing Docs link');
    console.log(`ok [tenant-edge-page] ${name} (${html.length} chars)`);
  } catch (e: any) {
    failures++;
    console.error(`FAIL [edge-page] ${name}: ${e?.message || e}`);
  }
}

const SERVICE_IDS = new Set(SERVICE_CATALOG.map((service) => service.id));
for (const [lang, dict] of [['en', en], ['vi', vi]] as const) {
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k === 'synapseone.lang' ? lang : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  for (const { id } of DOC_TABS) {
    const path = `/docs?tab=${id}`;
    try {
      const html = renderToString(
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <LanguageProvider>
              <Docs />
            </LanguageProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
      if (typeof html !== 'string' || html.length === 0) throw new Error('empty render');
      if (SERVICE_IDS.has(id)) {
        const panels = (html.match(/data-sdk-panel=/g) || []).length;
        if (panels !== 4) throw new Error(`expected 4 SDK panels, received ${panels}`);
        for (const language of ['javascript', 'python', 'go', 'rust']) {
          if (!html.includes(`data-sdk-panel="${language}"`)) throw new Error(`missing ${language} SDK panel`);
        }
        const localizedHeading = lang === 'vi' ? 'Sử dụng SDK' : 'SDK usage';
        if (!html.includes(localizedHeading)) throw new Error(`missing ${lang} SDK heading`);
      }
      console.log(`ok [docs-${lang}] ${path} (${html.length} chars)`);
    } catch (e: any) {
      failures++;
      console.error(`FAIL [docs-${lang}] ${path}: ${e?.message || e}`);
    }
  }
}

for (const [lang, dict] of [['en', en], ['vi', vi]] as const) {
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k === 'synapseone.lang' ? lang : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  try {
    const html = renderToString(
      <MemoryRouter>
        <LanguageProvider>
          <MobileServiceLinks />
        </LanguageProvider>
      </MemoryRouter>,
    );
    const links = (html.match(/<a /g) || []).length;
    if (links !== SERVICE_CATALOG.length) throw new Error(`expected ${SERVICE_CATALOG.length} mobile service links, received ${links}`);
    for (const service of SERVICE_CATALOG) {
      if (!html.includes(`href="${service.consoleRoute}"`)) throw new Error(`missing mobile link ${service.id}`);
    }
    console.log(`ok [mobile-services-${lang}] ${links} links`);
    const sidebarHtml = renderToString(
      <MemoryRouter>
        <LanguageProvider>
          <ServicesSidebar open />
        </LanguageProvider>
      </MemoryRouter>,
    );
    if (!sidebarHtml.includes('href="/api-docs"') || !sidebarHtml.includes('API')) {
      throw new Error('services sidebar API link did not render');
    }
    console.log(`ok [services-sidebar-${lang}] API link renders`);
  } catch (e: any) {
    failures++;
    console.error(`FAIL [mobile-services-${lang}]: ${e?.message || e}`);
  }
}

try {
  const scopePickerHtml = renderToString(
    <TenantKeyScopePicker
      options={['*', 'base:read', 'base:write', 'workflow:Execute', 'platform:Admin']}
      selected={['base:read']}
      onChange={() => undefined}
    />,
  );
  if (!scopePickerHtml.includes('Select all') || !scopePickerHtml.includes('Clear')) {
    throw new Error('tenant scope picker bulk actions did not render');
  }
  if (!scopePickerHtml.includes('data-scope-option="base:read"')
    || !scopePickerHtml.includes('data-scope-option="workflow:Execute"')) {
    throw new Error('tenant scope picker options did not render');
  }
  if (scopePickerHtml.includes('data-scope-option="platform:Admin"')) {
    throw new Error('platform scope leaked into tenant scope picker');
  }
  console.log(`ok [tenant-scope-picker] ${scopePickerHtml.length} chars`);
} catch (e: any) {
  console.error(`FAIL [tenant-scope-picker]: ${e?.message || e}`);
  process.exit(1);
}

if (failures > 0) {
  console.error(`${failures} route(s) failed to render`);
  process.exit(1);
}

// Loaded organization rows exercise the Link branch that effects never reach
// during the normal route SSR smoke above.
try {
  const loadedHtml = renderToString(
    <MemoryRouter>
      <OrganizationTable
        orgs={[{ id: '00000000-0000-4000-8000-000000000001', slug: 'loaded-org', display_name: 'Loaded Org' }]}
        canAdmin={false}
        onRename={() => undefined}
      />
    </MemoryRouter>,
  );
  if (!loadedHtml.includes('loaded-org') || !loadedHtml.includes('href="/quotas"')) throw new Error('loaded organization row did not render quota link');
  console.log(`ok [loaded] organizations (${loadedHtml.length} chars)`);
} catch (e: any) {
  console.error(`FAIL [loaded] organizations: ${e?.message || e}`);
  process.exit(1);
}

if (apiKeyStatus({ expires_at: new Date(Date.now() - 1000).toISOString() }) !== 'expired') throw new Error('expired key status regression');
if (apiKeyStatus({ revoked_at: new Date().toISOString() }) !== 'revoked') throw new Error('revoked key status regression');
if (quotaFieldSource({ overridden: true, overrides: { requestsPerMin: true } }, 'requestsPerMin') !== 'override') throw new Error('override field source regression');
if (quotaFieldSource({ overridden: true, overrides: { requestsPerMin: true } }, 'requestsPer5h') !== 'default') throw new Error('inherited field source regression');
if (organizationDetailKey('org-a') === organizationDetailKey('org-b')) throw new Error('organization route remount key regression');
console.log('ok [loaded] key status, per-field quota source and organization remount key');

// Visual workflow editor (default visual tab, empty selection) — catches JSX
// crashes in the overlay/palette/canvas/inspector default branches.
try {
  const editorHtml = renderToString(
    <WorkflowEditor
      workflowId="w1"
      initial={{
        name: 'demo',
        nodes: [
          { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', position: [200, 300], parameters: { path: 'ev' } },
          { id: 'b', name: 'Log', type: 'n8n-nodes-base.noOp', position: [420, 300], parameters: {} },
        ],
        connections: { Webhook: { main: [[{ node: 'Log', type: 'main', index: 0 }]] } },
      }}
      headers={{}}
      onClose={() => undefined}
      onSaved={() => undefined}
    />,
  );
  if (editorHtml.length === 0) throw new Error('empty editor render');
  console.log(`ok [editor] visual default (${editorHtml.length} chars)`);
} catch (e: any) {
  console.error(`FAIL [editor]: ${e?.message || e}`);
  process.exit(1);
}
console.log('ssr smoke: all routes render');
