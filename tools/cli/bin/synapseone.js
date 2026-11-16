#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * synapseone CLI — zero dependencies, Node 18+ (global fetch).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = (() => {
  try {
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const CONF_DIR = path.join(os.homedir(), '.synapseone');
const CONF_FILE = path.join(CONF_DIR, 'config.json');
// Pre-rebrand config location; read-only fallback so existing logins survive.
const LEGACY_CONF_FILE = path.join(os.homedir(), '.synapsedx', 'config.json');

// ---------- config ----------
function loadConfig() {
  for (const file of [CONF_FILE, LEGACY_CONF_FILE]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* try next location */
    }
  }
  return {};
}
function saveConfig(cfg) {
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  // Credentials on disk: owner-only (0600). Token/API key in this file is a
  // bearer secret — never print it (see cmdConfig redaction below).
  fs.writeFileSync(CONF_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONF_FILE, 0o600); } catch { /* non-POSIX (win) */ }
}
function baseUrl(opts) {
  return (opts.base || process.env.SYNAPSEONE_BASE_URL || process.env.SYNAPSEDX_BASE_URL || loadConfig().baseUrl || 'https://api.synapseone.space').replace(/\/$/, '');
}
function authHeaders(opts) {
  const cfg = loadConfig();
  const token = opts.token || process.env.SYNAPSEONE_TOKEN || process.env.SYNAPSEDX_TOKEN || cfg.token;
  const apiKey = opts.apikey || process.env.SYNAPSEONE_API_KEY || process.env.SYNAPSEDX_API_KEY || cfg.apiKey;
  const h = { 'Content-Type': 'application/json', Connection: 'close' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (apiKey) h['X-API-Key'] = apiKey;
  return h;
}

// ---------- http ----------
async function req(method, p, body, opts) {
  let r;
  try {
    r = await fetch(baseUrl(opts) + p, {
      method,
      headers: authHeaders(opts),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`network ${p}: ${e.message || e}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw httpError(r.status, p, data);
  // A 200 HTML page means the base URL is the console/marketing host, not the
  // gateway. Surface it instead of printing the SPA as if it were data.
  const ctype = String(r.headers.get('content-type') || '').toLowerCase();
  const looksHtml = ctype.includes('text/html') || /^\s*(<!doctype html|<html)/i.test(String(data || ''));
  if (looksHtml) {
    throw new Error(
      `non-JSON response from ${baseUrl(opts)}${p}: received HTML (status ${r.status}). ` +
      'The base URL looks like the console host; use https://api.synapseone.space or pass --base.',
    );
  }
  return data;
}
function httpError(status, p, data) {
  // Clear messages for the two common LDS failures: reserved NGSI-LD
  // attribute names (400 reserved_attribute) and missing resources (404).
  const raw = typeof data === 'string' ? data : JSON.stringify(data);
  let code = '';
  let msg = '';
  let reserved = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (typeof data.code === 'string') code = data.code;
    else if (typeof data.error === 'string') code = data.error;
    if (data.error && typeof data.error === 'object') {
      code = code || data.error.code || '';
      msg = data.error.message || '';
    }
    msg = msg || (typeof data.message === 'string' ? data.message : '');
    if (Array.isArray(data.reserved)) reserved = data.reserved.filter((x) => typeof x === 'string');
  }
  if (status === 400 && (code === 'reserved_attribute' || /reserved_attribute/i.test(raw || ''))) {
    return new Error(
      `HTTP 400 ${p}: reserved_attribute${msg ? ` — ${msg}` : ''}` +
      `${reserved.length ? ` (reserved: ${reserved.join(', ')})` : ''}`,
    );
  }
  if (status === 404) {
    return new Error(`HTTP 404 ${p}: not found${msg ? ` — ${msg}` : raw && raw !== 'null' ? ` — ${raw}` : ''}`);
  }
  const err = new Error(`HTTP ${status} ${p}: ${raw}`);
  err.status = status;
  err.data = data;
  return err;
}
const GET = (p, o) => req('GET', p, undefined, o);
const POST = (p, b, o) => req('POST', p, b, o);
const DEL = (p, o) => req('DELETE', p, undefined, o);

/**
 * Binary-safe request used by the object-storage commands. JSON requests go
 * through req(); OCS bodies are opaque bytes and must never be re-encoded.
 */
async function reqRaw(method, p, body, opts, extraHeaders = {}) {
  const headers = { ...authHeaders(opts), ...extraHeaders };
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream';
  let r;
  try {
    r = await fetch(baseUrl(opts) + p, { method, headers, body });
  } catch (e) {
    throw new Error(`network ${p}: ${e.message || e}`);
  }
  if (!r.ok) {
    const text = await r.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    throw httpError(r.status, p, data);
  }
  return { buffer: Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

// ---------- argument coercion ----------
/** `--value` accepts JSON when it parses, otherwise the literal string. */
function valueArg(o, what = 'value') {
  if (o.valueFile) return fs.readFileSync(o.valueFile, 'utf8').replace(/\r?\n$/, '');
  if (o.value === undefined) {
    console.error(`missing ${what} (use --value '<json|text>' or --value-file <path>)`);
    process.exit(2);
  }
  try { return JSON.parse(String(o.value)); } catch { return String(o.value); }
}
/** Secret values are always literal strings, even when they look like JSON. */
function stringArg(o, what = 'value') {
  if (o.valueFile) return fs.readFileSync(o.valueFile, 'utf8').replace(/\r?\n$/, '');
  if (o.value !== undefined) return String(o.value);
  console.error(`missing ${what} (use --value '<text>' or --value-file <path>)`);
  process.exit(2);
}
function jsonArg(o, what) {
  const raw = o.payload !== undefined ? o.payload : o.input;
  if (raw !== undefined) {
    try { return JSON.parse(String(raw)); }
    catch { return readJson(String(raw)); }
  }
  if (o.file) return readJson(o.file);
  console.error(`missing ${what} (use --data '<json>'|json-file or --file json-file)`);
  process.exit(2);
}
/** Queue/stream payloads may legitimately be a bare string; only parse when JSON. */
function payloadArg(o, what = 'payload') {
  const raw = o.payload !== undefined ? o.payload : o.input;
  if (raw !== undefined) {
    try { return JSON.parse(String(raw)); }
    catch {
      try { return readJson(String(raw)); } catch { return String(raw); }
    }
  }
  if (o.file) return readJson(o.file);
  console.error(`missing ${what} (use --payload '<json|text>' or --file payload.json)`);
  process.exit(2);
}
function valuesArg(o, what = 'values') {
  if (Array.isArray(o.values) && o.values.length) return listArg(o.values);
  if (Array.isArray(o.members) && o.members.length) return listArg(o.members);
  if (o.input !== undefined || o.file) {
    const v = jsonArg(o, what);
    return Array.isArray(v) ? v : [v];
  }
  if (o.value !== undefined) {
    const v = valueArg(o);
    return Array.isArray(v) ? v : [v];
  }
  console.error(`missing ${what} (use --value V, --values a,b, or --data '[...]')`);
  process.exit(2);
}
function textArg(o, positional, what = 'text') {
  if (o.text !== undefined) return String(o.text);
  if (o.input !== undefined) {
    const raw = String(o.input);
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : parsed;
    } catch {
      try { return readJson(raw); } catch { return raw; }
    }
  }
  if (o.file) return readJson(o.file);
  if (positional) return String(positional);
  console.error(`missing ${what} (pass it as an argument or --text '<value>')`);
  process.exit(2);
}
function listArg(v) {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
}
function kvList(v) {
  const pairs = v === undefined ? [] : (Array.isArray(v) ? v : [v]);
  const out = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) throw new Error(`bad key=value '${pair}'`);
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}
function queryOf(pairs) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}
function numOpt(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got '${v}'`);
  return n;
}
function intOpt(v) {
  const n = numOpt(v);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) throw new Error(`expected an integer, got '${v}'`);
  return n;
}
function boolFlag(v) {
  return v === true || v === 'true' || v === '1';
}
function enc(v, name) {
  return encodeURIComponent(need(v, name));
}

// ---------- output ----------
function out(data, opts, pick) {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data === null || data === undefined) {
    console.log('(empty)');
    return;
  }
  if (Array.isArray(data)) {
    if (!data.length) {
      console.log('(empty)');
      return;
    }
    if (data.every((x) => x === null || typeof x !== 'object')) {
      for (const row of data) console.log(fmt(row));
      return;
    }
    const cols = pick || Object.keys(data[0]).filter((k) => !/document|context/i.test(k));
    console.log(cols.join('\t'));
    for (const row of data) {
      console.log(cols.map((c) => fmt(row[c])).join('\t'));
    }
    return;
  }
  if (typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) console.log(`${k}: ${fmt(v)}`);
    return;
  }
  console.log(String(data));
}
function fmt(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
}
function need(v, name) {
  if (!v) {
    console.error(`missing <${name}>`);
    process.exit(2);
  }
  return v;
}

// ---------- args ----------
// Additional flags are table-driven so adding a command never means growing
// the if/else chain below. Existing flags keep their explicit parsing above.
const FLAG_TARGETS = {
  prefix: 'prefix', cursor: 'cursor', value: 'value', 'value-file': 'valueFile',
  ttl: 'ttl', 'ttl-seconds': 'ttl', by: 'by', start: 'start', stop: 'stop', end: 'end', count: 'count',
  'max-len': 'maxLen', 'retention-ms': 'retentionMs', 'min-id': 'minId', 'from-id': 'fromId',
  'block-ms': 'blockMs', 'start-id': 'startId', side: 'side', member: 'member',
  payload: 'payload', delay: 'delay', 'delay-seconds': 'delay', 'dedupe-key': 'dedupeKey',
  'max-attempts': 'maxAttempts', 'visibility-timeout': 'visibilityTimeout',
  'wait-seconds': 'waitSeconds', 'wait-ms': 'waitMs', consumer: 'consumer',
  header: 'headers', members: 'members', values: 'values', receipt: 'receipts', ids: 'ids',
  channel: 'channel', channels: 'channels', to: 'to', recipient: 'recipient',
  subject: 'subject', body: 'body', 'body-file': 'bodyFile', 'idempotency-key': 'idempotencyKey',
  collection: 'collections', collections: 'collections', filter: 'filters', filters: 'filtersJson',
  output: 'output', 'content-type': 'contentType', expires: 'expires', delimiter: 'delimiter',
  'quota-bytes': 'quotaBytes', part: 'part', 'upload-id': 'uploadId',
  sql: 'sql', column: 'columns', description: 'description', 'stream-topic': 'streamTopic', 'source-bucket': 'sourceBucket',
  'stream-group': 'streamGroup', 'batch-size': 'batchSize', 'interval-ms': 'intervalMs',
  'write-mode': 'writeMode', 'max-per-collection': 'maxPerCollection',
  assignee: 'assignee', deadline: 'deadline', note: 'note', decision: 'decision',
  role: 'roles', 'candidate-role': 'candidateRoles', 'decision-schema': 'decisionSchema',
  title: 'title', node: 'node', 'execution-id': 'executionId',
  feature: 'feature', 'status-class': 'statusClass', q: 'q', from: 'from', text: 'text',
  'secret-version': 'secretVersion', scope: 'secretScope', 'lock-token': 'lockToken',
  message: 'messages', system: 'system', model: 'model', temperature: 'temperature',
  'max-tokens': 'maxTokens', dimensions: 'dimensions', instruction: 'instruction',
  choice: 'choices', questions: 'questions', state: 'state', history: 'history',
  'job-type': 'jobType', 'timeout-ms': 'timeoutMs', question: 'question', dataset: 'dataset',
  key: 'key', error: 'error', headers: 'headers',
};
const LIST_FLAGS = new Set(['collections', 'filters', 'columns', 'roles', 'candidateRoles', 'messages', 'choices', 'headers', 'members', 'values', 'receipts', 'ids']);
const BOOL_FLAGS = {
  ready: 'ready', 'with-scores': 'withScores', rev: 'rev', force: 'force', stats: 'stats',
  'no-requeue': 'noRequeue', requeue: 'requeue', 'if-not-exists': 'ifNotExists', 'if-exists': 'ifExists',
  'reset-attempts': 'resetAttempts', 'with-stats': 'withStats', 'auto-ack': 'autoAck',
  'include-data': 'includeData', unsubscribed: 'unsubscribed',
};

