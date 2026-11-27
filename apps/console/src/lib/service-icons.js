// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import {
  faBolt,
  faDatabase,
  faInbox,
  faGaugeHigh,
  faLink,
  faMagnifyingGlass,
  faBrain,
  faStream,
  faCloud,
  faServer,
  faWarehouse,
  faLayerGroup,
  faBell,
  faUserShield,
} from '@fortawesome/free-solid-svg-icons';

/** Icon registry shared by the desktop services sidebar and mobile Topbar menu. */
export const SERVICE_ICONS = {
  gateway: faServer,
  iam: faUserShield,
  workflow: faBolt,
  runner: faServer,
  ai: faBrain,
  inference: faBrain,
  lds: faLink,
  base: faDatabase,
  search: faMagnifyingGlass,
  faststore: faGaugeHigh,
  queue: faInbox,
  stream: faStream,
  ocs: faCloud,
  notifications: faBell,
  warehouse: faWarehouse,
  lakehouse: faLayerGroup,
};
