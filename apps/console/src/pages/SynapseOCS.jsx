// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCloud,
  faHardDrive,
  faFolderOpen,
  faFile,
  faUpload,
  faDownload,
  faTrash,
  faPlus,
  faRotateRight,
  faKey,
} from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import {
  Badge,
  Btn,
  Card,
  Empty,
  Err,
  Field,
  Input,
  Modal,
  PageTitle,
  StatValue,
  Table,
  TableSkeleton,
} from '../components/ui.jsx';

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export default function SynapseOCS() {
  const { headers } = useAuth();
  const [buckets, setBuckets] = useState([]);
  const [selected, setSelected] = useState('');
  const [objects, setObjects] = useState([]);
  const [prefix, setPrefix] = useState('');
  const [loading, setLoading] = useState(true);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [bucketName, setBucketName] = useState('');
  const [quotaMb, setQuotaMb] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  const loadBuckets = async () => {
    setLoading(true);
    setErr(null);
    try {
      const result = await api.ocsBuckets(headers);
      const list = Array.isArray(result?.buckets) ? result.buckets : [];
      setBuckets(list);
      if (!selected || !list.some((bucket) => bucket.name === selected)) {
        setSelected(list[0]?.name || '');
      }
    } catch (error) {
      setErr(error);
    } finally {
      setLoading(false);
    }
  };

  const loadObjects = async (bucket = selected, nextPrefix = prefix) => {
    if (!bucket) {
      setObjects([]);
      return;
    }
    setObjectsLoading(true);
    try {
      const result = await api.ocsObjects(bucket, { prefix: nextPrefix, limit: 200 }, headers);
      setObjects(Array.isArray(result?.objects) ? result.objects : []);
    } catch (error) {
      setErr(error);
      setObjects([]);
    } finally {
      setObjectsLoading(false);
    }
  };

  useEffect(() => {
    loadBuckets();
  }, [headers?.token, headers?.apiKey]);

  useEffect(() => {
    loadObjects(selected, prefix);
  }, [selected]);

  const createBucket = async (event) => {
    event.preventDefault();
    if (!bucketName.trim()) return;
    setBusy(true);
    try {
      await api.ocsCreateBucket(
        bucketName.trim().toLowerCase(),
        quotaMb ? Number(quotaMb) * 1024 * 1024 : undefined,
        headers,
      );
      setBucketName('');
      setQuotaMb('');
      setCreateOpen(false);
      await loadBuckets();
    } catch (error) {
      alert(`Create bucket failed: ${error.message || error}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteBucket = async (bucket) => {
    if (!confirm(`Delete bucket '${bucket.name}' and every object inside it?`)) return;
    try {
      await api.ocsDeleteBucket(bucket.name, true, headers);
      if (selected === bucket.name) setSelected('');
      await loadBuckets();
    } catch (error) {
      alert(`Delete bucket failed: ${error.message || error}`);
    }
  };

  const uploadFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !selected) return;
    setBusy(true);
    try {
      const key = `${prefix}${file.name}`.replace(/^\/+/, '');
      await api.ocsPutObject(selected, key, file, file.type || 'application/octet-stream', headers);
      await loadObjects(selected, prefix);
    } catch (error) {
      alert(`Upload failed: ${error.message || error}`);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const downloadObject = async (object) => {
    try {
      const result = await api.ocsPresign(selected, object.key, 'GET', 120, headers);
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      alert(`Download failed: ${error.message || error}`);
    }
  };

  const deleteObject = async (object) => {
    if (!confirm(`Delete '${object.key}'?`)) return;
    try {
      await api.ocsDeleteObject(selected, object.key, headers);
      await loadObjects(selected, prefix);
    } catch (error) {
      alert(`Delete failed: ${error.message || error}`);
    }
  };

  const current = buckets.find((bucket) => bucket.name === selected);

  return (
    <div>
      <PageTitle
        title="SynapseOCS"
        sub="Bucket-aware object cloud storage with direct upload, signed URLs, range reads and tenant quotas."
        right={(
          <>
            <Btn kind="ghost" onClick={() => { setErr(null); loadBuckets(); loadObjects(); }}>
              <FontAwesomeIcon icon={faRotateRight} /> Refresh
            </Btn>
            <Btn onClick={() => setCreateOpen(true)}>
              <FontAwesomeIcon icon={faPlus} /> New bucket
            </Btn>
          </>
        )}
      />
      {err && <Err e={err} />}

      <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr] gap-5">
        <Card className="h-fit">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-main-text flex items-center gap-2">
              <FontAwesomeIcon icon={faCloud} className="text-main-blue" /> Buckets
            </h3>
            <Badge tone="blue">{buckets.length}</Badge>
          </div>
          {loading ? <TableSkeleton rows={4} /> : buckets.length === 0 ? (
            <Empty text="No buckets yet" action={<Btn onClick={() => setCreateOpen(true)}>Create bucket</Btn>} />
          ) : (
            <div className="space-y-2">
              {buckets.map((bucket) => (
                <button
                  key={bucket.name}
                  type="button"
                  onClick={() => { setSelected(bucket.name); setPrefix(''); }}
                  className={`w-full text-left rounded-2xl border px-3 py-3 transition ${
                    selected === bucket.name
                      ? 'border-main-blue bg-main-blue/5'
                      : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm text-main-text truncate">{bucket.name}</span>
                    <FontAwesomeIcon icon={faFolderOpen} className="text-main-blue" />
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-normal-text">
                    <span>{bucket.objects ?? 0} objects</span>
                    <span>{formatBytes(bucket.bytes)}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[11px] text-normal-text">{bucket.quotaBytes ? `quota ${formatBytes(bucket.quotaBytes)}` : 'tenant quota'}</span>
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); deleteBucket(bucket); }}
                      className="text-red-500 hover:text-red-600"
                      aria-label={`Delete ${bucket.name}`}
                    >
                      <FontAwesomeIcon icon={faTrash} />
                    </button>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card><p className="text-xs text-normal-text mb-1">Selected bucket</p><p className="font-semibold text-main-text truncate">{selected || '–'}</p></Card>
            <Card><p className="text-xs text-normal-text mb-1">Objects</p><StatValue value={current?.objects ?? objects.length} /></Card>
            <Card><p className="text-xs text-normal-text mb-1">Used</p><StatValue value={formatBytes(current?.bytes)} /></Card>
            <Card><p className="text-xs text-normal-text mb-1">Quota</p><StatValue value={current?.quotaBytes ? formatBytes(current.quotaBytes) : 'Tenant'} /></Card>
          </div>

          <Card>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
              <div>
                <h3 className="font-semibold text-main-text flex items-center gap-2">
                  <FontAwesomeIcon icon={faHardDrive} className="text-main-blue" /> Objects
                </h3>
                <p className="text-xs text-normal-text mt-1">Prefix search, presigned download and direct upload.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={prefix}
                  onChange={(event) => setPrefix(event.target.value)}
                  placeholder="prefix/ (e.g. evidence/)"
                  className="w-52"
                  onKeyDown={(event) => { if (event.key === 'Enter') loadObjects(selected, prefix); }}
                />
                <Btn kind="ghost" onClick={() => loadObjects(selected, prefix)}>Browse</Btn>
                <Btn onClick={() => fileInput.current?.click()} disabled={!selected || busy} loading={busy}>
                  <FontAwesomeIcon icon={faUpload} /> Upload
                </Btn>
                <input ref={fileInput} type="file" className="hidden" onChange={uploadFile} />
              </div>
            </div>

            {!selected ? <Empty text="Select a bucket to browse objects" /> : objectsLoading ? <TableSkeleton rows={5} /> : objects.length === 0 ? (
              <Empty text="No objects under this prefix" action={<Btn onClick={() => fileInput.current?.click()}>Upload a file</Btn>} />
            ) : (
              <Table head={['Object', 'Size', 'Type', 'ETag', 'Updated', '']}>
                {objects.map((object) => (
                  <tr key={object.key} className="border-t border-slate-100">
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2 min-w-0">
                        <FontAwesomeIcon icon={faFile} className="text-slate-400 shrink-0" />
                        <span className="font-medium text-main-text truncate">{object.key}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-normal-text whitespace-nowrap">{formatBytes(object.size)}</td>
                    <td className="py-3 pr-4 text-normal-text whitespace-nowrap">{object.contentType || '–'}</td>
                    <td className="py-3 pr-4 text-xs text-normal-text font-mono truncate max-w-[140px]">{object.etag || '–'}</td>
                    <td className="py-3 pr-4 text-xs text-normal-text whitespace-nowrap">{object.updatedAt ? new Date(object.updatedAt).toLocaleString() : '–'}</td>
                    <td className="py-3">
                      <div className="flex items-center gap-1">
                        <button type="button" className="p-2 rounded-xl hover:bg-slate-100 text-main-blue" onClick={() => downloadObject(object)} aria-label={`Download ${object.key}`}>
                          <FontAwesomeIcon icon={faDownload} />
                        </button>
                        <button type="button" className="p-2 rounded-xl hover:bg-red-50 text-red-500" onClick={() => deleteObject(object)} aria-label={`Delete ${object.key}`}>
                          <FontAwesomeIcon icon={faTrash} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card className="bg-gradient-to-br from-blue-50 to-cyan-50 border border-blue-100">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-2xl bg-white text-main-blue grid place-items-center shadow-sm">
                <FontAwesomeIcon icon={faKey} />
              </div>
              <div>
                <h3 className="font-semibold text-main-text">Signed URLs, not S3 keys</h3>
                <p className="text-sm text-normal-text mt-1">
                  Downloads use short-lived HMAC URLs from SynapseOCS. The browser never sees the S3/MinIO credential,
                  and legacy <code className="text-xs">/v1/storage</code> remains available for existing files clients.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Modal open={createOpen} title="New bucket" onClose={() => setCreateOpen(false)}>
        <form onSubmit={createBucket}>
          <Field label="Bucket name">
            <Input
              value={bucketName}
              onChange={(event) => setBucketName(event.target.value)}
              placeholder="city-assets"
              required
            />
          </Field>
          <Field label="Optional quota (MB)">
            <Input
              type="number"
              min="1"
              value={quotaMb}
              onChange={(event) => setQuotaMb(event.target.value)}
              placeholder="leave empty for tenant quota"
            />
          </Field>
          <div className="flex justify-end gap-2 mt-4">
            <Btn kind="ghost" onClick={() => setCreateOpen(false)}>Cancel</Btn>
            <Btn type="submit" loading={busy} disabled={!bucketName.trim()}>Create bucket</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
