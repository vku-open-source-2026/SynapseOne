// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Legacy env compatibility: services prefer SYNAPSEONE_* but keep honouring
 * SYNAPSEDX_* during the rebrand window. New names win when both are set.
 */
import dotenv from 'dotenv';

dotenv.config();

for (const key of Object.keys(process.env)) {
  if (!key.startsWith('SYNAPSEDX_')) continue;
  const next = `SYNAPSEONE_${key.slice('SYNAPSEDX_'.length)}`;
  if (!process.env[next]) process.env[next] = process.env[key];
}

export {};