function parse(argv) {
  const args = [];
  const opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--ready') opts.ready = true;
    else if (a === '--base' || a === '--token' || a === '--apikey') opts[a.slice(2)] = argv[++i];
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else if (a.startsWith('--token=')) opts.token = a.slice(8);
    else if (a.startsWith('--apikey=')) opts.apikey = a.slice(9);
    else if (a.startsWith('--context=')) contextOpt(opts, a.slice(10));
    else if (a === '--context') {
      const v = argv[++i];
      if (!v) throw new Error('missing value for --context k=v');
      contextOpt(opts, v);
    }
    else if (a === '--file') opts.file = argv[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice(7);
    else if (a.startsWith('--limit=')) opts.limit = a.slice(8);
    else if (a === '--limit') opts.limit = argv[++i];
    else if (a.startsWith('--actor=')) opts.actor = a.slice(8);
    else if (a === '--actor') opts.actor = argv[++i];
    else if (a.startsWith('--name=')) opts.name = a.slice(7);
    else if (a === '--name') opts.name = argv[++i];
    else if (a.startsWith('--template=')) opts.template = a.slice(11);
    else if (a === '--template') opts.template = argv[++i];
    else if (a.startsWith('--email=')) opts.email = a.slice(8);
    else if (a === '--email') opts.email = argv[++i];
    else if (a.startsWith('--org=')) opts.org = a.slice(6);
    else if (a === '--org') opts.org = argv[++i];
    else if (a === '--label') opts.label = argv[++i];
    else if (a.startsWith('--label=')) opts.label = a.slice(8);
    else if (a === '--input') opts.input = argv[++i];
    else if (a.startsWith('--input=')) opts.input = a.slice(8);
    else if (a === '--data') opts.input = argv[++i];
    else if (a.startsWith('--data=')) opts.input = a.slice(7);
    else if (a === '--offset') opts.offset = argv[++i];
    else if (a.startsWith('--offset=')) opts.offset = a.slice(9);
    else if (a === '--status') opts.status = argv[++i];
    else if (a.startsWith('--status=')) opts.status = a.slice(9);
    else if (a === '--triggered-by') opts.triggeredBy = argv[++i];
    else if (a.startsWith('--triggered-by=')) opts.triggeredBy = a.slice(15);
    else if (a === '--workflow') opts.workflow = argv[++i];
    else if (a.startsWith('--workflow=')) opts.workflow = a.slice(11);
    else if (a === '--workflowId' || a === '--workflow-id') opts.workflow = argv[++i];
    else if (a.startsWith('--workflowId=')) opts.workflow = a.slice(13);
    else if (a.startsWith('--workflow-id=')) opts.workflow = a.slice(14);
    else if (a === '--include-data' || a === '--includeData') opts.includeData = 'true';
    else if (a.startsWith('--include-data=')) opts.includeData = a.slice(15);
    else if (a === '--wait') opts.wait = true;
    else if (a === '--timeout') opts.timeout = argv[++i];
    else if (a.startsWith('--timeout=')) opts.timeout = a.slice(10);
    else if (a === '--account') opts.account = argv[++i];
    else if (a.startsWith('--account=')) opts.account = a.slice(10);
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a.startsWith('--mode=')) opts.mode = a.slice(7);
    else if (a === '--queue') opts.queue = argv[++i];
    else if (a.startsWith('--queue=')) opts.queue = a.slice(8);
    else if (a === '--scopes') opts.scopes = argv[++i];
    else if (a.startsWith('--scopes=')) opts.scopes = a.slice(9);
    else if (a === '--runner-key') opts.runnerKey = argv[++i];
    else if (a.startsWith('--runner-key=')) opts.runnerKey = a.slice(13);
    else if (a.startsWith('--includeData=')) opts.includeData = a.slice(14);
    else if (a === '--path') opts.path = argv[++i];
    else if (a.startsWith('--path=')) opts.path = a.slice(7);
    else if (a === '--method') opts.method = argv[++i];
    else if (a.startsWith('--method=')) opts.method = a.slice(9);
    else if (a === '--type') opts.credType = argv[++i];
    else if (a.startsWith('--type=')) opts.credType = a.slice(7);
    else if (a === '--secret') opts.secret = argv[++i];
    else if (a.startsWith('--secret=')) opts.secret = a.slice(9);
    else if (a === '--secret-file') opts.secretFile = argv[++i];
    else if (a.startsWith('--secret-file=')) opts.secretFile = a.slice(14);
    else if (a === '--expires-at') opts.expiresAt = argv[++i];
    else if (a.startsWith('--expires-at=')) opts.expiresAt = a.slice(13);
    else if (a.startsWith('--account=')) opts.account = a.slice(10);
    else if (a === '--account') opts.account = argv[++i];
    else if (a === '--entity-type' || a === '--entityType') opts.entityType = argv[++i];
    else if (a.startsWith('--entity-type=')) opts.entityType = a.slice(14);
    else if (a.startsWith('--entityType=')) opts.entityType = a.slice(13);
    else if (a.startsWith('--license=')) opts.license = a.slice(10);
    else if (a === '--license') opts.license = argv[++i];
    else if (a.startsWith('--slug=')) opts.slug = a.slice(7);
    else if (a === '--slug') opts.slug = argv[++i];
    else if (a.startsWith('--visibility=')) opts.visibility = a.slice(13);
    else if (a === '--visibility') opts.visibility = argv[++i];
    else if (a.startsWith('--description=')) opts.description = a.slice(14);
    else if (a === '--description') opts.description = argv[++i];
    else if (a === '--vector') opts.vector = argv[++i];
    else if (a.startsWith('--vector=')) opts.vector = a.slice(9);
    else if (a === '--query') opts.query = argv[++i];
    else if (a.startsWith('--query=')) opts.query = a.slice(8);
    else if (a === '--metric') opts.metric = argv[++i];
    else if (a.startsWith('--metric=')) opts.metric = a.slice(9);
    else if (a === '--field') opts.field = argv[++i];
    else if (a.startsWith('--field=')) opts.field = a.slice(8);
    else if (a === '--where') opts.where = argv[++i];
    else if (a.startsWith('--where=')) opts.where = a.slice(8);
    else if (a === '--mapping') opts.mapping = argv[++i];
    else if (a.startsWith('--mapping=')) opts.mapping = a.slice(10);
    else if (a === '--as') opts.as = argv[++i];
    else if (a.startsWith('--as=')) opts.as = a.slice(5);
    else if (a === '--id') opts.docId = argv[++i];
    else if (a.startsWith('--id=')) opts.docId = a.slice(5);
    // Explicit aliases for NGSI-LD @context URLs (see contextOpt above).
    else if (a.startsWith('--context-url=')) (opts.contextUrls ??= []).push(a.slice(14));
    else if (a === '--context-url' || a === '--contexts') {
      const v = argv[++i];
      if (!v) throw new Error('missing value for --context-url <url>');
      (opts.contextUrls ??= []).push(v);
    }
    // Token management flags.
    else if (a === '--grace') opts.grace = argv[++i];
    else if (a.startsWith('--grace=')) opts.grace = a.slice(8);
    else if (a === '--scopes') opts.scopes = argv[++i];
    else if (a.startsWith('--scopes=')) opts.scopes = a.slice(9);
    else if (a === '--user') opts.user = argv[++i];
    else if (a.startsWith('--user=')) opts.user = a.slice(7);
    else if (a === '--managed') opts.managed = argv[++i];
    else if (a.startsWith('--managed=')) opts.managed = a.slice(10);
    // Sign-in and MFA flags.
    else if (a === '--password') opts.password = argv[++i];
    else if (a.startsWith('--password=')) opts.password = a.slice(11);
    else if (a === '--code') opts.code = argv[++i];
    else if (a.startsWith('--code=')) opts.code = a.slice(7);
    else if (a === '--recovery-code') opts['recovery-code'] = argv[++i];
    else if (a.startsWith('--recovery-code=')) opts['recovery-code'] = a.slice(16);
    else if (a.startsWith('--')) {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
      const name = m ? m[1] : '';
      if (m && Object.prototype.hasOwnProperty.call(BOOL_FLAGS, name) && m[2] === undefined) {
        opts[BOOL_FLAGS[name]] = true;
      } else if (m && Object.prototype.hasOwnProperty.call(FLAG_TARGETS, name)) {
        const target = FLAG_TARGETS[name];
        const value = m[2] !== undefined ? m[2] : argv[++i];
        if (value === undefined) throw new Error(`missing value for --${name}`);
        if (LIST_FLAGS.has(target)) (opts[target] ??= []).push(value);
        else opts[target] = value;
      } else {
        args.push(a);
      }
    }
    else args.push(a);
  }
  return { args, opts };
}
function parseKV(s) {
  const i = s.indexOf('=');
  if (i < 0) throw new Error(`bad --context '${s}' (want k=v)`);
  return { [s.slice(0, i)]: s.slice(i + 1) };
}
function contextOpt(o, v) {
  // `--context https://...` is an NGSI-LD @context URL (repeatable, LDS);
  // `--context key=value` keeps its existing authz/sim decision-context meaning.
  if (/^https?:\/\//i.test(v)) (o.contextUrls ??= []).push(v);
  else (o.context ??= {}), Object.assign(o.context, parseKV(v));
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function readJsonArg(o, what) {
  // Inline JSON via --data (or --input), else a file via --file (workflows exec style).
  if (o.input) {
    try { return JSON.parse(o.input); }
    catch { return readJson(o.input); }
  }
  if (o.file) return readJson(o.file);
  console.error(`missing ${what} (use --file <json> or --data '<json>')`);
  process.exit(2);
}

// ---------- commands ----------
async function cmdLogin(o) {
  const email = o.email || o._[0];
  need(email, 'email');
  const org = o.org || o._[1] || 'acme';
  const body = { email, orgSlug: org };
  if (o.password) body.password = String(o.password);
  let r;
  try {
    r = await POST('/v1/auth/login', body, o);
  } catch (e) {
    if (e.status !== 401 || e.data?.error !== 'mfa_required') throw e;
    const code = o.code ? String(o.code) : '';
    const recoveryCode = o['recovery-code'] ? String(o['recovery-code']) : '';
    if (!code && !recoveryCode) {
      throw new Error('this account uses MFA: run login again with --code <6 digits> or --recovery-code <code>');
    }
    r = await POST('/v1/auth/mfa/verify', { mfaToken: e.data.mfaToken, ...(code ? { code } : { recoveryCode }) }, o);
  }
  const cfg = loadConfig();
  cfg.baseUrl = baseUrl(o);
  cfg.token = r.accessToken;
  if (r.refreshToken) cfg.refreshToken = r.refreshToken;
  delete cfg.apiKey;
  saveConfig(cfg);
  if (!o.json) console.log(`logged in as ${r.user.email} (token saved to ${CONF_FILE})`);
  else console.log(JSON.stringify(r, null, 2));
}
async function cmdUseKey(o) {
  const key = o._[0];
  need(key, 'key');
  const cfg = loadConfig();
  cfg.baseUrl = baseUrl(o);
  cfg.apiKey = key;
  delete cfg.token;
  saveConfig(cfg);
  if (!o.json) console.log(`api key saved to ${CONF_FILE}`);
}
async function cmdMe(o) {
  out(await GET('/v1/auth/me', o), o);
}
async function cmdHealth(o) {
  const path = o.ready ? '/ready' : '/health';
  const r = await fetch(baseUrl(o) + path, { headers: authHeaders(o) });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`non-JSON response from ${baseUrl(o)}${path}: use https://api.synapseone.space`);
  }
  if (r.status >= 500 && r.status !== 503) throw httpError(r.status, path, data);
  if (o.json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (o.ready && data && Array.isArray(data.upstreams)) {
    console.log(`status: ${data.status}  (${data.service || 'gateway'} v${data.version || '?'})`);
    for (const u of data.upstreams) {
      console.log(`  ${u.ok ? 'ok  ' : 'FAIL'} ${u.name}${u.status ? ` status=${u.status}` : ''}${typeof u.ms === 'number' ? ` ${u.ms}ms` : ''}`);
    }
  } else {
    for (const [k, v] of Object.entries(data || {})) console.log(`${k}: ${fmt(v)}`);
  }
  // Degraded readiness is a non-zero exit so probes/scripts can gate on it.
  if (o.ready && data && data.status !== 'ready') process.exitCode = 3;
}
async function cmdOrgs(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') return out(await GET('/v1/orgs', o), o, ['slug', 'display_name', 'id']);
  if (sub === 'create') {
    const [slug, name] = rest;
    need(slug, 'slug');
    return out(await POST('/v1/orgs', { slug, displayName: name || slug }, o), o);
  }
  throw new Error(`unknown orgs subcommand '${sub}'`);
}
async function orgId(o, maybeId) {
  if (maybeId) return maybeId;
  const orgs = await GET('/v1/orgs', o);
  if (!orgs.length) throw new Error('no organizations (login first?)');
  const bySlug = orgs.find((x) => x.slug === (process.env.DEMO_ORG_SLUG || 'acme'));
  return (bySlug || orgs[0]).id;
}
async function cmdAccounts(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    const org = rest.length > 1 ? rest[0] : await orgId(o);
    const slug = rest.length > 1 ? rest[1] : rest[0];
    const name = rest.length > 2 ? rest[2] : slug;
    need(slug, 'slug');
    return out(await POST(`/v1/orgs/${org}/accounts`, { slug, displayName: name }, o), o);
  }
  const org = sub && sub !== 'list' ? sub : await orgId(o);
  return out(await GET(`/v1/orgs/${encodeURIComponent(org)}/accounts`, o), o, ['slug', 'display_name', 'id']);
}
async function cmdUsers(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    const [org, email, name] = rest;
    need(org, 'org'); need(email, 'email');
    return out(await POST(`/v1/orgs/${encodeURIComponent(org)}/users`, { email, displayName: name || email }, o), o);
  }
  if (sub === 'policies') {
    need(rest[0], 'user-id');
    return out(await GET(`/v1/users/${encodeURIComponent(rest[0])}/policies`, o), o);
  }
  const org = await orgId(o, sub && sub !== 'list' ? sub : undefined);
  return out(await GET(`/v1/orgs/${encodeURIComponent(org)}/users`, o), o, ['email', 'display_name', 'id']);
}
async function cmdRefresh(o) {
  const cfg = loadConfig();
  const rt = o._[0] || (process.env.SYNAPSEONE_REFRESH_TOKEN || process.env.SYNAPSEDX_REFRESH_TOKEN) || cfg.refreshToken;
  need(rt, 'refresh-token (arg | $SYNAPSEONE_REFRESH_TOKEN)');
  const r = await POST('/v1/auth/refresh', { refreshToken: rt }, o);
  cfg.baseUrl = baseUrl(o);
  cfg.token = r.accessToken;
  if (r.refreshToken) cfg.refreshToken = r.refreshToken;
  delete cfg.apiKey;
  saveConfig(cfg);
  if (!o.json) console.log(`token rotated (saved to ${CONF_FILE})`);
  else console.log(JSON.stringify(r, null, 2));
}
async function cmdLogoutAll(o) {
  const cfg = loadConfig();
  const rt = o._[0] || (process.env.SYNAPSEONE_REFRESH_TOKEN || process.env.SYNAPSEDX_REFRESH_TOKEN) || cfg.refreshToken;
  need(rt, 'refresh-token (arg | $SYNAPSEONE_REFRESH_TOKEN)');
  const r = await POST('/v1/auth/logout-all', { refreshToken: rt }, o);
  delete cfg.refreshToken;
  saveConfig(cfg);
  out(r, o);
}
async function cmdVerify(o) {
  out(await GET('/v1/auth/verify', o), o);
}
async function cmdRoles(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    const [account, slug] = rest;
    need(account, 'account'); need(slug, 'slug');
    return out(await POST(`/v1/accounts/${encodeURIComponent(account)}/roles`, { slug }, o), o);
  }
  if (sub === 'delete') {
    need(rest[0], 'role-id');
    return out(await DEL(`/v1/roles/${encodeURIComponent(rest[0])}`, o), o);
  }
  need(sub, 'account');
  return out(await GET(`/v1/accounts/${encodeURIComponent(sub)}/roles`, o), o, ['slug', 'id']);
}
async function cmdPolicies(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    const [account, slug] = rest;
    need(account, 'account'); need(slug, 'slug');
    if (o.managed) return out(await POST(`/v1/accounts/${encodeURIComponent(account)}/policies`, { slug, managed: o.managed }, o), o);
    need(o.file, '--file policy.json (or --managed NAME)');
    return out(await POST(`/v1/accounts/${encodeURIComponent(account)}/policies`, { slug, document: readJson(o.file) }, o), o);
  }
  if (sub === 'delete') {
    need(rest[0], 'policy-id');
    return out(await DEL(`/v1/policies/${encodeURIComponent(rest[0])}`, o), o);
  }
  need(sub, 'account');
  return out(await GET(`/v1/accounts/${encodeURIComponent(sub)}/policies`, o), o, ['slug', 'id']);
}
async function cmdAttach(o) {
  need(o._[0], 'role-id'); need(o._[1], 'policy-id');
  return out(await POST(`/v1/roles/${encodeURIComponent(o._[0])}/attach`, { policyId: o._[1] }, o), o);
}
async function cmdDetach(o) {
  need(o._[0], 'role-id'); need(o._[1], 'policy-id');
  return out(await DEL(`/v1/roles/${encodeURIComponent(o._[0])}/policies/${encodeURIComponent(o._[1])}`, o), o);
}
async function cmdAssign(o) {
  need(o._[0], 'user-id'); need(o._[1], 'role-id');
  return out(await POST(`/v1/users/${encodeURIComponent(o._[0])}/assign`, { roleId: o._[1] }, o), o);
}
async function cmdUnassign(o) {
  need(o._[0], 'user-id'); need(o._[1], 'role-id');
  return out(await DEL(`/v1/users/${encodeURIComponent(o._[0])}/roles/${encodeURIComponent(o._[1])}`, o), o);
}
async function cmdAuthz(o) {
  const [user, action, resource] = o._;
  need(user, 'user-id'); need(action, 'action'); need(resource, 'resource');
  return out(await POST('/v1/authorize', { userId: user, action, resource, context: o.context }, o), o);
}
async function cmdSim(o) {
  need(o.file, '--file policy.json');
  const [action, resource] = o._;
  need(action, 'action'); need(resource, 'resource');
  const raw = readJson(o.file);
  const docs = Array.isArray(raw) ? raw : [raw];
  return out(await POST('/v1/authorize/dry-run', { documents: docs, action, resource, context: o.context }, o), o);
}
async function cmdAudit(o) {
  const qs = `?limit=${o.limit || 50}${o.actor ? `&actor=${encodeURIComponent(o.actor)}` : ''}`;
  return out(await GET(`/v1/audit${qs}`, o), o, ['created_at', 'actor_id', 'action', 'decision']);
}
async function cmdKeys(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    need(rest[0], 'account');
    const scopes = o.scopes ? String(o.scopes).split(',').map((x) => x.trim()).filter(Boolean) : ['*'];
    const body = { name: o.name || o.label || 'cli', scopes, ...(o.user ? { userId: o.user } : {}) };
    const r = await POST(`/v1/accounts/${encodeURIComponent(rest[0])}/keys`, body, o);
    // The new secret is printed to stdout once, on purpose (never to a log).
    if (!o.json) process.stdout.write(`SAVE THIS KEY (shown once):\n${r.apiKey}\nid: ${r.id}\n`);
    else process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  if (sub === 'rotate') {
    need(rest[0], 'key-id');
    const graceSeconds = o.grace === undefined ? 0 : Number(o.grace);
    if (!Number.isInteger(graceSeconds) || graceSeconds < 0) throw new Error('--grace must be a non-negative integer (seconds)');
    const r = await POST(`/v1/keys/${encodeURIComponent(rest[0])}/rotate`, { graceSeconds }, o);
    // The new secret is printed to stdout once, on purpose (never to a log).
    if (!o.json) process.stdout.write(`SAVE THIS KEY (shown once):\n${r.apiKey}\nid: ${r.id}\nold key ${r.rotatedFrom} expires at ${r.oldKeyExpiresAt}\n`);
    else process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  if (sub === 'revoke' || sub === 'delete') {
    need(rest[0], 'key-id');
    return out(await DEL(`/v1/keys/${encodeURIComponent(rest[0])}`, o), o);
  }
  if (sub === 'verify') {
    need(rest[0] || o.apikey, 'api-key (arg or --apikey)');
    return out(await POST('/v1/keys/verify', { apiKey: rest[0] || o.apikey }, o), o);
  }
  if (sub === 'list') {
    need(rest[0], 'account');
    const r = await GET(`/v1/accounts/${encodeURIComponent(rest[0])}/keys`, o);
    return out(Array.isArray(r) ? r : [], o, ['id', 'name', 'prefix', 'scopes', 'user_id', 'last_used_at', 'revoked_at']);
  }
  throw new Error(`usage: keys create <account> [--name N] [--scopes a,b] [--user USER_ID] | keys list <account> | keys rotate <key-id> [--grace SECONDS] | keys revoke <key-id> | keys verify <api-key>`);
}
async function cmdSa(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    need(rest[0], 'account'); need(rest[1], 'slug');
    return out(await POST(`/v1/accounts/${encodeURIComponent(rest[0])}/service-accounts`, { slug: rest[1] }, o), o);
  }
  if (sub === 'token') {
    need(rest[0], 'sa-id');
    const r = await POST(`/v1/service-accounts/${encodeURIComponent(rest[0])}/token`, {}, o);
    if (!o.json) console.log(`SAVE THIS TOKEN (short-lived):\n${r.accessToken}`);
    else console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (sub === 'roles') {
    need(rest[0], 'sa-id');
    return out(await GET(`/v1/service-accounts/${encodeURIComponent(rest[0])}/roles`, o), o, ['slug', 'id']);
  }
  if (sub === 'grant') {
    need(rest[0], 'sa-id'); need(rest[1], 'role-id');
    return out(await POST(`/v1/service-accounts/${encodeURIComponent(rest[0])}/roles`, { roleId: rest[1] }, o), o);
  }
  if (sub === 'revoke-role') {
    need(rest[0], 'sa-id'); need(rest[1], 'role-id');
    return out(await DEL(`/v1/service-accounts/${encodeURIComponent(rest[0])}/roles/${encodeURIComponent(rest[1])}`, o), o);
  }
  need(sub, 'account');
  return out(await GET(`/v1/accounts/${encodeURIComponent(sub)}/service-accounts`, o), o, ['slug', 'id']);
}

// ---------- token management: sessions, org admins, managed policies ----------
async function cmdSessions(o) {
  const [sub, ...rest] = o._;
  if (sub === 'revoke') {
    need(rest[0], 'session-id');
    return out(await DEL(`/v1/auth/sessions/${encodeURIComponent(rest[0])}`, o), o);
  }
  if (sub && sub !== 'list') throw new Error('usage: sessions [list] | sessions revoke <session-id>');
  return out(await GET('/v1/auth/sessions', o), o, ['id', 'created_at', 'expires_at']);
}
async function cmdMfa(o) {
  const [sub, arg] = o._;
  const code = o.code ? String(o.code) : undefined;
  const recoveryCode = o['recovery-code'] ? String(o['recovery-code']) : undefined;
  if (!sub || sub === 'status') return out(await GET('/v1/auth/mfa', o), o);
  if (sub === 'setup') {
    const r = await POST('/v1/auth/mfa/totp/setup', {}, o);
    if (o.json) return out(r, o);
    process.stdout.write(`Add this account to your authenticator app, then run: mfa enable <code>\n  secret: ${r.secret}\n  url:    ${r.otpauthUrl}\n`);
    return;
  }
  if (sub === 'enable') {
    need(arg || code, 'code');
    const r = await POST('/v1/auth/mfa/totp/enable', { code: arg || code }, o);
    if (o.json) return out(r, o);
    process.stdout.write(`MFA enabled. Store these recovery codes safely (shown once):\n  ${r.recoveryCodes.join('\n  ')}\n`);
    return;
  }
  if (sub === 'recovery-codes') {
    need(arg || code, 'code');
    return out(await POST('/v1/auth/mfa/recovery-codes', { code: arg || code }, o), o);
  }
  if (sub === 'disable') {
    if (!code && !recoveryCode) throw new Error('usage: mfa disable --code <6 digits> | --recovery-code <code>');
    return out(await POST('/v1/auth/mfa/disable', code ? { code } : { recoveryCode }, o), o);
  }
  if (sub === 'reset') {
    need(arg, 'user-id');
    return out(await DEL(`/v1/users/${encodeURIComponent(arg)}/mfa`, o), o);
  }
  if (sub === 'unlock') {
    need(arg, 'user-id');
    return out(await POST(`/v1/users/${encodeURIComponent(arg)}/unlock`, {}, o), o);
  }
  throw new Error('usage: mfa [status] | mfa setup | mfa enable <code> | mfa recovery-codes <code> | mfa disable --code C | mfa reset <user-id> | mfa unlock <user-id>');
}
async function cmdOrgAdmin(o) {
  const [userId, flag] = o._;
  need(userId, 'user-id');
  if (flag !== 'on' && flag !== 'off') throw new Error('usage: org-admin <user-id> on|off');
  return out(await req('PUT', `/v1/users/${encodeURIComponent(userId)}/org-admin`, { isOrgAdmin: flag === 'on' }, o), o);
}
async function cmdManagedPolicies(o) {
  return out(await GET('/v1/managed-policies', o), o, ['name', 'description']);
}

async function cmdWorkflows(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') {
    const r = await GET('/v1/workflows', o);
    return out(Array.isArray(r) ? r : r.data || r, o, ['id', 'name', 'active']);
  }
  if (sub === 'create') {
    if (o.template) {
      return out(await POST('/v1/workflows', { template: o.template, name: o.name }, o), o);
    }
    if (o.file) {
      const raw = readJson(o.file);
      // Accept either a full body ({template|definition, name}) or a bare definition.
      const body = raw && (raw.template || raw.definition) ? raw : { name: o.name || 'synapseone-workflow', definition: raw };
      if (o.name && !body.name) body.name = o.name;
      return out(await POST('/v1/workflows', body, o), o);
    }
    throw new Error(`workflows create needs --template T [--name N] or --file definition.json [--name N]`);
  }
  if (['get', 'activate', 'deactivate'].includes(sub)) {
    need(rest[0], 'workflow-id');
    const method = sub === 'get' ? 'GET' : 'POST';
    const suf = sub === 'get' ? '' : `/${sub}`;
    const id = encodeURIComponent(rest[0]);
    if (method === 'GET') return out(await GET(`/v1/workflows/${id}`, o), o);
    return out(await req('POST', `/v1/workflows/${id}${suf}`, {}, o), o);
  }
  if (sub === 'exec' || sub === 'execute') {
    need(rest[0], 'workflow-id');
    let payload = {};
    if (o.input) {
      try { payload = JSON.parse(o.input); }
      catch { payload = readJson(o.input); }
    } else if (o.file) {
      const raw = readJson(o.file);
      payload = raw && raw.input !== undefined ? raw.input : raw;
    }
    return out(await POST(`/v1/workflows/${encodeURIComponent(rest[0])}/execute${o.wait ? `?wait=1&timeoutMs=${encodeURIComponent(o.timeout || 60000)}` : ''}`, payload, o), o);
  }
  if (sub === 'test-run' || sub === 'testrun' || sub === 'try') {
    // Try a definition without saving: POST /v1/workflows/test-run {definition, input}.
    // --file def.json (required): a bare {nodes, connections} definition or {definition, input}.
    // --input input.json|'{"k":v}': extra run input (merged, --input wins on conflict).
    // --workflow-id ID: attach the run to a saved workflow's history.
    need(o.file, '--file def.json');
    const raw = readJson(o.file);
    const definition = raw && raw.definition ? raw.definition : raw;
    let input = raw && raw.input !== undefined && !o.input ? raw.input : {};
    if (o.input) {
      try { input = JSON.parse(o.input); }
      catch { input = readJson(o.input); }
    }
    const body = { definition, input };
    if (o.workflow) body.workflowId = String(o.workflow);
    return out(await POST('/v1/workflows/test-run', body, o), o);
  }
  if (sub === 'update') {
    need(rest[0], 'workflow-id');
    const patch = {};
    if (o.name) patch.name = o.name;
    if (o.file) {
      const raw = readJson(o.file);
      patch.definition = raw && raw.definition ? raw.definition : raw;
    }
    if (!patch.name && !patch.definition) {
      throw new Error(`workflows update needs --name N and/or --file definition.json`);
    }
    return out(await req('PUT', `/v1/workflows/${encodeURIComponent(rest[0])}`, patch, o), o);
  }
  if (sub === 'delete' || sub === 'rm') {
    need(rest[0], 'workflow-id');
    return out(await DEL(`/v1/workflows/${encodeURIComponent(rest[0])}`, o), o);
  }
  throw new Error(`unknown workflows subcommand '${sub}'`);
}
async function cmdRunners(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') {
    const r = await GET('/v1/workflow-runners', o);
    const rows = (Array.isArray(r) ? r : r.data || r).map((x) => ({
      ...x,
      connectors: `${x.connectedInstances || 0}/${x.instanceCount || 0}`,
    }));
    return out(rows, o, ['id', 'name', 'mode', 'queue', 'connectors', 'status']);
  }
  if (sub === 'options') return out(await GET('/v1/workflow-runners/options', o), o);
  if (sub === 'instances') {
    need(rest[0], 'runner-id');
    const r = await GET(`/v1/workflow-runners/${encodeURIComponent(rest[0])}`, o);
    return out(r.runner?.instances || [], o, ['id', 'hostname', 'version', 'concurrency', 'status', 'lastSeenAt']);
  }
  if (sub === 'rm-instance') {
    need(rest[0], 'runner-id');
    need(rest[1], 'instance-id');
    return out(await DEL(`/v1/workflow-runners/${encodeURIComponent(rest[0])}/instances/${encodeURIComponent(rest[1])}`, o), o);
  }
  if (sub === 'create') {
    need(o.name, '--name');
    if (!o.account) throw new Error('runners create needs --account <account-id> (runner API keys are account-scoped)');
    const mode = o.mode === 'hybrid' ? 'hybrid' : 'custom';
    const scopes = (o.scopes || 'workflow:*,queue:*,*:read,base:query,base:vector-search,inference:*')
      .split(',').map((s) => s.trim()).filter(Boolean);
    // Mint the runner key (plaintext returned once) then register the runner.
    const key = await POST(`/v1/accounts/${encodeURIComponent(o.account)}/keys`, {
      name: `workflow-runner-${String(o.name).slice(0, 80)}`,
      scopes,
    }, o);
    const reg = await POST('/v1/workflow-runners', {
      name: o.name, mode, ...(o.queue ? { queue: o.queue } : {}),
      apiKeyId: key.id, keyPrefix: key.prefix, apiKey: key.apiKey, scopes,
    }, o);
    return out({ runner: reg.runner, apiKey: key.apiKey, command: reg.command }, o);
  }
  if (sub === 'get' || sub === 'connection' || sub === 'command' || sub === 'delete') {
    need(rest[0], 'runner-id');
    const id = encodeURIComponent(rest[0]);
    if (sub === 'get') return out(await GET(`/v1/workflow-runners/${id}`, o), o);
    if (sub === 'connection') return out(await GET(`/v1/workflow-runners/${id}/connection`, o), o);
    if (sub === 'command') return out(await POST(`/v1/workflow-runners/${id}/command`, o.runnerKey ? { apiKey: o.runnerKey } : {}, o), o);
    return out(await DEL(`/v1/workflow-runners/${id}`, o), o);
  }
  throw new Error(`unknown runners subcommand '${sub}'`);
}

