// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  Copy,
  Database,
  Layers,
  MonitorSmartphone,
  ServerCog,
  Plus,
  ShieldCheck,
  Siren,
} from 'lucide-react';
import { useI18n } from '../lib/i18n-context.js';

const H2 = 'text-2xl font-semibold tracking-tight text-balance';
const LEAD = 'mt-3 max-w-2xl leading-relaxed text-s1-muted';
const CHIP = 'inline-flex items-center rounded-md border border-s1-line bg-s1-bg px-2 py-0.5 font-mono text-[11px] text-s1-muted';
const TILE = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25';

/* ---------- H1: where a request goes ---------- */

// Chips mirror the running stack: docker-compose.yml services and backing stores.
const FLOW = [
  { icon: MonitorSmartphone, chips: ['JavaScript', 'Python', 'Go', 'CLI', 'Console'] },
  { icon: ShieldCheck, host: 'api.synapseone.space', chips: ['JWT', 'API key', 'rate limit', 'x-request-id'] },
  {
    icon: ServerCog,
    chips: ['IAM', 'SynapseFlow', 'SynapseBase', 'Faststore', 'SynapseQueue', 'SynapseStream', 'Synapse Warehouse', 'SynapseOCS', 'Notifications', 'SynapseLDS', 'Inference', 'AI'],
  },
  { icon: Database, chips: ['PostgreSQL', 'Redis', 'SeaweedFS (S3)'] },
];

