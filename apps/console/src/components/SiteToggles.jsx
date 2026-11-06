// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '../lib/i18n-context.js';
import { useTheme } from '../lib/theme-context.js';

// Same buttons and icons as the SynapseCity header, so every Synapse site switches language/theme the same way.
const BTN =
  'flex h-9 w-9 items-center justify-center rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white transition-colors';

/** Language (VI/EN) and theme (light/dark/system) switches, shared by the public header, sign-in and console top bar. */
export default function SiteToggles({ className = '' }) {
  const { m, toggle } = useI18n();
  const { choice, cycle } = useTheme();
  const ThemeIcon = choice === 'dark' ? Moon : choice === 'light' ? Sun : Monitor;
  const themeLabel = m.nav.theme[choice];
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <button type="button" onClick={toggle} title={m.nav.switchLang} aria-label={m.nav.switchLang} className={BTN}>
        {m.nav.langShort}
      </button>
      <button type="button" onClick={cycle} title={themeLabel} aria-label={themeLabel} className={BTN}>
        <ThemeIcon className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}