async function cmdTemplates(o) {  const [sub, ...rest] = o._;
  if (sub && sub !== 'list') {
    return out(await GET(`/v1/templates/${encodeURIComponent(sub)}`, o), o);
  }
  if (sub === 'list' && rest[0]) {
    return out(await GET(`/v1/templates/${encodeURIComponent(rest[0])}`, o), o);
  }
  return out(await GET('/v1/templates', o), o, ['name', 'description']);
}
async function cmdExecutions(o) {
  const [sub, ...rest] = o._;
  if (sub && sub !== 'list') {
    const qs = o.includeData ? '?includeData=true' : '';
    return out(await GET(`/v1/executions/${encodeURIComponent(sub)}${qs}`, o), o);
  }
  // Allowlist mirrors GET /v1/executions: limit/offset/workflowId/status/triggeredBy/includeData.
  const qs = new URLSearchParams();
  if (o.limit) qs.set('limit', String(o.limit));
  if (o.offset) qs.set('offset', String(o.offset));
  if (o.workflow) qs.set('workflowId', String(o.workflow));
  if (o.status) qs.set('status', String(o.status));
  if (o.triggeredBy) qs.set('triggeredBy', String(o.triggeredBy));
  if (o.includeData) qs.set('includeData', String(o.includeData));
  const s = qs.toString();
  const r = await GET(`/v1/executions${s ? `?${s}` : ''}`, o);
  return out(Array.isArray(r) ? r : r.data || r, o, ['id', 'status', 'workflowId']);
}
async function cmdWebhook(o) {
  // Public inbound webhook: ANY /webhook/:path (no auth) triggers the ACTIVE
  // workflow whose webhook node declares that path. NOTE: the gateway does not
  // proxy /webhook/* — point --base at the workflow-service origin
  // (e.g. http://localhost:4002), not the gateway.
  const p = o._[0] || o.path;
  need(p, 'path (arg or --path <p>)');
  const clean = String(p).replace(/^\/+|\/+$/g, '').split('?')[0];
  let payload;
  if (o.input) {
    try { payload = JSON.parse(o.input); }
    catch { payload = readJson(o.input); }
  } else if (o.file) {
    payload = readJson(o.file);
  }
  const method = (o.method || (payload === undefined ? 'GET' : 'POST')).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
    throw new Error(`bad --method '${o.method}' (want GET|POST|PUT|PATCH|DELETE|HEAD)`);
  }
  const data = await req(method, `/webhook/${clean}`, payload, o);
  return out(data, o);
}
async function cmdConfig() {
  const cfg = loadConfig();
  const redacted = { file: CONF_FILE, baseUrl: cfg.baseUrl };
  if (cfg.token) redacted.token = '*** (saved)';
  if (cfg.apiKey) redacted.apiKey = '*** (saved)';
  if (cfg.refreshToken) redacted.refreshToken = '*** (saved)';
  console.log(JSON.stringify(redacted, null, 2));
}
function credentialSecret(o) {
  // Prefer --secret-file / env over --secret (flags leak via ps + shell history).
  if (o.secretFile) return fs.readFileSync(o.secretFile, 'utf8').trim();
  if (o.secret) return o.secret;
  if (process.env.SYNAPSEONE_CREDENTIAL_SECRET) return process.env.SYNAPSEONE_CREDENTIAL_SECRET;
  if (process.env.SYNAPSEDX_CREDENTIAL_SECRET) return process.env.SYNAPSEDX_CREDENTIAL_SECRET;
  throw new Error('missing credential secret (use --secret-file <path>, --secret <S>, or $SYNAPSEONE_CREDENTIAL_SECRET)');
}
async function cmdCredentials(o) {
  // Account-scoped secrets; PROPOSED contract (backend in progress): secrets are
  // encrypted at rest and NEVER returned — list/get return metadata only
  // {id, name, type, accountId, expiresAt, version}.
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    need(rest[0], 'account');
    need(o.name, '--name <name>');
    const type = o.credType || 'bearer';
    if (!['bearer', 'basic', 'apiKey', 'oauth2'].includes(type)) {
      throw new Error(`bad --type '${type}' (want bearer|basic|apiKey|oauth2)`);
    }
    const body = { name: o.name, type, secret: credentialSecret(o) };
    if (o.expiresAt) body.expiresAt = o.expiresAt;
    return out(await POST(`/v1/accounts/${encodeURIComponent(rest[0])}/credentials`, body, o), o);
  }
  if (!sub || sub === 'list') {
    const account = sub === 'list' ? rest[0] : sub;
    need(account, 'account');
    const r = await GET(`/v1/accounts/${encodeURIComponent(account)}/credentials`, o);
    return out(Array.isArray(r) ? r : r.data || r, o, ['id', 'name', 'type', 'version', 'expiresAt']);
  }
  if (sub === 'get') {
    need(rest[0], 'credential-id');
    return out(await GET(`/v1/credentials/${encodeURIComponent(rest[0])}`, o), o);
  }
  if (sub === 'delete' || sub === 'rm') {
    need(rest[0], 'credential-id');
    return out(await DEL(`/v1/credentials/${encodeURIComponent(rest[0])}`, o), o);
  }
  if (sub === 'rotate') {
    need(rest[0], 'credential-id');
    return out(await POST(`/v1/credentials/${encodeURIComponent(rest[0])}/rotate`, { secret: credentialSecret(o) }, o), o);
  }
  throw new Error(`unknown credentials subcommand '${sub}' (want create|list|get|delete|rotate)`);
}
async function cmdCall(o) {
  // Generic escape hatch: call any gateway endpoint directly.
  // Example: synapseone call GET /v1/accounts/acc123/credentials
  const [method, rawPath, ...extra] = o._;
  need(method, 'METHOD (GET|POST|PUT|PATCH|DELETE|HEAD)');
  need(rawPath, 'path (e.g. /v1/workflows)');
  if (extra.length) throw new Error(`unexpected args: ${extra.join(' ')}`);
  const m = String(method).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) {
    throw new Error(`bad METHOD '${method}' (want GET|POST|PUT|PATCH|DELETE|HEAD)`);
  }
  if (!String(rawPath).startsWith('/')) throw new Error(`path must start with '/' (got '${rawPath}')`);
  let body;
  if (o.input) {
    try { body = JSON.parse(o.input); }
    catch { body = readJson(o.input); }
  } else if (o.file) {
    body = readJson(o.file);
  }
  return out(await req(m, rawPath, body, o), o);
}

