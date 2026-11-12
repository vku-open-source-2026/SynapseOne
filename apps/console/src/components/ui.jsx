// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { Spinner, TableSkeleton as TableSkeletonBase, ListSkeleton, InlineLoader } from './loading.jsx';

export { Spinner, InlineLoader, ListSkeleton, TableSkeletonBase as TableSkeleton };
export { PageSkeleton, LoadingOverlay, RouteProgress, ScrollToTop, Dots } from './loading.jsx';

export function Card({ className = '', children }) {
  return <div className={`bg-white rounded-3xl shadow-md p-6 ${className}`}>{children}</div>;
}

export function PageTitle({ title, sub, right }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
      <div className="min-w-0">
        <h1 className="text-xl sm:text-2xl font-semibold text-main-text truncate">{title}</h1>
        {sub && <p className="text-normal-text text-sm mt-1">{sub}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">{right}</div>}
    </div>
  );
}

export function Btn({ children, onClick, kind = 'primary', type = 'button', disabled, loading = false, className = '' }) {
  const styles =
    kind === 'primary'
      ? 'bg-gradient-to-b from-main-start to-main-end text-white'
      : kind === 'danger'
        ? 'bg-red-500 text-white'
        : 'bg-slate-100 text-main-text';
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={onClick}
      className={`px-4 py-2 rounded-2xl text-sm font-medium shadow-sm disabled:opacity-60 disabled:cursor-wait whitespace-nowrap inline-flex items-center justify-center gap-2 transition-opacity ${styles} ${className}`}
    >
      {loading && <Spinner size="sm" className="sdx-spinner-on-dark" label="Loading" />}
      <span className={`inline-flex items-center gap-2 ${loading ? 'opacity-90' : ''}`}>{children}</span>
    </button>
  );
}

export function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-normal-text mb-1">{label}</span>
      {children}
    </label>
  );
}

export function Input({ className = '', ...rest }) {
  return (
    <input
      {...rest}
      className={`w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm text-main-text outline-none focus:border-main-blue ${className}`}
    />
  );
}

