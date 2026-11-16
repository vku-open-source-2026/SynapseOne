// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ChevronDown, Globe, Lock, Search } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { GROUPS } from '../lib/endpoints.js';
import { Err, Spinner } from '../components/ui.jsx';
import Chatbot from '../components/Chatbot.jsx';
import DocsShell, { CodeBlock, DocHeader, MethodBadge, slugify } from '../components/DocsShell.jsx';
import { useI18n } from '../lib/i18n-context.js';

// Path params always follow a slash. This intentionally does not treat the
// colon in action suffixes such as `documents:batch` as a `:batch` parameter.
const PATH_PARAM = /(^|\/):([A-Za-z0-9_]+)/g;

const groupId = (name) => `group-${slugify(name)}`;

/** Path with its `:params` picked out in the accent colour. */
function PathText({ path }) {
  const parts = [];
  let last = 0;
  for (const match of path.matchAll(PATH_PARAM)) {
    const start = match.index + match[1].length;
    parts.push(path.slice(last, start));
    parts.push(
      <span key={start} className="text-s1-accent">
        :{match[2]}
      </span>,
    );
    last = start + match[2].length + 1;
  }
  parts.push(path.slice(last));
  return <>{parts}</>;
}

const FIELD =
  'w-full rounded-lg border border-s1-line bg-s1-surface px-3 py-2 text-sm text-s1-fg outline-none transition placeholder:text-s1-muted focus:border-s1-accent focus:ring-2 focus:ring-sky-500/20';

