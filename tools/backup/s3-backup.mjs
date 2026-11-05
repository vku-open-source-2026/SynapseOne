// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Object-store backups for SynapseOCS (SeaweedFS or any S3 API).
 *
 * Runs inside the OCS image and reuses its S3 client (no extra dependency):
 *   node s3-backup.mjs once            take one snapshot
 *   node s3-backup.mjs loop            snapshot every BACKUP_INTERVAL_SECONDS
 *   node s3-backup.mjs list            list snapshots
 *   node s3-backup.mjs restore [name|latest] [--prefix P] [--dry-run]
 *
 * Layout under BACKUP_DIR (default /backups):
 *   blobs/<aa>/<sha256>        object bytes, stored once per distinct content
 *   snapshots/<stamp>.json     {bucket, objects:[{key,size,etag,contentType,sha256}]}
 *
 * Snapshots are incremental: an object whose key, size and ETag match the
 * previous snapshot reuses its blob without downloading. Snapshots older than
 * BACKUP_RETENTION_DAYS are removed (the newest is always kept) and blobs no
 * snapshot references are deleted. Restore writes each object back with its
 * original Content-Type, verifies the blob checksum first, skips objects that
 * are already identical and never deletes objects in the store.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The OCS image ships the client next to this script; tests point elsewhere.
const { S3Client } = await import(clientModuleOverride() ?? './dist/s3.js');
function clientModuleOverride() {
  const m = process.env.S3_BACKUP_CLIENT_MODULE;
  return m ? pathToFileURL(m).href : undefined;
}

const env = process.env;
const DIR = env.BACKUP_DIR || '/backups';
const BLOBS = join(DIR, 'blobs');
const SNAPS = join(DIR, 'snapshots');
const RETENTION_DAYS = Math.max(1, Number(env.BACKUP_RETENTION_DAYS) || 7);
const INTERVAL = Math.max(60, Number(env.BACKUP_INTERVAL_SECONDS) || 86_400);
const bucket = env.STORAGE_S3_BUCKET || 'synapseone-core';

const client = new S3Client({
  endpoint: env.STORAGE_S3_ENDPOINT || 'http://s3:9090',
  bucket,
  region: env.STORAGE_S3_REGION || 'us-east-1',
  accessKey: env.STORAGE_S3_ACCESS_KEY || 'test',
  secretKey: env.STORAGE_S3_SECRET_KEY || 'test',
  pathStyle: String(env.STORAGE_S3_PATH_STYLE ?? 'true') !== 'false',
});

