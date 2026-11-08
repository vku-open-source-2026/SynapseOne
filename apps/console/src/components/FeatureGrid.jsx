// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';

/**
 * Numbered feature cards shared by Home and About so both pages show the
 * building blocks the same way. `icons[i]` is a lucide icon for `items[i]`.
 */
export default function FeatureGrid({ items, icons }) {
  return (
    <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((f, i) => {
        const Icon = icons[i];
        return (
          <li
            key={f.title}
            className="group relative min-w-0 overflow-hidden rounded-2xl border border-s1-line bg-s1-surface p-7 transition duration-200 hover:-translate-y-1 hover:border-sky-300 hover:shadow-lg hover:shadow-sky-500/10 dark:hover:border-sky-700"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-5 top-2 select-none font-mono text-6xl font-bold text-sky-100 transition group-hover:text-sky-200 dark:text-sky-950 dark:group-hover:text-sky-900"
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25">
              {Icon && <Icon className="h-6 w-6" strokeWidth={1.75} />}
            </span>
            <h3 className="relative mt-6 text-lg font-semibold text-balance">{f.title}</h3>
            <p className="relative mt-2 text-sm leading-relaxed text-s1-muted">{f.text}</p>
          </li>
        );
      })}
    </ul>
  );
}
