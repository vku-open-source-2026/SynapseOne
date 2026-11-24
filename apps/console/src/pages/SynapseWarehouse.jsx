// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowRotateRight,
  faDatabase,
  faPlus,
  faPlay,
  faPause,
  faTrash,
  faTable,
  faCode,
  faBolt,
  faLayerGroup,
  faCircleExclamation,
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
  Pager,
  SearchBox,
  Skeleton,
  Table,
} from '../components/ui.jsx';

const DEFAULT_SQL = 'SELECT * FROM city_incidents LIMIT 100';
const COLUMN_HINT = 'name:type per line — types: string, number, boolean, timestamp, json';

function fmtTime(t) {
  if (!t) return '–';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString();
}

function fmtNumber(n) {
  return Number(n || 0).toLocaleString();
}

function statusTone(status) {
  return status === 'running' ? 'green' : status === 'paused' ? 'amber' : 'gray';
}

function parseColumns(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, type = 'string'] = line.split(':').map((part) => part.trim());
      return { name, type };
    })
    .filter((c) => c.name);
}

export default function SynapseWarehouse() {
  const { headers } = useAuth();
  const [tab, setTab] = useState('datasets');

  const [datasets, setDatasets] = useState([]);
  const [datasetTotal, setDatasetTotal] = useState(0);
  const [datasetOffset, setDatasetOffset] = useState(0);
  const [datasetSearch, setDatasetSearch] = useState('');
  const [jobTotal, setJobTotal] = useState(0);
  const [jobOffset, setJobOffset] = useState(0);
  const [jobSearch, setJobSearch] = useState('');
  const PAGE = 100;
  const [templates, setTemplates] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [sql, setSql] = useState(DEFAULT_SQL);
  const [queryResult, setQueryResult] = useState(null);
  const [queryErr, setQueryErr] = useState(null);
  const [queryLoading, setQueryLoading] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newColumns, setNewColumns] = useState('id:string\ncreated_at:timestamp\nvalue:number');
  const [newMode, setNewMode] = useState('batch');
  const [newTopic, setNewTopic] = useState('');
  const [createErr, setCreateErr] = useState(null);
  const [creating, setCreating] = useState(false);

  const [jobOpen, setJobOpen] = useState(false);
  const [jobName, setJobName] = useState('');
  const [jobMode, setJobMode] = useState('batch');
  const [jobSnapshotId, setJobSnapshotId] = useState('');
  const [jobTarget, setJobTarget] = useState('');
  const [jobSql, setJobSql] = useState('SELECT * FROM city_incidents LIMIT 100');
  const [jobWriteMode, setJobWriteMode] = useState('replace');
  const [jobTopic, setJobTopic] = useState('');
  const [jobIntervalMs, setJobIntervalMs] = useState(1000);
  const [jobCollection, setJobCollection] = useState('');
  const [jobNamespace, setJobNamespace] = useState('analytics');
  const [jobTable, setJobTable] = useState('');
  const [ocsBucket, setOcsBucket] = useState('');
  const [ocsKey, setOcsKey] = useState('');
  const [ocsFormat, setOcsFormat] = useState('');
  const [ocsPreview, setOcsPreview] = useState(null);
  const [ocsPreviewBusy, setOcsPreviewBusy] = useState(false);
  const [jobErr, setJobErr] = useState(null);
  const [jobSaving, setJobSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [d, t, j] = await Promise.all([
        api.warehouseDatasets({ limit: PAGE, offset: datasetOffset, name: datasetSearch }, headers),
        api.warehouseTemplates(headers),
        api.warehouseJobs({ limit: PAGE, offset: jobOffset, name: jobSearch }, headers),
      ]);
      setDatasets(Array.isArray(d?.items) ? d.items : []);
      setDatasetTotal(Number(d?.total) || 0);
      setTemplates(Array.isArray(t?.items) ? t.items : []);
      setJobs(Array.isArray(j?.items) ? j.items : []);
      setJobTotal(Number(j?.total) || 0);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, [headers, datasetOffset, datasetSearch, jobOffset, jobSearch]);

  useEffect(() => {
    load();
  }, [load]);

  const firstDataset = datasets[0]?.id || '';
  useEffect(() => {
    if (!jobTarget && firstDataset) setJobTarget(firstDataset);
  }, [firstDataset, jobTarget]);

  const runningJobs = useMemo(() => jobs.filter((j) => j.status === 'running').length, [jobs]);

  const runQuery = async () => {
    setQueryErr(null);
    setQueryLoading(true);
    try {
      const res = await api.warehouseQuery(sql, 200, headers);
      setQueryResult(res);
    } catch (e) {
      setQueryResult(null);
      setQueryErr(e);
    } finally {
      setQueryLoading(false);
    }
  };

  const openCreate = () => {
    setCreateErr(null);
    setNewId('');
    setNewName('');
    setNewDescription('');
    setNewColumns('id:string\ncreated_at:timestamp\nvalue:number');
    setNewMode('batch');
    setNewTopic('');
    setCreateOpen(true);
  };

  const createDataset = async () => {
    setCreateErr(null);
    setCreating(true);
    try {
      await api.warehouseCreateDataset({
        id: newId.trim() || undefined,
        name: newName.trim(),
        description: newDescription.trim(),
        mode: newMode,
        ...(newMode === 'stream' ? { streamTopic: newTopic.trim() } : {}),
        columns: parseColumns(newColumns),
      }, headers);
      setCreateOpen(false);
      await load();
    } catch (e) {
      setCreateErr(e);
    } finally {
      setCreating(false);
    }
  };

  const renameDataset = async (d) => {
    const name = window.prompt('Dataset display name', d.name || d.id);
    if (name === null) return;
    try {
      await api.warehouseUpdateDataset(d.id, { name }, headers);
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const deleteDataset = async (id) => {
    if (!window.confirm(`Delete dataset "${id}" and all of its rows?`)) return;
    try {
      await api.warehouseDeleteDataset(id, headers);
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const useDataset = (id) => {
    setSql(`SELECT * FROM ${id} LIMIT 100`);
    setTab('sql');
  };

  const openJob = () => {
    setJobErr(null);
    setJobName('');
    setJobMode('batch');
    setJobTarget(firstDataset);
    setJobSql('SELECT * FROM city_incidents LIMIT 100');
    setJobWriteMode('replace');
    setJobTopic('');
    setJobIntervalMs(1000);
    setOcsBucket('');
    setOcsKey('');
    setOcsFormat('');
    setOcsPreview(null);
    setJobOpen(true);
  };

  const previewOcs = async () => {
    if (!ocsBucket.trim() || !ocsKey.trim() || ocsPreviewBusy) return;
    setOcsPreviewBusy(true);
    setJobErr(null);
    try {
      setOcsPreview(await api.warehouseOcsPreview({
        bucket: ocsBucket.trim(),
        key: ocsKey.trim(),
        ...(ocsFormat ? { format: ocsFormat } : {}),
      }, headers));
    } catch (e) {
      setJobErr(e);
      setOcsPreview(null);
    } finally {
      setOcsPreviewBusy(false);
    }
  };

  const createJob = async () => {
    setJobErr(null);
    setJobSaving(true);
    try {
      const body = jobMode === 'batch'
        ? {
            name: jobName.trim() || undefined,
            mode: 'batch',
            targetDatasetId: jobTarget,
            sql: jobSql,
            writeMode: jobWriteMode,
          }
        : jobMode === 'lakehouse'
          ? {
              name: jobName.trim() || undefined,
              collection: jobCollection.trim(),
              namespace: jobNamespace.trim(),
              table: jobTable.trim(),
              backfill: true,
            }
          : jobMode === 'ocs'
            ? {
                name: jobName.trim() || undefined,
                bucket: ocsBucket.trim(),
                key: ocsKey.trim(),
                format: ocsFormat || undefined,
                targetDatasetId: jobTarget,
                writeMode: jobWriteMode,
              }
          : jobMode === 'base'
            ? {
                collection: jobCollection.trim(),
                targetDatasetId: jobTarget,
                writeMode: jobWriteMode,
              }
          : jobMode === 'lakehouse-c'
            ? {
                namespace: jobNamespace.trim(),
                table: jobTable.trim(),
                targetDatasetId: jobTarget,
                ...(jobSnapshotId ? { snapshotId: jobSnapshotId } : {}),
                writeMode: jobWriteMode,
              }
          : {
              name: jobName.trim() || undefined,
              mode: 'stream',
              targetDatasetId: jobTarget,
              streamTopic: jobTopic.trim(),
              intervalMs: Number(jobIntervalMs) || 1000,
            };
      if (jobMode === 'lakehouse') await api.warehouseEtlBaseLakehouse(body, headers);
      else if (jobMode === 'ocs') await api.warehouseEtlOcs(body, headers);
      else if (jobMode === 'base') await api.warehouseEtlBase(body, headers);
      else if (jobMode === 'lakehouse-c') await api.warehouseEtlLakehouse(body, headers);
      else await api.warehouseCreateJob(body, headers);
      setJobOpen(false);
      await load();
    } catch (e) {
      setJobErr(e);
    } finally {
      setJobSaving(false);
    }
  };

  const runJob = async (id) => {
    try {
      await api.warehouseRunJob(id, headers);
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const pauseJob = async (id) => {
    try {
      await api.warehousePauseJob(id, headers);
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const resumeJob = async (id) => {
    try {
      await api.warehouseResumeJob(id, headers);
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const renameJob = async (job) => {
    const name = window.prompt('ETL job name', job.name || job.id);
    if (name === null) return;
    try {
      await api.warehouseUpdateJob(job.id, { name }, headers);
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const deleteJob = async (id) => {
    if (!window.confirm('Delete this ETL job?')) return;
    try {
      await api.warehouseDeleteJob(id, headers);
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const columns = queryResult?.columns || [];
  const rows = queryResult?.rows || [];

  return (
    <div className="max-w-6xl">
      <PageTitle
        title="Synapse Warehouse"
        sub="Tenant-scoped DuckDB OLAP: datasets, read-only SQL and batch/stream ETL."
        right={<Btn kind="ghost" onClick={load} loading={loading}><FontAwesomeIcon icon={faArrowRotateRight} className="mr-1.5" />Refresh</Btn>}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Card className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-normal-text mb-1"><FontAwesomeIcon icon={faDatabase} /> DATASETS</div>
          <div className="text-2xl font-semibold text-main-text">{fmtNumber(datasets.length)}</div>
          <div className="text-xs text-normal-text mt-1">{fmtNumber(datasets.reduce((n, d) => n + Number(d.rowCount || 0), 0))} rows total</div>
        </Card>
        <Card className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-normal-text mb-1"><FontAwesomeIcon icon={faBolt} /> ETL JOBS</div>
          <div className="text-2xl font-semibold text-main-text">{fmtNumber(jobs.length)}</div>
          <div className="text-xs text-normal-text mt-1">{runningJobs} running</div>
        </Card>
        <Card className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-normal-text mb-1"><FontAwesomeIcon icon={faLayerGroup} /> TEMPLATES</div>
          <div className="text-2xl font-semibold text-main-text">{fmtNumber(templates.length)}</div>
          <div className="text-xs text-normal-text mt-1">batch + stream recipes</div>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {[
          ['datasets', 'Datasets', faTable],
          ['sql', 'SQL studio', faCode],
          ['etl', 'ETL jobs', faBolt],
        ].map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-3 py-1.5 rounded-2xl text-xs font-medium border transition-colors ${
              tab === id
                ? 'border-main-blue bg-main-blue/10 text-main-blue'
                : 'border-slate-200 text-normal-text hover:bg-slate-50'
            }`}
          >
            <FontAwesomeIcon icon={icon} className="mr-1.5" />{label}
          </button>
        ))}
      </div>

      <Err e={err} />

      {tab === 'datasets' && (
        <Card>
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-semibold text-main-text">Datasets</h2>
            <Btn onClick={openCreate}><FontAwesomeIcon icon={faPlus} className="mr-1.5" />New dataset</Btn>
          </div>
          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : datasets.length === 0 ? (
            <Empty text="No datasets yet. Create one, then run a batch ETL job or SQL into it." />
          ) : (
            <Table head={['Dataset', 'Mode', 'Rows', 'Columns', 'Created', 'Actions']}>
              {datasets.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="py-2 pr-4">
                    <div className="font-medium text-main-text">{d.id}</div>
                    <div className="text-xs text-normal-text">{d.name}</div>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={d.mode === 'stream' ? 'blue' : 'gray'}>{d.mode}</Badge>
                    {d.streamTopic ? <span className="ml-1 text-[11px] text-normal-text">{d.streamTopic}</span> : null}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{fmtNumber(d.rowCount)}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text">
                    {(d.columns || []).map((c) => `${c.name}:${c.type}`).join(', ') || '–'}
                  </td>
                  <td className="py-2 pr-4 text-xs text-normal-text whitespace-nowrap">{fmtTime(d.createdAt)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    <button type="button" className="text-xs text-main-blue hover:underline mr-3" onClick={() => useDataset(d.id)}>Query</button>
                    <button type="button" className="text-xs text-main-blue hover:underline mr-3" onClick={() => renameDataset(d)}>Rename</button>
                    <button type="button" className="text-xs text-red-500 hover:underline" onClick={() => deleteDataset(d.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'datasets' && <Pager total={datasetTotal} limit={PAGE} offset={datasetOffset} onChange={setDatasetOffset} loading={loading} />}
      {tab === 'sql' && (
        <div className="space-y-4">
          <Card>
            <div className="flex items-center justify-between gap-3 mb-2">
              <h2 className="font-semibold text-main-text">Read-only SQL</h2>
              <span className="text-[11px] text-normal-text">SELECT / WITH only · results capped at 5 MB</span>
            </div>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={7}
              spellCheck={false}
              className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono text-main-text outline-none focus:border-main-blue"
            />
            <div className="flex items-center gap-2 mt-3">
              <Btn onClick={runQuery} loading={queryLoading}><FontAwesomeIcon icon={faPlay} className="mr-1.5" />Run query</Btn>
              {queryResult && (
                <span className="text-xs text-normal-text">
                  {fmtNumber(queryResult.rowCount)} rows · {queryResult.durationMs} ms{queryResult.truncated ? ' · truncated' : ''}
                </span>
              )}
            </div>
            <Err e={queryErr} />
          </Card>

          {queryResult && (
            <Card>
              {rows.length === 0 ? (
                <Empty text="The query returned an empty result set." />
              ) : (
                <Table head={columns}>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      {columns.map((c) => (
                        <td key={c} className="py-1.5 pr-4 text-xs whitespace-nowrap">
                          {row[c] === null || row[c] === undefined ? '–' : typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          )}
        </div>
      )}

      {tab === 'etl' && (
        <div className="space-y-6">
          <Card>
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="font-semibold text-main-text">ETL jobs</h2>
              <Btn onClick={openJob}><FontAwesomeIcon icon={faPlus} className="mr-1.5" />New job</Btn>
            </div>
            {loading ? (
              <Skeleton className="h-32 w-full" />
            ) : jobs.length === 0 ? (
              <Empty text="No ETL jobs. Create a batch transform or a stream ingestion job." />
            ) : (
              <Table head={['Job', 'Mode', 'Target', 'Status', 'Last run', 'Actions']}>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-slate-100">
                    <td className="py-2 pr-4">
                      <div className="font-medium text-main-text">{j.name}</div>
                      <div className="text-[11px] text-normal-text truncate max-w-[16rem]">{j.sql || j.streamTopic || j.id}</div>
                    </td>
                    <td className="py-2 pr-4"><Badge tone={j.mode === 'stream' ? 'blue' : 'gray'}>{j.mode}</Badge></td>
                    <td className="py-2 pr-4 text-xs">{j.targetDatasetId}</td>
                    <td className="py-2 pr-4"><Badge tone={statusTone(j.status)}>{j.status}</Badge></td>
                    <td className="py-2 pr-4 text-xs whitespace-nowrap">
                      {fmtTime(j.lastRunAt)}
                      {j.lastError ? (
                        <div className="text-red-500 text-[11px] max-w-[18rem] truncate" title={j.lastError}>
                          <FontAwesomeIcon icon={faCircleExclamation} className="mr-1" />{j.lastError}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {j.mode === 'batch' && (
                        <button type="button" className="text-xs text-main-blue hover:underline mr-3" onClick={() => runJob(j.id)}>Run</button>
                      )}
                      {j.status === 'running' ? (
                        <button type="button" className="text-xs text-amber-500 hover:underline mr-3" onClick={() => pauseJob(j.id)}>
                          <FontAwesomeIcon icon={faPause} className="mr-1" />Pause
                        </button>
                      ) : j.mode === 'stream' ? (
                        <button type="button" className="text-xs text-emerald-600 hover:underline mr-3" onClick={() => resumeJob(j.id)}>
                          <FontAwesomeIcon icon={faPlay} className="mr-1" />Resume
                        </button>
                      ) : null}
                      {(j.mode !== 'stream' || j.status !== 'running') && (
                        <button type="button" className="text-xs text-main-blue hover:underline mr-3" onClick={() => renameJob(j)}>Rename</button>
                      )}
                      <button type="button" className="text-xs text-red-500 hover:underline" onClick={() => deleteJob(j.id)}>
                        <FontAwesomeIcon icon={faTrash} className="mr-1" />Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <h2 className="font-semibold text-main-text mb-1">ETL templates</h2>
            <p className="text-xs text-normal-text mb-3">Recipes surfaced by the warehouse API; copy one into a job or a SynapseFlow workflow.</p>
            {templates.length === 0 ? (
              <Empty text="This warehouse build did not return any ETL recipes." />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {templates.map((t) => (
                  <div key={t.id} className="rounded-2xl border border-slate-100 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-main-text">{t.name}</span>
                      <Badge tone={t.mode === 'stream' ? 'blue' : 'gray'}>{t.mode}</Badge>
                    </div>
                    <p className="text-xs text-normal-text mt-1">{t.description}</p>
                    {t.sqlTemplate ? (
                      <div className="mt-2"><Code data={t.sqlTemplate} limit={220} /></div>
                    ) : null}
                    <button
                      type="button"
                      className="mt-2 text-xs text-main-blue hover:underline"
                      onClick={() => {
                        setJobMode(t.mode || 'batch');
                        setJobName(t.name || t.id);
                        setJobSql(t.sqlTemplate || '');
                        setJobWriteMode(t.writeMode || 'replace');
                        setJobTopic(t.streamTopicHint || '');
                        setJobTarget(firstDataset);
                        setJobOpen(true);
                      }}
                      disabled={!datasets.length}
                    >
                      Create job from template →
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
      {tab === 'jobs' && <Pager total={jobTotal} limit={PAGE} offset={jobOffset} onChange={setJobOffset} loading={loading} />}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New warehouse dataset">
        <Field label="Dataset id (lower-case slug)"><Input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="city_incidents" /></Field>
        <Field label="Name"><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="City incidents" /></Field>
        <Field label="Description"><Input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="Raw incident feed" /></Field>
        <Field label="Columns">
          <textarea
            value={newColumns}
            onChange={(e) => setNewColumns(e.target.value)}
            rows={5}
            spellCheck={false}
            className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono text-main-text outline-none focus:border-main-blue"
          />
          <span className="block text-[11px] text-normal-text mt-1">{COLUMN_HINT}</span>
        </Field>
        <Field label="Mode">
          <select value={newMode} onChange={(e) => setNewMode(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">
            <option value="batch">batch</option>
            <option value="stream">stream</option>
          </select>
        </Field>
        {newMode === 'stream' && (
          <Field label="Stream topic"><Input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="iot-sensors" /></Field>
        )}
        <Err e={createErr} />
        <div className="flex items-center gap-2 mt-4">
          <Btn onClick={createDataset} loading={creating} disabled={!newName.trim()}>Create dataset</Btn>
          <Btn kind="ghost" onClick={() => setCreateOpen(false)}>Cancel</Btn>
        </div>
      </Modal>

      <Modal open={jobOpen} onClose={() => setJobOpen(false)} title="New ETL job">
        <Field label="Job name"><Input value={jobName} onChange={(e) => setJobName(e.target.value)} placeholder="Daily incident rollup" /></Field>
        <Field label="Mode">
          <select value={jobMode} onChange={(e) => setJobMode(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">
            <option value="batch">batch SQL</option>
            <option value="stream">stream (continuous)</option>
            <option value="base">base snapshot → warehouse (Path A)</option>
            <option value="lakehouse">base → lakehouse change log (Path B)</option>
            <option value="lakehouse-c">lakehouse → warehouse (Path C)</option>
            <option value="ocs">ocs file (csv / jsonl / parquet)</option>
          </select>
        </Field>
        {jobMode !== 'lakehouse' && (
          <Field label="Target dataset">
            <select value={jobTarget} onChange={(e) => setJobTarget(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
            </select>
          </Field>
        )}
        {jobMode === 'batch' ? (
          <>
            <Field label="Transform SQL">
              <textarea
                value={jobSql}
                onChange={(e) => setJobSql(e.target.value)}
                rows={5}
                spellCheck={false}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono text-main-text outline-none focus:border-main-blue"
              />
            </Field>
            <Field label="Write mode">
              <select value={jobWriteMode} onChange={(e) => setJobWriteMode(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">
                <option value="replace">replace</option>
                <option value="append">append</option>
              </select>
            </Field>
          </>
        ) : jobMode === 'lakehouse' ? (
          <>
            <Field label="Base collection"><Input value={jobCollection} onChange={(e) => setJobCollection(e.target.value)} placeholder="parks" /></Field>
            <Field label="Lakehouse namespace"><Input value={jobNamespace} onChange={(e) => setJobNamespace(e.target.value)} placeholder="analytics" /></Field>
            <Field label="Iceberg change-log table" desc="Must have event_id, collection, document_id, operation, version, occurred_at, data, deleted.">
              <Input value={jobTable} onChange={(e) => setJobTable(e.target.value)} placeholder="parks_changes" />
            </Field>
          </>
        ) : jobMode === 'base' ? (
          <>
            <Field label="Base collection"><Input value={jobCollection} onChange={(e) => setJobCollection(e.target.value)} placeholder="parks" /></Field>
            <Field label="Write mode">
              <select value={jobWriteMode} onChange={(e) => setJobWriteMode(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">
                <option value="replace">replace</option>
                <option value="append">append</option>
              </select>
            </Field>
          </>
        ) : jobMode === 'lakehouse-c' ? (
          <>
            <Field label="Lakehouse namespace"><Input value={jobNamespace} onChange={(e) => setJobNamespace(e.target.value)} placeholder="analytics" /></Field>
            <Field label="Iceberg table"><Input value={jobTable} onChange={(e) => setJobTable(e.target.value)} placeholder="parks" /></Field>
            <Field label="Snapshot id (optional)" desc="Empty uses the current snapshot."><Input value={jobSnapshotId} onChange={(e) => setJobSnapshotId(e.target.value)} placeholder="1234567890" /></Field>
            <Field label="Write mode">
              <select value={jobWriteMode} onChange={(e) => setJobWriteMode(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">
                <option value="replace">replace</option>
                <option value="append">append</option>
              </select>
            </Field>
          </>
        ) : jobMode === 'ocs' ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="OCS bucket"><Input value={ocsBucket} onChange={(e) => setOcsBucket(e.target.value)} placeholder="data" /></Field>
              <Field label="Format"><select value={ocsFormat} onChange={(e) => setOcsFormat(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm"><option value="">from extension</option><option value="csv">csv</option><option value="jsonl">jsonl</option><option value="parquet">parquet</option></select></Field>
            </div>
            <Field label="Object key"><Input value={ocsKey} onChange={(e) => setOcsKey(e.target.value)} placeholder="exports/incidents.csv" /></Field>
            <div className="flex items-center gap-2 mb-3">
              <Btn kind="secondary" onClick={previewOcs} loading={ocsPreviewBusy} disabled={!ocsBucket.trim() || !ocsKey.trim()}>Preview schema</Btn>
              {ocsPreview && <span className="text-[11px] text-normal-text">{ocsPreview.bytes} bytes · {ocsPreview.columns?.length || 0} columns</span>}
            </div>
            {ocsPreview?.columns?.length > 0 && <Code data={{ columns: ocsPreview.columns, sample: ocsPreview.rows }} />}
            <Field label="Write mode">
              <select value={jobWriteMode} onChange={(e) => setJobWriteMode(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">
                <option value="replace">replace (transactional)</option>
                <option value="append">append (at-least-once)</option>
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="Stream topic"><Input value={jobTopic} onChange={(e) => setJobTopic(e.target.value)} placeholder="iot-sensors" /></Field>
            <Field label="Poll interval (ms)"><Input type="number" value={jobIntervalMs} onChange={(e) => setJobIntervalMs(e.target.value)} /></Field>
          </>
        )}
        <Err e={jobErr} />
        <div className="flex items-center gap-2 mt-4">
          <Btn
            onClick={createJob}
            loading={jobSaving}
            disabled={
              (jobMode !== 'lakehouse' && !jobTarget)
              || (jobMode === 'stream' && !jobTopic.trim())
              || (jobMode === 'lakehouse' && (!jobCollection.trim() || !jobNamespace.trim() || !jobTable.trim()))
              || (jobMode === 'base' && !jobCollection.trim())
              || (jobMode === 'lakehouse-c' && (!jobNamespace.trim() || !jobTable.trim()))
              || (jobMode === 'ocs' && (!ocsBucket.trim() || !ocsKey.trim()))
            }
          >Create job</Btn>
          <Btn kind="ghost" onClick={() => setJobOpen(false)}>Cancel</Btn>
        </div>
      </Modal>
    </div>
  );
}