// ---------- lds (SynapseLDS, /v1/lds) ----------
const LDS = '/v1/lds';
const LDS_DS_COLS = ['id', 'slug', 'name', 'entityType', 'license', 'defaultVisibility'];
const LDS_ATTR_COLS = ['name', 'ngsiLdType', 'visibility', 'description'];

function ldsVisibility(v, allowed) {
  if (!allowed.split('|').includes(v)) throw new Error(`bad --visibility '${v}' (want ${allowed})`);
  return v;
}
function ldsId(v, name) {
  return encodeURIComponent(need(v, name));
}
async function cmdLds(o) {
  const [sub, ...rest] = o._;
  if (sub === 'licenses') {
    const r = await GET(`${LDS}/licenses`, o);
    return out(Array.isArray(r) ? r : r.data || r, o, ['id', 'name', 'openData']);
  }
  if (sub === 'datasources') return ldsDatasources(o, rest);
  if (sub === 'attributes') return ldsAttributes(o, rest);
  if (sub === 'ingest') return ldsIngest(o, rest);
  if (sub === 'entities') return ldsEntities(o, rest);
  if (sub === 'entity') return ldsEntity(o, rest);
  if (sub === 'stats') return ldsStats(o, rest);
  throw new Error(`usage: synapseone lds licenses | lds datasources [list|create|get|update|delete] | lds attributes [list|set] <id> | lds ingest <id> | lds entities <id> | lds entity <id> <entity-id> | lds stats <id>`);
}
async function ldsDatasources(o, args) {
  const [sub, ...rest] = args;
  if (!sub || sub === 'list') {
    const qs = new URLSearchParams();
    if (o.org) qs.set('orgId', String(o.org));
    if (o.account) qs.set('accountId', String(o.account));
    const s = qs.toString();
    const r = await GET(`${LDS}/datasources${s ? `?${s}` : ''}`, o);
    return out(Array.isArray(r) ? r : r.data || r, o, LDS_DS_COLS);
  }
  if (sub === 'create') {
    need(o.name, '--name <name>');
    need(o.entityType, '--entity-type <Type>');
    need(o.license, '--license <SPDX>');
    const body = { name: o.name, entityType: o.entityType, license: o.license };
    if (o.slug) body.slug = o.slug;
    if (o.contextUrls?.length) body.contexts = o.contextUrls;
    if (o.visibility) body.defaultVisibility = ldsVisibility(o.visibility, 'public|internal');
    if (o.description) body.description = o.description;
    return out(await POST(`${LDS}/datasources`, body, o), o);
  }
  if (sub === 'get') {
    return out(await GET(`${LDS}/datasources/${ldsId(rest[0], 'datasource-id')}`, o), o);
  }
  if (sub === 'update') {
    const id = ldsId(rest[0], 'datasource-id');
    const patch = {};
    if (o.name) patch.name = o.name;
    if (o.entityType) patch.entityType = o.entityType;
    if (o.license) patch.license = o.license;
    if (o.slug) patch.slug = o.slug;
    if (o.contextUrls?.length) patch.contexts = o.contextUrls;
    if (o.visibility) patch.defaultVisibility = ldsVisibility(o.visibility, 'public|internal');
    if (o.description) patch.description = o.description;
    if (!Object.keys(patch).length) {
      throw new Error('lds datasources update needs at least one of --name|--entity-type|--license|--slug|--context-url|--visibility|--description');
    }
    return out(await req('PATCH', `${LDS}/datasources/${id}`, patch, o), o);
  }
  if (sub === 'delete' || sub === 'rm') {
    return out(await DEL(`${LDS}/datasources/${ldsId(rest[0], 'datasource-id')}`, o), o);
  }
  throw new Error(`unknown lds datasources subcommand '${sub}' (want list|create|get|update|delete)`);
}
async function ldsAttributes(o, args) {
  const [sub, ...rest] = args;
  if (sub === 'set' || sub === 'put') {
    const id = ldsId(rest[0], 'datasource-id');
    const payload = readJsonArg(o, 'attributes JSON');
    const attributes = Array.isArray(payload) ? payload : payload && payload.attributes;
    if (!Array.isArray(attributes)) throw new Error('lds attributes set wants a JSON array or {"attributes":[...]}');
    return out(await req('PUT', `${LDS}/datasources/${id}/attributes`, { attributes }, o), o);
  }
  if (!sub || sub === 'list') {
    const r = await GET(`${LDS}/datasources/${ldsId(rest[0], 'datasource-id')}/attributes`, o);
    return out(Array.isArray(r) ? r : r.attributes || r.data || r, o, LDS_ATTR_COLS);
  }
  throw new Error(`unknown lds attributes subcommand '${sub}' (want list|set)`);
}
async function ldsIngest(o, args) {
  const id = ldsId(args[0], 'datasource-id');
  const record = readJsonArg(o, 'record JSON');
  return out(await POST(`${LDS}/datasources/${id}/records`, record, o), o);
}
async function ldsEntities(o, args) {
  const id = ldsId(args[0], 'datasource-id');
  const qs = new URLSearchParams();
  if (o.limit) qs.set('limit', String(o.limit));
  if (o.offset) qs.set('offset', String(o.offset));
  if (o.visibility) qs.set('visibility', ldsVisibility(o.visibility, 'public|restricted'));
  const s = qs.toString();
  const r = await GET(`${LDS}/datasources/${id}/entities${s ? `?${s}` : ''}`, o);
  // NGSI-LD documents: always JSON (table columns would mangle nested properties).
  console.log(JSON.stringify(r, null, 2));
}
async function ldsEntity(o, args) {
  const id = ldsId(args[0], 'datasource-id');
  const r = await GET(`${LDS}/datasources/${id}/entities/${ldsId(args[1], 'entity-id')}`, o);
  console.log(JSON.stringify(r, null, 2));
}
async function ldsStats(o, args) {
  return out(await GET(`${LDS}/datasources/${ldsId(args[0], 'datasource-id')}/stats`, o), o);
}

// ---------- SynapseBase ----------
const BASE = '/v1/base';
const BASE_COL_COLS = ['id', 'name', 'description', 'updatedAt'];
const BASE_DOC_COLS = ['id', 'version', 'createdAt', 'updatedAt'];
const BASE_VEC_COLS = ['id', 'similarity', 'distance'];

async function cmdBase(o) {
  const [sub, ...rest] = o._;
  if (sub === 'collections') return baseCollections(o, rest);
  if (sub === 'documents') return baseDocuments(o, rest);
  if (sub === 'vector-search' || sub === 'vectorSearch') return baseVectorSearch(o, rest);
  if (sub === 'query') return baseQuery(o, rest);
  throw new Error(`usage: synapseone base collections [list|create|get|delete] | base documents [list|insert|get|delete] <collection> | base vector-search <collection> | base query <collection>`);
}

async function baseCollections(o, args) {
  const [sub, name] = args;
  if (!sub || sub === 'list') {
    const r = await GET(`${BASE}/collections`, o);
    return out(Array.isArray(r) ? r : r.data || r, o, BASE_COL_COLS);
  }
  if (sub === 'create') {
    const colName = name || o.name;
    need(colName, 'collection name (arg or --name <name>)');
    let mapping;
    if (o.mapping) {
      try { mapping = JSON.parse(o.mapping); } catch { mapping = readJson(o.mapping); }
    } else if (o.file) {
      mapping = readJson(o.file);
    }
    const body = { name: colName };
    if (o.description) body.description = o.description;
    if (mapping) body.mapping = mapping;
    return out(await POST(`${BASE}/collections`, body, o), o);
  }
  if (sub === 'get') {
    need(name, 'collection name');
    return out(await GET(`${BASE}/collections/${encodeURIComponent(name)}`, o), o);
  }
  if (sub === 'delete' || sub === 'rm') {
    need(name, 'collection name');
    return out(await DEL(`${BASE}/collections/${encodeURIComponent(name)}`, o), o);
  }
  throw new Error(`unknown base collections subcommand '${sub}' (want list|create|get|delete)`);
}

async function baseDocuments(o, args) {
  const [sub, col, id] = args;
  if (sub === 'list') {
    need(col, 'collection name');
    const qs = new URLSearchParams();
    if (o.limit) qs.set('limit', String(o.limit));
    if (o.offset) qs.set('offset', String(o.offset));
    if (o.as) qs.set('as', String(o.as));
    const s = qs.toString();
    const r = await GET(`${BASE}/collections/${encodeURIComponent(col)}/documents${s ? `?${s}` : ''}`, o);
    return out(o.json ? r : r.items || (Array.isArray(r) ? r : r.data || r), o, BASE_DOC_COLS);
  }
  if (sub === 'insert' || sub === 'create') {
    need(col, 'collection name');
    const payload = readJsonArg(o, 'document JSON');
    const docId = id || o.docId || (payload && payload.id);
    const body = { ...payload };
    if (docId) body.id = docId;
    return out(await POST(`${BASE}/collections/${encodeURIComponent(col)}/documents`, body, o), o);
  }
  if (sub === 'get') {
    need(col, 'collection name');
    need(id, 'document id');
    const qs = o.as ? `?as=${encodeURIComponent(o.as)}` : '';
    return out(await GET(`${BASE}/collections/${encodeURIComponent(col)}/documents/${encodeURIComponent(id)}${qs}`, o), o);
  }
  if (sub === 'delete' || sub === 'rm') {
    need(col, 'collection name');
    need(id, 'document id');
    return out(await DEL(`${BASE}/collections/${encodeURIComponent(col)}/documents/${encodeURIComponent(id)}`, o), o);
  }
  throw new Error(`unknown base documents subcommand '${sub}' (want list|insert|get|delete)`);
}

async function baseVectorSearch(o, args) {
  const [col] = args;
  need(col, 'collection name');
  let vector;
  if (o.vector) {
    try { vector = JSON.parse(o.vector); } catch { vector = readJson(o.vector); }
  } else if (o.query) {
    const emb = await POST('/v1/inference/embeddings', { input: o.query }, o);
    vector = emb?.data?.[0]?.embedding || emb?.embedding;
  }
  if (!vector || !Array.isArray(vector)) {
    throw new Error('base vector-search requires --vector <json-array> or --query <text>');
  }
  const body = { vector };
  if (o.limit) body.limit = Number(o.limit);
  if (o.metric) body.metric = o.metric;
  if (o.field) body.field = o.field;
  if (o.as) body.as = o.as;
  if (o.where) {
    try { body.where = JSON.parse(o.where); } catch { body.where = readJson(o.where); }
  }
  const r = await POST(`${BASE}/collections/${encodeURIComponent(col)}/vector-search`, body, o);
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  return out(r.items || r, o, BASE_VEC_COLS);
}

async function baseQuery(o, args) {
  const [col] = args;
  need(col, 'collection name');
  const payload = readJsonArg(o, 'query JSON');
  const r = await POST(`${BASE}/collections/${encodeURIComponent(col)}/query`, payload, o);
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  return out(r.items || r, o, ['id', 'similarity', 'version', 'createdAt']);
}

// ---------- Synapse Faststore ----------
const FASTSTORE = '/v1/faststore';

