// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

interface Window {
  start: number;
  count: number;
}

export class RouteRateLimiter {
  private readonly windows = new Map<string, Window>();
  private checks = 0;

  check(routeId: string, clientKey: string, limitPerMinute: number, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (limitPerMinute === 0) return { allowed: true, retryAfterSeconds: 0 };
    this.checks += 1;
    if (this.checks % 256 === 0 || this.windows.size > 10000) {
      for (const [key, window] of this.windows) {
        if (now - window.start >= 60000) this.windows.delete(key);
      }
    }
    const key = `${routeId}:${clientKey}`;
    let window = this.windows.get(key);
    if (!window || now - window.start >= 60000) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= limitPerMinute) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + 60000 - now) / 1000)) };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
