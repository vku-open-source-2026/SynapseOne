// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { runEntrypoint } from './server';

export { startTunnelService, runEntrypoint, type TunnelService } from './server';

if (require.main === module) {
  void runEntrypoint('combined').catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Tunnel service failed';
    process.stderr.write(`${JSON.stringify({ level: 'error', component: 'server', event: 'startup_failed', message })}\n`);
    process.exitCode = 1;
  });
}
