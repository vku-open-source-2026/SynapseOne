// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * SynapseOne app-icon tile: azure tile + the white S-gap mark.
 * The tile keeps the mark legible on both light and dark console chrome.
 */
export default function BrandSymbol({ className = 'h-8 w-8' }) {
  return (
    <svg viewBox="0 0 256 256" className={className} aria-hidden="true">
      <rect width="256" height="256" rx="56" fill="#0A72C4" />
      <g transform="translate(51.2 51.2) scale(0.6)">
        <g fill="none" stroke="#FFFFFF" strokeWidth="44" strokeLinecap="butt" strokeLinejoin="round">
          <path d="M 180 48 H 84 A 40 40 0 0 0 84 128 H 115" />
        </g>
        <circle cx="180" cy="48" r="22" fill="#FFFFFF" />
        <g fill="none" stroke="#FFFFFF" strokeWidth="44" strokeLinecap="butt" strokeLinejoin="round">
          <path d="M 141 128 H 172 A 40 40 0 0 1 172 208 H 76" />
        </g>
        <circle cx="76" cy="208" r="22" fill="#FFFFFF" />
      </g>
    </svg>
  );
}
