// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faHouse, faBuilding, faUsers, faServer, faChartSimple, faBoxes,
  faListCheck, faUserShield, faArrowLeft,
} from '@fortawesome/free-solid-svg-icons';

const ITEMS = [
  { to: '/admin/overview', label: 'Overview', icon: faHouse },
  { to: '/admin/orgs', label: 'Organizations', icon: faBuilding },
  { to: '/admin/accounts', label: 'Accounts', icon: faBoxes },
  { to: '/admin/users', label: 'Users & Access', icon: faUsers },
  { to: '/admin/health', label: 'Service Health', icon: faServer },
  { to: '/admin/usage', label: 'Usage', icon: faChartSimple },
  { to: '/admin/audit', label: 'Audit & Security', icon: faListCheck },
  { to: '/admin/access', label: 'Platform Admins', icon: faUserShield, owner: true },
];

export { ITEMS as ADMIN_NAV_ITEMS };

export default function AdminSidebar({ role }) {
  const { pathname } = useLocation();
  const { auth } = useAuth();
  const tenantContexts = (auth?.contexts || []).filter((c) => c.type === 'tenant');
  return (
    <aside aria-label="Platform administration navigation" className="fixed left-3 xl:left-5 top-0 h-screen w-64 xl:w-72 hidden lg:flex flex-col items-center z-30">
      <Link to="/admin/overview" className="my-6 mt-8 ml-2 whitespace-nowrap text-xl xl:text-2xl font-semibold bg-gradient-to-b from-[#0A72C4] to-[#4FACFE] bg-clip-text text-transparent">
        SynapseOne Admin
      </Link>
      <nav className="w-full bg-white rounded-3xl py-4 px-3 flex flex-col text-normal-text shadow-md max-h-[82vh] overflow-y-auto s1-thin-scroll">
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Platform</div>
        {ITEMS.filter((it) => !it.owner || role === 'owner').map((it) => {
          const active = pathname === it.to || pathname.startsWith(it.to + '/');
          return (
            <Link key={it.to} to={it.to} aria-current={active ? 'page' : undefined} className={`flex items-center px-4 py-2 my-0.5 rounded-2xl text-sm transition-colors ${active ? 'text-main-blue bg-main-blue/10 font-medium' : 'hover:bg-background'}`}>
              <FontAwesomeIcon icon={it.icon} className="mr-3 w-4" />
              {it.label}
            </Link>
          );
        })}
        {tenantContexts.length > 0 && <>
          <div className="my-2 border-t border-slate-100" />
          <Link to="/dashboard" className="flex items-center px-4 py-2 my-0.5 rounded-2xl text-sm hover:bg-background">
            <FontAwesomeIcon icon={faArrowLeft} className="mr-3 w-4" />
            Tenant Console
          </Link>
        </>}
      </nav>
    </aside>
  );
}
