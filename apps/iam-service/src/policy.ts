// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * AWS IAM-style policy evaluation: explicit Deny wins, then Allow, default deny.
 */
import type { PolicyDoc } from './db';

function toArr(x: string | string[]): string[] {
  return Array.isArray(x) ? x : [x];
}

// Linear-time glob matcher: '*' matches any sequence (including ':'), exact
// otherwise. Literal segments are found with KMP, so adversarial patterns cannot
// trigger regex backtracking. 'prefix:*' still requires the ':' boundary — no
// over-match of 'prefixEvil'.
export const MAX_GLOB_WILDCARDS = 16;
const MAX_PATTERN_LEN = 512;

/** Count wildcard runs, not raw '*' characters: consecutive stars are one glob
 *  wildcard and must not consume the anti-abuse budget. */
function countGlobWildcards(pattern: string): number {
  let count = 0;
  let previousStar = false;
  for (const ch of pattern) {
    if (ch === '*') {
      if (!previousStar) count++;
      previousStar = true;
    } else {
      previousStar = false;
    }
  }
  return count;
}

function globSegments(pattern: string): string[] {
  const segments: string[] = [];
  let literal = '';
  for (const ch of pattern) {
    if (ch === '*') {
      if (literal) segments.push(literal);
      literal = '';
    } else {
      literal += ch;
    }
  }
  if (literal) segments.push(literal);
  return segments;
}

/** KMP substring search. Each successful search resumes after its match, so a
 *  complete glob match scans the value at most once (plus literal comparisons). */
function findLiteral(value: string, literal: string, from: number): number {
  if (!literal) return from;
  const failure = new Array<number>(literal.length).fill(0);
  for (let i = 1, matched = 0; i < literal.length; i++) {
    while (matched > 0 && literal[i] !== literal[matched]) matched = failure[matched - 1];
    if (literal[i] === literal[matched]) matched++;
    failure[i] = matched;
  }
  for (let i = from, matched = 0; i < value.length; i++) {
    while (matched > 0 && value[i] !== literal[matched]) matched = failure[matched - 1];
    if (value[i] === literal[matched]) matched++;
    if (matched === literal.length) return i - literal.length + 1;
  }
  return -1;
}

export function matchPattern(pattern: string, value: string): boolean {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  if (pattern.length > MAX_PATTERN_LEN || countGlobWildcards(pattern) > MAX_GLOB_WILDCARDS) return false;
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  // Bare service prefix still matches 'service:*' (legacy behavior). Treat a
  // consecutive trailing wildcard run as the collapsed single wildcard.
  if (pattern.endsWith('*')) {
    let beforeStars = pattern.length - 1;
    while (beforeStars >= 0 && pattern[beforeStars] === '*') beforeStars--;
    if (beforeStars >= 0 && pattern[beforeStars] === ':' && value === pattern.slice(0, beforeStars)) return true;
  }

  const segments = globSegments(pattern);
  const startsWildcard = pattern.startsWith('*');
  const endsWildcard = pattern.endsWith('*');
  let segmentIndex = 0;
  let valueIndex = 0;
  if (!startsWildcard) {
    const first = segments[segmentIndex++];
    if (!value.startsWith(first)) return false;
    valueIndex = first.length;
  }
  const searchEnd = endsWildcard ? segments.length : segments.length - 1;
  while (segmentIndex < searchEnd) {
    const literal = segments[segmentIndex++];
    const found = findLiteral(value, literal, valueIndex);
    if (found < 0) return false;
    valueIndex = found + literal.length;
  }
  if (!endsWildcard) {
    const last = segments[segmentIndex];
    return last.length <= value.length - valueIndex && value.endsWith(last);
  }
  return true;
}

export interface AuthzRequest {
  action: string;   // e.g. "workflow:Execute"
  resource: string; // e.g. "arn:synapseone:acme:prod:workflow:etl-nightly" or "*"
}

export type ConditionContext = Record<string, string | number | boolean | undefined>;

