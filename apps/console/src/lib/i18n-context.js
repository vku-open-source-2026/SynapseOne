// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { createContext, useContext } from 'react';
import { vi } from '../locales/vi.js';

export const I18nContext = createContext(null);

// Outside <LanguageProvider> (isolated component renders, SSR of a single
// component) fall back to Vietnamese instead of throwing.
const FALLBACK = { lang: 'vi', m: vi, dicts: { vi }, setLang: () => undefined, toggle: () => undefined };

/** Current language (`vi` | `en`) and its copy `m`. Provided by <LanguageProvider> in lib/i18n.jsx. */
export function useI18n() {
  return useContext(I18nContext) || FALLBACK;
}
