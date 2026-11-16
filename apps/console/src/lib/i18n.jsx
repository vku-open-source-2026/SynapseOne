// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { vi } from '../locales/vi.js';
import { en } from '../locales/en.js';
import { I18nContext } from './i18n-context.js';

export const LANG_KEY = 'synapseone.lang';

/**
 * Vietnamese words are written as separate syllables, so browsers happily
 * break "dữ liệu" into "dữ / liệu". Joining common compounds with a
 * non-breaking space keeps each word on one line.
 */
const VI_COMPOUNDS = [
  'mã nguồn mở', 'mã nguồn', 'dữ liệu', 'hạ tầng', 'nền tảng', 'giấy phép', 'tài khoản',
  'tổ chức', 'người dùng', 'vai trò', 'chính sách', 'phân quyền', 'xác thực', 'đăng nhập',
  'đăng xuất', 'khóa API', 'quy trình', 'tự động', 'hàng đợi', 'sự kiện', 'lưu trữ',
  'đối tượng', 'thông báo', 'ứng dụng', 'dịch vụ', 'hệ thống', 'quản lý', 'quản trị',
  'nhật ký', 'kiểm toán', 'bảo mật', 'tài liệu', 'mật khẩu', 'phiên bản', 'trải nghiệm',
  'đóng góp', 'chúng tôi', 'Việt Nam', 'doanh nghiệp', 'phát triển', 'tích hợp', 'triển khai',
  'tự cài đặt', 'cài đặt', 'đô thị', 'khẩn cấp', 'trí tuệ nhân tạo', 'giới hạn', 'truy cập',
  'sao lưu', 'khôi phục', 'mô hình', 'giao diện', 'dòng lệnh', 'bộ nhớ đệm', 'tài nguyên',
];
const COMPOUND_RE = new RegExp(
  [...VI_COMPOUNDS].sort((a, b) => b.length - a.length).map((w) => w.replace(/ /g, '\\s')).join('|'),
  'giu',
);

function keepCompounds(value) {
  if (typeof value === 'string') {
    return value.replace(COMPOUND_RE, (word) => word.replace(/\s/g, ' '));
  }
  if (Array.isArray(value)) return value.map(keepCompounds);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keepCompounds(v)]));
  }
  return value;
}

// Licence and tier names must not break at their hyphen ("Apache-" / "2.0"); use a non-breaking hyphen.
function keepNames(value) {
  if (typeof value === 'string') return value.replace(/(Apache|Tier)-(\d)/g, '$1\u2011$2');
  if (Array.isArray(value)) return value.map(keepNames);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keepNames(v)]));
  }
  return value;
}

const DICTS = { vi: keepNames(keepCompounds(vi)), en: keepNames(en) };

function readLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'vi' || saved === 'en') return saved;
  } catch {
    /* storage blocked */
  }
  // Vietnamese is the default audience; only switch for browsers that ask for something else.
  const browser = typeof navigator !== 'undefined' && navigator.language ? navigator.language.toLowerCase() : 'vi';
  return browser.startsWith('vi') ? 'vi' : 'en';
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(readLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = DICTS[lang].meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', DICTS[lang].meta.description);
  }, [lang]);

  const setLang = useCallback((next) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => setLang(lang === 'vi' ? 'en' : 'vi'), [lang, setLang]);

  const value = useMemo(() => ({ lang, m: DICTS[lang], dicts: DICTS, setLang, toggle }), [lang, setLang, toggle]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