function fsWriteOptions(o) {
  const body = {};
  if (o.ttl !== undefined) body.ttlSeconds = intOpt(o.ttl);
  if (o.ifNotExists) body.ifNotExists = true;
  if (o.ifExists) body.ifExists = true;
  return body;
}

async function cmdFaststore(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'stats') return out(await GET(`${FASTSTORE}/stats`, o), o);
  if (sub === 'keys') {
    const r = await GET(`${FASTSTORE}/keys${queryOf({ prefix: o.prefix, limit: o.limit, cursor: o.cursor })}`, o);
    if (o.json) return out(r, o);
    out(r.keys || r.items || r, o, ['key', 'type', 'ttlSeconds']);
    if (r.cursor) console.error(`next cursor: ${r.cursor}`);
    return;
  }
  if (sub === 'get') return out(await GET(`${FASTSTORE}/keys/${enc(rest[0], 'key')}`, o), o);
  if (sub === 'set' || sub === 'put') {
    const body = { value: valueArg(o), ...fsWriteOptions(o) };
    return out(await req('PUT', `${FASTSTORE}/keys/${enc(rest[0], 'key')}`, body, o), o);
  }
  if (sub === 'del' || sub === 'delete' || sub === 'rm') {
    return out(await DEL(`${FASTSTORE}/keys/${enc(rest[0], 'key')}`, o), o);
  }
  if (sub === 'ttl') return out(await GET(`${FASTSTORE}/keys/${enc(rest[0], 'key')}/ttl`, o), o);
  if (sub === 'expire') {
    if (o.ttl === undefined) throw new Error('faststore expire needs --ttl <seconds>');
    return out(await POST(`${FASTSTORE}/keys/${enc(rest[0], 'key')}/expire`, { ttlSeconds: intOpt(o.ttl) }, o), o);
  }
  if (sub === 'incr') {
    const body = {};
    if (o.by !== undefined) body.by = intOpt(o.by);
    if (o.ttl !== undefined) body.ttlSeconds = intOpt(o.ttl);
    return out(await POST(`${FASTSTORE}/keys/${enc(rest[0], 'key')}/incr`, body, o), o);
  }
  if (sub === 'batch') return out(await POST(`${FASTSTORE}/batch`, jsonArg(o, 'batch JSON'), o), o);
  if (sub === 'hashes' || sub === 'hash') return faststoreHashes(o, rest);
  if (sub === 'lists' || sub === 'list') return faststoreLists(o, rest);
  if (sub === 'sets' || sub === 'set') return faststoreSets(o, rest);
  if (sub === 'zsets' || sub === 'zset') return faststoreZsets(o, rest);
  if (sub === 'locks' || sub === 'lock') return faststoreLocks(o, rest);
  throw new Error('usage: synapseone faststore [stats|keys|get|set|del|ttl|expire|incr|batch|hashes|lists|sets|zsets|locks] ...');
}

async function faststoreHashes(o, args) {
  const [sub, ...rest] = args;
  const key = () => enc(rest[0], 'key');
  if (!sub || sub === 'get' || sub === 'list') {
    if (rest[1] !== undefined) return out(await GET(`${FASTSTORE}/hashes/${key()}/${enc(rest[1], 'field')}`, o), o);
    const r = await GET(`${FASTSTORE}/hashes/${key()}`, o);
    if (o.json) return out(r, o);
    if (r && r.values) return out(Object.entries(r.values).map(([field, value]) => ({ field, value })), o, ['field', 'value']);
    return out(r, o);
  }
  if (sub === 'set' || sub === 'put') {
    if (rest[1] !== undefined) {
      return out(await req('PUT', `${FASTSTORE}/hashes/${key()}/${enc(rest[1], 'field')}`, { value: valueArg(o), ...fsWriteOptions(o) }, o), o);
    }
    const values = jsonArg(o, 'hash values JSON');
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('hash values must be a JSON object');
    return out(await req('PUT', `${FASTSTORE}/hashes/${key()}`, { values, ...fsWriteOptions(o) }, o), o);
  }
  if (sub === 'del' || sub === 'delete' || sub === 'rm') {
    const p = rest[1] !== undefined ? `${FASTSTORE}/hashes/${key()}/${enc(rest[1], 'field')}` : `${FASTSTORE}/hashes/${key()}`;
    return out(await DEL(p, o), o);
  }
  if (sub === 'incr') {
    const body = { field: need(rest[1], 'field') };
    if (o.by !== undefined) body.by = intOpt(o.by);
    if (o.ttl !== undefined) body.ttlSeconds = intOpt(o.ttl);
    return out(await POST(`${FASTSTORE}/hashes/${key()}/incr`, body, o), o);
  }
  if (sub === 'len' || sub === 'length') return out(await GET(`${FASTSTORE}/hashes/${key()}/length`, o), o);
  throw new Error('usage: faststore hashes [get|set|del] <key> [field] [--value V]');
}

async function faststoreLists(o, args) {
  const [sub, ...rest] = args;
  const key = () => enc(rest[0], 'key');
  if (!sub || sub === 'range' || sub === 'get') {
    const r = await GET(`${FASTSTORE}/lists/${key()}${queryOf({ start: o.start, stop: o.stop })}`, o);
    return out(o.json ? r : (r.values !== undefined ? r.values : r), o);
  }
  if (sub === 'push') {
    const values = valuesArg(o);
    const side = o.side || 'right';
    return out(await POST(`${FASTSTORE}/lists/${key()}/push`, { values, side, ...(o.ttl !== undefined ? { ttlSeconds: intOpt(o.ttl) } : {}) }, o), o);
  }
  if (sub === 'pop') {
    const body = { side: o.side || 'left' };
    if (o.count !== undefined) body.count = intOpt(o.count);
    return out(await POST(`${FASTSTORE}/lists/${key()}/pop`, body, o), o);
  }
  if (sub === 'trim') {
    const body = {};
    if (o.start !== undefined) body.start = intOpt(o.start);
    if (o.stop !== undefined) body.stop = intOpt(o.stop);
    return out(await POST(`${FASTSTORE}/lists/${key()}/trim`, body, o), o);
  }
  if (sub === 'len' || sub === 'length') return out(await GET(`${FASTSTORE}/lists/${key()}/length`, o), o);
  if (sub === 'del' || sub === 'delete' || sub === 'rm') return out(await DEL(`${FASTSTORE}/lists/${key()}`, o), o);
  throw new Error('usage: faststore lists [range|push|pop|trim|len|del] <key>');
}

async function faststoreSets(o, args) {
  const [sub, ...rest] = args;
  const key = () => enc(rest[0], 'key');
  if (!sub || sub === 'members' || sub === 'get') {
    const r = await GET(`${FASTSTORE}/sets/${key()}`, o);
    return out(o.json ? r : (r.members !== undefined ? r.members : r), o);
  }
  if (sub === 'add') {
    return out(await POST(`${FASTSTORE}/sets/${key()}/add`, { members: valuesArg(o, 'members'), ...(o.ttl !== undefined ? { ttlSeconds: intOpt(o.ttl) } : {}) }, o), o);
  }
  if (sub === 'remove' || sub === 'rem') {
    return out(await POST(`${FASTSTORE}/sets/${key()}/remove`, { members: valuesArg(o, 'members') }, o), o);
  }
  if (sub === 'contains') {
    return out(await POST(`${FASTSTORE}/sets/${key()}/contains`, { member: valueArg(o, 'member') }, o), o);
  }
  if (sub === 'card' || sub === 'len') return out(await GET(`${FASTSTORE}/sets/${key()}/card`, o), o);
  if (sub === 'del' || sub === 'delete' || sub === 'rm') return out(await DEL(`${FASTSTORE}/sets/${key()}`, o), o);
  throw new Error('usage: faststore sets [members|add|remove|contains|card|del] <key>');
}

async function faststoreZsets(o, args) {
  const [sub, ...rest] = args;
  const key = () => enc(rest[0], 'key');
  if (!sub || sub === 'range' || sub === 'get') {
    const q = queryOf({ start: o.start, stop: o.stop, rev: o.rev ? '1' : undefined, withScores: o.withScores ? '1' : undefined });
    const r = await GET(`${FASTSTORE}/zsets/${key()}${q}`, o);
    return out(o.json ? r : (r.members !== undefined ? r.members : r), o);
  }
  if (sub === 'add') {
    let members;
    if (o.value !== undefined || o.members?.length) {
      const score = numOpt(o.score);
      if (score === undefined) throw new Error('faststore zsets add needs --score <number>');
      members = valuesArg(o, 'members').map((member) => ({ member, score }));
    } else {
      members = jsonArg(o, 'members JSON');
      if (!Array.isArray(members)) throw new Error('zset members must be a JSON array of {member, score}');
    }
    return out(await POST(`${FASTSTORE}/zsets/${key()}/add`, { members, ...(o.ttl !== undefined ? { ttlSeconds: intOpt(o.ttl) } : {}) }, o), o);
  }
  if (sub === 'incr') {
    const body = { member: valueArg(o, 'member') };
    if (o.by !== undefined) body.by = numOpt(o.by);
    return out(await POST(`${FASTSTORE}/zsets/${key()}/incr`, body, o), o);
  }
  if (sub === 'remove' || sub === 'rem') {
    return out(await POST(`${FASTSTORE}/zsets/${key()}/remove`, { members: valuesArg(o, 'members') }, o), o);
  }
  if (sub === 'score' || sub === 'rank') {
    const member = rest[1] !== undefined ? rest[1] : valueArg(o, 'member');
    return out(await POST(`${FASTSTORE}/zsets/${key()}/${sub}`, { member, rev: o.rev ? true : undefined }, o), o);
  }
  if (sub === 'card' || sub === 'len') return out(await GET(`${FASTSTORE}/zsets/${key()}/card`, o), o);
  if (sub === 'del' || sub === 'delete' || sub === 'rm') return out(await DEL(`${FASTSTORE}/zsets/${key()}`, o), o);
  throw new Error('usage: faststore zsets [range|add|incr|remove|score|rank|card|del] <key>');
}

async function faststoreLocks(o, args) {
  const [sub, ...rest] = args;
  const name = () => enc(rest[0], 'lock');
  if (sub === 'acquire') {
    const body = { ttlSeconds: o.ttl === undefined ? 30 : intOpt(o.ttl) };
    if (o.waitMs !== undefined) body.waitMs = intOpt(o.waitMs);
    if (o.lockToken) body.token = o.lockToken;
    return out(await POST(`${FASTSTORE}/locks/${name()}/acquire`, body, o), o);
  }
  if (sub === 'release' || sub === 'extend') {
    const token = rest[1] !== undefined ? rest[1] : o.lockToken;
    if (!token) throw new Error(`faststore locks ${sub} needs a token (<name> <token> or --lock-token)`);
    const body = { token };
    if (sub === 'extend') body.ttlSeconds = o.ttl === undefined ? 30 : intOpt(o.ttl);
    return out(await POST(`${FASTSTORE}/locks/${name()}/${sub}`, body, o), o);
  }
  throw new Error('usage: faststore locks acquire <name> [--ttl 30] [--wait-ms 0] | locks release|extend <name> <token>');
}

// ---------- SynapseQueue ----------
const QUEUE = '/v1/queue';

async function cmdQueue(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') {
    const r = await GET(`${QUEUE}/queues`, o);
    return out(Array.isArray(r) ? r : r.data || r, o, ['queue', 'name', 'maxAttempts', 'visibilityTimeoutSeconds']);
  }
  const name = () => enc(rest[0], 'queue');
  if (sub === 'create') {
    const body = {};
    if (o.maxAttempts !== undefined) body.maxAttempts = intOpt(o.maxAttempts);
    if (o.visibilityTimeout !== undefined) body.visibilityTimeoutSeconds = intOpt(o.visibilityTimeout);
    return out(await req('PUT', `${QUEUE}/queues/${name()}`, body, o), o);
  }
  if (sub === 'get') return out(await GET(`${QUEUE}/queues/${name()}`, o), o);
  if (sub === 'delete' || sub === 'rm') return out(await DEL(`${QUEUE}/queues/${name()}`, o), o);
  if (sub === 'purge') return out(await POST(`${QUEUE}/queues/${name()}/purge`, {}, o), o);
  if (sub === 'stats') return out(await GET(`${QUEUE}/queues/${name()}/stats`, o), o);
  if (sub === 'send' || sub === 'publish') {
    const body = { payload: payloadArg(o) };
    if (o.delay !== undefined) body.delaySeconds = intOpt(o.delay);
    if (o.maxAttempts !== undefined) body.maxAttempts = intOpt(o.maxAttempts);
    if (o.headers?.length) body.headers = kvList(o.headers);
    if (o.dedupeKey) body.dedupeKey = String(o.dedupeKey);
    if (o.docId) body.id = String(o.docId);
    return out(await POST(`${QUEUE}/queues/${name()}/messages`, body, o), o);
  }
  if (sub === 'send-batch' || sub === 'batch') {
    const raw = jsonArg(o, 'batch messages JSON');
    const messages = Array.isArray(raw) ? raw : raw.messages;
    if (!Array.isArray(messages)) throw new Error('batch JSON must be an array or {"messages":[...]}');
    return out(await POST(`${QUEUE}/queues/${name()}/messages:batch`, { messages }, o), o);
  }
  if (sub === 'consume') {
    const body = {};
    if (o.count !== undefined) body.maxMessages = intOpt(o.count);
    if (o.visibilityTimeout !== undefined) body.visibilityTimeoutSeconds = intOpt(o.visibilityTimeout);
    if (o.waitSeconds !== undefined) body.waitSeconds = intOpt(o.waitSeconds);
    if (o.consumer) body.consumer = String(o.consumer);
    const r = await POST(`${QUEUE}/queues/${name()}/consume`, body, o);
    if (o.json) return out(r, o);
    const msgs = r.messages || [];
    if (!msgs.length) return console.log('(empty)');
    console.log('id\treceipt\tattempts\tstate\tpayload');
    for (const m of msgs) {
      console.log([m.id, m.receipt, m.attempts ?? 0, m.state || '', JSON.stringify(m.payload)].join('\t'));
    }
    return;
  }
  if (sub === 'ack') {
    const receipts = [...rest.slice(1), ...(o.receipts || [])];
    if (!receipts.length) throw new Error('queue ack needs at least one receipt');
    if (receipts.length === 1) return out(await POST(`${QUEUE}/queues/${name()}/ack`, { receipt: receipts[0] }, o), o);
    return out(await POST(`${QUEUE}/queues/${name()}/ack`, { receipts }, o), o);
  }
  if (sub === 'nack') {
    const receipt = need(rest[1], 'receipt');
    const body = { receipt, requeue: o.requeue === undefined ? !o.noRequeue : boolFlag(o.requeue) };
    if (o.delay !== undefined) body.delaySeconds = intOpt(o.delay);
    if (o.error) body.error = String(o.error);
    return out(await POST(`${QUEUE}/queues/${name()}/nack`, body, o), o);
  }
  if (sub === 'heartbeat') {
    const body = { receipt: need(rest[1], 'receipt') };
    if (o.visibilityTimeout !== undefined) body.visibilityTimeoutSeconds = intOpt(o.visibilityTimeout);
    return out(await POST(`${QUEUE}/queues/${name()}/heartbeat`, body, o), o);
  }
  if (sub === 'peek') {
    const r = await GET(`${QUEUE}/queues/${name()}/messages${queryOf({ limit: o.limit, ready: o.ready ? '1' : undefined })}`, o);
    return out(r.messages || r, o, ['id', 'state', 'attempts', 'availableAt']);
  }
  if (sub === 'dead') {
    const r = await GET(`${QUEUE}/queues/${name()}/dead${queryOf({ limit: o.limit })}`, o);
    return out(r.messages || r, o, ['id', 'attempts', 'deadAt', 'deadReason']);
  }
  if (sub === 'replay') {
    const body = {};
    if (o.delay !== undefined) body.delaySeconds = intOpt(o.delay);
    if (o.resetAttempts) body.resetAttempts = true;
    return out(await POST(`${QUEUE}/queues/${name()}/dead/${enc(rest[1], 'message-id')}/replay`, body, o), o);
  }
  if (sub === 'rm-dead' || sub === 'delete-dead') {
    return out(await DEL(`${QUEUE}/queues/${name()}/dead/${enc(rest[1], 'message-id')}`, o), o);
  }
  throw new Error('usage: synapseone queue [list|create|get|delete|purge|stats|send|send-batch|consume|ack|nack|heartbeat|peek|dead|replay|rm-dead] ...');
}

