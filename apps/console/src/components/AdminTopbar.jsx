// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRightFromBracket, faShieldHalved } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';
import { Badge } from './ui.jsx';

export default function AdminTopbar() {
  const { auth, logout } = useAuth();
  const platform = usePlatformAuth();
  const email = platform.user?.email || auth?.email || 'platform administrator';
  return (
    <div className="hidden lg:flex fixed top-0 left-0 right-0 h-16 z-20 px-4 lg:px-6 items-center justify-end console-topbar-band border-b border-slate-200">
      <div className="flex items-center gap-3 pr-2 lg:pr-8">
        <Badge tone="blue"><FontAwesomeIcon icon={faShieldHalved} className="mr-1" /> {platform.role || 'platform'}</Badge>
        <span className="text-xs text-normal-text max-w-64 truncate" title={email}>{email}</span>
        <Link to="/dashboard" className="text-xs text-main-blue hover:underline">Tenant console</Link>
        <button
          type="button"
          onClick={() => { platform.logout(); logout(); }}
          className="text-xs text-red-500 inline-flex items-center gap-1"
        >
          <FontAwesomeIcon icon={faArrowRightFromBracket} /> Sign out
        </button>
      </div>
    </div>
  );
}
