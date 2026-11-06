// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n-context.js';

const REPO = 'https://github.com/vku-open-source-2026/SynapseOne';
const LINK = 'inline-block py-1 whitespace-nowrap hover:text-s1-accent transition-colors';

/** Slim footer under every signed-in console page: licence line plus the links people need while working. */
export default function ConsoleFooter() {
  const { m } = useI18n();
  const l = m.footer.links;
  return (
    <footer className="mt-12 shrink-0 flex flex-col gap-3 border-t border-s1-line pt-5 text-xs text-s1-muted xl:flex-row xl:items-center xl:justify-between">
      <p className="whitespace-nowrap">{m.footer.bottom}</p>
      <nav aria-label={m.footer.project} className="flex flex-wrap gap-x-5 gap-y-2">
        <Link to="/api-docs" className={LINK}>{l.apiDocs}</Link>
        <Link to="/docs" className={LINK}>{l.docs}</Link>
        <a href={REPO} target="_blank" rel="noreferrer" className={LINK}>GitHub</a>
        <a href={`${REPO}/issues`} target="_blank" rel="noreferrer" className={LINK}>{l.issues}</a>
        <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={LINK}>{l.source}</a>
      </nav>
    </footer>
  );
}
