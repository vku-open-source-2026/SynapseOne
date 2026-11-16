// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Owner-managed Docker resource controls for workflow runners.
 *
 * The owner UI exposes an explicit on/off switch for the CPU limit and the
 * memory limit, numeric CPU/MiB fields (sliders) and a workflow concurrency
 * selector.  This module is the single validation/normalisation boundary:
 *
 *   - `normalizeDockerResources()` validates an owner request body;
 *   - `effectiveDockerResources()` resolves the persisted
 *     `metadata.dockerResources` (or the legacy inference-derived defaults when
 *     the owner has never configured it);
 *   - `dockerResourceFlags()` renders the `docker run` cgroup flags.
 *
 * Values that reach the command renderer are always one of five validated
 * fields, so a tampered `metadata.dockerResources` string can never be pasted
 * into the shell command.  Inference model limits (`metadata.inference.limits`)
 * stay separate: they tune the local worker, not the container cgroup.
 */

export type RunnerKind = 'workflow' | 'inference' | 'hybrid';

export interface DockerResources {
  /** Emit `--cpus` when true; omit it entirely when false. */
  cpuEnabled: boolean;
  /** Emit `--memory` + `--memory-swap` when true; omit both when false. */
  memoryEnabled: boolean;
  /** CPU limit in cores (Docker `--cpus`). */
  cpus: number;
  /** Memory limit in MiB (Docker `--memory`). */
  memoryMb: number;
  /** Workflow lane concurrency (`WORKFLOW_RUNNER_CONCURRENCY`). */
  concurrency: number;
}

export const DOCKER_RESOURCES = {
  cpusMin: 0.25,
  cpusMax: 64,
  memoryMbMin: 256,
  memoryMbMax: 262144,
  concurrencyMin: 1,
  concurrencyMax: 32,
  /** Legacy defaults kept when the owner never configured this runner. */
  legacy: {
    workflow: { cpus: 2, memoryMb: 1024, concurrency: 8 },
    inference: { cpus: 2, memoryMb: 6144, concurrency: 8 },
    hybrid: { cpus: 2, memoryMb: 6144, concurrency: 8 },
  },
} as const;

const DOCKER_RESOURCE_KEYS = ['cpuEnabled', 'memoryEnabled', 'cpus', 'memoryMb', 'concurrency'] as const;

export function normalizeRunnerKind(value: unknown): RunnerKind {
  return value === 'inference' || value === 'hybrid' ? value : 'workflow';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 2-decimal rounding keeps `--cpus` free of float noise (0.25, 1.5, 64). */
function roundCpus(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Defaults used when no owner configuration exists at all. */
export function defaultDockerResources(kind: RunnerKind): DockerResources {
  const legacy = DOCKER_RESOURCES.legacy[normalizeRunnerKind(kind)];
  return {
    cpuEnabled: true,
    memoryEnabled: true,
    cpus: legacy.cpus,
    memoryMb: legacy.memoryMb,
    concurrency: legacy.concurrency,
  };
}

/** Pre-control command shape: CPU came from `inference.limits.threads` and
 *  memory from `inference.limits.maxRssMb`.  Keep that behaviour for runners
 *  the owner has not re-configured yet, so an existing deployment's command
 *  does not change silently. */
export function legacyDockerResources(
  kind: RunnerKind,
  inferenceLimits?: Record<string, any> | null,
): DockerResources {
  const base = defaultDockerResources(kind);
  const limits = inferenceLimits && typeof inferenceLimits === 'object' ? inferenceLimits : {};
  const threads = Number(limits.threads);
  const maxRssMb = Number(limits.maxRssMb);
  return {
    cpuEnabled: true,
    memoryEnabled: true,
    cpus: Number.isFinite(threads) && threads > 0
      ? roundCpus(clamp(threads, DOCKER_RESOURCES.cpusMin, DOCKER_RESOURCES.cpusMax))
      : base.cpus,
    memoryMb: Number.isFinite(maxRssMb) && maxRssMb > 0
      ? Math.round(clamp(maxRssMb, DOCKER_RESOURCES.memoryMbMin, DOCKER_RESOURCES.memoryMbMax))
      : base.memoryMb,
    concurrency: base.concurrency,
  };
}

/**
 * Validate an owner-supplied `dockerResources` body.
 *
 * Unknown fields are rejected so the persisted shape stays exactly five keys.
 * Omitted fields are inherited from `base` (the current effective config on
 * PATCH, the kind defaults on create), which keeps the UI sliders additive.
 */
export function normalizeDockerResources(
  input: unknown,
  base: DockerResources = defaultDockerResources('workflow'),
): { value?: DockerResources; error?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'dockerResources must be an object' };
  }
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(DOCKER_RESOURCE_KEYS as readonly string[]).includes(key)) {
      return { error: `dockerResources may only contain ${DOCKER_RESOURCE_KEYS.join(', ')}` };
    }
  }
  const value: DockerResources = { ...base };

  if (source.cpuEnabled !== undefined) {
    if (typeof source.cpuEnabled !== 'boolean') return { error: 'dockerResources.cpuEnabled must be a boolean' };
    value.cpuEnabled = source.cpuEnabled;
  }
  if (source.memoryEnabled !== undefined) {
    if (typeof source.memoryEnabled !== 'boolean') return { error: 'dockerResources.memoryEnabled must be a boolean' };
    value.memoryEnabled = source.memoryEnabled;
  }
  if (source.cpus !== undefined) {
    if (typeof source.cpus !== 'number' || !Number.isFinite(source.cpus)) {
      return { error: `dockerResources.cpus must be a number ${DOCKER_RESOURCES.cpusMin}..${DOCKER_RESOURCES.cpusMax}` };
    }
    if (source.cpus < DOCKER_RESOURCES.cpusMin || source.cpus > DOCKER_RESOURCES.cpusMax) {
      return { error: `dockerResources.cpus must be ${DOCKER_RESOURCES.cpusMin}..${DOCKER_RESOURCES.cpusMax}` };
    }
    value.cpus = roundCpus(source.cpus);
  }
  if (source.memoryMb !== undefined) {
    if (typeof source.memoryMb !== 'number' || !Number.isInteger(source.memoryMb)) {
      return { error: `dockerResources.memoryMb must be an integer ${DOCKER_RESOURCES.memoryMbMin}..${DOCKER_RESOURCES.memoryMbMax}` };
    }
    if (source.memoryMb < DOCKER_RESOURCES.memoryMbMin || source.memoryMb > DOCKER_RESOURCES.memoryMbMax) {
      return { error: `dockerResources.memoryMb must be ${DOCKER_RESOURCES.memoryMbMin}..${DOCKER_RESOURCES.memoryMbMax}` };
    }
    value.memoryMb = source.memoryMb;
  }
  if (source.concurrency !== undefined) {
    if (typeof source.concurrency !== 'number' || !Number.isInteger(source.concurrency)) {
      return { error: `dockerResources.concurrency must be an integer ${DOCKER_RESOURCES.concurrencyMin}..${DOCKER_RESOURCES.concurrencyMax}` };
    }
    if (source.concurrency < DOCKER_RESOURCES.concurrencyMin || source.concurrency > DOCKER_RESOURCES.concurrencyMax) {
      return { error: `dockerResources.concurrency must be ${DOCKER_RESOURCES.concurrencyMin}..${DOCKER_RESOURCES.concurrencyMax}` };
    }
    value.concurrency = source.concurrency;
  }
  return { value };
}

