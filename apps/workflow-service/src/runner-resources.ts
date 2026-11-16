// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Runner resource telemetry + pure admission helpers.
 *
 * The runner heartbeat samples this module every 15 s and stores at most 120
 * points (30 minutes).  CPU is a delta measurement from a monotonic counter:
 * cgroup v2 `cpu.stat` (`usage_usec`), cgroup v1 `cpuacct.usage` (ns), or
 * `/proc/stat` as a host fallback.  Memory uses cgroup `memory.current` /
 * `memory.max` (v2) or `memory.usage_in_bytes` / `memory.limit_in_bytes` (v1),
 * with `/proc/meminfo` fallback.  Docker `--cpus`, `--cpuset-cpus` and
 * `--memory` are therefore honoured without a Docker socket.
 *
 * The emitted sample contains only numbers, an ISO timestamp and a coarse
 * source enum.  Host paths, hostnames, PIDs, environment values and credentials
 * never leave `RunnerResourceSampler`; `sanitizeResourceSample()` re-applies
 * that boundary before persistence/UI.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

export type ResourceSampleSource =
  | 'cgroup-v2'
  | 'cgroup-v1'
  | 'cgroup-mixed'
  | 'host'
  | 'unknown';

export interface CpuResourceSample {
  /** CPU limit in cores (Docker --cpus / cpuset / host count). */
  limitCores: number;
  /** Recent CPU usage in cores from a monotonic counter delta. */
  usedCores: number;
  /** usedCores / limitCores, clamped to 0..100. */
  percent: number;
  /** max(0, limitCores - usedCores), never above the host CPU count. */
  availableCores: number;
}

export interface MemoryResourceSample {
  /** Memory limit in MiB (Docker --memory / host total). */
  limitMb: number;
  /** Current memory usage in MiB (cgroup current or host used). */
  usedMb: number;
  /** max(0, min(limitMb - usedMb, host MemAvailable)). */
  availableMb: number;
}

export interface ResourceSample {
  /** Observation time. Kept as the canonical timestamp for history/UI. */
  sampledAt: string;
  /** Explicit runner observation time (same instant as sampledAt). */
  observedAt: string;
  /** Server receipt time; never used for freshness. */
  receivedAt?: string;
  cpu: CpuResourceSample;
  memory: MemoryResourceSample;
  source: ResourceSampleSource;
}

export interface RunnerResourceSamplerOptions {
  /** Default /sys/fs/cgroup (tests may point at a fixture tree). */
  cgroupRoot?: string;
  /** Default /proc (tests may point at a fixture tree). */
  procRoot?: string;
  /** Wall clock for sampledAt (tests inject a fixed clock). */
  now?: () => number;
  /** Monotonic clock in ms for CPU counter deltas. */
  monotonic?: () => number;
}

export interface ResourceReservation {
  cpuCores?: number;
  memoryMb?: number;
}

export interface ResourceFitRequest {
  cpuCores: number;
  memoryMb: number;
}

export interface ResourceCandidate extends ResourceFitRequest {
  [key: string]: unknown;
}

export interface ResourceFitOptions {
  /** Default 10% of the CPU limit. */
  cpuHeadroomPercent?: number;
  /** Default 256 MiB. */
  memoryHeadroomMb?: number;
  /** Jobs already admitted but not yet finished. */
  activeReservations?: readonly ResourceReservation[];
  /** Default Date.now(); used for stale-sample detection. */
  now?: number;
  /** Default 15000 ms (one heartbeat). */
  staleAfterMs?: number;
}

export type ResourceFitReason =
  | 'cpu'
  | 'memory'
  | 'cpu+memory'
  | 'stale'
  | 'unavailable'
  | 'invalid';

