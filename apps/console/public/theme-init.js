// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Apply the saved theme and language before first paint (mirrors src/lib/theme.jsx and src/lib/i18n.jsx).
// A file, not an inline <script>: production CSP is `script-src 'self'`.
(function () {
  var root = document.documentElement;
  var choice = 'system';
  try { choice = localStorage.getItem('synapseone.theme') || 'system'; } catch (e) {}
  var dark = choice === 'dark' || (choice === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) root.classList.add('dark');
  root.style.colorScheme = dark ? 'dark' : 'light';
  try { var lang = localStorage.getItem('synapseone.lang'); if (lang === 'vi' || lang === 'en') root.lang = lang; } catch (e) {}
})();
