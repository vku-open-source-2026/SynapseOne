// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const { sanitizeRequestHeaders, sanitizeResponseHeaders } = require('./validation');

function requestHeaders(input, upstream) {
  const safe = sanitizeRequestHeaders(input, true);
  const headers = new Headers();
  for (const [name, values] of Object.entries(safe)) {
    for (const value of values) headers.append(name, value);
  }
  headers.set('host', upstream.host);
  // Keep upstream bytes stable: fetch must not transparently decode a response
  // whose content-encoding would be removed before forwarding it.
  headers.set('accept-encoding', 'identity');
  return headers;
}

function responseHeaders(headers) {
  const entries = [];
  const raw = typeof headers.raw === 'function' ? headers.raw() : {};
  for (const [name, value] of headers.entries()) {
    if (name === 'set-cookie') continue;
    entries.push([name, [value]]);
  }
  const cookies = Array.isArray(raw['set-cookie'])
    ? raw['set-cookie']
    : typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (cookies.length) entries.push(['set-cookie', cookies]);
  return sanitizeResponseHeaders(Object.fromEntries(entries));
}

module.exports = { requestHeaders, responseHeaders };