export interface ResourceFitResult {
  ok: boolean;
  reason?: ResourceFitReason;
  sampleAgeMs: number;
  cpu: {
    requestedCores: number;
    limitCores: number;
    sampleAvailableCores: number;
    observedBusyCores: number;
    reservedCores: number;
    effectiveBusyCores: number;
    headroomCores: number;
    /** Available after reservations + headroom; 0 for stale/unavailable. */
    availableCores: number;
    remainingCores: number;
  };
  memory: {
    requestedMb: number;
    limitMb: number;
    sampleAvailableMb: number;
    reservedMb: number;
    headroomMb: number;
    /** Available after reservations + headroom; 0 for stale/unavailable. */
    availableMb: number;
    remainingMb: number;
  };
}

export interface ResourceChoice<T extends ResourceCandidate> {
  selected: T | null;
  fit: ResourceFitResult | null;
  rejected: Array<{ candidate: T; fit: ResourceFitResult }>;
}

export const RESOURCE_HISTORY_LIMIT = 120;
export const RESOURCE_HEARTBEAT_MS = 15_000;
export const DEFAULT_CPU_HEADROOM_PERCENT = 10;
export const DEFAULT_MEMORY_HEADROOM_MB = 256;

const MIB = 1024 * 1024;
const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';
const DEFAULT_PROC_ROOT = '/proc';
const MAX_CORES = 4096;
const MAX_MEMORY_MB = 16 * 1024 * 1024;
/** Kernels report "unlimited" as a huge sentinel for cgroup v1 memory. */
const UNLIMITED_BYTES = 2 ** 60;

interface HostReading {
  cpuCount: number;
  totalMb: number;
  availableMb: number;
  stat: string | null;
}

interface CgroupV2Reading {
  present: boolean;
  cpuStat: string | null;
  cpuMax: string | null;
  cpuset: string | null;
  memoryCurrent: string | null;
  memoryMax: string | null;
}

interface CgroupV1Reading {
  present: boolean;
  cpuacctUsage: string | null;
  quota: string | null;
  period: string | null;
  cpuset: string | null;
  memoryUsage: string | null;
  memoryLimit: string | null;
}

interface CpuCounter {
  kind: 'cgroup-v2' | 'cgroup-v1' | 'host';
  usage?: number;
  busy?: number;
  total?: number;
}

interface LastCpuCounter {
  kind: CpuCounter['kind'];
  usage?: number;
  busy?: number;
  total?: number;
  at: number;
}

function decimal(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Strict number for request fields: null/undefined/empty are invalid, not 0. */
function requiredNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/** Strict number for a counter file: missing file stays NaN, never 0. */
function numberFromText(value: string | null): number {
  if (value === null || value === '') return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sourceOrDefault(value: unknown): ResourceSampleSource {
  return value === 'cgroup-v2' ||
    value === 'cgroup-v1' ||
    value === 'cgroup-mixed' ||
    value === 'host'
    ? value
    : 'unknown';
}

function safeSample(nowMs: number, source: ResourceSampleSource = 'unknown'): ResourceSample {
  const time = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  return {
    sampledAt: new Date(time).toISOString(),
    observedAt: new Date(time).toISOString(),
    cpu: { limitCores: 0, usedCores: 0, percent: 0, availableCores: 0 },
    memory: { limitMb: 0, usedMb: 0, availableMb: 0 },
    source,
  };
}

function parseKeyValue(text: string | null): Record<string, string> {
  const values: Record<string, string> = {};
  if (!text) return values;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf(' ');
    if (index <= 0) continue;
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim();
  }
  return values;
}

function parseMeminfoMb(text: string | null, key: string): number | null {
  if (!text) return null;
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
  if (!match) return null;
  const kb = Number(match[1]);
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
}

function parseCpuinfoCount(text: string | null): number | null {
  if (!text) return null;
  const matches = text.match(/^processor\s*:/gm);
  return matches && matches.length > 0 ? matches.length : null;
}

function parseCpuSetCount(text: string | null): number | null {
  if (!text) return null;
  const value = text.trim();
  if (!value) return null;
  let total = 0;
  for (const part of value.split(',')) {
    const token = part.trim();
    if (!token) return null;
    if (token.includes('-')) {
      const [startRaw, endRaw] = token.split('-', 2);
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        return null;
      }
      total += end - start + 1;
    } else {
      const single = Number(token);
      if (!Number.isInteger(single) || single < 0) return null;
      total += 1;
    }
    if (total > MAX_CORES) return null;
  }
  return total > 0 ? total : null;
}

