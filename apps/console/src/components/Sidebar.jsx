// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faHouse,
  faBuilding,
  faBoxes,
  faUsers,
  faUserShield,
  faScroll,
  faKey,
  faRobot,
  faListCheck,
  faFlask,
  faBook,
  faCode,
  faLock,
} from '@fortawesome/free-solid-svg-icons';
import { useI18n } from '../lib/i18n-context.js';
import BrandSymbol from './BrandSymbol.jsx';

const CORE_ITEMS = [
  { to: '/dashboard', key: 'dashboard', icon: faHouse, match: (p) => p.startsWith('/dashboard') },
  { to: '/orgs', key: 'orgs', icon: faBuilding, match: (p) => p.startsWith('/orgs') },
  { to: '/accounts', key: 'accounts', icon: faBoxes, match: (p) => p.startsWith('/accounts') },
  { to: '/users', key: 'users', icon: faUsers, match: (p) => p.startsWith('/users') },
  { to: '/roles', key: 'roles', icon: faUserShield, match: (p) => p.startsWith('/roles') },
  { to: '/policies', key: 'policies', icon: faScroll, match: (p) => p.startsWith('/policies') },
  { to: '/keys', key: 'keys', icon: faKey, match: (p) => p.startsWith('/keys') },
  { to: '/service-accounts', key: 'serviceAccounts', icon: faRobot, match: (p) => p.startsWith('/service-accounts') },
  { to: '/authorize', key: 'authorize', icon: faFlask, match: (p) => p.startsWith('/authorize') },
  { to: '/audit', key: 'audit', icon: faListCheck, match: (p) => p.startsWith('/audit') },
  { to: '/security', key: 'security', icon: faLock, match: (p) => p.startsWith('/security') },
];

const DOC_ITEMS = [
  { to: '/api-docs', key: 'apiDocs', icon: faCode, match: (p) => p.startsWith('/api-docs') },
  { to: '/docs', key: 'docs', icon: faBook, match: (p) => p.startsWith('/docs') },
];

export default function Sidebar() {
  const { pathname } = useLocation();
  const { m } = useI18n();
  return (
    <aside
      aria-label="Core Navigation"
      className="fixed left-3 xl:left-5 top-0 h-screen w-64 xl:w-72 hidden lg:flex flex-col items-center z-30"
    >
      <Link to="/" className="my-6 mt-8 ml-2 flex items-center gap-2">
        <BrandSymbol className="h-8 w-8 shrink-0" />
        <p className="whitespace-nowrap text-xl xl:text-2xl font-semibold bg-gradient-to-b from-[#0A72C4] to-[#4FACFE] bg-clip-text text-transparent">
          {m.console.title}
        </p>
      </Link>
      <nav className="w-full bg-white rounded-3xl py-4 px-3 flex flex-col text-normal-text shadow-md max-h-[82vh] overflow-y-auto s1-thin-scroll">
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {m.console.core}
        </div>
        {CORE_ITEMS.map((it) => {
          const active = it.match(pathname);
          return (
            <Link
              key={it.to}
              to={it.to}
              className={`flex items-center px-4 py-2 my-0.5 rounded-2xl text-sm transition-colors ${
                active ? 'text-main-blue bg-main-blue/10 font-medium' : 'hover:bg-background'
              }`}
            >
              <FontAwesomeIcon icon={it.icon} className="mr-3 w-4" />
              {m.console.nav[it.key]}
            </Link>
          );
        })}

        <div className="my-2 border-t border-slate-100" />

        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {m.console.docsSection}
        </div>
        {DOC_ITEMS.map((it) => {
          const active = it.match(pathname);
          return (
            <Link
              key={it.to}
              to={it.to}
              className={`flex items-center px-4 py-2 my-0.5 rounded-2xl text-sm transition-colors ${
                active ? 'text-main-blue bg-main-blue/10 font-medium' : 'hover:bg-background'
              }`}
            >
              <FontAwesomeIcon icon={it.icon} className="mr-3 w-4" />
              {m.console.nav[it.key]}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