// ---------- SynapseStream ----------
const STREAM = '/v1/stream';

async function cmdStream(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'topics' || sub === 'list') {
    const r = await GET(`${STREAM}/topics`, o);
    return out(r.topics || r, o);
  }
  const topic = () => enc(rest[0], 'topic');
  if (sub === 'create') {
    const body = {};
    if (o.maxLen !== undefined) body.maxLen = intOpt(o.maxLen);
    if (o.minId) body.minId = String(o.minId);
    if (o.retentionMs !== undefined) body.retentionMs = intOpt(o.retentionMs);
    return out(await req('PUT', `${STREAM}/topics/${topic()}`, body, o), o);
  }
  if (sub === 'get') return out(await GET(`${STREAM}/topics/${topic()}`, o), o);
  if (sub === 'delete' || sub === 'rm') return out(await DEL(`${STREAM}/topics/${topic()}`, o), o);
  if (sub === 'stats') return out(await GET(`${STREAM}/topics/${topic()}/stats`, o), o);
  if (sub === 'publish' || sub === 'send') {
    const body = { payload: payloadArg(o) };
    if (o.key) body.key = String(o.key);
    if (o.headers?.length) body.headers = kvList(o.headers);
    if (o.docId) body.id = String(o.docId);
    return out(await POST(`${STREAM}/topics/${topic()}/events`, body, o), o);
  }
  if (sub === 'publish-batch' || sub === 'send-batch') {
    const raw = jsonArg(o, 'batch events JSON');
    const events = Array.isArray(raw) ? raw : raw.events;
    if (!Array.isArray(events)) throw new Error('batch JSON must be an array or {"events":[...]}');
    return out(await POST(`${STREAM}/topics/${topic()}/events:batch`, { events }, o), o);
  }
  if (sub === 'read') {
    const body = { count: o.count === undefined ? 100 : intOpt(o.count) };
    if (o.fromId) body.fromId = String(o.fromId);
    if (o.blockMs !== undefined) body.blockMs = intOpt(o.blockMs);
    const r = await POST(`${STREAM}/topics/${topic()}/read`, body, o);
    return out(r.events || r, o);
  }
  if (sub === 'range') {
    const r = await GET(`${STREAM}/topics/${topic()}/range${queryOf({ start: o.start, end: o.end, count: o.count })}`, o);
    return out(r.events || r, o);
  }
  if (sub === 'group' || sub === 'groups') return streamGroup(o, rest);
  throw new Error('usage: synapseone stream [topics|create|get|delete|stats|publish|publish-batch|read|range|group] ...');
}

async function streamGroup(o, args) {
  const [sub, topicArg, groupArg] = args;
  if (sub === 'create' || sub === 'read' || sub === 'ack' || sub === 'delete' || sub === 'rm') {
    // args are [action, topic, group, ...ids]
  }
  const base = `${STREAM}/topics/${enc(topicArg, 'topic')}/groups/${enc(groupArg, 'group')}`;
  if (!sub || sub === 'create') {
    return out(await req('PUT', base, o.startId ? { startId: String(o.startId) } : {}, o), o);
  }
  if (sub === 'delete' || sub === 'rm') return out(await DEL(base, o), o);
  if (sub === 'read') {
    const body = { count: o.count === undefined ? 10 : intOpt(o.count) };
    if (o.consumer) body.consumer = String(o.consumer);
    if (o.blockMs !== undefined) body.blockMs = intOpt(o.blockMs);
    if (o.autoAck) body.autoAck = true;
    const r = await POST(`${base}/read`, body, o);
    return out(r.events || r, o);
  }
  if (sub === 'ack') {
    const ids = [...args.slice(3), ...(o.ids || [])];
    const fromData = o.input || o.file ? jsonArg(o, 'message ids JSON') : null;
    const all = fromData ? (Array.isArray(fromData) ? fromData : fromData.ids) : ids;
    if (!Array.isArray(all) || !all.length) throw new Error('stream group ack needs message ids (args or --data \'["1-0"]\')');
    return out(await POST(`${base}/ack`, { ids: all.map(String) }, o), o);
  }
  throw new Error('usage: stream group create|delete <topic> <group> | group read <topic> <group> | group ack <topic> <group> <id>...');
}

// ---------- SynapseOCS (object storage) ----------
const OCS = '/v1/ocs';

function ocsObjectPath(bucket, key) {
  return `${OCS}/buckets/${enc(bucket, 'bucket')}/objects/${String(need(key, 'key')).split('/').map(encodeURIComponent).join('/')}`;
}
function contentTypeFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return {
    '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.zip': 'application/zip',
  }[ext] || 'application/octet-stream';
}

async function cmdOcs(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'bucket-list' || ((sub === 'buckets' || sub === 'bucket') && (!rest[0] || rest[0] === 'list'))) {
    const q = o.stats || o.withStats ? '?withStats=1' : '';
    const r = await GET(`${OCS}/buckets${q}`, o);
    return out(r.buckets || r, o, ['name', 'createdAt', 'owner', 'quotaBytes', 'objects', 'bytes']);
  }
  if (sub === 'bucket' || sub === 'buckets') {
    const [action, name] = rest;
    const bucket = () => enc(name, 'bucket');
    if (!action || action === 'list') {
      const q = o.stats || o.withStats ? '?withStats=1' : '';
      const r = await GET(`${OCS}/buckets${q}`, o);
      return out(r.buckets || r, o, ['name', 'createdAt', 'owner', 'quotaBytes', 'objects', 'bytes']);
    }
    if (action === 'create') {
      const body = { name: need(name, 'bucket name') };
      if (o.quotaBytes !== undefined) body.quotaBytes = intOpt(o.quotaBytes);
      return out(await POST(`${OCS}/buckets`, body, o), o);
    }
    if (action === 'get' || action === 'head') return out(await GET(`${OCS}/buckets/${bucket()}`, o), o);
    if (action === 'stats') return out(await GET(`${OCS}/buckets/${bucket()}/stats`, o), o);
    if (action === 'delete' || action === 'rm') return out(await DEL(`${OCS}/buckets/${bucket()}`, o), o);
    throw new Error('usage: ocs bucket [list|create|get|stats|delete] [name] [--quota-bytes N]');
  }
  if (sub === 'ls' || sub === 'list') {
    const bucket = rest[0];
    const r = await GET(`${OCS}/buckets/${enc(bucket, 'bucket')}/objects${queryOf({ prefix: o.prefix, delimiter: o.delimiter, limit: o.limit, cursor: o.cursor })}`, o);
    if (o.json) return out(r, o);
    out(r.objects || r, o, ['key', 'size', 'contentType', 'etag', 'lastModified']);
    if (r.commonPrefixes?.length) console.error(`prefixes: ${r.commonPrefixes.join(', ')}`);
    if (r.nextCursor) console.error(`next cursor: ${r.nextCursor}`);
    return;
  }
  if (sub === 'put' || sub === 'upload' || sub === 'cp') {
    const bucket = rest[0];
    const key = rest[1];
    let body;
    if (o.file) body = fs.readFileSync(o.file);
    else if (o.input !== undefined) body = Buffer.from(String(o.input));
    else if (o.value !== undefined) body = Buffer.from(String(o.value));
    else throw new Error('ocs put needs --file <path> or --data <text>');
    const type = o.contentType || (o.file ? contentTypeFor(o.file) : 'application/octet-stream');
    const r = await reqRaw('PUT', ocsObjectPath(bucket, key), body, o, { 'Content-Type': type });
    const text = r.buffer.toString('utf8');
    if (o.json) return console.log(text);
    try { return out(JSON.parse(text || '{}'), o); } catch { return console.log(text); }
  }
  if (sub === 'get' || sub === 'cat' || sub === 'download') {
    const r = await reqRaw('GET', ocsObjectPath(rest[0], rest[1]), undefined, o);
    if (o.output) {
      fs.writeFileSync(o.output, r.buffer);
      if (!o.json) console.log(`saved ${r.buffer.length} bytes to ${o.output}`);
      return;
    }
    process.stdout.write(r.buffer);
    return;
  }
  if (sub === 'head') {
    const r = await reqRaw('HEAD', ocsObjectPath(rest[0], rest[1]), undefined, o);
    for (const [k, v] of r.headers.entries()) console.log(`${k}: ${v}`);
    return;
  }
  if (sub === 'rm' || sub === 'delete') {
    return out(await DEL(ocsObjectPath(rest[0], rest[1]), o), o);
  }
  if (sub === 'copy' || sub === 'cp-copy') {
    const body = { sourceKey: need(rest[1], 'source key'), destinationKey: need(rest[2], 'destination key') };
    if (rest[3] || o.sourceBucket) body.sourceBucket = rest[3] || String(o.sourceBucket);
    return out(await POST(`${OCS}/buckets/${enc(rest[0], 'bucket')}/objects/copy`, body, o), o);
  }
  if (sub === 'presign') {
    const body = { key: need(rest[1], 'key'), method: (o.method || 'GET').toUpperCase() };
    if (o.expires !== undefined) body.expiresIn = intOpt(o.expires);
    return out(await POST(`${OCS}/buckets/${enc(rest[0], 'bucket')}/presign`, body, o), o);
  }
  if (sub === 'upload-part' || sub === 'part') {
    if (!o.uploadId) throw new Error('ocs part needs --upload-id <id>');
    const part = rest[1] !== undefined ? rest[1] : o.part;
    if (part === undefined) throw new Error('ocs part needs a part number');
    const body = o.file ? fs.readFileSync(o.file) : Buffer.from(String(o.input || ''));
    const p = `${OCS}/buckets/${enc(rest[0], 'bucket')}/uploads/${enc(o.uploadId, 'upload-id')}/parts/${enc(part, 'part')}${queryOf({ key: need(rest[2], 'key') })}`;
    const r = await reqRaw('PUT', p, body, o, { 'Content-Type': 'application/octet-stream' });
    const text = r.buffer.toString('utf8');
    try { return out(JSON.parse(text || '{}'), o); } catch { return console.log(text); }
  }
  if (sub === 'uploads') {
    const [action, bucket, arg2, arg3] = rest;
    if (action === 'create') {
      return out(await POST(`${OCS}/buckets/${enc(bucket, 'bucket')}/uploads`, { key: need(arg2, 'key'), contentType: o.contentType || 'application/octet-stream' }, o), o);
    }
    if (action === 'complete') {
      const raw = jsonArg(o, 'parts JSON');
      const parts = Array.isArray(raw) ? raw : raw.parts;
      return out(await POST(`${OCS}/buckets/${enc(bucket, 'bucket')}/uploads/${enc(arg2, 'upload-id')}/complete`, { key: need(arg3, 'key'), parts }, o), o);
    }
    if (action === 'abort' || action === 'delete') {
      return out(await DEL(`${OCS}/buckets/${enc(bucket, 'bucket')}/uploads/${enc(arg2, 'upload-id')}${queryOf({ key: arg3 })}`, o), o);
    }
    throw new Error('usage: ocs uploads create <bucket> <key> | uploads complete <bucket> <id> <key> --file parts.json | uploads abort <bucket> <id> <key>');
  }
  throw new Error('usage: synapseone ocs [buckets|bucket|ls|put|get|head|rm|copy|presign|uploads|part] ...');
}

// ---------- SynapseNotifications ----------
const NOTIFICATIONS = '/v1/notifications';

function inferChannel(to) {
  if (/^https?:\/\//i.test(String(to))) return 'webhook';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) return 'email';
  if (/^\+?[0-9][0-9 .-]{5,}$/.test(String(to))) return 'sms';
  return 'log';
}

function notificationRecipient(o, channel) {
  const raw = o.recipient || o.to || o._[0];
  if (!raw) throw new Error('missing recipient (use --to <email|phone|url>)');
  if (typeof raw === 'string' && raw.trim().startsWith('{')) return JSON.parse(raw);
  const value = String(raw);
  switch (channel) {
    case 'email': return { email: value };
    case 'sms': return { phone: value };
    case 'webhook': return { url: value };
    case 'push': return { pushToken: value };
    default: return { target: value };
  }
}

async function cmdNotifications(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') {
    const r = await GET(`${NOTIFICATIONS}${queryOf({ status: o.status, limit: o.limit })}`, o);
    return out(Array.isArray(r) ? r : r.notifications || r.items || r, o, ['id', 'channel', 'status', 'subject', 'createdAt']);
  }
  if (sub === 'get') return out(await GET(`${NOTIFICATIONS}/${enc(rest[0], 'notification-id')}`, o), o);
  if (sub === 'send' || sub === 'create') {
    const channels = listArg(o.channels || o.channel);
    const fallbackTo = o.to || o.recipient || rest[0];
    if (!channels.length) channels.push(inferChannel(fallbackTo));
    for (const ch of channels) {
      if (!['email', 'sms', 'webhook', 'push', 'log'].includes(ch)) throw new Error(`bad channel '${ch}' (email|sms|webhook|push|log)`);
    }
    let bodyText = o.body;
    if (bodyText === undefined && o.bodyFile) bodyText = fs.readFileSync(o.bodyFile, 'utf8');
    if (bodyText === undefined) throw new Error('notifications send needs --body <text> or --body-file <path>');
    const body = {
      ...(channels.length === 1 ? { channel: channels[0] } : { channels }),
      recipient: notificationRecipient({ ...o, to: o.to || rest[0] }, channels[0]),
      subject: o.subject === undefined ? '' : String(o.subject),
      body: String(bodyText),
    };
    if (o.input !== undefined || o.file) body.data = jsonArg(o, 'template data JSON');
    if (o.idempotencyKey) body.idempotencyKey = String(o.idempotencyKey);
    return out(await POST(NOTIFICATIONS, body, o), o);
  }
  if (sub === 'cancel') return out(await POST(`${NOTIFICATIONS}/${enc(rest[0], 'notification-id')}/cancel`, {}, o), o);
  if (sub === 'prefs' || sub === 'preferences') {
    const [action, recipient] = rest;
    const rid = enc(recipient, 'recipient');
    if (!action || action === 'get') return out(await GET(`${NOTIFICATIONS}/preferences/${rid}`, o), o);
    if (action === 'set') {
      const body = { channels: listArg(o.channels), unsubscribed: !!o.unsubscribed };
      return out(await req('PUT', `${NOTIFICATIONS}/preferences/${rid}`, body, o), o);
    }
    throw new Error('usage: notifications prefs get|set <recipient> [--channels email,sms] [--unsubscribed]');
  }
  if (sub === 'unsubscribe') {
    return out(await POST(`${NOTIFICATIONS}/unsubscribe`, { recipient: need(rest[0], 'recipient') }, o), o);
  }
  throw new Error('usage: synapseone notifications [list|get|send|cancel|prefs|unsubscribe] ...');
}

