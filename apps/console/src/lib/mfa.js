// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

// Server responses remain authoritative when runtime configuration and IAM
// disagree. Never hide a required challenge or offer unavailable controls.
export function platformMfaFormRequired(runtimeEnabled, error) {
  return runtimeEnabled || error?.code === 'platform_mfa_required' || error?.code === 'invalid_mfa_code';
}

export function mfaStatusAvailable(status) {
  return status?.available !== false;
}
