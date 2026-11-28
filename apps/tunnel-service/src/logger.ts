// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  child(component: string): Logger;
  debug(event: string, fields?: Record<string, string | number | boolean | null>): void;
  info(event: string, fields?: Record<string, string | number | boolean | null>): void;
  warn(event: string, fields?: Record<string, string | number | boolean | null>): void;
  error(event: string, fields?: Record<string, string | number | boolean | null>): void;
}

export function createLogger(level: LogLevel, component = 'tunnel'): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const emit = (logLevel: LogLevel, event: string, fields: Record<string, string | number | boolean | null> = {}): void => {
    if (LEVEL_WEIGHT[logLevel] < threshold) return;
    // Callers must pass only allowlisted operational metadata. Never pass request
    // headers, tokens, URLs with credentials, or raw upstream error messages.
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: logLevel,
      component,
      event,
      ...fields,
    })}\n`);
  };
  return {
    child: (name) => createLogger(level, `${component}:${name}`),
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
