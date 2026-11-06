// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Be Vietnam Pro is drawn for Vietnamese; Poppins rendered stacked diacritics (ộ, ữ) badly.
        sans: ['"Be Vietnam Pro"', '"Noto Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Public site tokens, defined as CSS variables in src/index.css (light + dark).
        s1: {
          bg: 'var(--s1-bg)',
          surface: 'var(--s1-surface)',
          fg: 'var(--s1-fg)',
          muted: 'var(--s1-muted)',
          line: 'var(--s1-line)',
          accent: 'var(--s1-accent)',
          'accent-soft': 'var(--s1-accent-soft)',
          code: 'var(--s1-code)',
          'code-fg': 'var(--s1-code-fg)',
          'code-muted': 'var(--s1-code-muted)',
        },
        'main-blue': '#4FACFE',
        'second-blue': '#00F2FE',
        'main-start': '#00F2FE',
        'main-end': '#4FACFE',
        'normal-text': '#6C7580',
        'main-text': '#4B5563',
        background: '#f6f7fb',
        emerald: { 500: '#10b981', 600: '#059669' },
        red: { 400: '#f77170', 500: '#ef4444', 600: '#dc2626' },
        amber: { 400: '#fbbf24', 500: '#f59e0b' },
        slate: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
        },
      },
    },
  },
  plugins: [],
};
