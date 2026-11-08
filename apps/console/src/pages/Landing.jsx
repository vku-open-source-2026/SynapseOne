// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Bot, KeyRound, Layers, ShieldCheck, WandSparkles, Zap } from 'lucide-react';
import PublicHeader from '../components/PublicHeader.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import FeatureGrid from '../components/FeatureGrid.jsx';
import { BuiltOn, ClientTabs, RequestFlow } from '../components/HomeSections.jsx';
import Terminal from '../components/Terminal.jsx';
import { PRIMARY_BTN, SECONDARY_BTN } from '../components/public-styles.js';
import { appDashboardUrl, isCanonicalAppHost } from '../lib/site.js';
import { useI18n } from '../lib/i18n-context.js';

// Icons in the same order as `landing.features` in src/locales.
const FEATURE_ICONS = [ShieldCheck, KeyRound, Zap, Layers, Bot, WandSparkles];

export default function Landing() {
  const { m } = useI18n();
  const t = m.landing;
  // Web chinh (@): nut Mo Console tro ve canonical app (cloud.*) theo env.
  const offSite = !isCanonicalAppHost();
  const openConsoleHref = appDashboardUrl();
  return (
    <div className="min-h-screen bg-s1-bg text-s1-fg">
      <PublicHeader />

      <main className="mx-auto max-w-6xl px-4 pt-28 sm:pt-32 pb-20">
        {/* Hero: claim and actions on the left; from 1024px the CLI install sits beside it as the first thing to try. */}
        <section className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <div className="min-w-0">
            <p className="font-mono text-xs text-s1-muted">Apache-2.0 · api.synapseone.space</p>
            <h1 className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">
              {t.titleBefore} <span className="text-s1-accent">{t.titleHighlight}</span> {t.titleAfter}
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-s1-muted">{t.lead}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {offSite ? (
                <a href={openConsoleHref} className={PRIMARY_BTN}>
                  {t.openConsole}
                </a>
              ) : (
                <Link to="/login" className={PRIMARY_BTN}>
                  {t.openConsole}
                </Link>
              )}
              <Link to="/api-docs" className={SECONDARY_BTN}>
                {t.exploreApi}
              </Link>
            </div>
          </div>

          <div className="min-w-0">
            <Terminal
              title={t.cliTitle}
              code={`curl -fsSL https://synapseone.space/install.sh | sh\n${t.cliComment}\nnpx -y @synapseone/cli@latest --help`}
            />
            <p className="mt-3 text-sm text-s1-muted">{t.cliText}</p>
          </div>
        </section>

        <section className="mt-24">
          <h2 className="text-2xl font-semibold tracking-tight">{t.featuresHeading}</h2>
          <FeatureGrid items={t.features} icons={FEATURE_ICONS} />
        </section>

        <RequestFlow />
        <ClientTabs />
        <BuiltOn />

        <section className="mt-24 grid gap-8 lg:grid-cols-[1fr_1.6fr] lg:items-center">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-tight text-balance">{t.selfHostTitle}</h2>
            <p className="mt-3 font-mono text-sm text-s1-muted">docker compose up -d --build</p>
          </div>
          <div className="min-w-0">
            <Terminal
              title="~/SynapseOne"
              code={`cp .env.example .env   ${t.selfHostEnv}\ndocker compose up -d --build\nopen http://localhost:3000   ${t.selfHostLogin}`}
            />
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
