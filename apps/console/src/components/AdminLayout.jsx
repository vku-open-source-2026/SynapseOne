// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Link } from 'react-router-dom';
import AdminSidebar from './AdminSidebar.jsx';
import AdminTopbar from './AdminTopbar.jsx';
import ConsoleFooter from './ConsoleFooter.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';
import { useAuth } from '../lib/auth.jsx';

const MOBILE = [
  ['/admin/overview', 'Overview'],
  ['/admin/orgs', 'Organizations'],
  ['/admin/users', 'Users'],
  ['/admin/health', 'Health'],
  ['/admin/usage', 'Usage'],
  ['/admin/audit', 'Audit'],
];

export default function AdminLayout({ children }) {
  const { role, logout } = usePlatformAuth();
  const { logout: logoutTenant } = useAuth();
  const signOut = () => { logout(); logoutTenant(); };
  return (
    <div className="min-h-screen bg-background">
      <AdminSidebar role={role} />
      <AdminTopbar />
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="flex items-center justify-between px-4 h-14">
          <Link to="/admin/overview" className="font-semibold text-main-blue">SynapseOne Admin</Link>
          <button type="button" onClick={signOut} className="text-xs text-red-500">Sign out</button>
        </div>
        <nav className="flex gap-3 overflow-x-auto px-4 pb-2 text-xs">
          {MOBILE.map(([to, label]) => <Link key={to} to={to} className="whitespace-nowrap text-main-text hover:text-main-blue">{label}</Link>)}
          {role === 'owner' && <Link to="/admin/access" className="whitespace-nowrap text-main-text hover:text-main-blue">Admins</Link>}
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
