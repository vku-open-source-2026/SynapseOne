// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Menu, X } from 'lucide-react';
import {
  faBuilding,
  faBoxes,
  faUser,
  faBolt,
  faDatabase,
  faInbox,
  faGaugeHigh,
  faLink,
} from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import ContextSwitcher from './ContextSwitcher.jsx';
import { useScope } from './Scope.jsx';
import { PLATFORM_SERVICES } from './ServicesSidebar.jsx';
import SiteToggles from './SiteToggles.jsx';
import StableLabel from './StableLabel.jsx';
import { useI18n } from '../lib/i18n-context.js';

const PICK = 'px-2 py-1.5 rounded-2xl border border-slate-200 text-xs bg-white outline-none w-32 truncate';

function ScopePicks({ scope, onDone }) {
  const { m } = useI18n();
  return (
    <>
      <span className="inline-flex items-center gap-1 text-normal-text" title={m.console.org}>
        <FontAwesomeIcon icon={faBuilding} size="xs" />
        <select value={scope.orgId} onChange={(e) => { scope.setOrgId(e.target.value); onDone?.(); }} className={PICK}>
          <option value="">{m.console.orgPick}</option>
          {scope.orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.slug}
            </option>
          ))}
        </select>
      </span>
      <span className="inline-flex items-center gap-1 text-normal-text" title={m.console.account}>
        <FontAwesomeIcon icon={faBoxes} size="xs" />
        <select value={scope.accountId} onChange={(e) => { scope.setAccountId(e.target.value); onDone?.(); }} className={PICK}>
          <option value="">{m.console.accountPick}</option>
          {scope.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.slug}
            </option>
          ))}
        </select>
      </span>
    </>
  );
}


