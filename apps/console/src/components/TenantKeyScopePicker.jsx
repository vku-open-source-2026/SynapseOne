// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useMemo, useState } from 'react';
import {
  groupTenantKeyScopes,
  normalizeTenantKeyScopes,
  selectAllTenantKeyScopes,
  tenantKeyScopeDescription,
  toggleTenantKeyScope,
} from '../lib/api-key-scopes.js';

export default function TenantKeyScopePicker({ options, selected = [], onChange, disabled = false }) {
  const [query, setQuery] = useState('');
  const available = useMemo(() => normalizeTenantKeyScopes(options), [options]);
  const selectedScopes = useMemo(
    () => available.filter((scope) => selected.includes(scope)),
    [available, selected],
  );
  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    return groupTenantKeyScopes(available)
      .map((group) => ({
        ...group,
        scopes: term
          ? group.scopes.filter((scope) => scope.toLowerCase().includes(term)
            || tenantKeyScopeDescription(scope).toLowerCase().includes(term))
          : group.scopes,
      }))
      .filter((group) => group.scopes.length);
  }, [available, query]);
  const allSelected = available.length > 0 && selectedScopes.length === available.length;
  const hasSelection = selectedScopes.length > 0;

  const toggleGroup = (groupScopes) => {
    const allGroupSelected = groupScopes.every((scope) => selected.includes(scope));
    const next = new Set(selected);
    for (const scope of groupScopes) {
      if (allGroupSelected) next.delete(scope);
      else next.add(scope);
    }
    onChange(available.filter((scope) => next.has(scope)));
  };

  return (
    <fieldset disabled={disabled} className="mb-3 min-w-0">
      <legend className="block text-xs font-medium text-normal-text mb-1">Scopes</legend>
      <p className="text-[11px] text-normal-text/80 mb-2">
        Choose tenant permissions for this account. Platform administration scopes are never included.
      </p>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Find a permission…"
        aria-label="Find a permission"
        className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm text-main-text outline-none focus:border-main-blue mb-2"
      />
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => onChange(selectAllTenantKeyScopes(available))}
          disabled={disabled || !available.length || allSelected}
          className="px-3 py-1.5 rounded-xl bg-main-blue/10 text-main-blue text-xs font-medium disabled:opacity-50"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => onChange([])}
          disabled={disabled || !hasSelection}
          className="px-3 py-1.5 rounded-xl bg-slate-100 text-main-text text-xs font-medium disabled:opacity-50"
        >
          Clear
        </button>
        <span className="ml-auto text-[11px] text-normal-text" aria-live="polite">
          {selectedScopes.length} / {available.length} selected
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto rounded-2xl border border-slate-200 divide-y divide-slate-100">
        {!available.length ? (
          <p className="p-3 text-xs text-normal-text">
            {disabled ? 'Select an account to choose its tenant scopes.' : 'No tenant scopes are available.'}
          </p>
        ) : !groups.length ? (
          <p className="p-3 text-xs text-normal-text">No permissions match “{query}”.</p>
        ) : groups.map((group) => {
          const groupSelected = group.scopes.every((scope) => selected.includes(scope));
          return (
            <div key={group.prefix} className="p-3">
              <label className="flex items-center gap-2 text-xs font-semibold text-main-text mb-2">
                <input
                  type="checkbox"
                  checked={groupSelected}
                  onChange={() => toggleGroup(group.scopes)}
                  className="h-4 w-4 rounded border-slate-300 text-main-blue"
                  aria-label={`Select all ${group.label} scopes`}
                />
                {group.label}
              </label>
              <div className="space-y-1.5">
                {group.scopes.map((scope) => (
                  <label key={scope} className="flex items-start gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selected.includes(scope)}
                      onChange={() => onChange(toggleTenantKeyScope(selected, scope, available))}
                      data-scope-option={scope}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-main-blue"
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-xs text-main-text">{scope}</span>
                      <span className="block text-[11px] text-normal-text">{tenantKeyScopeDescription(scope)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
