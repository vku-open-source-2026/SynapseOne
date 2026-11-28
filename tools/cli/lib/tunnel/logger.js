// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info', stream = process.stderr) {
  const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;
  const emit = (logLevel, event, fields = {}) => {
    if (LEVEL_WEIGHT[logLevel] < threshold) return;
    // Only operational metadata belongs here. Never log tokens, credentials,
    // request headers, upstream bodies, or raw network/protocol errors.
    stream.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: logLevel,
      component: 'tunnel',
      event,
      ...fields,
    })}\n`);
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

module.exports = { createLogger };