export function Table({ head, children }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-normal-text">
            {head.map((h) => (
              <th key={h} className="py-2 pr-4 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Badge({ tone = 'gray', children }) {
  const tones = {
    gray: 'bg-slate-100 text-main-text',
    green: 'bg-emerald-500/10 text-emerald-600',
    red: 'bg-red-500/10 text-red-600',
    blue: 'bg-main-blue/10 text-main-blue',
    amber: 'bg-amber-400/15 text-amber-500',
  };
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${tones[tone] || tones.gray}`}>
      {children}
    </span>
  );
}

export function Empty({ text = 'No data yet', action }) {
  return (
    <div className="py-6 text-center">
      <p className="text-normal-text text-sm">{text}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={`sdx-skeleton rounded-2xl ${className}`} />;
}

export function StatValue({ loading, value }) {
  if (loading) return <Skeleton className="h-9 w-16" />;
  return <p className="text-3xl font-semibold text-main-text tabular-nums">{value ?? '–'}</p>;
}

const ERROR_COPY = {
  org_admin_required: {
    title: 'Cần quyền quản trị tổ chức',
    message: 'Tài khoản của bạn vẫn dùng được các tính năng tenant, nhưng Audit yêu cầu quyền Organization Administrator. Hãy liên hệ admin của tổ chức hoặc đăng nhập bằng tài khoản admin.',
  },
  platform_admin_required: {
    title: 'Cần quyền Platform Admin',
    message: 'Tài khoản này không phải Platform Administrator đang hoạt động. Hãy dùng tài khoản đã được cấp quyền trong /admin/access.',
  },
  platform_admin_inactive: {
    title: 'Platform Admin đã bị thu hồi hoặc vô hiệu hóa',
    message: 'Quyền Platform Administrator của tài khoản này không còn hiệu lực. Liên hệ Platform Owner để được cấp lại.',
  },
  platform_admin_org_required: {
    title: 'Sai tổ chức Platform',
    message: 'Platform Administrator phải là thành viên của tổ chức synapseone-platform. Tài khoản hiện tại thuộc tổ chức tenant.',
  },
  platform_mfa_required: {
    title: 'Cần bật MFA',
    message: 'Platform Console yêu cầu TOTP MFA. Hãy bật MFA trong Security trước khi mở /admin.',
  },
  platform_role_required: {
    title: 'Vai trò Platform không đủ quyền',
    message: 'Hành động này yêu cầu vai trò owner hoặc operator. Tài khoản auditor chỉ được đọc.',
  },
  platform_step_up_required: {
    title: 'Cần xác thực step-up',
    message: 'Hành động này cần một mã TOTP mới. Mã step-up chỉ dùng một lần và gắn với đúng hành động hiện tại.',
  },
  scope_denied: {
    title: 'API key không đủ scope',
    message: 'API key hiện tại không có quyền cho thao tác này. Dùng user JWT hoặc API key có scope phù hợp.',
  },
  access_denied: {
    title: 'Không có quyền thực hiện',
    message: 'Policy hoặc vai trò hiện tại không cho phép thao tác này.',
  },
  last_admin: {
    title: 'Không thể xóa admin cuối cùng',
    message: 'Mỗi organization phải còn ít nhất một Organization Administrator đang hoạt động.',
  },
  last_owner: {
    title: 'Không thể xóa owner cuối cùng',
    message: 'Phải còn ít nhất một Platform Owner đang hoạt động để quản trị hệ thống.',
  },
  invite_required: {
    title: 'Cần mã kích hoạt',
    message: 'Tài khoản đã được mời nhưng chưa kích hoạt. Dùng mã activation code một lần tại /register.',
  },
  org_membership_required: {
    title: 'Chưa được mời vào tổ chức',
    message: 'Email này chưa có lời mời vào tổ chức. Liên hệ admin tổ chức để được mời trước.',
  },
  invalid_mfa_code: {
    title: 'Mã xác thực không đúng',
    message: 'Mã TOTP đã hết hạn, đã dùng, hoặc không khớp. Thử mã mới sau chu kỳ 30 giây.',
  },
  account_locked: {
    title: 'Tài khoản tạm khóa',
    message: 'Có quá nhiều lần xác thực sai. Thử lại sau hoặc nhờ admin mở khóa.',
  },
  invalid_token: {
    title: 'Phiên đăng nhập không hợp lệ',
    message: 'Token đã hết hạn hoặc không hợp lệ. Đăng nhập lại để tiếp tục.',
  },
  forbidden: {
    title: 'Không có quyền truy cập',
    message: 'Tài khoản hiện tại không được phép truy cập tài nguyên này.',
  },
  not_found: {
    title: 'Không tìm thấy dữ liệu',
    message: 'Tài nguyên không tồn tại hoặc bạn không có quyền xem (tenant isolation).',
  },
  invalid_invite_token: {
    title: 'Mã kích hoạt không hợp lệ',
    message: 'Mã đã hết hạn hoặc đã được dùng. Nhờ admin cấp mã mới.',
  },
  reserved_org_slug: {
    title: 'Slug tổ chức bị giữ chỗ',
    message: 'Slug này dành riêng cho platform administration. Chọn slug khác.',
  },
};

function errorCodeOf(e) {
  return e?.body?.error || e?.code || (() => {
    const m = String(e?.message || '').match(/"error"\s*:\s*"([^"]+)"/);
    return m ? m[1] : '';
  })();
}

function defaultErrorCopy(e, code) {
  const status = Number(e?.status || 0);
  if (status === 401) return { title: 'Phiên đăng nhập đã hết hạn', message: 'Đăng nhập lại để tiếp tục.' };
  if (status === 403) return { title: 'Không có quyền thực hiện', message: 'Tài khoản hiện tại không được phép thực hiện thao tác này.' };
  if (status === 404) return { title: 'Không tìm thấy dữ liệu', message: 'Tài nguyên không tồn tại hoặc bạn không có quyền xem.' };
  if (status === 409) return { title: 'Dữ liệu đã thay đổi', message: 'Có xung đột dữ liệu. Tải lại trang rồi thử lại.' };
  if (status === 429) return { title: 'Quá nhiều yêu cầu', message: 'Vui lòng chờ một chút rồi thử lại.' };
  if (status >= 500) return { title: 'Máy chủ đang gặp sự cố', message: 'Thử lại sau hoặc kiểm tra service health.' };
  return { title: 'Không thực hiện được thao tác', message: code ? `Mã lỗi: ${code}` : 'Vui lòng thử lại.' };
}

export function Err({ e }) {
  const [show, setShow] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  if (!e) return null;
  const code = errorCodeOf(e);
  const copy = ERROR_COPY[code] || defaultErrorCopy(e, code);
  const full = e.message || String(e);
  const LIMIT = 220;
  const long = full.length > LIMIT;
  const copyTextNow = async () => {
    await copyText(full);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mb-4 px-4 py-3 rounded-2xl bg-red-500/10 text-red-700 text-sm min-w-0" role="alert">
      <p className="font-medium">{copy.title}</p>
      <p className="text-xs mt-1 text-red-600/90">{copy.message}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {code && <span className="font-mono opacity-70">{code}</span>}
        {long && (
          <button onClick={() => setShow((v) => !v)} className="underline underline-offset-2 hover:opacity-80">
            {show ? 'Ẩn chi tiết' : 'Chi tiết kỹ thuật'}
          </button>
        )}
        <button onClick={copyTextNow} className="underline underline-offset-2 hover:opacity-80">
          {copied ? 'Đã copy' : 'Copy lỗi'}
        </button>
      </div>
      {show && <p className="mt-2 break-all text-[11px] font-mono opacity-80">{full}</p>}
    </div>
  );
}

export function Modal({ title, onClose, children, open }) {
  React.useEffect(() => {
    if (open === false) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  if (open === false) return null;

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl shadow-md p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-main-text">{title}</h3>
          <button onClick={onClose} className="text-normal-text text-xl leading-none">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  // Portal to <body>: a `fixed inset-0` overlay must never be trapped by an
  // ancestor with a transform or overflow (page-enter animations, scroll
  // containers), it always needs to cover the full viewport and centre
  // against it, not against the page column.
  if (typeof document === 'undefined') return overlay; // SSR safety (ssr-smoke)
  return createPortal(overlay, document.body);
}

// Editor test-output convention (WorkflowEditor.jsx): never mount more than a
// 2k-char slice of a payload in one <pre>; huge execDetail blobs froze the DOM.
export const CODE_LIMIT = 2000;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* clipboard API unavailable (permissions/insecure ctx), fall back below */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* best-effort */
  }
  document.body.removeChild(ta);
}

export function Code({ data, limit = CODE_LIMIT, wrap = false }) {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  let text;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch {
    text = String(data);
  }
  const long = text.length > limit;
  const shown = expanded || !long ? text : text.slice(0, limit);
  const copy = async () => {
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="min-w-0">
      <pre className={`bg-background rounded-2xl p-3 text-xs ${wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'} text-main-text`}>
        {shown}
        {!expanded && long ? '…' : ''}
      </pre>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-normal-text">
        {long && <span>Showing {expanded ? text.length : limit} of {text.length} chars</span>}
        {long && (
          <button onClick={() => setExpanded((v) => !v)} className="text-main-blue hover:underline">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <button onClick={copy} className="text-main-blue hover:underline">
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