// ---------- Search (SynapseBase index) ----------
async function cmdSearch(o) {
  const [sub, ...rest] = o._;
  if (sub === 'reindex') {
    const body = {};
    const collections = listArg(o.collections);
    if (collections.length) body.collections = collections;
    if (o.maxPerCollection !== undefined) body.maxPerCollection = intOpt(o.maxPerCollection);
    return out(await POST('/v1/search/reindex', body, o), o);
  }
  if (sub === 'status') return out(await GET('/v1/search/status', o), o);
  const words = sub === 'query' ? rest : [sub, ...rest];
  const query = words.join(' ').trim() || o.query || '';
  if (!query) throw new Error(`missing query (synapseone search "authentication guide")`);
  const filters = {};
  Object.assign(filters, kvList(o.filters));
  if (o.filtersJson) Object.assign(filters, jsonArg({ ...o, input: o.filtersJson, file: undefined }, 'filters JSON'));
  const body = {
    query,
    mode: o.mode || 'fulltext',
    ...(listArg(o.collections).length === 1 ? { collection: listArg(o.collections)[0] } : {}),
    ...(listArg(o.collections).length > 1 ? { collections: listArg(o.collections) } : {}),
    ...(o.limit !== undefined ? { limit: intOpt(o.limit) } : {}),
    ...(o.cursor ? { cursor: String(o.cursor) } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
  };
  const r = await POST('/v1/search', body, o);
  if (o.json) return out(r, o);
  out(r.items || r.results || r, o, ['documentId', 'title', 'collectionId', 'score', 'snippet']);
  if (r.total !== undefined) console.error(`total: ${r.total}${r.nextCursor ? `  next cursor: ${r.nextCursor}` : ''}`);
  return;
}

// ---------- Tenant secret vault ----------
const SECRETS = '/v1/secrets';

async function cmdSecrets(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') {
    const r = await GET(SECRETS, o);
    return out(r.items || r, o, ['name', 'scope', 'version', 'description', 'updatedAt']);
  }
  const name = () => enc(rest[0], 'secret-name');
  if (sub === 'create') {
    const body = {
      name: need(rest[0], 'secret name'),
      value: stringArg(o, 'secret value'),
      description: o.description === undefined ? '' : String(o.description),
      scope: o.secretScope || 'tenant',
    };
    if (o.account) body.accountId = String(o.account);
    return out(await POST(SECRETS, body, o), o);
  }
  if (sub === 'get') return out(await GET(`${SECRETS}/${name()}`, o), o);
  if (sub === 'read') {
    const body = {};
    if (o.secretVersion !== undefined) body.version = intOpt(o.secretVersion);
    const r = await POST(`${SECRETS}/${name()}/read`, body, o);
    if (o.json) return out(r, o);
    return console.log(r.value);
  }
  if (sub === 'rotate') {
    const body = { value: stringArg(o, 'secret value') };
    if (o.grace !== undefined) body.graceSeconds = intOpt(o.grace);
    return out(await POST(`${SECRETS}/${name()}/rotate`, body, o), o);
  }
  if (sub === 'revoke') {
    const body = {};
    if (o.secretVersion !== undefined) body.version = intOpt(o.secretVersion);
    return out(await POST(`${SECRETS}/${name()}/revoke`, body, o), o);
  }
  if (sub === 'delete' || sub === 'rm') return out(await DEL(`${SECRETS}/${name()}`, o), o);
  throw new Error('usage: synapseone secrets [list|create|get|read|rotate|revoke|delete] ...');
}

// ---------- Inference (LLM, embeddings, decision router) ----------
async function cmdInference(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'health') return out(await GET('/v1/inference/health', o), o);
  if (sub === 'chat' || sub === 'completion') {
    let body;
    if (o.file) {
      body = readJson(o.file);
      if (o.model) body.model = String(o.model);
      if (o.temperature !== undefined) body.temperature = numOpt(o.temperature);
      if (o.maxTokens !== undefined) body.max_tokens = intOpt(o.maxTokens);
    } else {
      const messages = [];
      if (o.system) messages.push({ role: 'system', content: String(o.system) });
      const prompt = [...rest].join(' ').trim();
      for (const m of o.messages || []) {
        const match = /^(system|user|assistant):\s*([\s\S]+)$/i.exec(String(m));
        if (match) messages.push({ role: match[1].toLowerCase(), content: match[2] });
        else messages.push({ role: 'user', content: String(m) });
      }
      if (prompt) messages.push({ role: 'user', content: prompt });
      if (!messages.length) throw new Error('inference chat needs a prompt argument, --message, --system, or --file request.json');
      body = { messages };
      if (o.model) body.model = String(o.model);
      if (o.temperature !== undefined) body.temperature = numOpt(o.temperature);
      if (o.maxTokens !== undefined) body.max_tokens = intOpt(o.maxTokens);
    }
    const r = await POST('/v1/inference/chat/completions', body, o);
    if (o.json) return out(r, o);
    const content = r?.choices?.[0]?.message?.content;
    if (content !== undefined) return console.log(content);
    return out(r, o);
  }
  if (sub === 'embeddings' || sub === 'embed') {
    if (o.file) {
      return out(await POST('/v1/inference/embeddings', readJson(o.file), o), o);
    }
    const text = textArg(o, rest.join(' '), 'input text');
    const body = { input: text };
    if (o.model) body.model = String(o.model);
    if (o.dimensions !== undefined) body.dimensions = intOpt(o.dimensions);
    return out(await POST('/v1/inference/embeddings', body, o), o);
  }
  if (sub === 'decision') {
    if (o.file) return out(await POST('/v1/inference/decision', readJson(o.file), o), o);
    const state = o.state || rest.join(' ');
    if (!state) throw new Error('inference decision needs --state <text> or --file request.json');
    const questions = o.questions ? jsonArg({ ...o, input: o.questions, file: undefined }, 'questions JSON') : null;
    if (!questions) throw new Error('inference decision needs --questions <json>');
    return out(await POST('/v1/inference/decision', { state, questions }, o), o);
  }
  if (sub === 'route') {
    const input = o.text !== undefined ? String(o.text) : o.input !== undefined ? String(o.input) : rest.join(' ');
    if (!input) throw new Error('inference route needs --input <text>');
    const choices = kvList(o.choices);
    if (!Object.keys(choices).length) throw new Error('inference route needs --choice id=description (repeatable)');
    const body = { input, choices };
    if (o.instruction) body.instruction = String(o.instruction);
    return out(await POST('/v1/inference/decision/route', body, o), o);
  }
  if (sub === 'jobs' || sub === 'job') return inferenceJobs(o, rest);
  throw new Error('usage: synapseone inference [health|chat|embeddings|decision|route|jobs] ...');
}

const AI = '/v1/ai';

async function cmdAi(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'agent') {
    const question = o.question || rest.join(' ');
    if (!question) throw new Error('ai agent needs a question argument or --question <text>');
    const body = { question };
    if (o.history) body.history = jsonArg({ ...o, input: o.history, file: undefined }, 'history JSON');
    return out(await POST(`${AI}/agent`, body, o), o);
  }
  throw new Error('usage: synapseone ai agent <question> [--history json]');
}

async function inferenceJobs(o, args) {
  const [sub, ...rest] = args;
  const JOBS = '/v1/inference-jobs';
  if (!sub || sub === 'list') {
    const r = await GET(`${JOBS}${queryOf({ status: o.status, limit: o.limit })}`, o);
    return out(r.data || r.items || r, o, ['id', 'type', 'status', 'createdAt']);
  }
  if (sub === 'get') return out(await GET(`${JOBS}/${enc(rest[0], 'job-id')}`, o), o);
  if (sub === 'submit' || sub === 'create') {
    const payload = o.file ? readJson(o.file) : (o.input ? payloadArg(o) : null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('inference jobs submit needs --file payload.json or --data \'{...}\'');
    const body = { type: o.jobType || 'chat', payload };
    if (o.queue) body.queue = String(o.queue);
    if (o.wait) { body.wait = true; if (o.timeoutMs !== undefined) body.timeoutMs = intOpt(o.timeoutMs); }
    return out(await POST(JOBS, body, o), o);
  }
  throw new Error('usage: inference jobs [list|get|submit] ...');
}

// ---------- Synapse Warehouse ----------
const WAREHOUSE = '/v1/warehouse';

async function cmdWarehouse(o) {
  const [sub, ...rest] = o._;
  if (!sub) {
    const r = await GET(`${WAREHOUSE}/datasets`, o);
    return out(r.datasets || r.data || r, o, ['id', 'name', 'mode', 'rowCount', 'updatedAt']);
  }
  if (sub === 'dataset' || sub === 'datasets') return warehouseDataset(o, rest);
  if (sub === 'query') {
    if (!o.sql) throw new Error('warehouse query needs --sql "SELECT ..."');
    const body = { sql: String(o.sql) };
    if (o.limit !== undefined) body.limit = intOpt(o.limit);
    const r = await POST(`${WAREHOUSE}/query`, body, o);
    if (o.json) return out(r, o);
    out(r.rows || [], o, r.columns || undefined);
    if (r.rowCount !== undefined) console.error(`rows: ${r.rowCount}${r.truncated ? ' (truncated)' : ''} in ${r.durationMs ?? '?'}ms`);
    return;
  }
  if (sub === 'templates') return out(await GET(`${WAREHOUSE}/templates`, o), o);
  if (sub === 'jobs') {
    const r = await GET(`${WAREHOUSE}/jobs`, o);
    return out(r.jobs || r.data || r, o, ['id', 'name', 'mode', 'status', 'targetDatasetId', 'lastRunAt']);
  }
  if (sub === 'job') return warehouseJob(o, rest);
  if (sub === 'etl-batch') {
    const body = { targetDatasetId: need(o.dataset, '--dataset <id>'), sql: need(o.sql, '--sql') };
    if (o.name) body.name = String(o.name);
    if (o.writeMode) body.writeMode = String(o.writeMode);
    return out(await POST(`${WAREHOUSE}/etl/batch`, body, o), o);
  }
  throw new Error('usage: synapseone warehouse [datasets|dataset|query|templates|jobs|job|etl-batch] ...');
}

async function warehouseDataset(o, args) {
  const [sub, ...rest] = args;
  if (!sub || sub === 'list') {
    const r = await GET(`${WAREHOUSE}/datasets`, o);
    return out(r.datasets || r.data || r, o, ['id', 'name', 'mode', 'rowCount']);
  }
  if (sub === 'create') {
    const columns = (o.columns || []).map((raw) => {
      const i = String(raw).indexOf(':');
      if (i < 1) throw new Error(`bad --column '${raw}' (want name:type)`);
      return { name: raw.slice(0, i), type: raw.slice(i + 1) };
    });
    if (!columns.length) throw new Error('warehouse dataset create needs at least one --column name:type');
    const body = { name: need(o.name || rest[0], 'name'), columns };
    if (o.docId) body.id = String(o.docId);
    if (o.description) body.description = String(o.description);
    if (o.mode) body.mode = String(o.mode);
    if (o.streamTopic) body.streamTopic = String(o.streamTopic);
    return out(await POST(`${WAREHOUSE}/datasets`, body, o), o);
  }
  if (sub === 'get') return out(await GET(`${WAREHOUSE}/datasets/${enc(rest[0], 'dataset-id')}`, o), o);
  if (sub === 'delete' || sub === 'rm') return out(await DEL(`${WAREHOUSE}/datasets/${enc(rest[0], 'dataset-id')}`, o), o);
  if (sub === 'rows' || sub === 'insert') {
    const raw = jsonArg(o, 'rows JSON');
    const rows = Array.isArray(raw) ? raw : raw.rows;
    if (!Array.isArray(rows)) throw new Error('rows JSON must be an array or {"rows":[...]}');
    return out(await POST(`${WAREHOUSE}/datasets/${enc(rest[0], 'dataset-id')}/rows`, { rows }, o), o);
  }
  throw new Error('usage: warehouse dataset [list|create|get|delete|rows] ...');
}

async function warehouseJob(o, args) {
  const [sub, ...rest] = args;
  if (!sub || sub === 'list') {
    const r = await GET(`${WAREHOUSE}/jobs`, o);
    return out(r.jobs || r.data || r, o, ['id', 'name', 'mode', 'status', 'targetDatasetId']);
  }
  if (sub === 'create') {
    const body = {
      name: need(o.name || rest[0], 'name'),
      targetDatasetId: need(o.dataset, '--dataset <id>'),
      mode: o.mode || 'batch',
      writeMode: o.writeMode || 'append',
    };
    if (body.mode === 'batch') body.sql = need(o.sql, '--sql');
    else {
      body.streamTopic = need(o.streamTopic, '--stream-topic');
      if (o.streamGroup) body.streamGroup = String(o.streamGroup);
    }
    if (o.batchSize !== undefined) body.batchSize = intOpt(o.batchSize);
    if (o.intervalMs !== undefined) body.intervalMs = intOpt(o.intervalMs);
    return out(await POST(`${WAREHOUSE}/jobs`, body, o), o);
  }
  const id = () => enc(rest[0], 'job-id');
  if (sub === 'get') return out(await GET(`${WAREHOUSE}/jobs/${id()}`, o), o);
  if (sub === 'run' || sub === 'pause' || sub === 'resume') return out(await POST(`${WAREHOUSE}/jobs/${id()}/${sub}`, {}, o), o);
  if (sub === 'delete' || sub === 'rm') return out(await DEL(`${WAREHOUSE}/jobs/${id()}`, o), o);
  throw new Error('usage: warehouse job [list|create|get|run|pause|resume|delete] ...');
}

// ---------- Human tasks ----------
const HUMAN_TASKS = '/v1/human-tasks';

async function cmdHumanTasks(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') {
    const q = queryOf({
      status: o.status, assignee: o.assignee, workflowId: o.workflow,
      executionId: o.executionId, limit: o.limit, offset: o.offset,
    });
    const r = await GET(`${HUMAN_TASKS}${q}`, o);
    return out(r.items || r.data || r, o, ['id', 'title', 'status', 'assignee', 'deadline']);
  }
  if (sub === 'get') return out(await GET(`${HUMAN_TASKS}/${enc(rest[0], 'task-id')}`, o), o);
  if (sub === 'create') {
    const body = { title: need(o.title || rest.join(' '), 'title') };
    if (o.description) body.description = String(o.description);
    if (o.assignee) body.assignee = String(o.assignee);
    const roles = listArg(o.candidateRoles || o.roles);
    if (roles.length) body.candidateRoles = roles;
    if (o.deadline) body.deadline = String(o.deadline);
    if (o.workflow) body.workflowId = String(o.workflow);
    if (o.executionId) body.executionId = String(o.executionId);
    if (o.node) body.node = String(o.node);
    if (o.input !== undefined || o.file) body.payload = jsonArg(o, 'payload JSON');
    if (o.decisionSchema) body.decisionSchema = jsonArg({ ...o, input: o.decisionSchema, file: undefined }, 'decision schema JSON');
    return out(await POST(HUMAN_TASKS, body, o), o);
  }
  const id = () => enc(rest[0], 'task-id');
  if (sub === 'claim') return out(await POST(`${HUMAN_TASKS}/${id()}/claim`, {}, o), o);
  if (sub === 'approve' || sub === 'complete' || sub === 'reject') {
    const body = {};
    if (o.note !== undefined) body.note = String(o.note);
    if (o.decision) body.decision = jsonArg({ ...o, input: o.decision, file: undefined }, 'decision JSON');
    const action = sub === 'reject' ? 'reject' : 'complete';
    return out(await POST(`${HUMAN_TASKS}/${id()}/${action}`, body, o), o);
  }
  if (sub === 'expire') return out(await POST(`${HUMAN_TASKS}/${id()}/expire`, o.force ? { force: true } : {}, o), o);
  throw new Error('usage: synapseone human-tasks [list|get|create|claim|approve|reject|expire] ...');
}