// AWS-style conditions (subset): StringEquals (+ IfExists variants), StringLike.
// Condition chưa thỏa → statement bị bỏ qua (không match).
// ReDoS guard: StringLike dùng linear-time glob matcher — giới hạn độ dài/số
// wildcard để policy độc hại không thể đốt CPU mỗi lần authorize. Cùng giới hạn
// áp lúc ghi; ở đây fail-closed ("không match") cho document bất ngờ.
const MAX_LIKE_PATTERN_LEN = 256;
const MAX_LIKE_PATTERNS_PER_KEY = 100;

export function matchCondition(cond: any, ctx: ConditionContext): boolean {
  // An absent Condition is unconditional; a malformed one is not. Failing
  // open here turned a typo into an unconditional Allow/Deny.
  if (cond === undefined) return true;
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return false;
  for (const [opRaw, kv] of Object.entries(cond)) {
    const ifExists = opRaw.endsWith('IfExists');
    const op = ifExists ? opRaw.slice(0, -'IfExists'.length) : opRaw;
    if (op !== 'StringEquals' && op !== 'StringLike') return false;
    if (typeof kv !== 'object' || kv === null || Array.isArray(kv)) return false;
    for (const [k, v] of Object.entries(kv as Record<string, any>)) {
      const actual = ctx[k];
      if (actual === undefined) {
        if (ifExists) continue;
        return false;
      }
      const a = String(actual);
      if (a.length > 4096) return false; // context value bất thường → không match
      if (op === 'StringEquals') {
        const ok = Array.isArray(v) ? v.map(String).includes(a) : String(v) === a;
        if (!ok) return false;
      } else if (op === 'StringLike') {
        const patterns = (Array.isArray(v) ? v : [v]).map(String);
        if (patterns.length > MAX_LIKE_PATTERNS_PER_KEY) return false;
        const ok = patterns.some((p) => p.length <= MAX_LIKE_PATTERN_LEN && matchPattern(p, a));
        if (!ok) return false;
      } else {
        return false; // operator lạ → conservative: không match
      }
    }
  }
  return true;
}

export function evaluatePolicies(
  docs: PolicyDoc[],
  req: AuthzRequest,
  context: ConditionContext = {},
): { allowed: boolean; matchedBy?: string } {
  let allowed = false;
  for (const doc of docs) {
    for (const st of doc.Statement || []) {
      const actions = toArr(st.Action);
      const resources = toArr(st.Resource);
      const actionHit = actions.some((a) => matchPattern(a, req.action));
      const resourceHit = resources.some((r) => matchPattern(r, req.resource));
      if (!actionHit || !resourceHit) continue;
      if (!matchCondition((st as any).Condition, context)) continue;
      if (st.Effect === 'Deny') return { allowed: false, matchedBy: 'Deny' };
      if (st.Effect === 'Allow') allowed = true;
    }
  }
  return { allowed, matchedBy: allowed ? 'Allow' : undefined };
}

// helpers to build common docs
export function adminPolicy(): PolicyDoc {
  return { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] };
}
export function readOnlyPolicy(): PolicyDoc {
  return { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: ['*:Get', '*:List', '*:Describe', '*:Read'], Resource: '*' }] };
}
export function workflowRunnerPolicy(accountSlug: string): PolicyDoc {
  const safe = /^[a-z0-9-]{1,64}$/.test(accountSlug || '') ? accountSlug : '*';
  return {
    Version: '2026-01-01',
    Statement: [
      { Effect: 'Allow', Action: ['workflow:Execute', 'workflow:Read'], Resource: safe === '*' ? '*' : `arn:synapseone:*:${safe}:*` },
      { Effect: 'Deny', Action: ['iam:*', 'org:Delete'], Resource: '*' },
    ],
  };
}

/**
 * Validate a policy document BEFORE storing/evaluating it (called by IAM on
 * createPolicy + authorize/dry-run). Returns an error message, or null when valid.
 * Caps: statements, pattern lengths, condition size — blocks stored-ReDoS and
 * oversized documents (DoS via 1mb JSON body full of statements).
 */
const MAX_STATEMENTS = 100;
const MAX_CONDITION_BYTES = 8192;