export default function Topbar({ servicesOpen = true, onToggleServices }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  // A hairline under the bar once the page scrolls, so the edge reads clearly.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const { auth, headers, logout } = useAuth();
  const scope = useScope();
  const { m } = useI18n();
  const { pathname } = useLocation();
  if (pathname === '/login') return null;

  const logoutAll = async () => {
    setMenu(false);
    try {
      const rt = auth?.refreshToken;
      if (rt) await api.logoutAll(rt);
    } catch {
      /* best-effort, local session clears regardless */
    }
    logout();
  };

  const email = auth?.email || (auth?.apiKey ? m.console.apiKeySession : '');

  return (
    <>
      {/* Mobile Top Header */}
      <header className="lg:hidden fixed z-50 top-0 left-0 w-full bg-white/80 backdrop-blur-md shadow-sm">
        <div className="flex items-center justify-between px-4 h-14">
          <Link to="/" className="font-semibold bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">
            {m.console.title}
          </Link>
          <div className="flex items-center gap-1">
            <SiteToggles />
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-label={open ? m.nav.closeMenu : m.nav.openMenu}
              aria-expanded={open}
              className="w-9 h-9 inline-flex items-center justify-center text-xl text-normal-text"
            >
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </header>

      {/* Desktop Controls (Positioned strictly with deterministic CSS classes) */}
      <div
        className={`hidden lg:flex fixed top-0 ${
          servicesOpen ? 'console-topbar-dual' : 'console-topbar-single'
        } h-16 z-30 px-4 lg:px-6 items-center justify-end console-topbar-band border-b transition-all duration-200 ${
          scrolled ? 'border-slate-200 shadow-[0_6px_12px_-10px_rgba(15,27,45,0.25)]' : 'border-transparent'
        }`}
      >
        {/* Solid band: page content scrolls under it instead of showing between the controls. */}
        <div className="max-w-6xl mx-auto w-full flex items-center justify-end gap-2">
          <SiteToggles className="bg-white rounded-2xl shadow-sm px-0.5 py-0.5" />
          <ScopePicks scope={scope} />

          {/* Services Toggle Pill */}
          {onToggleServices && (
            <button
              type="button"
              onClick={onToggleServices}
              title={servicesOpen ? m.console.hideServices : m.console.showServices}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-2xl shadow-sm text-xs font-medium transition-all ${
                servicesOpen
                  ? 'bg-main-blue text-white shadow-main-blue/20'
                  : 'bg-white text-main-text hover:text-main-blue border border-slate-200 shadow-sm'
              }`}
            >
              <FontAwesomeIcon icon={faBolt} className="text-xs" />
              <StableLabel pick={(d) => d.console.services} />
              <span
                className={`w-4 h-4 rounded-full text-[10px] flex items-center justify-center font-bold ${
                  servicesOpen ? 'bg-white/25 text-white' : 'bg-slate-100 text-normal-text'
                }`}
              >
                5
              </span>
            </button>
          )}

          {(auth?.contexts?.length || 0) > 1 && <ContextSwitcher />}

          {/* User Pill */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenu(!menu)}
              title={email}
              className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-2xl bg-white shadow-md text-normal-text hover:text-main-blue"
            >
              <span className="text-xs max-w-36 truncate">{email}</span>
              <span className="w-7 h-7 rounded-full bg-background flex items-center justify-center">
                <FontAwesomeIcon icon={faUser} size="xs" />
              </span>
            </button>
            {menu && (
              <div className="absolute right-0 mt-2 w-52 bg-white rounded-2xl shadow-xl p-2 text-sm" onMouseLeave={() => setMenu(false)}>
                <div className="px-3 py-2 text-xs text-normal-text truncate">{email}</div>
                <button onClick={() => { setMenu(false); logout(); }} className="w-full text-left px-3 py-2 rounded-xl hover:bg-background text-main-text">
                  {m.console.signOut}
                </button>
                {auth?.refreshToken && (
                  <button onClick={logoutAll} className="w-full text-left px-3 py-2 rounded-xl hover:bg-background text-red-500">
                    {m.console.signOutAll}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mobile Drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/30 pt-14" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-b-3xl p-4 mx-3 shadow-md max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col gap-2 pb-3 mb-2 border-b border-slate-100">
              <ScopePicks scope={scope} onDone={() => setOpen(false)} />
            </div>

            {/* Core Section */}
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 py-1">
              {m.console.core}
            </div>
            {['dashboard', 'orgs', 'accounts', 'users', 'roles', 'policies', 'keys', 'service-accounts', 'authorize', 'audit', 'security'].map(
              (r) => (
                <Link
                  key={r}
                  to={`/${r}`}
                  onClick={() => setOpen(false)}
                  className="block py-1.5 text-main-text text-sm hover:text-main-blue"
                >
                  {m.console.nav[r.replace(/-(\w)/g, (_, c) => c.toUpperCase())]}
                </Link>
              ),
            )}

            {/* Services Section */}
            <div className="mt-3 pt-2 border-t border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-main-blue py-1">
              {m.console.servicesSection}
            </div>
            {PLATFORM_SERVICES.map((s) => (
              <Link
                key={s.to}
                to={s.to}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 py-1.5 text-main-text text-sm hover:text-main-blue group"
              >
                <div
                  style={{
                    background: s.bgGradient,
                    boxShadow: `0 2px 6px ${s.shadowColor}`,
                  }}
                  className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-xs shrink-0 group-hover:scale-105 transition-transform"
                >
                  <FontAwesomeIcon icon={s.icon} className="w-3 h-3" />
                </div>
                <span className="font-medium text-xs">{s.label}</span>
              </Link>
            ))}

            {/* Docs Section */}
            <div className="mt-3 pt-2 border-t border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-400 py-1">
              {m.console.docsApis}
            </div>
            {['api-docs', 'docs'].map((r) => (
              <Link
                key={r}
                to={`/${r}`}
                onClick={() => setOpen(false)}
                className="block py-1.5 text-main-text text-sm hover:text-main-blue"
              >
                {m.console.nav[r.replace(/-(\w)/g, (_, c) => c.toUpperCase())]}
              </Link>
            ))}

            <div className="mt-3 pt-3 border-t border-slate-100">
              <button onClick={() => { logout(); setOpen(false); }} className="block py-2 text-red-500 text-sm font-medium">
                  {m.console.signOut}
                </button>
              {auth?.refreshToken && (
                <button onClick={logoutAll} className="block py-2 text-red-500 text-sm">
                    {m.console.signOutAll}
                  </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
