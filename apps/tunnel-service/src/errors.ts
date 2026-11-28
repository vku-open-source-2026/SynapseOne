// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Response } from 'express';

export class TunnelError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, expose = true) {
    super(message);
    this.name = 'TunnelError';
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

export function isTunnelError(error: unknown): error is TunnelError {
  return error instanceof TunnelError;
}

export function sendError(res: Response, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (isTunnelError(error)) {
    res.status(error.status).json({
      error: error.code,
      message: error.expose ? error.message : 'Request failed',
    });
    return;
  }
  res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
}
