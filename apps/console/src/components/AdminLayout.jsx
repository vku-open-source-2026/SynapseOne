// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import AdminSidebar, { ADMIN_NAV_ITEMS } from './AdminSidebar.jsx';
import AdminTopbar from './AdminTopbar.jsx';
import ConsoleFooter from './ConsoleFooter.jsx';
import SiteToggles from './SiteToggles.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';
import { useAuth } from '../lib/auth.jsx';

export default function AdminLayout({ children }) {
  const { role, logout } = usePlatformAuth();
  const { logout: logoutTenant } = useAuth();
  const { pathname } = useLocation();
  const signOut = () => { logout(); logoutTenant(); };
  const items = ADMIN_NAV_ITEMS.filter((it) => !it.owner || role === 'owner');
  return (
    <div className="min-h-screen bg-background">
      <AdminSidebar role={role} />
      <AdminTopbar />
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-white backdrop-blur border-b border-slate-200">
        <div className="flex items-center justify-between px-4 h-14 gap-2">
          <Link to="/admin/overview" className="font-semibold text-main-blue">SynapseOne Admin</Link>
          <div className="flex items-center gap-1">
            <SiteToggles />
            <Link to="/dashboard" className="text-xs text-normal-text px-2">Tenant</Link>
            <button type="button" onClick={signOut} className="text-xs text-red-500 px-2">Sign out</button>
          </div>
        </div>
        <nav className="flex gap-3 overflow-x-auto px-4 pb-2 text-xs" aria-label="Platform administration navigation">
          {items.map((it) => {
            const active = pathname === it.to || pathname.startsWith(it.to + '/');
            return (
              <Link
                key={it.to}
                to={it.to}
                aria-current={active ? 'page' : undefined}
                className={`whitespace-nowrap hover:text-main-blue ${active ? 'text-main-blue font-medium' : 'text-main-text'}`}
              >
                {it.label.replace(' & Access', '').replace(' & Security', '')}
              </Link>
            );
          })}
        </nav>
      </div>
      <main className="transition-all duration-200 console-layout-single px-4 lg:px-6 pt-28 lg:pt-20 pb-8 min-w-0 min-h-screen flex flex-col sdx-page-enter">
        <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col">
          <div className="flex-1">{children}</div>
          <ConsoleFooter />
        </div>
      </main>
    </div>
  );
}