function validateCondition(cond: any, statementIndex: number): string | null {
  const where = `Statement[${statementIndex}].Condition`;
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return `${where} must be an object`;
  const operators = Object.keys(cond);
  if (operators.length === 0) return `${where} must not be empty`;
  for (const opRaw of operators) {
    const op = opRaw.endsWith('IfExists') ? opRaw.slice(0, -'IfExists'.length) : opRaw;
    if (op !== 'StringEquals' && op !== 'StringLike') return `${where}.${opRaw} is not a supported operator`;
    const kv = (cond as any)[opRaw];
    if (!kv || typeof kv !== 'object' || Array.isArray(kv)) return `${where}.${opRaw} must be an object`;
    const entries = Object.entries(kv as Record<string, any>);
    if (entries.length === 0 || entries.length > MAX_LIKE_PATTERNS_PER_KEY) {
      return `${where}.${opRaw} must have 1..${MAX_LIKE_PATTERNS_PER_KEY} keys`;
    }
    for (const [key, value] of entries) {
      if (!key || key.length > 128) return `${where}.${opRaw} has an invalid key`;
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0 || values.length > MAX_LIKE_PATTERNS_PER_KEY) {
        return `${where}.${opRaw}.${key} must have 1..${MAX_LIKE_PATTERNS_PER_KEY} values`;
      }
      for (const item of values) {
        if (!['string', 'number', 'boolean'].includes(typeof item)) {
          return `${where}.${opRaw}.${key} values must be strings, numbers or booleans`;
        }
        if (String(item).length > MAX_LIKE_PATTERN_LEN) {
          return `${where}.${opRaw}.${key} value exceeds ${MAX_LIKE_PATTERN_LEN} chars`;
        }
        if (op === 'StringLike' && countGlobWildcards(String(item)) > MAX_GLOB_WILDCARDS) {
          return `${where}.${opRaw}.${key} value exceeds ${MAX_GLOB_WILDCARDS} wildcards`;
        }
      }
    }
  }
  return null;
}

export function validatePolicyDocument(doc: any): string | null {
  if (!doc || typeof doc !== 'object') return 'document must be an object';
  if (!Array.isArray((doc as any).Statement)) return 'document.Statement required (AWS IAM style)';
  const stmts = (doc as any).Statement;
  if (stmts.length === 0) return 'document.Statement must not be empty';
  if (stmts.length > MAX_STATEMENTS) return `document.Statement exceeds ${MAX_STATEMENTS} statements`;
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    if (!st || typeof st !== 'object') return `Statement[${i}] must be an object`;
    if (st.Effect !== 'Allow' && st.Effect !== 'Deny') return `Statement[${i}].Effect must be Allow|Deny`;
    for (const key of ['Action', 'Resource'] as const) {
      const arr = Array.isArray(st[key]) ? st[key] : [st[key]];
      if (arr.length === 0 || arr.length > MAX_STATEMENTS) return `Statement[${i}].${key} must have 1..${MAX_STATEMENTS} entries`;
      for (const p of arr) {
        if (typeof p !== 'string' || p.length === 0) return `Statement[${i}].${key} entries must be non-empty strings`;
        if (p.length > MAX_PATTERN_LEN) return `Statement[${i}].${key} pattern exceeds ${MAX_PATTERN_LEN} chars`;
        if (countGlobWildcards(p) > MAX_GLOB_WILDCARDS) {
          return `Statement[${i}].${key} pattern exceeds ${MAX_GLOB_WILDCARDS} wildcards`;
        }
      }
    }
    if (st.Condition !== undefined) {
      let bytes = 0;
      try {
        bytes = Buffer.byteLength(JSON.stringify(st.Condition), 'utf8');
      } catch {
        return `Statement[${i}].Condition is not JSON-serializable`;
      }
      if (bytes > MAX_CONDITION_BYTES) return `Statement[${i}].Condition exceeds ${MAX_CONDITION_BYTES} bytes`;
      const condErr = validateCondition(st.Condition, i);
      if (condErr) return condErr;
    }
  }
  return null;
}
