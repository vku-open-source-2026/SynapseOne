// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { createContext, useContext } from 'react';

export const ThemeContext = createContext(null);

const FALLBACK = { choice: 'system', setChoice: () => undefined, cycle: () => undefined };

/** Current theme choice (`light` | `dark` | `system`). Provided by <ThemeProvider> in lib/theme.jsx. */
export function useTheme() {
  return useContext(ThemeContext) || FALLBACK;
}