export default function ApiDocs() {
  const { m } = useI18n();
  const t = m.apiPage;
  const { headers, auth } = useAuth();
  const [open, setOpen] = useState(null);
  const [body, setBody] = useState('');
  const [pathVals, setPathVals] = useState({});
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);
  const [query, setQuery] = useState('');

  const key = (g, e) => `${g}:${e.method}:${e.path}`;

  const fillPath = (p) =>
    p.replace(PATH_PARAM, (_, prefix, n) => {
      const v = (pathVals[n] || '').trim();
      if (!v) throw new Error(t.missingParam.replace('{name}', n));
      return `${prefix}${encodeURIComponent(v)}`;
    });

  const copyCurl = async (g, e) => {
    let p;
    try {
      p = fillPath(e.path);
    } catch (ex) {
      setErr(ex);
      return;
    }
    let payload;
    if (e.method !== 'GET') {
      try {
        payload = body.trim() ? JSON.parse(body) : {};
      } catch {
        setErr(new Error(t.badJson));
        return;
      }
    }
    const parts = [`curl -X ${e.method} '${baseUrl()}${p}'`];
    // Secrets stay out of the clipboard: reference env vars instead.
    if (headers.token) parts.push(`-H "Authorization: Bearer $SYNAPSEONE_TOKEN"`);
    if (headers.apiKey) parts.push(`-H "X-API-Key: $SYNAPSEONE_API_KEY"`);
    if (e.method !== 'GET') {
      parts.push(`-H 'Content-Type: application/json'`);
      // Escape single quotes for POSIX shells (o'clock → o'\''clock).
      parts.push(`-d '${JSON.stringify(payload).replace(/'/g, `'\\''`)}'`);
    }
    const cmd = parts.join(' \\\n  ');
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = cmd;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(key(g, e));
    setTimeout(() => setCopied(null), 2000);
  };

  const toggle = (g, e) => {
    const k = key(g, e);
    setOpen(open === k ? null : k);
    setOut(null);
    setErr(null);
    setBody(e.body ? JSON.stringify(e.body, null, 2) : '');
    setPathVals({});
  };

  const run = async (e) => {
    setErr(null);
    setOut(null);
    setBusy(true);
    try {
      const p = fillPath(e.path);
      let payload;
      if (e.method !== 'GET') {
        try {
          payload = body.trim() ? JSON.parse(body) : {};
        } catch {
          throw new Error(t.badJson);
        }
      }
      // api.call goes through the session client: expired access tokens
      // rotate silently instead of 401ing until a full reload.
      // HTTP errors still surface with their real status + body below.
      try {
        const data = await api.call(e.method, p, e.method === 'GET' ? undefined : payload, headers);
        setOut({ status: 200, body: data });
      } catch (ex) {
        if (ex && typeof ex.status === 'number') setOut({ status: ex.status, body: ex.body ?? null });
        else throw ex;
      }
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  // Chatbot "Open in docs": load the agent suggestion into the try-it form below.
  const openInDocs = (sug, sugBody, sugPathVals) => {
    const g = GROUPS.find((x) => x.endpoints.some((e) => e.method === sug.method && e.path === sug.path));
    if (!g) return false;
    setQuery('');
    setBody(sugBody);
    setPathVals(sugPathVals);
    setOut(null);
    setErr(null);
    setOpen(`${g.name}:${sug.method}:${sug.path}`);
    requestAnimationFrame(() => {
      document.getElementById(groupId(g.name))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return true;
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      endpoints: g.endpoints.filter((e) => `${e.method} ${e.path} ${e.desc}`.toLowerCase().includes(q)),
    })).filter((g) => g.endpoints.length > 0);
  }, [query]);

  const nav = [
    {
      title: t.navLabel,
      items: groups.map((g) => ({ id: g.name, label: g.name, count: g.endpoints.length, href: `#${groupId(g.name)}` })),
    },
    { title: m.docsPage.groups.more, items: [{ id: 'docs', label: m.nav.docs, to: '/docs' }] },
  ];

  return (
    <>
    <DocsShell navLabel={t.navLabel} nav={nav}>
      <DocHeader
        kicker={t.kicker}
        title={t.title}
        right={
          <Link
            to="/docs"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-s1-line bg-s1-surface px-3 py-2 text-sm font-medium transition hover:border-s1-accent hover:text-s1-accent"
          >
            <BookOpen className="h-4 w-4" />
            {m.nav.docs}
          </Link>
        }
      >
        <p>{t.lead}</p>
      </DocHeader>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-s1-line bg-s1-surface px-3 py-2 font-mono text-xs">
          <span className="shrink-0 font-sans text-s1-muted">{t.baseUrl}</span>
          <span className="truncate text-s1-fg">{baseUrl()}</span>
        </div>
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t.filter}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s1-muted" />
          <input
            type="search"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder={t.filter}
            className={`${FIELD} pl-9`}
          />
        </label>
      </div>

      {!auth && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t.anonBefore}{' '}
            <Link to="/login" className="font-medium underline underline-offset-2">
              {t.signIn}
            </Link>{' '}
            {t.anonAfter}
          </span>
        </p>
      )}

      <div className="mt-6">
        <Err e={err} />
      </div>

      <div id="api-groups" className="space-y-10">
        {groups.length === 0 && <p className="text-sm text-s1-muted">{t.noMatch}</p>}
        {groups.map((g) => (
          <section key={g.name} aria-labelledby={groupId(g.name)}>
            <h2 id={groupId(g.name)} className="flex scroll-mt-24 items-baseline gap-2 text-lg font-semibold tracking-tight">
              {g.name}
              <span className="font-mono text-xs font-normal text-s1-muted">{g.endpoints.length}</span>
            </h2>
            <ul className="mt-3 divide-y divide-s1-line overflow-hidden rounded-xl border border-s1-line bg-s1-surface">
              {g.endpoints.map((e) => {
                const k = key(g.name, e);
                const isOpen = open === k;
                const params = [...e.path.matchAll(/(?:^|\/):([A-Za-z0-9_]+)/g)].map((x) => x[1]);
                const isPublic = e.auth === 'none';
                return (
                  <li key={k}>
                    <button
                      type="button"
                      onClick={() => toggle(g.name, e)}
                      aria-expanded={isOpen}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-s1-bg ${isOpen ? 'bg-s1-bg' : ''}`}
                    >
                      <span className="pt-0.5">
                        <MethodBadge method={e.method} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <code className="block break-all font-mono text-[13px] text-s1-fg">
                          <PathText path={e.path} />
                        </code>
                        <span className="mt-0.5 block text-xs leading-relaxed text-s1-muted">{e.desc}</span>
                      </span>
                      <span
                        className="hidden shrink-0 items-center gap-1 pt-0.5 text-xs text-s1-muted sm:inline-flex"
                        title={isPublic ? t.public : `${t.auth} (${e.auth})`}
                      >
                        {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                        {isPublic ? t.public : t.auth}
                      </span>
                      <ChevronDown
                        className={`mt-0.5 h-4 w-4 shrink-0 text-s1-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      />
                    </button>

                    {isOpen && (
                      <div className="space-y-4 border-t border-s1-line bg-s1-bg px-4 py-4">
                        {params.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-s1-muted">{t.pathParams}</p>
                            <div className="mt-2 space-y-2">
                              {params.map((p) => (
                                <label key={p} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                                  <span className="shrink-0 break-all font-mono text-xs text-s1-accent sm:w-28">:{p}</span>
                                  <input
                                    value={pathVals[p] || ''}
                                    onChange={(ev) => setPathVals({ ...pathVals, [p]: ev.target.value })}
                                    placeholder={`${t.enter} ${p}…`}
                                    className={FIELD}
                                  />
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {e.method !== 'GET' && (
                          <label className="block">
                            <span className="text-xs font-medium text-s1-muted">{t.body}</span>
                            <textarea
                              value={body}
                              onChange={(ev) => setBody(ev.target.value)}
                              rows={6}
                              spellCheck={false}
                              className={`${FIELD} mt-2 font-mono text-xs`}
                            />
                          </label>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => run(e)}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
                          >
                            {busy && <Spinner size="xs" className="sdx-spinner-on-dark" />}
                            {busy ? t.calling : t.tryIt}
                          </button>
                          <button
                            type="button"
                            onClick={() => copyCurl(g.name, e)}
                            title={t.curlHint}
                            className="whitespace-nowrap rounded-lg border border-s1-line bg-s1-surface px-4 py-2 text-sm font-medium transition hover:border-s1-accent hover:text-s1-accent"
                          >
                            {copied === k ? t.copied : t.copyCurl}
                          </button>
                        </div>
                        {out && (
                          <div className="space-y-2">
                            <p className="flex items-center gap-2 text-xs font-medium text-s1-muted">
                              {t.response}
                              <span
                                className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold ${
                                  out.status < 300
                                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                                    : out.status < 500
                                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                      : 'bg-rose-500/10 text-rose-600 dark:text-rose-300'
                                }`}
                              >
                                HTTP {out.status}
                              </span>
                            </p>
                            <CodeBlock code={out.body ?? 'null'} maxHeight />
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </DocsShell>
    <Chatbot auth={auth} headers={headers} onOpenInDocs={openInDocs} />
    </>
  );
}
