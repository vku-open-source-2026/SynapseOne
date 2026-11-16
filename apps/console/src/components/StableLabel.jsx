// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { useI18n } from '../lib/i18n-context.js';

/**
 * Text whose box is as wide as its longest translation, so switching VI/EN
 * never moves neighbouring buttons under the pointer. `pick` selects the
 * string from a locale dictionary, e.g. `(m) => m.nav.signIn`.
 */
export default function StableLabel({ pick, className = '' }) {
  const { m, dicts } = useI18n();
  return (
    <span className={`inline-grid whitespace-nowrap ${className}`}>
      {Object.entries(dicts).map(([lang, dict]) => (
        <span key={lang} aria-hidden="true" className="invisible col-start-1 row-start-1">
          {pick(dict)}
        </span>
      ))}
      <span className="col-start-1 row-start-1 text-center">{pick(m)}</span>
    </span>
  );
}