function parseProcStat(text: string | null): { busy: number; total: number } | null {
  if (!text) return null;
  const line = text
    .split('\n')
    .find((entry) => entry.startsWith('cpu '));
  if (!line) return null;
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((entry) => Number(entry));
  if (values.length < 4 || values.some((entry) => !Number.isFinite(entry) || entry < 0)) {
    return null;
  }
  const idle = values[3] + (values[4] || 0);
  // guest/guest_nice are already included in user/nice; exclude them from the
  // total to avoid double counting on virtualised hosts.
  const total = values.slice(0, 8).reduce((sum, entry) => sum + entry, 0);
  const busy = total - idle;
  if (total <= 0 || busy < 0) return null;
  return { busy, total };
}

function parseCgroupV2Usage(text: string | null): number | null {
  const usage = Number(parseKeyValue(text).usage_usec);
  return Number.isFinite(usage) && usage >= 0 ? usage : null;
}

function parseCgroupV2QuotaCores(text: string | null): number | null {
  if (!text) return null;
  const [quotaRaw, periodRaw] = text.trim().split(/\s+/);
  if (quotaRaw === 'max') return null;
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) {
    return null;
  }
  return quota / period;
}

function parseCgroupV1QuotaCores(quotaText: string | null, periodText: string | null): number | null {
  const quota = Number(quotaText);
  const period = Number(periodText);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) {
    return null;
  }
  return quota / period;
}

function parseCgroupV2LimitBytes(text: string | null): number | null {
  if (!text) return null;
  const value = text.trim();
  if (!value || value === 'max') return null;
  const parsed = Number(value);
  // cgroup v2 treats only "max" as unlimited; 0 is a real (zero) cap.
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parseCgroupV1LimitBytes(text: string | null): number | null {
  if (!text) return null;
  const parsed = Number(text.trim());
  // cgroup v1 uses a huge sentinel (and sometimes 0/-1) for unlimited.
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= UNLIMITED_BYTES) return null;
  return parsed;
}

function bytesToMb(value: number): number {
  return value / MIB;
}

