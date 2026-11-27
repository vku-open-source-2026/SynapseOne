// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCode,
  faMagnifyingGlass,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { useI18n } from '../lib/i18n-context.js';
import { SERVICE_CATALOG, matchesService } from '../lib/service-catalog.js';
import { SERVICE_ICONS } from '../lib/service-icons.js';

// Kept as a named export for Topbar and existing imports.
export const PLATFORM_SERVICES = SERVICE_CATALOG;

export default function ServicesSidebar({ open = true, onToggle }) {
  const { pathname } = useLocation();
  const [query, setQuery] = useState('');
  const { m } = useI18n();
  const copy = (svc) => m.services[svc.id] || svc;

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = SERVICE_CATALOG.filter((svc) => {
    if (!q) return true;
    const localized = copy(svc);
    return [svc.label, localized.label, svc.category, localized.category, svc.desc, localized.desc, ...svc.keywords]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(q));
  });

  return (
    <aside
      aria-label={m.console.servicesSection}
      className="fixed right-3 xl:right-5 top-0 h-screen w-64 xl:w-72 hidden lg:flex flex-col z-30 pt-4 pb-6"
    >
      <div className="w-full bg-white rounded-3xl p-4 shadow-md max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <h2 className="font-semibold text-sm text-main-text">{m.console.servicesSection}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-main-blue bg-main-blue/10 px-2 py-0.5 rounded-full">
              {filtered.length} {m.console.active}
            </span>
            {onToggle && (
              <button
                type="button"
                onClick={onToggle}
                title={m.console.collapseServices}
                className="text-normal-text hover:text-main-text p-1 text-xs"
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            )}
          </div>
        </div>

        <div className="relative mt-3 mb-3">
          <FontAwesomeIcon
            icon={faMagnifyingGlass}
            className="absolute left-3 top-2.5 text-xs text-normal-text"
          />
          <input
            type="text"
            placeholder={m.console.searchServices}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-7 py-1.5 rounded-2xl border border-slate-200 text-xs text-main-text outline-none focus:border-main-blue transition-colors bg-background/50 focus:bg-white"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2.5 top-2 text-xs text-normal-text hover:text-main-text"
            >
              <FontAwesomeIcon icon={faXmark} />
            </button>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto space-y-2 pr-1 s1-thin-scroll">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-normal-text">
              <p>{m.console.noServices} &ldquo;{query}&rdquo;</p>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-2 text-main-blue underline hover:text-main-end"
              >
                {m.console.clearSearch}
              </button>
            </div>
          ) : (
            filtered.map((svc) => {
              const active = matchesService(svc, pathname);
              const localized = copy(svc);
              const label = localized.label || svc.label;
              return (
                <div
                  key={svc.id}
                  className={`group block p-2.5 rounded-2xl border transition-all ${
                    active
                      ? 'border-main-blue bg-main-blue/10 shadow-sm'
                      : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      style={{
                        background: svc.bgGradient,
                        boxShadow: `0 3px 8px ${svc.shadowColor}`,
                      }}
                      className="w-8 h-8 rounded-xl flex items-center justify-center text-white shrink-0 group-hover:scale-105 transition-transform"
                    >
                      <FontAwesomeIcon icon={SERVICE_ICONS[svc.id]} className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          to={svc.consoleRoute}
                          className={`text-xs font-semibold truncate ${
                            active ? 'text-main-blue' : 'text-main-text group-hover:text-main-blue'
                          }`}
                        >
                          {label}
                        </Link>
                        {active && <span className="w-1.5 h-1.5 rounded-full bg-main-blue shrink-0" />}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] text-normal-text truncate">{localized.category}</p>
                        <Link
                          to={`/docs?tab=${svc.docsTab}`}
                          className="shrink-0 text-[10px] font-medium text-main-blue hover:underline"
                          title={`${m.nav.docs}: ${label}`}
                        >
                          {m.nav.docs}
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </nav>

        <div className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-normal-text flex items-center justify-between">
          <span>{m.console.servicesFooter}</span>
          <Link to="/api-docs" className="text-main-blue hover:underline flex items-center gap-1">
            <FontAwesomeIcon icon={faCode} className="text-[10px]" /> API
          </Link>
        </div>
      </div>
    </aside>
  );
}
