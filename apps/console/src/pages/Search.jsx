// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * Tenant-scoped search over the SynapseBase index: full-text, semantic,
 * hybrid, facets, reindex and index freshness. No second search backend.
 */
import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass, faRotateRight, faLayerGroup } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, Field, Input, PageTitle } from '../components/ui.jsx';

const MODES = [
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'fulltext', label: 'Full-text' },
  { value: 'semantic', label: 'Semantic' },
];

function FacetList({ facets }) {
  const entries = Object.entries(facets || {}).filter(([, values]) => Array.isArray(values) && values.length);
  if (!entries.length) return null;
  return (
    <Card>
      <h2 className="font-semibold text-sm mb-3 flex items-center gap-2">
        <FontAwesomeIcon icon={faLayerGroup} className="text-main-blue" /> Facets
      </h2>
      <div className="space-y-4">
        {entries.map(([name, values]) => (
          <div key={name}>
            <div className="text-xs font-medium uppercase tracking-wide text-normal-text mb-2">{name}</div>
            <div className="flex flex-wrap gap-2">
              {values.slice(0, 12).map((item) => (
                <span key={`${name}:${item.value}`} className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-2.5 py-1 text-xs">
                  <span className="truncate max-w-[12rem]">{item.value}</span>
                  <span className="text-normal-text">{item.count}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function Search() {
  const { headers } = useAuth();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('hybrid');
  const [collection, setCollection] = useState('');
  const [limit, setLimit] = useState(20);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [err, setErr] = useState(null);

  const loadStatus = async () => {
    try {
      setStatus(await api.searchStatus(headers));
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => { loadStatus(); }, [headers]);

  const run = async (event) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      setResult(await api.search({
        query: query.trim(),
        mode,
        limit: Number(limit) || 20,
        ...(collection.trim() ? { collection: collection.trim() } : {}),
      }, headers));
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  };

  const reindex = async () => {
    if (!window.confirm('Rebuild the tenant search index? This can take a while on large datasets.')) return;
    setReindexing(true);
    setErr(null);
    try {
      await api.searchReindex({}, headers);
      await loadStatus();
    } catch (e) {
      setErr(e);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div>
      <PageTitle
        title="SynapseSearch"
        sub="Tenant-scoped full-text, semantic and hybrid search over SynapseBase documents."
        right={<Btn kind="secondary" onClick={reindex} loading={reindexing}>
          <FontAwesomeIcon icon={faRotateRight} /> Reindex
        </Btn>}
      />
      {err && <Err e={err} />}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <Card>
            <form onSubmit={run} className="space-y-3">
              <Field label="Query">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. flood alert Hanoi"
                  autoFocus
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Mode">
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                    className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white"
                  >
                    {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </Field>
                <Field label="Collection" desc="Optional name or id">
                  <Input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="parks" />
                </Field>
                <Field label="Limit">
                  <Input type="number" min="1" max="100" value={limit} onChange={(e) => setLimit(e.target.value)} />
                </Field>
              </div>
              <Btn type="submit" loading={loading} disabled={!query.trim()}>
                <FontAwesomeIcon icon={faMagnifyingGlass} /> Search
              </Btn>
            </form>
          </Card>

          {result && (
            <Card>
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="font-semibold text-sm">Results</h2>
                <div className="text-xs text-normal-text">
                  {result.total} match{result.total === 1 ? '' : 'es'} · {result.mode}
                </div>
              </div>
              {result.items?.length ? (
                <ul className="divide-y divide-slate-100">
                  {result.items.map((hit) => (
                    <li key={hit.id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-sm text-main-text truncate">{hit.title || hit.documentId}</div>
                          <div className="text-xs text-normal-text mt-0.5">{hit.metadata?.collection || hit.collectionId}</div>
                          <p className="text-sm text-normal-text mt-1">{hit.snippet}</p>
                        </div>
                        <Badge tone="blue">{Number(hit.score || 0).toFixed(3)}</Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="No matches" text="Try a broader query, another mode, or rebuild the index." />
              )}
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <h2 className="font-semibold text-sm mb-3">Index status</h2>
            {status ? (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-normal-text">Documents</dt><dd>{status.indexed}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-normal-text">Collections</dt><dd>{status.collections}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-normal-text">Updated</dt><dd className="text-right">{status.updatedAt || '—'}</dd></div>
              </dl>
            ) : err ? <p className="text-sm text-red-500">Index status unavailable. Retry the search.</p> : <p className="text-sm text-normal-text">Loading…</p>}
          </Card>
          <FacetList facets={result?.facets} />
        </div>
      </div>
    </div>
  );
}
