// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Tenant-scoped Apache Iceberg catalog: namespaces, real Parquet tables,
 * snapshots (time travel), schema evolution and bounded scans.
 */
import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faLayerGroup,
  faPlus,
  faRotateRight,
  faTable,
  faCodeBranch,
  faTrash,
  faMagnifyingGlass,
  faClockRotateLeft,
} from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import {
  Badge,
  Btn,
  Card,
  Code,
  Empty,
  Err,
  Field,
  Input,
  Modal,
  PageTitle,
  TableSkeleton,
} from '../components/ui.jsx';

function fmtBytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

const DEFAULT_SCHEMA = JSON.stringify(
  [
    { name: 'id', type: 'string', required: true },
    { name: 'value', type: 'long' },
    { name: 'observed_at', type: 'timestamp' },
  ],
  null,
  2,
);

export default function Lakehouse() {
  const { headers } = useAuth();
  const [namespaces, setNamespaces] = useState([]);
  const [namespace, setNamespace] = useState('');
  const [tables, setTables] = useState([]);
  const [table, setTable] = useState('');
  const [meta, setMeta] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [createNsOpen, setCreateNsOpen] = useState(false);
  const [newNs, setNewNs] = useState('');
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [newTable, setNewTable] = useState('');
  const [newSchema, setNewSchema] = useState(DEFAULT_SCHEMA);
  const [appendOpen, setAppendOpen] = useState(false);
  const [appendRows, setAppendRows] = useState('[\n  {"id": "a", "value": 1}\n]');
  const [appendKey, setAppendKey] = useState('');
  const [evolveOpen, setEvolveOpen] = useState(false);
  const [evolveColumns, setEvolveColumns] = useState('[\n  {"name": "source", "type": "string"}\n]');
  const [queryResult, setQueryResult] = useState(null);
  const [maintenance, setMaintenance] = useState(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadNamespaces = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [nsRes, usageRes] = await Promise.all([
        api.lakehouseNamespaces(headers),
        api.lakehouseUsage(headers).catch(() => null),
      ]);
      const list = nsRes?.items || [];
      setNamespaces(list);
      setUsage(usageRes);
      if (!namespace && list.length) setNamespace(list[0]);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadNamespaces(); }, [headers]);

  const loadTables = async (ns = namespace) => {
    if (!ns) return;
    setLoading(true);
    try {
      const res = await api.lakehouseTables(ns, headers);
      setTables(res?.items || []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  };

  const loadTable = async (ns = namespace, name = table) => {
    if (!ns || !name) return;
    setErr(null);
    try {
      const [m, s] = await Promise.all([
        api.lakehouseTable(ns, name, headers),
        api.lakehouseSnapshots(ns, name, headers).catch(() => ({ items: [] })),
      ]);
      setMeta(m);
      setSnapshots(s?.items || []);
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    setTable('');
    setMeta(null);
    setSnapshots([]);
    setQueryResult(null);
    setMaintenance(null);
    if (namespace) loadTables(namespace);
  }, [namespace]);

  useEffect(() => {
    setQueryResult(null);
    setMaintenance(null);
    setMeta(null);
    if (table) loadTable(namespace, table);
  }, [table]);

  const createNamespace = async (e) => {
    e.preventDefault();
    if (!newNs.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.lakehouseCreateNamespace(newNs.trim(), headers);
      setCreateNsOpen(false);
      setNewNs('');
      await loadNamespaces();
      setNamespace(newNs.trim());
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const createTable = async (e) => {
    e.preventDefault();
    if (!newTable.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const schema = JSON.parse(newSchema);
      await api.lakehouseCreateTable(namespace, { name: newTable.trim(), schema }, headers);
      setCreateTableOpen(false);
      setNewTable('');
      await loadTables(namespace);
      setTable(newTable.trim());
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const append = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const rows = JSON.parse(appendRows);
      await api.lakehouseAppend(namespace, table, {
        rows,
        ...(appendKey.trim() ? { idempotencyKey: appendKey.trim() } : {}),
      }, headers);
      setAppendOpen(false);
      setAppendKey('');
      await Promise.all([loadTable(namespace, table), loadNamespaces()]);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const evolve = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const add = JSON.parse(evolveColumns);
      await api.lakehouseEvolve(namespace, table, { add }, headers);
      setEvolveOpen(false);
      await loadTable(namespace, table);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const runQuery = async (snapshotId) => {
    setQueryLoading(true);
    setErr(null);
    try {
      const res = await api.lakehouseQuery(namespace, table, {
        limit: 100,
        ...(snapshotId ? { snapshotId } : {}),
      }, headers);
      setQueryResult(res);
    } catch (e) {
      setErr(e);
    } finally {
      setQueryLoading(false);
    }
  };

  const loadMaintenance = async () => {
    setErr(null);
    try {
      setMaintenance(await api.lakehouseMaintenance(namespace, table, headers));
    } catch (e) {
      setErr(e);
    }
  };

  const deleteNamespace = async (ns) => {
    if (!window.confirm(`Delete namespace "${ns}"? It must be empty; table data files are retained.`)) return;
    try {
      await api.lakehouseDeleteNamespace(ns, headers);
      if (namespace === ns) { setNamespace(''); setTable(''); setMeta(null); }
      await loadNamespaces();
    } catch (e) {
      setErr(e);
    }
  };

  const deleteTable = async () => {
    if (!window.confirm(`Drop Iceberg table "${namespace}.${table}"? Catalog metadata is removed; data files are retained.`)) return;
    setBusy(true);
    try {
      await api.lakehouseDeleteTable(namespace, table, headers);
      setTable('');
      setMeta(null);
      await loadTables(namespace);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageTitle
        title="Lakehouse"
        sub="Apache Iceberg tables on tenant-scoped object storage with snapshots, schema evolution and trusted Warehouse materialization."
        right={
          <div className="flex gap-2">
            <Btn kind="secondary" onClick={() => setCreateNsOpen(true)}>
              <FontAwesomeIcon icon={faPlus} className="mr-1.5" /> Namespace
            </Btn>
            <Btn kind="secondary" onClick={() => { loadNamespaces(); if (namespace) loadTables(namespace); }} loading={loading}>
              <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" /> Refresh
            </Btn>
          </div>
        }
      />
      {err && <Err e={err} />}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <Card className="lg:col-span-1 p-4">
          <h3 className="font-semibold text-sm flex items-center justify-between mb-3">
            <span>Namespaces</span>
            <Badge tone="blue">{namespaces.length}</Badge>
          </h3>
          {namespaces.length === 0 ? (
            <Empty title="No namespaces" sub="Create one to start an Iceberg catalog." icon={faLayerGroup} />
          ) : (
            <div className="space-y-1">
              {namespaces.map((ns) => (
                <div key={ns} className={`flex items-center gap-1 rounded-xl ${namespace === ns ? 'bg-main-blue/10 text-main-blue' : 'hover:bg-slate-50 text-main-text'}`}>
                  <button
                    onClick={() => setNamespace(ns)}
                    className={`flex-1 text-left px-3 py-2 rounded-xl text-sm transition-colors ${namespace === ns ? 'font-medium' : ''}`}
                  >
                    <FontAwesomeIcon icon={faLayerGroup} className="mr-2 text-xs" /> {ns}
                  </button>
                  <button type="button" title="Delete namespace" className="text-xs text-red-500 hover:underline px-2" onClick={() => deleteNamespace(ns)}>×</button>
                </div>
              ))}
            </div>
          )}
          {usage && (
            <dl className="mt-4 pt-3 border-t border-slate-100 space-y-1 text-[11px] text-normal-text">
              <div className="flex justify-between"><dt>Tables</dt><dd>{usage.tables}</dd></div>
              <div className="flex justify-between"><dt>Namespaces</dt><dd>{usage.namespaces}/{usage.maxNamespaces}</dd></div>
              <div className="flex justify-between"><dt>Bytes</dt><dd>{fmtBytes(usage.bytes)} / {fmtBytes(usage.maxBytes)}</dd></div>
              <div className="flex justify-between"><dt>Max rows/append</dt><dd>{usage.maxRowsPerAppend}</dd></div>
            </dl>
          )}
        </Card>

        <div className="lg:col-span-3 space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <FontAwesomeIcon icon={faTable} className="text-main-blue" />
                Tables {namespace && <span className="text-normal-text font-normal">in {namespace}</span>}
              </h3>
              <Btn kind="primary" onClick={() => setCreateTableOpen(true)} disabled={!namespace}>
                <FontAwesomeIcon icon={faPlus} className="mr-1.5" /> New Table
              </Btn>
            </div>
            {!namespace ? (
              <Empty title="Select a namespace" sub="Namespaces isolate tenant Iceberg tables." />
            ) : loading && tables.length === 0 ? (
              <TableSkeleton rows={3} />
            ) : tables.length === 0 ? (
              <Empty title="No tables" sub="Create an Iceberg v2 table with a typed schema." icon={faTable} />
            ) : (
              <div className="flex flex-wrap gap-2">
                {tables.map((name) => (
                  <button
                    key={name}
                    onClick={() => setTable(name)}
                    className={`px-3 py-1.5 rounded-xl text-sm border transition-colors ${
                      table === name ? 'border-main-blue bg-main-blue/10 text-main-blue' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </Card>

          {meta && (
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-main-text">{namespace}.{table}</h3>
                  <p className="text-xs text-normal-text mt-1 font-mono break-all">{meta.location}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Btn kind="secondary" onClick={() => setAppendOpen(true)}>
                    <FontAwesomeIcon icon={faPlus} className="mr-1.5" /> Append
                  </Btn>
                  <Btn kind="secondary" onClick={() => setEvolveOpen(true)}>
                    <FontAwesomeIcon icon={faCodeBranch} className="mr-1.5" /> Add Column
                  </Btn>
                  <Btn kind="secondary" onClick={loadMaintenance}>
                    <FontAwesomeIcon icon={faClockRotateLeft} className="mr-1.5" /> Maintenance
                  </Btn>
                  <Btn kind="danger" onClick={deleteTable} loading={busy}>
                    <FontAwesomeIcon icon={faTrash} className="mr-1.5" /> Drop
                  </Btn>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3 mt-4 text-sm">
                <div className="p-3 rounded-2xl bg-slate-50">
                  <div className="text-[11px] uppercase tracking-wide text-normal-text">Format</div>
                  <div className="font-medium">Iceberg v{meta.formatVersion}</div>
                </div>
                <div className="p-3 rounded-2xl bg-slate-50">
                  <div className="text-[11px] uppercase tracking-wide text-normal-text">Snapshots</div>
                  <div className="font-medium">{meta.snapshotCount}</div>
                </div>
                <div className="p-3 rounded-2xl bg-slate-50 min-w-0">
                  <div className="text-[11px] uppercase tracking-wide text-normal-text">Current snapshot</div>
                  <div className="font-mono text-xs truncate">{meta.currentSnapshotId || '—'}</div>
                </div>
              </div>

              <div className="mt-4">
                <h4 className="text-xs font-medium uppercase tracking-wide text-normal-text mb-2">Schema</h4>
                <div className="flex flex-wrap gap-2">
                  {meta.schema?.map((column) => (
                    <span key={column.id} className="px-2.5 py-1 rounded-xl bg-slate-100 text-xs">
                      <span className="font-medium">{column.name}</span>
                      <span className="text-normal-text"> : {column.type}{column.required ? ' *' : ''}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Btn kind="secondary" onClick={() => runQuery()} loading={queryLoading}>
                  <FontAwesomeIcon icon={faMagnifyingGlass} className="mr-1.5" /> Query current
                </Btn>
                <span className="text-xs text-normal-text">Snapshot ids are strings; click one to time-travel.</span>
              </div>

              {snapshots.length > 0 && (
                <div className="mt-3 space-y-1 max-h-52 overflow-y-auto">
                  {snapshots.slice().reverse().map((snap) => (
                    <button
                      key={snap.snapshotId}
                      onClick={() => runQuery(snap.snapshotId)}
                      className="w-full text-left px-3 py-2 rounded-xl border border-slate-100 hover:bg-slate-50 flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <FontAwesomeIcon icon={faClockRotateLeft} className="text-main-blue" />
                        <span className="font-mono truncate">{snap.snapshotId}</span>
                      </span>
                      <span className="text-normal-text shrink-0">
                        {snap.operation} · {new Date(snap.timestampMs).toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {maintenance && (
                <div className="mt-4 p-3 rounded-2xl border border-amber-200 bg-amber-50/40">
                  <div className="text-xs font-medium text-main-text mb-1">Lifecycle report</div>
                  <p className="text-xs text-normal-text">
                    Physical cleanup is {maintenance.physicalCleanup}; retained snapshots and referenced files are protected.
                  </p>
                  <Code data={maintenance} />
                </div>
              )}

              {queryResult && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-medium uppercase tracking-wide text-normal-text">
                      Query result · {queryResult.rowCount} row(s)
                    </h4>
                    {queryResult.snapshotId && <Badge tone="blue">snapshot {String(queryResult.snapshotId).slice(0, 8)}…</Badge>}
                  </div>
                  <Code data={queryResult.rows} />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {createNsOpen && (
        <Modal title="Create Iceberg namespace" onClose={() => setCreateNsOpen(false)}>
          <form onSubmit={createNamespace} className="space-y-4">
            <Field label="Name" desc="Lowercase letters, numbers and underscores; 1..40 chars.">
              <Input value={newNs} onChange={(e) => setNewNs(e.target.value)} placeholder="analytics" autoFocus />
            </Field>
            <div className="flex justify-end gap-2">
              <Btn kind="secondary" onClick={() => setCreateNsOpen(false)}>Cancel</Btn>
              <Btn type="submit" loading={busy} disabled={!newNs.trim()}>Create</Btn>
            </div>
          </form>
        </Modal>
      )}

      {createTableOpen && (
        <Modal title={`Create table in ${namespace}`} onClose={() => setCreateTableOpen(false)}>
          <form onSubmit={createTable} className="space-y-4">
            <Field label="Table name">
              <Input value={newTable} onChange={(e) => setNewTable(e.target.value)} placeholder="events" autoFocus />
            </Field>
            <Field label="Schema (JSON)" desc="Types: string, long, double, boolean, timestamp, date, json.">
              <textarea
                value={newSchema}
                onChange={(e) => setNewSchema(e.target.value)}
                rows={8}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Btn kind="secondary" onClick={() => setCreateTableOpen(false)}>Cancel</Btn>
              <Btn type="submit" loading={busy} disabled={!newTable.trim()}>Create</Btn>
            </div>
          </form>
        </Modal>
      )}

      {appendOpen && (
        <Modal title={`Append to ${namespace}.${table}`} onClose={() => setAppendOpen(false)}>
          <form onSubmit={append} className="space-y-4">
            <Field label="Rows (JSON array)">
              <textarea
                value={appendRows}
                onChange={(e) => setAppendRows(e.target.value)}
                rows={8}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono"
              />
            </Field>
            <Field label="Idempotency key" desc="Optional; a replay returns the existing snapshot instead of appending again.">
              <Input value={appendKey} onChange={(e) => setAppendKey(e.target.value)} placeholder="batch-2026-11-24" />
            </Field>
            <div className="flex justify-end gap-2">
              <Btn kind="secondary" onClick={() => setAppendOpen(false)}>Cancel</Btn>
              <Btn type="submit" loading={busy}>Append</Btn>
            </div>
          </form>
        </Modal>
      )}

      {evolveOpen && (
        <Modal title={`Evolve ${namespace}.${table}`} onClose={() => setEvolveOpen(false)}>
          <form onSubmit={evolve} className="space-y-4">
            <Field label="Columns to add (JSON array)">
              <textarea
                value={evolveColumns}
                onChange={(e) => setEvolveColumns(e.target.value)}
                rows={6}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Btn kind="secondary" onClick={() => setEvolveOpen(false)}>Cancel</Btn>
              <Btn type="submit" loading={busy}>Add columns</Btn>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