// ---------- Usage analytics ----------
const USAGE = '/v1/usage';

async function cmdUsage(o) {
  const [sub, ...rest] = o._;
  const path = sub === 'events' ? `${USAGE}/events` : `${USAGE}/summary`;
  const q = queryOf({
    from: o.from, to: o.to, feature: o.feature, accountId: o.account, actor: o.actor,
    method: o.method, status: o.status, statusClass: o.statusClass, q: o.q,
    limit: o.limit, offset: o.offset,
  });
  const r = await GET(`${path}${q}`, o);
  if (sub === 'events') return out(r.events || r.items || r, o, ['created_at', 'feature', 'method', 'path', 'status', 'duration_ms']);
  return out(r, o);
}

// ---------- SCIM token lifecycle ----------
async function cmdScim(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'tokens') {
    const r = await GET('/v1/scim/tokens', o);
    return out(r.items || r, o, ['id', 'description', 'scopes', 'expires_at', 'created_at']);
  }
  if (sub === 'token') {
    const [action, ...args] = rest;
    if (action === 'create') {
      const body = { scopes: listArg(o.scopes).length ? listArg(o.scopes) : ['scim:read', 'scim:write'] };
      if (o.description) body.description = String(o.description);
      if (o.ttl !== undefined) body.ttlSeconds = intOpt(o.ttl);
      const r = await POST('/v1/scim/tokens', body, o);
      if (o.json) return out(r, o);
      console.log(`SAVE THIS TOKEN (shown once):\n${r.token}\nid: ${r.id}`);
      return;
    }
    if (action === 'revoke') {
      return out(await DEL(`/v1/scim/tokens/${enc(args[0], 'token-id')}`, o), o);
    }
    throw new Error('usage: scim token create [--description D] [--scopes scim:read,scim:write] [--ttl N] | scim token revoke <id>');
  }
  throw new Error('usage: synapseone scim [tokens|token create|token revoke] ...');
}

const COMMANDS = {
  login: { fn: cmdLogin, use: 'login --email E [--org ORG] [--password P] [--code 123456 | --recovery-code C] [--base URL]', doc: 'Sign in (password or dev login, with MFA code when enabled), save token + refresh' },
  mfa: { fn: cmdMfa, use: 'mfa [status] | mfa setup | mfa enable <code> | mfa recovery-codes <code> | mfa disable --code C | mfa reset <user-id> | mfa unlock <user-id>', doc: 'Multi-factor authentication (TOTP) and sign-in lockout' },
  refresh: { fn: cmdRefresh, use: 'refresh [refresh-token]', doc: 'Rotate access token (atomic server-side)' },
  'logout-all': { fn: cmdLogoutAll, use: 'logout-all [refresh-token]', doc: 'Revoke ALL sessions of token owner' },
  verify: { fn: cmdVerify, use: 'verify', doc: 'Check current Bearer / API key' },
  'use-key': { fn: cmdUseKey, use: 'use-key <api-key>', doc: 'Save API key instead of token' },
  logout: { fn: async () => { saveConfig({ baseUrl: loadConfig().baseUrl }); console.log('logged out'); }, use: 'logout', doc: 'Clear saved credentials' },
  config: { fn: cmdConfig, use: 'config', doc: 'Show saved config (secrets redacted)' },
  whoami: { fn: cmdMe, use: 'whoami', doc: 'Current user (/v1/auth/me)' },
  health: { fn: cmdHealth, use: 'health [--ready] [--json]', doc: 'Gateway /health or aggregate /ready (exit 3 when degraded)' },
  orgs: { fn: cmdOrgs, use: 'orgs [list|create <slug> [name]]', doc: 'Organizations' },
  accounts: { fn: cmdAccounts, use: 'accounts [org] [list] | accounts create [org] <slug> [name]', doc: 'Accounts' },
  users: { fn: cmdUsers, use: 'users [org] | users create <org> <email> [name] | users policies <user-id>', doc: 'Users + effective policies' },
  roles: { fn: cmdRoles, use: 'roles <account> [list] | roles create <account> <slug> | roles delete <id>', doc: 'Roles' },
  policies: { fn: cmdPolicies, use: 'policies <account> [list] | policies create <account> <slug> (--file p.json | --managed ReadOnlyAccess) | policies delete <id>', doc: 'Policies' },
  'managed-policies': { fn: cmdManagedPolicies, use: 'managed-policies', doc: 'AWS-style managed policies (AdministratorAccess, ReadOnlyAccess, ...)' },
  'org-admin': { fn: cmdOrgAdmin, use: 'org-admin <user-id> on|off', doc: 'Grant/revoke organization administrator' },
  sessions: { fn: cmdSessions, use: 'sessions [list] | sessions revoke <session-id>', doc: 'Your login sessions (refresh tokens)' },
  attach: { fn: cmdAttach, use: 'attach <role-id> <policy-id>', doc: 'Attach policy to role' },
  detach: { fn: cmdDetach, use: 'detach <role-id> <policy-id>', doc: 'Detach policy from role' },
  assign: { fn: cmdAssign, use: 'assign <user-id> <role-id>', doc: 'Assign role to user' },
  unassign: { fn: cmdUnassign, use: 'unassign <user-id> <role-id>', doc: 'Remove role from user' },
  authz: { fn: cmdAuthz, use: 'authz <user> <action> <resource> [--context k=v]', doc: 'Authorize check' },
  sim: { fn: cmdSim, use: 'sim --file policy.json <action> <resource> [--context k=v]', doc: 'Policy simulator' },
  audit: { fn: cmdAudit, use: 'audit [--limit N] [--actor ID]', doc: 'Audit log' },
  keys: { fn: cmdKeys, use: 'keys create <account> [--name N] [--scopes a,b] [--user USER_ID] | keys list <account> | keys rotate <key-id> [--grace SECONDS] | keys revoke <key-id> | keys verify <api-key>', doc: 'API keys (scoped, owner-bound, rotatable)' },
  sa: { fn: cmdSa, use: 'sa <account> [list] | sa create <account> <slug> | sa token <sa-id> | sa roles <sa-id> | sa grant <sa-id> <role-id> | sa revoke-role <sa-id> <role-id>', doc: 'Service accounts + their roles' },
  credentials: { fn: cmdCredentials, use: 'credentials create <account> --name N --type bearer|basic|apiKey|oauth2 (--secret S | --secret-file F) [--expires-at ISO] | credentials [list] <account> | credentials get|delete <id> | credentials rotate <id> (--secret S | --secret-file F)', doc: 'Account credentials, secrets write-only (PROPOSED: backend in progress)' },
  workflows: { fn: cmdWorkflows, use: 'workflows [list] | workflows create --template T [--name N] | workflows create --file def.json [--name N] | workflows get|activate|deactivate <id> | workflows exec|execute <id> [--data \'{...}\'|input.json] [--file payload.json] [--wait] [--timeout MS] | workflows update [--name N] [--file def.json] <id> | workflows delete <id> | workflows test-run --file def.json [--input input.json|\'{...}\'] [--workflow-id ID]', doc: 'Workflows (local engine)' },
  runners: { fn: cmdRunners, use: 'runners [list] | runners options | runners create --name N --account ID [--mode custom|hybrid] [--queue Q] [--scopes S] | runners get|connection|instances|command|delete <id> | runners rm-instance <id> <instance-id>', doc: 'Self-hosted workflow runners (queue connectors)' },
  executions: { fn: cmdExecutions, use: 'executions [list] [--limit N] [--offset N] [--workflow-id ID] [--status success|error|running] [--triggered-by manual|webhook|cron|test] [--include-data] | executions <id> [--include-data]', doc: 'Workflow executions ({data:[]} envelope)' },
  webhook: { fn: cmdWebhook, use: 'webhook <path> [--data \'{...}\'|payload.json] [--file payload.json] [--method POST] [--base http://localhost:4002]', doc: 'Fire a public inbound webhook (no auth; --base = workflow origin)' },
  templates: { fn: cmdTemplates, use: 'templates [list|<name>]', doc: 'Built-in templates' },
  lds: { fn: cmdLds, use: 'lds licenses | lds datasources [list] [--org <orgId>] [--account <accountId>] | lds datasources create --name N --entity-type T --license SPDX [--slug S] [--context URL]... [--visibility public|internal] [--description D] | lds datasources get|delete <id> | lds datasources update <id> [--name N] [--entity-type T] [--license SPDX] [--slug S] [--context URL]... [--visibility public|internal] [--description D] | lds attributes list <id> | lds attributes set <id> (--file attrs.json | --data \'[...]\') | lds ingest <id> (--file record.json | --data \'{...}\') | lds entities <id> [--limit N] [--offset N] [--visibility public|restricted] | lds entity <id> <entity-id> | lds stats <id>', doc: 'SynapseLDS: licenses, datasources, attribute registry, ingest, NGSI-LD entities' },
  base: { fn: cmdBase, use: 'base collections [list|create|get|delete] | base documents [list|insert|get|delete] <col> | base vector-search <col> (--vector \'[...]\'|--query \'...\') [--limit N] [--metric cosine|l2|ip] [--where \'{...}\'] | base query <col>', doc: 'SynapseBase: collections, document CRUD, vector similarity search, and hybrid queries' },
  faststore: { fn: cmdFaststore, use: 'faststore [stats|keys|get|set|del|ttl|expire|incr|batch] [key] | faststore hashes|lists|sets|zsets|locks <action> ...', doc: 'Synapse Faststore: KV, hashes, lists, sets, sorted sets and distributed locks' },
  queue: { fn: cmdQueue, use: 'queue [list|create|get|delete|purge|stats] [name] | queue send|consume|ack|nack|heartbeat|peek|dead|replay <name> ...', doc: 'SynapseQueue: queues, publish/consume, receipts, dead letters' },
  stream: { fn: cmdStream, use: 'stream [topics|create|get|delete|stats|publish|read|range] <topic> | stream group create|read|ack|delete <topic> <group>', doc: 'SynapseStream: topics, events, consumer groups' },
  ocs: { fn: cmdOcs, use: 'ocs buckets | bucket create|get|stats|delete <name> | ls <bucket> | put|get|head|rm <bucket> <key> | copy | presign', doc: 'SynapseOCS: buckets and binary objects' },
  notifications: { fn: cmdNotifications, use: 'notifications [list|get|send|cancel] ... | notifications prefs get|set <recipient> | notifications unsubscribe <recipient>', doc: 'SynapseNotifications: outbox, delivery and preferences' },
  search: { fn: cmdSearch, use: 'search \'<query>\' [--mode fulltext|semantic|hybrid] [--collection C] | search reindex | search status', doc: 'Tenant-scoped search over SynapseBase documents' },
  secrets: { fn: cmdSecrets, use: 'secrets [list|create|get|read|rotate|revoke|delete] <name>', doc: 'Tenant secret vault (versioned, encrypted at rest)' },
  inference: { fn: cmdInference, use: 'inference [health|chat|embeddings|decision|route] ... | inference jobs [list|get|submit]', doc: 'Synapse Inference: chat, embeddings, decision routing, queued jobs' },
  ai: { fn: cmdAi, use: 'ai agent <question> [--history json]', doc: 'Synapse AI agent (decision + LLM)' },
  warehouse: { fn: cmdWarehouse, use: 'warehouse [datasets|dataset|query|templates|jobs|job|etl-batch] ...', doc: 'Synapse Warehouse: datasets, SQL queries, ETL jobs' },
  'human-tasks': { fn: cmdHumanTasks, use: 'human-tasks [list|get|create|claim|approve|reject|expire] ...', doc: 'Workflow human approval tasks' },
  usage: { fn: cmdUsage, use: 'usage summary|events [--from ISO] [--to ISO] [--feature F] [--limit N]', doc: 'Org usage analytics (summary and request events)' },
  scim: { fn: cmdScim, use: 'scim tokens | scim token create|revoke ...', doc: 'SCIM provisioning token lifecycle' },
  call: { fn: cmdCall, use: 'call <METHOD> <path> [--data \'{...}\'|body.json] [--file body.json]', doc: 'Generic gateway call (escape hatch for new endpoints)' },
};

function help() {
  console.log(`synapseone v${VERSION} — SynapseOne CLI (Apache-2.0)

Usage: synapseone [--base URL] [--token T | --apikey K] [--json] <command> [args]

Auth defaults: --base > $SYNAPSEONE_BASE_URL > ~/.synapseone/config.json > https://api.synapseone.space
`);
  const names = Object.keys(COMMANDS);
  const w = Math.max(...names.map((n) => n.length));
  for (const n of names) console.log(`  ${n.padEnd(w)}  ${COMMANDS[n].doc}\n    usage: synapseone ${COMMANDS[n].use}`);
  console.log('\nExamples:\n  synapseone login --email demo@acme.local\n  synapseone orgs create acme2 "ACME 2"\n  synapseone authz <uid> workflow:Execute "*" --context team=etl\n  synapseone --json workflows list\n  synapseone workflows create --template code-transform --name demo-transform\n  synapseone workflows test-run --file def.json --input input.json\n  synapseone workflows exec wf_abc123 --data \'{"value":21}\'\n  synapseone executions list --workflow-id wf_abc123 --status success --limit 20\n  synapseone webhook synapseone-event --data \'{"value":21}\' --base http://localhost:4002\n  synapseone base collections create kb --mapping \'{"fields":{"vec":{"path":"embedding","type":"vector","dimension":384}}}\'\n  synapseone base vector-search kb --query "authentication guide" --limit 5\n  synapseone faststore set cache:demo --value \'{"ok":true}\' --ttl 300\n  synapseone queue create emails --max-attempts 5\n  synapseone queue send emails --payload \'{"to":"a@b.c"}\'\n  synapseone stream create telemetry --max-len 100000\n  synapseone stream publish telemetry --payload \'{"value":25.4}\'\n  synapseone ocs bucket create city-assets\n  synapseone ocs put city-assets map.png --file ./map.png\n  synapseone notifications send a@b.c --channel email --subject Hi --body Hello\n  synapseone inference chat "summarize the incident" --model gpt-4o-mini\n  synapseone lds licenses\n  synapseone lds datasources create --name buildings --entity-type Building --license CC-BY-4.0\n  synapseone lds entities ds_123 --limit 20 --visibility public');
}

async function main() {
  const { args, opts } = parse(process.argv.slice(2));
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === 'version' || cmd === '--version') {
    if (cmd === 'version' || cmd === '--version') return console.log(`synapseone v${VERSION}`);
    return help();
  }
  const c = COMMANDS[cmd];
  if (!c) {
    console.error(`unknown command '${cmd}' — try: synapseone help`);
    process.exit(2);
  }
  try {
    await c.fn({ ...opts, _: rest });
  } catch (e) {
    console.error(`error: ${e.message || e}`);
    process.exit(1);
  }
}

main();
