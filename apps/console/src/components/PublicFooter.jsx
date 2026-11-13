// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n-context.js';
import { appDashboardUrl, isCanonicalAppHost } from '../lib/site.js';

const REPO = 'https://github.com/vku-open-source-2026/SynapseOne';
// py-1 gives each link a finger-sized tap area on phones without changing the look.
const linkClass = 'inline-block py-1 text-sm text-s1-muted hover:text-s1-accent transition-colors';

function Column({ title, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-s1-fg">{title}</h3>
      <ul className="mt-2 space-y-0.5">
        {React.Children.map(children, (c) => (
          <li>{c}</li>
        ))}
      </ul>
    </div>
  );
}

function Ext({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
      {children}
    </a>
  );
}

/** Footer shared by the public pages (same columns as the other Synapse sites). */
export default function PublicFooter() {
  const { m } = useI18n();
  const f = m.footer;
  const l = f.links;
  return (
    <footer className="border-t border-s1-line bg-s1-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr]">
        <div>
          <Link
            to="/"
            className="text-xl font-semibold bg-gradient-to-b from-[#0A72C4] to-[#4FACFE] bg-clip-text text-transparent"
          >
            synapseone
          </Link>
          <p className="mt-2 text-sm text-s1-muted">{f.tagline}</p>
        </div>
        <Column title={f.product}>
          {isCanonicalAppHost() ? (
            <Link to="/dashboard" className={linkClass}>{l.console}</Link>
          ) : (
            <a href={appDashboardUrl()} className={linkClass}>{l.console}</a>
          )}
          <Link to="/api-docs" className={linkClass}>{l.apiDocs}</Link>
          <Link to="/docs" className={linkClass}>{l.docs}</Link>
          <Link to="/about" className={linkClass}>{l.about}</Link>
        </Column>
        <Column title={f.project}>
          <Ext href={REPO}>{l.repo}</Ext>
          <Ext href={`${REPO}/releases`}>{l.releases}</Ext>
          <Ext href={`${REPO}/blob/main/CHANGELOG.md`}>{l.changelog}</Ext>
          <Ext href="https://www.npmjs.com/package/@synapseone/sdk">{l.npm}</Ext>
          <Ext href="https://pypi.org/project/synapseone-sdk/">{l.pypi}</Ext>
        </Column>
        <Column title={f.support}>
          <Ext href={`${REPO}#readme`}>{l.build}</Ext>
          <Ext href={`${REPO}/issues`}>{l.issues}</Ext>
          <Ext href={`${REPO}/blob/main/CONTRIBUTING.md`}>{l.contributing}</Ext>
        </Column>
        <Column title={f.licenses}>
          <Ext href={`${REPO}/blob/main/LICENSE`}>{l.source}</Ext>
          <Ext href={`${REPO}/blob/main/THIRD-PARTY.md`}>{l.thirdParty}</Ext>
        </Column>
      </div>
      <div className="border-t border-s1-line">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-s1-muted">{f.bottom}</p>
      </div>
    </footer>
  );
}
