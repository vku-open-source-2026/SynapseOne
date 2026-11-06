// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../lib/i18n-context.js';
import { useAuth } from '../lib/auth.jsx';

/**
 * Shared frame for the Docs and API Docs pages: a sticky section nav on the
 * left, the page in the middle and, when `toc` is set, an "On this page" list
 * built from the `[data-toc]` headings inside the page.
 */
export default function DocsShell({ navLabel, nav, toc = false, tocKey, children }) {
  const { m } = useI18n();
  // Signed in, the console's own sidebars take room: show the columns one breakpoint later.
  const { auth } = useAuth();
  const L = auth ? WIDE_CONSOLE : WIDE_PUBLIC;
  const bodyRef = useRef(null);
  const [heads, setHeads] = useState([]);
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    if (!toc || !bodyRef.current) return undefined;
    const els = [...bodyRef.current.querySelectorAll('[data-toc]')];
    setHeads(els.map((el) => ({ id: el.id, text: el.dataset.toc || el.textContent })));
    setCurrent(els[0]?.id ?? null);
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setCurrent(hit.target.id);
      },
      { rootMargin: '-96px 0px -65% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [toc, tocKey]);

  return (
    <div className={`grid gap-8 ${L.grid} ${toc ? L.gridToc : ''}`}>
      {/* Phones and tablets: one scrollable row of sections. */}
      <nav aria-label={navLabel} className={`-mx-4 overflow-x-auto px-4 ${L.chips}`}>
        <ul className="flex w-max gap-2">
          {nav.flatMap((g) => g.items).map((item) => (
            <li key={item.id}>
              <NavItem item={item} chip />
            </li>
          ))}
        </ul>
      </nav>

      <nav aria-label={navLabel} className={`hidden ${L.side}`}>
        <div className="sticky top-24 max-h-[calc(100vh-7rem)] space-y-6 overflow-y-auto pb-6 pr-1">
          {nav.map((g) => (
            <div key={g.title}>
              <p className="px-3 text-xs font-semibold text-s1-fg">{g.title}</p>
              <ul className="mt-2 space-y-0.5 border-l border-s1-line">
                {g.items.map((item) => (
                  <li key={item.id}>
                    <NavItem item={item} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div ref={bodyRef} className="min-w-0">
        {children}
      </div>

      {toc && (
        <aside className={`hidden ${L.toc}`}>
          {heads.length > 1 && (
            <div className="sticky top-24">
              <p className="text-xs font-semibold text-s1-fg">{m.docsPage.onThisPage}</p>
              <ul className="mt-3 space-y-2 text-[13px]">
                {heads.map((h) => (
                  <li key={h.id}>
                    <a
                      href={`#${h.id}`}
                      className={`block leading-snug transition hover:text-s1-fg ${
                        current === h.id ? 'font-medium text-s1-accent' : 'text-s1-muted'
                      }`}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

// Tailwind needs whole class names, so each layout spells its breakpoints out.
const WIDE_PUBLIC = {
  grid: 'lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10',
  gridToc: 'xl:grid-cols-[13rem_minmax(0,1fr)_11rem]',
  chips: 'lg:hidden',
  side: 'lg:block',
  toc: 'xl:block',
};
const WIDE_CONSOLE = {
  grid: 'xl:grid-cols-[12rem_minmax(0,1fr)] xl:gap-10',
  gridToc: '2xl:grid-cols-[12rem_minmax(0,1fr)_11rem]',
  chips: 'xl:hidden',
  side: 'xl:block',
  toc: '2xl:block',
};

function NavItem({ item, chip = false }) {
  const { active, label, count, onClick, href, to } = item;
  const cls = chip
    ? `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition ${
        active ? 'border-s1-accent bg-s1-accent-soft font-medium text-s1-accent' : 'border-s1-line bg-s1-surface text-s1-muted hover:text-s1-fg'
      }`
    : `-ml-px flex w-full items-start justify-between gap-2 border-l-2 py-1.5 pl-3 pr-2 text-left text-sm transition ${
        active
          ? 'border-s1-accent font-medium text-s1-accent'
          : 'border-transparent text-s1-muted hover:border-s1-line hover:text-s1-fg'
      }`;
  const inner = (
    <>
      <span className={chip ? '' : 'min-w-0 leading-snug'}>{label}</span>
      {count != null && <span className="shrink-0 pt-0.5 font-mono text-[11px] text-s1-muted">{count}</span>}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cls}>
        {inner}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} onClick={onClick} className={cls} aria-current={active ? 'true' : undefined}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls} aria-current={active ? 'page' : undefined}>
      {inner}
    </button>
  );
}

/** Page heading inside DocsShell: a mono context line, the title and an optional lead. */
export function DocHeader({ kicker, title, children, right }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 max-w-3xl">
        {kicker && <p className="text-sm font-medium text-s1-accent">{kicker}</p>}
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        {children && <div className="s1-prose mt-4 space-y-4 text-[15px] leading-7 text-s1-muted">{children}</div>}
      </div>
      {right && <div className="flex shrink-0 flex-wrap gap-2">{right}</div>}
    </header>
  );
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** HTTP method label with a fixed width so paths line up. */
const METHOD_STYLE = {
  GET: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30',
  POST: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  PUT: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  PATCH: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  DELETE: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
};

export function MethodBadge({ method }) {
  const style = METHOD_STYLE[method];
  if (!style) return <span className="text-xs font-medium text-s1-muted">{method}</span>;
  return (
    <span className={`inline-flex w-16 shrink-0 justify-center rounded-md py-0.5 font-mono text-[11px] font-semibold ring-1 ring-inset ${style}`}>
      {method}
    </span>
  );
}

/** Dark code panel with a copy button. Lines starting with # or // are dimmed. */
export function CodeBlock({ code, label, maxHeight = false }) {
  const { lang } = useI18n();
  const [copied, setCopied] = useState(false);
  const text = typeof code === 'string' ? code : JSON.stringify(code, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the text stays selectable */
    }
  };
  return (
    <div className="group relative min-w-0 overflow-hidden rounded-xl border border-s1-line bg-s1-code">
      {label && <div className="border-b border-white/10 px-4 py-2 font-mono text-xs text-s1-code-muted">{label}</div>}
      <button
        type="button"
        onClick={copy}
        aria-label={lang === 'vi' ? 'Sao chép' : 'Copy'}
        className={`absolute right-2 ${label ? 'top-1' : 'top-2'} inline-flex items-center gap-1.5 rounded-md bg-s1-code px-2 py-1 text-xs text-s1-code-muted opacity-100 transition hover:bg-white/10 hover:text-white sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{copied ? (lang === 'vi' ? 'Đã sao chép' : 'Copied') : lang === 'vi' ? 'Sao chép' : 'Copy'}</span>
      </button>
      <pre className={`${maxHeight ? 'max-h-[28rem] overflow-auto' : 'overflow-x-auto'} p-4 font-mono text-[13px] leading-relaxed text-s1-code-fg`}>
        {text.split('\n').map((line, i) => {
          const t = line.trimStart();
          const comment = t.startsWith('#') || t.startsWith('//');
          return (
            <span key={i} className={`block ${comment ? 'text-s1-code-muted' : ''}`}>
              {line || ' '}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

/** Bordered table for reference data; scrolls sideways on phones. */
export function DocTable({ head, children }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-s1-line">
      <table className="w-full text-sm">
        <thead className="bg-s1-bg">
          <tr className="text-left text-xs text-s1-muted">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-s1-surface">{children}</tbody>
      </table>
    </div>
  );
}