async function readText(file: string): Promise<string | null> {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function readFirst(files: string[]): Promise<string | null> {
  const values = await Promise.all(files.map((file) => readText(file)));
  return values.find((value) => value !== null) ?? null;
}

function normalizeReservation(reservation: ResourceReservation | null | undefined): {
  cpuCores: number;
  memoryMb: number;
} {
  return {
    cpuCores: Math.max(0, decimal(reservation?.cpuCores, 0)),
    memoryMb: Math.max(0, decimal(reservation?.memoryMb, 0)),
  };
}

/**
 * Normalize an untrusted stored sample.  Only known numeric fields, the ISO
 * timestamp and the coarse source enum survive; host paths, hostnames, PIDs,
 * credentials and arbitrary extra keys are dropped.
 */
export function sanitizeResourceSample(input: unknown): ResourceSample {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const cpuRaw = (raw.cpu && typeof raw.cpu === 'object' ? raw.cpu : {}) as Record<string, any>;
  const memoryRaw =
    (raw.memory && typeof raw.memory === 'object' ? raw.memory : {}) as Record<string, any>;

  const limitCores = clamp(decimal(cpuRaw.limitCores, 0), 0, MAX_CORES);
  const usedRaw = clamp(decimal(cpuRaw.usedCores, 0), 0, MAX_CORES);
  const usedCores = limitCores > 0 ? Math.min(usedRaw, limitCores) : 0;
  const computedCpuAvailable = Math.max(0, limitCores - usedCores);
  const hasCpuAvailable =
    cpuRaw.availableCores !== undefined &&
    cpuRaw.availableCores !== null &&
    Number.isFinite(Number(cpuRaw.availableCores));
  const availableCores = hasCpuAvailable
    ? Math.min(computedCpuAvailable, clamp(decimal(cpuRaw.availableCores, 0), 0, limitCores))
    : computedCpuAvailable;

  const limitMb = clamp(decimal(memoryRaw.limitMb, 0), 0, MAX_MEMORY_MB);
  const usedMb = clamp(decimal(memoryRaw.usedMb, 0), 0, MAX_MEMORY_MB);
  const computedMemoryAvailable = Math.max(0, limitMb - usedMb);
  const hasMemoryAvailable =
    memoryRaw.availableMb !== undefined &&
    memoryRaw.availableMb !== null &&
    Number.isFinite(Number(memoryRaw.availableMb));
  const availableMb = hasMemoryAvailable
    ? Math.min(computedMemoryAvailable, clamp(decimal(memoryRaw.availableMb, 0), 0, limitMb))
    : computedMemoryAvailable;

  const observedRaw = raw.observedAt === undefined || raw.observedAt === null
    ? raw.sampledAt
    : raw.observedAt;
  const rawTime =
    typeof observedRaw === 'number'
      ? observedRaw
      : Date.parse(typeof observedRaw === 'string' ? observedRaw : '');
  const time = Number.isFinite(rawTime) && rawTime > 0 ? rawTime : 0;
  const receivedRaw = raw.receivedAt;
  const receivedTime =
    typeof receivedRaw === 'number'
      ? receivedRaw
      : Date.parse(typeof receivedRaw === 'string' ? receivedRaw : '');

  return {
    sampledAt: new Date(time).toISOString(),
    observedAt: new Date(time).toISOString(),
    ...(Number.isFinite(receivedTime) && receivedTime > 0
      ? { receivedAt: new Date(receivedTime).toISOString() }
      : {}),
    cpu: {
      limitCores: round(limitCores, 3),
      usedCores: round(usedCores, 3),
      percent: limitCores > 0 ? round(clamp((usedCores / limitCores) * 100, 0, 100), 2) : 0,
      availableCores: round(availableCores, 3),
    },
    memory: {
      limitMb: Math.round(limitMb),
      usedMb: Math.round(usedMb),
      availableMb: Math.round(availableMb),
    },
    source: sourceOrDefault(raw.source),
  };
}

/** Append one sanitized sample to a bounded history (default/hard max 120). */
export function appendResourceHistory(
  existing: readonly unknown[] | null | undefined,
  sample: unknown,
  max = RESOURCE_HISTORY_LIMIT,
): ResourceSample[] {
  const requested = Number(max);
  const limit = Number.isFinite(requested)
    ? Math.min(RESOURCE_HISTORY_LIMIT, Math.max(1, Math.floor(requested)))
    : RESOURCE_HISTORY_LIMIT;
  const history: ResourceSample[] = [];
  if (Array.isArray(existing)) {
    for (const entry of existing) history.push(sanitizeResourceSample(entry));
  }
  history.push(sanitizeResourceSample(sample));
  return history.length > limit ? history.slice(-limit) : history;
}

/** True when a sample is too old/new to admit work against (default 15 s). */
export function isResourceSampleStale(
  sample: unknown,
  now = Date.now(),
  staleAfterMs = RESOURCE_HEARTBEAT_MS,
): boolean {
  const safe = sanitizeResourceSample(sample);
  const sampled = Date.parse(safe.sampledAt);
  if (!Number.isFinite(sampled) || sampled <= 0) return true;
  const threshold = Math.max(0, decimal(staleAfterMs, RESOURCE_HEARTBEAT_MS));
  const reference = Number.isFinite(now) ? now : Date.now();
  return Math.abs(reference - sampled) > threshold;
}

/**
 * Pure admission check.  Applies the sample's available CPU/RAM, then subtracts
 * active reservations and the configured headroom.  It never admits above the
 * usable budget (no oversubscription by rounding).
 */
export function fitRunnerResources(
  sample: unknown,
  request: ResourceFitRequest,
  options: ResourceFitOptions = {},
): ResourceFitResult {
  const safe = sanitizeResourceSample(sample);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const sampled = Date.parse(safe.sampledAt);
  const sampleAgeMs = Number.isFinite(sampled) ? now - sampled : Number.POSITIVE_INFINITY;
  const stale = isResourceSampleStale(
    safe,
    now,
    options.staleAfterMs ?? RESOURCE_HEARTBEAT_MS,
  );

  const requestedCores = requiredNumber(request?.cpuCores);
  const requestedMb = requiredNumber(request?.memoryMb);
  const invalidRequest =
    !Number.isFinite(requestedCores) || requestedCores < 0 ||
    !Number.isFinite(requestedMb) || requestedMb < 0;

  const reservations = Array.isArray(options.activeReservations)
    ? options.activeReservations.map((entry) => normalizeReservation(entry))
    : [];
  const reservedCores = reservations.reduce((sum, entry) => sum + entry.cpuCores, 0);
  const reservedMb = reservations.reduce((sum, entry) => sum + entry.memoryMb, 0);

  const headroomPercent = clamp(
    decimal(options.cpuHeadroomPercent ?? DEFAULT_CPU_HEADROOM_PERCENT, DEFAULT_CPU_HEADROOM_PERCENT),
    0,
    100,
  );
  const headroomMb = Math.max(
    0,
    decimal(options.memoryHeadroomMb ?? DEFAULT_MEMORY_HEADROOM_MB, DEFAULT_MEMORY_HEADROOM_MB),
  );

  const limitCores = safe.cpu.limitCores;
  const limitMb = safe.memory.limitMb;
  const sampleAvailableCores = safe.cpu.availableCores;
  const sampleAvailableMb = safe.memory.availableMb;
  const headroomCores = limitCores * (headroomPercent / 100);
  const observedBusyCores = Math.max(0, limitCores - sampleAvailableCores);
  // CPU reservations are an overlay on observed container usage, not additive:
  // the sampled usage already includes the active jobs.  Use
  // limit - max(observedBusy, reserved) - headroom so a job is not counted twice.
  // Memory stays conservative: job reservations are incremental on top of the
  // already-loaded model/runner usage measured by the sample.
  const effectiveBusyCores = Math.max(observedBusyCores, reservedCores);
  const unavailable = safe.source === 'unknown' || limitCores <= 0 || limitMb <= 0;

  const usableCores = stale || unavailable
    ? 0
    : Math.max(0, Math.min(sampleAvailableCores, limitCores - reservedCores) - headroomCores);
  const usableMb = stale || unavailable
    ? 0
    : Math.max(0, sampleAvailableMb - reservedMb - headroomMb);

  let reason: ResourceFitReason | undefined;
  const epsilon = 1e-9;
  if (invalidRequest) reason = 'invalid';
  else if (stale) reason = 'stale';
  else if (unavailable) reason = 'unavailable';
  else {
    const cpuOk = requestedCores <= usableCores + epsilon;
    const memoryOk = requestedMb <= usableMb + epsilon;
    if (!cpuOk && !memoryOk) reason = 'cpu+memory';
    else if (!cpuOk) reason = 'cpu';
    else if (!memoryOk) reason = 'memory';
  }

  const remainingCores =
    reason === 'cpu' || reason === 'cpu+memory' || reason === 'stale' || reason === 'unavailable'
      ? usableCores - (Number.isFinite(requestedCores) ? requestedCores : 0)
      : Math.max(0, usableCores - (Number.isFinite(requestedCores) ? requestedCores : 0));
  const remainingMb =
    reason === 'memory' || reason === 'cpu+memory' || reason === 'stale' || reason === 'unavailable'
      ? usableMb - (Number.isFinite(requestedMb) ? requestedMb : 0)
      : Math.max(0, usableMb - (Number.isFinite(requestedMb) ? requestedMb : 0));

  return {
    ok: reason === undefined,
    ...(reason ? { reason } : {}),
    sampleAgeMs: Number.isFinite(sampleAgeMs) ? Math.round(sampleAgeMs) : -1,
    cpu: {
      requestedCores: Number.isFinite(requestedCores) ? round(requestedCores, 3) : 0,
      limitCores: round(limitCores, 3),
      sampleAvailableCores: round(sampleAvailableCores, 3),
      observedBusyCores: round(observedBusyCores, 3),
      reservedCores: round(reservedCores, 3),
      effectiveBusyCores: round(effectiveBusyCores, 3),
      headroomCores: round(headroomCores, 3),
      availableCores: round(usableCores, 3),
      remainingCores: round(remainingCores, 3),
    },
    memory: {
      requestedMb: Number.isFinite(requestedMb) ? round(requestedMb, 1) : 0,
      limitMb: Math.round(limitMb),
      sampleAvailableMb: Math.round(sampleAvailableMb),
      reservedMb: Math.round(reservedMb),
      headroomMb: Math.round(headroomMb),
      availableMb: Math.round(usableMb),
      remainingMb: Math.round(remainingMb),
    },
  };
}

/** First-fit selection; call again with selected work added to reservations. */
export function chooseRunnerResources<T extends ResourceCandidate>(
  candidates: readonly T[] | null | undefined,
  sample: unknown,
  options: ResourceFitOptions = {},
): ResourceChoice<T> {
  const rejected: Array<{ candidate: T; fit: ResourceFitResult }> = [];
  if (!Array.isArray(candidates)) return { selected: null, fit: null, rejected };
  for (const candidate of candidates) {
    const fit = fitRunnerResources(sample, candidate, options);
    if (fit.ok) return { selected: candidate, fit, rejected };
    rejected.push({ candidate, fit });
  }
  return { selected: null, fit: null, rejected };
}

/** Short aliases for callers that prefer `fitResources` / `chooseResources`. */
export const fitResources = fitRunnerResources;
export const chooseResources = chooseRunnerResources;

export class RunnerResourceSampler {
  private readonly cgroupRoot: string;
  private readonly procRoot: string;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private lastCpu: LastCpuCounter | null = null;
  private inFlight: Promise<ResourceSample> | null = null;

  constructor(options: RunnerResourceSamplerOptions = {}) {
    this.cgroupRoot = options.cgroupRoot || DEFAULT_CGROUP_ROOT;
    this.procRoot = options.procRoot || DEFAULT_PROC_ROOT;
    this.now = options.now || (() => Date.now());
    this.monotonic =
      options.monotonic || (() => Number(process.hrtime.bigint()) / 1_000_000);
  }

  async sample(): Promise<ResourceSample> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sampleOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async sampleOnce(): Promise<ResourceSample> {
    const startedAt = this.now();
    try {
      const [host, v2, v1] = await Promise.all([
        this.readHost(),
        this.readCgroupV2(),
        this.readCgroupV1(),
      ]);
      return this.buildSample(startedAt, host, v2, v1);
    } catch {
      // Never let telemetry break the heartbeat; unknown is fail-closed for
      // admission rather than leaking a host path or an exception message.
      return safeSample(startedAt, 'unknown');
    }
  }

  private async readHost(): Promise<HostReading> {
    const [stat, meminfo, cpuinfo] = await Promise.all([
      readText(path.join(this.procRoot, 'stat')),
      readText(path.join(this.procRoot, 'meminfo')),
      readText(path.join(this.procRoot, 'cpuinfo')),
    ]);
    const detectedCpus = parseCpuinfoCount(cpuinfo);
    const cpuCount = Math.max(
      1,
      detectedCpus || os.cpus().length || 1,
    );
    const totalMb = parseMeminfoMb(meminfo, 'MemTotal') || os.totalmem() / MIB;
    const availableMb =
      parseMeminfoMb(meminfo, 'MemAvailable') || os.freemem() / MIB;
    return {
      cpuCount,
      totalMb: Math.max(0, totalMb),
      availableMb: Math.max(0, Math.min(availableMb, totalMb)),
      stat,
    };
  }

  private async readCgroupV2(): Promise<CgroupV2Reading> {
    const roots = [this.cgroupRoot, path.join(this.cgroupRoot, 'unified')];
    const [cpuStat, cpuMax, cpusetEffective, cpuset, memoryCurrent, memoryMax] =
      await Promise.all([
        readFirst(roots.map((root) => path.join(root, 'cpu.stat'))),
        readFirst(roots.map((root) => path.join(root, 'cpu.max'))),
        readFirst(roots.map((root) => path.join(root, 'cpuset.cpus.effective'))),
        readFirst(roots.map((root) => path.join(root, 'cpuset.cpus'))),
        readFirst(roots.map((root) => path.join(root, 'memory.current'))),
        readFirst(roots.map((root) => path.join(root, 'memory.max'))),
      ]);
    return {
      present: Boolean(cpuStat || cpuMax || memoryCurrent || memoryMax),
      cpuStat,
      cpuMax,
      cpuset: cpusetEffective || cpuset,
      memoryCurrent,
      memoryMax,
    };
  }

  private async readCgroupV1(): Promise<CgroupV1Reading> {
    const cpuDirs = ['cpu,cpuacct', 'cpu', 'cpuacct'].map((name) =>
      path.join(this.cgroupRoot, name),
    );
    const cpusetDirs = [path.join(this.cgroupRoot, 'cpuset'), ...cpuDirs];
    const memoryDir = path.join(this.cgroupRoot, 'memory');
    const [cpuacctUsage, quota, period, cpuset, memoryUsage, memoryLimit] =
      await Promise.all([
        readFirst(cpuDirs.map((dir) => path.join(dir, 'cpuacct.usage'))),
        readFirst(cpuDirs.map((dir) => path.join(dir, 'cpu.cfs_quota_us'))),
        readFirst(cpuDirs.map((dir) => path.join(dir, 'cpu.cfs_period_us'))),
        readFirst(
          cpusetDirs.flatMap((dir) => [
            path.join(dir, 'cpuset.cpus'),
            path.join(dir, 'cpuset.effective_cpus'),
          ]),
        ),
        readFirst([path.join(memoryDir, 'memory.usage_in_bytes')]),
        readFirst([path.join(memoryDir, 'memory.limit_in_bytes')]),
      ]);
    return {
      present: Boolean(
        cpuacctUsage || quota || memoryUsage || memoryLimit || cpuset,
      ),
      cpuacctUsage,
      quota,
      period,
      cpuset,
      memoryUsage,
      memoryLimit,
    };
  }

  private buildSample(
    nowMs: number,
    host: HostReading,
    v2: CgroupV2Reading,
    v1: CgroupV1Reading,
  ): ResourceSample {
    const monotonic = this.monotonic();
    const hostCpuLimit = Math.max(1, host.cpuCount);

    const v2Usage = parseCgroupV2Usage(v2.cpuStat);
    const v1Usage = numberFromText(v1.cpuacctUsage);
    const hostStat = parseProcStat(host.stat);

    let counter: CpuCounter | null = null;
    if (v2Usage !== null) counter = { kind: 'cgroup-v2', usage: v2Usage };
    else if (Number.isFinite(v1Usage) && v1Usage >= 0) {
      counter = { kind: 'cgroup-v1', usage: v1Usage };
    } else if (hostStat) {
      counter = { kind: 'host', busy: hostStat.busy, total: hostStat.total };
    }

    const quotaCandidates = [
      parseCgroupV2QuotaCores(v2.cpuMax),
      parseCgroupV1QuotaCores(v1.quota, v1.period),
    ].filter((value): value is number => value !== null && value > 0);
    const cpusetCandidates = [
      parseCpuSetCount(v2.cpuset),
      parseCpuSetCount(v1.cpuset),
    ].filter((value): value is number => value !== null && value > 0);
    const quotaCores = quotaCandidates.length ? Math.min(...quotaCandidates) : null;
    const cpusetCores = cpusetCandidates.length ? Math.min(...cpusetCandidates) : null;
    const rawLimitCores = Math.min(
      hostCpuLimit,
      quotaCores ?? hostCpuLimit,
      cpusetCores ?? hostCpuLimit,
    );
    const limitCores = clamp(rawLimitCores, 0.01, hostCpuLimit);

    let usedCores = 0;
    let cpuDeltaValid = false;
    const previous = this.lastCpu;
    const elapsedMs = previous ? Math.max(0, monotonic - previous.at) : 0;
    if (counter && previous && counter.kind === previous.kind) {
      if (counter.kind === 'host') {
        const busy = counter.busy ?? 0;
        const total = counter.total ?? 0;
        const prevBusy = previous.busy ?? 0;
        const prevTotal = previous.total ?? 0;
        const busyDelta = busy - prevBusy;
        const totalDelta = total - prevTotal;
        if (busyDelta >= 0 && totalDelta > 0) {
          usedCores = (busyDelta / totalDelta) * hostCpuLimit;
          cpuDeltaValid = true;
        }
      } else {
        const usage = counter.usage ?? 0;
        const prevUsage = previous.usage ?? 0;
        const usageDelta = usage - prevUsage;
        if (usageDelta >= 0 && elapsedMs > 0) {
          const divisor = counter.kind === 'cgroup-v2' ? 1000 : 1_000_000;
          usedCores = usageDelta / divisor / elapsedMs;
          cpuDeltaValid = true;
        }
      }
    }
    if (counter) {
      this.lastCpu = {
        kind: counter.kind,
        usage: counter.usage,
        busy: counter.busy,
        total: counter.total,
        at: monotonic,
      };
    }
    usedCores = clamp(usedCores, 0, limitCores);
    // No delta yet (first sample), or a counter reset/decrease: do not claim
    // idle CPU.  Keep percent at 0 but make the sample non-admitting until the
    // next genuine interval produces a positive/valid measurement.
    const availableCores = cpuDeltaValid
      ? clamp(limitCores - usedCores, 0, hostCpuLimit)
      : 0;

    const v2MemoryCurrent = numberFromText(v2.memoryCurrent);
    const v1MemoryUsage = numberFromText(v1.memoryUsage);
    const v2MemoryLimit = parseCgroupV2LimitBytes(v2.memoryMax);
    const v1MemoryLimit = parseCgroupV1LimitBytes(v1.memoryLimit);
    const cgroupMemoryUsedBytes = Number.isFinite(v2MemoryCurrent)
      ? v2MemoryCurrent
      : Number.isFinite(v1MemoryUsage)
        ? v1MemoryUsage
        : null;
    const cgroupMemoryLimitBytes = v2MemoryLimit ?? v1MemoryLimit ?? null;
    const hostTotalMb = Math.max(0, host.totalMb);
    const hostAvailableMb = clamp(host.availableMb, 0, hostTotalMb);
    const usedMb =
      cgroupMemoryUsedBytes !== null
        ? bytesToMb(Math.max(0, cgroupMemoryUsedBytes))
        : Math.max(0, hostTotalMb - hostAvailableMb);
    const limitMb = clamp(
      cgroupMemoryLimitBytes !== null ? bytesToMb(cgroupMemoryLimitBytes) : hostTotalMb,
      0,
      hostTotalMb,
    );
    const availableMb = clamp(
      Math.min(Math.max(0, limitMb - usedMb), hostAvailableMb),
      0,
      limitMb,
    );

    const usedV2 = v2.present;
    const usedV1 = v1.present;
    const source: ResourceSampleSource =
      usedV2 && usedV1
        ? 'cgroup-mixed'
        : usedV2
          ? 'cgroup-v2'
          : usedV1
            ? 'cgroup-v1'
            : 'host';

    return sanitizeResourceSample({
      sampledAt: nowMs,
      cpu: {
        limitCores,
        usedCores,
        percent: limitCores > 0 ? (usedCores / limitCores) * 100 : 0,
        availableCores,
      },
      memory: { limitMb, usedMb, availableMb },
      source,
    });
  }
}
