// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ThemeContext } from './theme-context.js';

export const THEME_KEY = 'synapseone.theme';
const ORDER = ['light', 'dark', 'system'];

function readChoice() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* storage blocked: fall back to the OS preference */
  }
  return 'system';
}

function systemPrefersDark() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/** Mirrors public/theme-init.js so the first paint already has the right theme. */
function apply(choice) {
  const dark = choice === 'dark' || (choice === 'system' && systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1220' : '#f6f7fb');
}

export function ThemeProvider({ children }) {
  const [choice, setChoiceState] = useState(readChoice);

  useEffect(() => {
    apply(choice);
    if (choice !== 'system' || !window.matchMedia) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [choice]);

  const setChoice = useCallback((next) => {
    setChoiceState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const cycle = useCallback(() => {
    setChoice(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]);
  }, [choice, setChoice]);

  const value = useMemo(() => ({ choice, setChoice, cycle }), [choice, setChoice, cycle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
