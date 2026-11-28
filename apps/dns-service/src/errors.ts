// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function invalid(message: string, details?: unknown): never {
  throw new ServiceError(400, 'validation_error', message, details);
}

export function notFound(resource: string): never {
  throw new ServiceError(404, 'not_found', `${resource} not found`);
}

export function conflict(code: string, message: string): never {
  throw new ServiceError(409, code, message);
}
