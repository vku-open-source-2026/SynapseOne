// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCopy } from '@fortawesome/free-solid-svg-icons';
import { useI18n } from '../lib/i18n-context.js';

/** Shell snippet panel for the public pages. Comment lines (`# …`) are dimmed; Copy copies the commands only. */
export default function Terminal({ title, code }) {
  const { lang } = useI18n();
  const [copied, setCopied] = useState(false);
  const commands = code
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, ''))
    .filter((l) => l && !l.startsWith('#'))
    .join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the text stays selectable */
    }
  };
  const label = copied ? (lang === 'vi' ? 'Đã sao chép' : 'Copied') : lang === 'vi' ? 'Sao chép' : 'Copy';
  return (
    <div className="overflow-hidden rounded-2xl border border-s1-line bg-s1-code shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="truncate font-mono text-xs text-s1-code-muted">{title}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-s1-code-muted transition hover:bg-white/10 hover:text-white"
        >
          <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
          {label}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-s1-code-fg">
        {code.split('\n').map((line, i) => {
          const at = line.indexOf('#');
          const cmd = at === -1 ? line : line.slice(0, at);
          const comment = at === -1 ? '' : line.slice(at);
          return (
            <span key={i} className="block">
              {cmd && <span className="select-none text-s1-code-muted">$ </span>}
              {cmd}
              {comment && <span className="text-s1-code-muted">{comment}</span>}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