export function RequestFlow() {
  const { m } = useI18n();
  const t = m.landing;
  return (
    <section className="mt-24">
      <h2 className={H2}>{t.flowTitle}</h2>
      <p className={LEAD}>{t.flowLead}</p>
      <ol className="mt-8 grid gap-3 md:grid-cols-2 md:gap-5 xl:grid-cols-4 xl:gap-10">
        {FLOW.map((step, i) => {
          const Icon = step.icon;
          const copy = t.flow[i];
          const gateway = i === 1;
          return (
            <li key={copy.title} className="relative min-w-0">
              <div
                className={`flex h-full flex-col rounded-2xl border bg-s1-surface p-5 ${
                  gateway ? 'border-sky-300 shadow-lg shadow-sky-500/10 dark:border-sky-700' : 'border-s1-line'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={TILE}>
                    <Icon className="h-5 w-5" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-mono text-[11px] text-s1-muted">{String(i + 1).padStart(2, '0')}</span>
                    <span className="block font-semibold leading-tight">{copy.title}</span>
                  </span>
                </div>
                {step.host && <p className="mt-3 truncate font-mono text-xs text-s1-accent">{step.host}</p>}
                <p className="mt-3 text-sm leading-relaxed text-s1-muted">{copy.text}</p>
                <ul className="mt-4 flex flex-wrap gap-1.5 pt-1">
                  {step.chips.map((c) => (
                    <li key={c} className={CHIP}>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
              {i < FLOW.length - 1 && (
                <>
                  {/* Arrow to the next step: below on phones, in the gap from 1280px; the 2-column tablet grid relies on the step numbers. */}
                  <span className="flex justify-center py-1 text-s1-muted md:hidden" aria-hidden="true">
                    <ArrowDown className="h-4 w-4" />
                  </span>
                  <span
                    className="absolute -right-8 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-s1-line bg-s1-surface text-s1-accent xl:flex"
                    aria-hidden="true"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ---------- H2: one task, five clients ---------- */

// Same calls as the SDK guides in /docs, pointed at the public gateway.
const SNIPPETS = [
  {
    id: 'js',
    label: 'JavaScript',
    pkg: 'npm i @synapseone/sdk',
    code: `import { SynapseOneClient } from '@synapseone/sdk';

const c = new SynapseOneClient({ baseUrl: 'https://api.synapseone.space' });
const { accessToken } = await c.iam.login('demo@acme.local', 'acme');
c.setToken(accessToken);

await c.base.createDocument('parks', {
  id: 'park-1',
  object: { name: 'Central', capacity: 120 },
});`,
  },
  {
    id: 'py',
    label: 'Python',
    pkg: 'pip install synapseone-sdk',
    code: `from synapseone_sdk import SynapseOneClient

c = SynapseOneClient("https://api.synapseone.space")
login = c.iam.login("demo@acme.local", "acme")
c.set_token(login["accessToken"])

c.base.create_document(
    "parks",
    object={"name": "Central", "capacity": 120},
    id="park-1",
)`,
  },
  {
    id: 'go',
    label: 'Go',
    pkg: 'go get github.com/synapseone/synapseone-sdk-go',
    code: `c := synapseone.New("https://api.synapseone.space")

login, err := c.Login("demo@acme.local", "acme")
if err != nil { log.Fatal(err) }
c.SetToken(login["accessToken"].(string))

_, err = c.CreateBaseDocument("parks", synapseone.BaseDocumentInput{
    ID:     "park-1",
    Object: map[string]any{"name": "Central", "capacity": 120},
})`,
  },
  {
    id: 'cli',
    label: 'CLI',
    pkg: 'npx -y @synapseone/cli@latest --help',
    code: `export SYNAPSEONE_BASE_URL=https://api.synapseone.space

synapseone login --email demo@acme.local --org acme
synapseone base documents insert parks --id park-1 \\
  --data '{"name":"Central","capacity":120}'`,
  },
  {
    id: 'curl',
    label: 'cURL',
    pkg: 'curl + jq',
    code: `TOKEN=$(curl -s -XPOST https://api.synapseone.space/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)

curl -s -XPOST https://api.synapseone.space/v1/base/collections/parks/documents \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"park-1","object":{"name":"Central","capacity":120}}'`,
  },
];

export function ClientTabs() {
  const { m, lang } = useI18n();
  const t = m.landing;
  const [active, setActive] = useState('js');
  const [copied, setCopied] = useState(false);
  const snip = SNIPPETS.find((s) => s.id === active);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snip.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the text stays selectable */
    }
  };
  return (
    <section className="mt-24 grid gap-8 lg:grid-cols-[1fr_1.5fr] lg:items-start lg:gap-12">
      <div className="min-w-0">
        <h2 className={H2}>{t.clientsTitle}</h2>
        <p className={LEAD}>{t.clientsLead}</p>
        <ul className="mt-6 divide-y divide-s1-line border-y border-s1-line">
          {SNIPPETS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setActive(s.id)}
                className={`flex w-full items-center gap-3 py-2.5 text-left text-sm transition ${
                  active === s.id ? 'text-s1-accent' : 'text-s1-fg hover:text-s1-accent'
                }`}
              >
                <span className="w-24 shrink-0 font-medium">{s.label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-s1-muted">{s.pkg}</span>
                {active === s.id && <ArrowRight className="h-4 w-4 shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
        <Link to="/docs?tab=javascript" className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-s1-accent hover:underline">
          {t.clientsDocs}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      <div className="min-w-0">
        <div className="overflow-hidden rounded-2xl border border-s1-line bg-s1-code shadow-sm">
          <div className="flex items-center gap-1 border-b border-white/10 px-2">
            <div role="tablist" aria-label={t.clientsTitle} className="s1-no-scrollbar flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
              {SNIPPETS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={active === s.id}
                  onClick={() => setActive(s.id)}
                  className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-medium transition ${
                    active === s.id ? 'border-sky-400 text-white' : 'border-transparent text-s1-code-muted hover:text-white'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={copy}
              aria-label={lang === 'vi' ? 'Sao chép' : 'Copy'}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-s1-code-muted transition hover:bg-white/10 hover:text-white"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{copied ? (lang === 'vi' ? 'Đã sao chép' : 'Copied') : lang === 'vi' ? 'Sao chép' : 'Copy'}</span>
            </button>
          </div>
          <pre role="tabpanel" className="min-h-[15rem] overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-s1-code-fg">
            {snip.code}
          </pre>
        </div>
        <p className="mt-3 text-sm text-s1-muted">{t.clientsNote}</p>
      </div>
    </section>
  );
}

/* ---------- H3: running on SynapseOne ---------- */

// Tier-3 apps on the public internet; each calls SynapseDX (see each repo README). Add new apps here.
const APPS = [
  { key: 'city', name: 'SynapseCity', icon: Building2, href: 'https://synapsecity.sbs' },
  { key: 'sos', name: 'SynapseCitySOS', icon: Siren, href: 'https://sos.synapsecity.sbs' },
];

// SDK namespaces SynapseDX calls (apps/capabilities-service), most used first.
const DX_USES = ['SynapseBase', 'IAM', 'Storage', 'Faststore', 'Notifications', 'SynapseLDS', 'SynapseFlow', 'SynapseOCS', 'SynapseStream', 'Inference'];

const LIFT =
  'transition duration-200 hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-lg hover:shadow-sky-500/10 dark:hover:border-sky-700';

function LayerLabel({ children }) {
  return <p className="mb-3 text-xs font-semibold text-s1-muted">{children}</p>;
}

/** Vertical link between two tiers, naming the package that carries the calls. */
function Connector({ pkg }) {
  return (
    <div className="flex flex-col items-center py-2" aria-hidden="true">
      <span className="h-4 w-px bg-s1-line" />
      <span className="rounded-full border border-s1-line bg-s1-surface px-3 py-1 font-mono text-[11px] text-s1-muted">{pkg}</span>
      <span className="h-3 w-px bg-s1-line" />
      <ArrowDown className="-mt-1 h-3.5 w-3.5 text-s1-muted" />
    </div>
  );
}

export function BuiltOn() {
  const { m } = useI18n();
  const t = m.landing;
  const b = t.built;
  return (
    <section className="mt-24">
      <h2 className={H2}>{t.builtTitle}</h2>
      <p className={LEAD}>{t.builtLead}</p>

      <div className="mt-8">
        {/* Tier 3: grows as more apps go live. */}
        <LayerLabel>{t.layers.apps}</LayerLabel>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {APPS.map((app) => {
            const Icon = app.icon;
            return (
              <li key={app.key} className="min-w-0">
                <a
                  href={app.href}
                  target="_blank"
                  rel="noreferrer"
                  className={`group flex h-full flex-col rounded-2xl border border-s1-line bg-s1-surface p-5 ${LIFT}`}
                >
                  <span className="flex items-center gap-3">
                    <span className={TILE}>
                      <Icon className="h-5 w-5" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{app.name}</span>
                      <span className="block truncate font-mono text-xs text-s1-muted">{app.href.replace('https://', '')}</span>
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-s1-muted transition group-hover:text-s1-accent" aria-label={t.visit} />
                  </span>
                  <span className="mt-3 text-sm leading-relaxed text-s1-muted">{b[app.key].text}</span>
                </a>
              </li>
            );
          })}
          <li className="min-w-0">
            <Link
              to="/docs?tab=javascript"
              className="group flex h-full flex-col rounded-2xl border border-dashed border-s1-line p-5 transition hover:border-s1-accent"
            >
              <span className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-s1-line text-s1-muted transition group-hover:border-s1-accent group-hover:text-s1-accent">
                  <Plus className="h-5 w-5" />
                </span>
                <span className="font-semibold">{b.yours.name}</span>
              </span>
              <span className="mt-3 text-sm leading-relaxed text-s1-muted">{b.yours.text}</span>
            </Link>
          </li>
        </ul>

        <Connector pkg="@synapsedx/capabilities" />

        {/* Tier 2 */}
        <LayerLabel>{t.layers.shared}</LayerLabel>
        <a
          href="https://synapsedx.sbs"
          target="_blank"
          rel="noreferrer"
          className={`group grid gap-5 rounded-2xl border border-s1-line bg-s1-surface p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center ${LIFT}`}
        >
          <span className="min-w-0">
            <span className="flex items-center gap-3">
              <span className={TILE}>
                <Layers className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">SynapseDX</span>
                <span className="block font-mono text-xs text-s1-muted">synapsedx.sbs</span>
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-s1-muted transition group-hover:text-s1-accent" aria-label={t.visit} />
            </span>
            <span className="mt-3 block text-sm leading-relaxed text-s1-muted">{b.dx.text}</span>
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-medium text-s1-fg">{t.usesLabel}</span>
            <span className="mt-2 flex flex-wrap gap-1.5">
              {DX_USES.map((u) => (
                <span key={u} className={CHIP}>
                  {u}
                </span>
              ))}
            </span>
          </span>
        </a>

        <Connector pkg="@synapseone/sdk" />

        {/* Tier 1: this platform. */}
        <LayerLabel>{t.layers.platform}</LayerLabel>
        <div className="flex flex-col gap-3 rounded-2xl border border-sky-300 bg-s1-accent-soft p-5 sm:flex-row sm:items-center dark:border-sky-700">
          <span className="flex items-center gap-3">
            <span className={TILE}>
              <ServerCog className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <span>
              <span className="flex items-center gap-2">
                <span className="font-semibold">SynapseOne</span>
                <span className="rounded-full bg-s1-surface px-2 py-0.5 text-[11px] font-medium text-s1-accent">{b.one.here}</span>
              </span>
              <span className="block font-mono text-xs text-s1-muted">api.synapseone.space</span>
            </span>
          </span>
          <span className="text-sm leading-relaxed text-s1-muted sm:ml-auto sm:max-w-md sm:text-right">{b.one.text}</span>
        </div>
      </div>
    </section>
  );
}
