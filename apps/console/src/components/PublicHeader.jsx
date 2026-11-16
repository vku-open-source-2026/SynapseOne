// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LogIn, Menu, X } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { appDashboardUrl, appLoginUrl, isCanonicalAppHost } from '../lib/site.js';
import { useI18n } from '../lib/i18n-context.js';
import SiteToggles from './SiteToggles.jsx';
import StableLabel from './StableLabel.jsx';
import BrandSymbol from './BrandSymbol.jsx';

export default function PublicHeader() {
  const [open, setOpen] = useState(false);
  const { auth } = useAuth();
  const { m } = useI18n();
  const LINKS = [
    { to: '/', pick: (d) => d.nav.home },
    { to: '/api-docs', pick: (d) => d.nav.apiDocs },
    { to: '/docs', pick: (d) => d.nav.docs },
    { to: '/about', pick: (d) => d.nav.about },
  ];
  // Multi-domain: web chinh (@) redirect Dang nhap/Console ve canonical app (cloud.*) theo env.
  const offSite = !isCanonicalAppHost();
  const authHref = auth ? appDashboardUrl() : appLoginUrl();
  // Desktop labels reserve the width of the longest translation (StableLabel) so a language switch never shifts the buttons.
  const pickAuth = (d) => (auth ? d.nav.console : d.nav.signIn);
  const authMobileLabel = auth ? m.nav.openConsole : m.nav.signIn;
  return (
    <header className="fixed z-50 top-0 left-0 w-full border-b border-s1-line bg-s1-surface">
      <div className="flex items-center justify-between px-4 mx-auto max-w-6xl h-16">
        <Link
          to="/"
          className="flex items-center gap-2 text-xl font-semibold text-s1-fg"
        >
          <BrandSymbol className="h-8 w-8 shrink-0" />
          <span className="bg-gradient-to-b from-[#0A72C4] to-[#4FACFE] bg-clip-text text-transparent">synapseone</span>
        </Link>
        <nav className="hidden md:flex items-center gap-1 text-sm">
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="rounded-lg px-3 py-1.5 text-s1-muted transition hover:text-s1-fg">
              <StableLabel pick={l.pick} />
            </Link>
          ))}
          <SiteToggles className="ml-1" />
          {offSite ? (
            <a
              href={authHref}
              className="ml-2 inline-flex items-center whitespace-nowrap rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-1.5 font-semibold text-white transition hover:brightness-110"
            >
              <LogIn className="mr-1.5 inline h-4 w-4 align-[-3px]" />
              <StableLabel pick={pickAuth} />
            </a>
          ) : (
            <Link
              to={auth ? '/dashboard' : '/login'}
              className="ml-2 inline-flex items-center whitespace-nowrap rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-1.5 font-semibold text-white transition hover:brightness-110"
            >
              <LogIn className="mr-1.5 inline h-4 w-4 align-[-3px]" />
              <StableLabel pick={pickAuth} />
            </Link>
          )}
        </nav>
        <div className="md:hidden flex items-center gap-1">
          <SiteToggles />
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-label={open ? m.nav.closeMenu : m.nav.openMenu}
            aria-expanded={open}
            className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-s1-muted hover:text-s1-fg"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="md:hidden border-t border-s1-line bg-s1-surface px-4 py-2 shadow-md">
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} onClick={() => setOpen(false)} className="block py-2 text-sm text-s1-fg">
              {l.pick(m)}
            </Link>
          ))}
          {offSite ? (
            <a
              href={authHref}
              onClick={() => setOpen(false)}
              className="block py-2 text-sm font-semibold text-s1-accent"
            >
              {authMobileLabel}
            </a>
          ) : (
            <Link
              to={auth ? '/dashboard' : '/login'}
              onClick={() => setOpen(false)}
              className="block py-2 text-sm font-semibold text-s1-accent"
            >
              {authMobileLabel}
            </Link>
          )}
        </div>
      )}
    </header>
  );
}