const log = (msg) => console.log(`[s3-backup] ${msg}`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const blobPath = (hash) => join(BLOBS, hash.slice(0, 2), hash);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path, data) {
  const tmp = `${path}.part`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function snapshotNames() {
  await mkdir(SNAPS, { recursive: true });
  return (await readdir(SNAPS)).filter((n) => n.endsWith('.json')).sort();
}

async function readSnapshot(name) {
  return JSON.parse(await readFile(join(SNAPS, name), 'utf8'));
}

async function listAll() {
  const out = [];
  let token;
  do {
    const page = await client.list('', 1000, token);
    out.push(...page.objects); // keys and ETags arrive XML-decoded
    token = page.next;
  } while (token);
  return out;
}

async function takeSnapshot() {
  await mkdir(BLOBS, { recursive: true });
  const names = await snapshotNames();
  const previous = new Map();
  if (names.length) {
    for (const o of (await readSnapshot(names[names.length - 1])).objects) previous.set(o.key, o);
  }
  const listed = await listAll();
  const objects = [];
  let downloaded = 0;
  let reused = 0;
  let bytes = 0;
  for (const o of listed) {
    const prev = previous.get(o.key);
    if (prev && prev.size === o.size && prev.etag === o.etag && (await exists(blobPath(prev.sha256)))) {
      objects.push(prev);
      reused++;
      bytes += o.size;
      continue;
    }
    const obj = await client.get(o.key);
    if (!obj) continue; // deleted between list and get
    const hash = sha256(obj.body);
    const target = blobPath(hash);
    if (!(await exists(target))) {
      await mkdir(join(BLOBS, hash.slice(0, 2)), { recursive: true });
      await writeAtomic(target, obj.body);
    }
    objects.push({ key: o.key, size: obj.body.length, etag: o.etag || obj.etag, contentType: obj.contentType, sha256: hash });
    downloaded++;
    bytes += obj.body.length;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const name = `${stamp}.json`;
  await writeAtomic(join(SNAPS, name), JSON.stringify({ createdAt: new Date().toISOString(), bucket, objects }, null, 1));
  log(`snapshot ${name}: ${objects.length} objects, ${bytes} bytes (${downloaded} downloaded, ${reused} unchanged)`);
  await prune();
  return name;
}

async function prune() {
  const names = await snapshotNames();
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const keep = [];
  for (const [i, name] of names.entries()) {
    const isNewest = i === names.length - 1;
    const created = Date.parse((await readSnapshot(name)).createdAt);
    if (!isNewest && created < cutoff) {
      await rm(join(SNAPS, name), { force: true });
      log(`expired snapshot ${name}`);
    } else {
      keep.push(name);
    }
  }
  const referenced = new Set();
  for (const name of keep) for (const o of (await readSnapshot(name)).objects) referenced.add(o.sha256);
  let removed = 0;
  for (const shard of await readdir(BLOBS).catch(() => [])) {
    for (const file of await readdir(join(BLOBS, shard)).catch(() => [])) {
      if (!referenced.has(file)) {
        await rm(join(BLOBS, shard, file), { force: true });
        removed++;
      }
    }
  }
  if (removed) log(`removed ${removed} unreferenced blobs`);
}

async function restore(args) {
  const names = await snapshotNames();
  if (!names.length) throw new Error('no snapshots');
  const wanted = args.find((a) => !a.startsWith('--')) || 'latest';
  const name = wanted === 'latest' ? names[names.length - 1] : names.find((n) => n === wanted || n === `${wanted}.json`);
  if (!name) throw new Error(`snapshot ${wanted} not found (run: node s3-backup.mjs list)`);
  const pi = args.indexOf('--prefix');
  const prefix = pi >= 0 ? args[pi + 1] || '' : '';
  const dryRun = args.includes('--dry-run');
  const snap = await readSnapshot(name);
  let restored = 0;
  let same = 0;
  let failed = 0;
  for (const o of snap.objects) {
    if (prefix && !o.key.startsWith(prefix)) continue;
    try {
      const current = await client.head(o.key);
      if (current && current.size === o.size && current.etag === o.etag) {
        same++;
        continue;
      }
      if (dryRun) {
        log(`would restore ${o.key}`);
        restored++;
        continue;
      }
      const body = await readFile(blobPath(o.sha256));
      if (sha256(body) !== o.sha256) throw new Error('blob checksum mismatch');
      await client.put(o.key, body, o.contentType || 'application/octet-stream');
      restored++;
    } catch (e) {
      failed++;
      console.error(`[s3-backup] restore ${o.key}: ${e.message || e}`);
    }
  }
  log(`restore from ${name}${prefix ? ` (prefix ${prefix})` : ''}${dryRun ? ' [dry-run]' : ''}: ${restored} restored, ${same} already identical, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

async function listSnapshots() {
  for (const name of await snapshotNames()) {
    const s = await readSnapshot(name);
    const bytes = s.objects.reduce((n, o) => n + o.size, 0);
    console.log(`${name}\t${s.objects.length} objects\t${bytes} bytes`);
  }
}

const [cmd = 'once', ...rest] = process.argv.slice(2);
try {
  if (cmd === 'once') await takeSnapshot();
  else if (cmd === 'list') await listSnapshots();
  else if (cmd === 'restore') await restore(rest);
  else if (cmd === 'loop') {
    log(`every ${INTERVAL}s, keep ${RETENTION_DAYS} days, bucket ${bucket}`);
    for (;;) {
      try {
        await takeSnapshot();
      } catch (e) {
        console.error(`[s3-backup] snapshot failed: ${e.message || e}`);
      }
      await new Promise((r) => setTimeout(r, INTERVAL * 1000));
    }
  } else {
    console.error('usage: node s3-backup.mjs once|loop|list|restore [name|latest] [--prefix P] [--dry-run]');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`[s3-backup] ${e.message || e}`);
  process.exitCode = 1;
}