/** Validate the persisted shape. Invalid/tampered values are ignored (null)
 *  instead of leaking into a command; the caller then falls back to defaults. */
export function readDockerResources(value: unknown, kind: RunnerKind): DockerResources | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = normalizeDockerResources(value, defaultDockerResources(kind));
  return parsed.value ?? null;
}

/**
 * Resolve the config that actually drives this runner's Docker command.
 * Platform runners always have an effective config (owner value or legacy
 * defaults). Tenant runners only have one when an owner explicitly stored one;
 * otherwise they keep the historic "no cgroup flags, concurrency 1" shape.
 */
export function effectiveDockerResources(runner: {
  scope?: string | null;
  kind?: string | null;
  metadata?: Record<string, any> | null;
}): DockerResources | null {
  const kind = normalizeRunnerKind(runner.kind);
  const metadata = runner.metadata && typeof runner.metadata === 'object' ? runner.metadata : {};
  const persisted = readDockerResources(metadata.dockerResources, kind);
  if (persisted) return persisted;
  if (runner.scope === 'platform') {
    const inference = metadata.inference && typeof metadata.inference === 'object' ? metadata.inference : {};
    return legacyDockerResources(kind, inference.limits);
  }
  return null;
}

/** `--cpus` / `--memory` / `--memory-swap` in stable order. Disabled limits
 *  emit nothing at all; when memory is enabled both memory flags stay equal. */
export function dockerResourceFlags(resources: DockerResources | null): string[] {
  if (!resources) return [];
  const flags: string[] = [];
  // Numbers are validated above, but re-check before shell rendering as
  // defence in depth for a forged persisted object.
  if (resources.cpuEnabled && Number.isFinite(resources.cpus)
    && resources.cpus >= DOCKER_RESOURCES.cpusMin && resources.cpus <= DOCKER_RESOURCES.cpusMax) {
    flags.push(`--cpus=${roundCpus(resources.cpus)}`);
  }
  if (resources.memoryEnabled && Number.isInteger(resources.memoryMb)
    && resources.memoryMb >= DOCKER_RESOURCES.memoryMbMin && resources.memoryMb <= DOCKER_RESOURCES.memoryMbMax) {
    flags.push(`--memory=${resources.memoryMb}m`, `--memory-swap=${resources.memoryMb}m`);
  }
  return flags;
}

/** Workflow lane concurrency for `WORKFLOW_RUNNER_CONCURRENCY`. */
export function dockerResourceConcurrency(resources: DockerResources | null): number {
  if (!resources) return 1;
  const value = Number(resources.concurrency);
  if (!Number.isInteger(value)) return 1;
  return clamp(value, DOCKER_RESOURCES.concurrencyMin, DOCKER_RESOURCES.concurrencyMax);
}

/** Public bounds/defaults for the owner UI (`/v1/platform/runners/options`). */
export function dockerResourceOptions(): Record<string, any> {
  return {
    fields: [...DOCKER_RESOURCE_KEYS],
    bounds: {
      cpus: { min: DOCKER_RESOURCES.cpusMin, max: DOCKER_RESOURCES.cpusMax, step: 0.25 },
      memoryMb: { min: DOCKER_RESOURCES.memoryMbMin, max: DOCKER_RESOURCES.memoryMbMax, step: 256 },
      concurrency: { min: DOCKER_RESOURCES.concurrencyMin, max: DOCKER_RESOURCES.concurrencyMax, step: 1 },
    },
    defaults: {
      workflow: defaultDockerResources('workflow'),
      inference: defaultDockerResources('inference'),
      hybrid: defaultDockerResources('hybrid'),
    },
    note: 'CPU and memory limits map to Docker --cpus / --memory / --memory-swap; disabled limits are omitted. Inference model limits stay in metadata.inference.limits.',
  };
}
