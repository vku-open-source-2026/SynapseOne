#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Inject runtime URLs into config.js (build once, deploy anywhere).
# - SYNAPSEONE_PUBLIC_BASE_URL: gateway API ma TRINH DUYET goi toi (https://api.* o prod).
# - CONSOLE_APP_URL: canonical app host (https://cloud.* o prod). Web chinh (@)
#   dung gia tri nay de redirect nut Dang nhap / Mo Console ve cloud.
# - SYNAPSEONE_MFA_ENABLED: boolean MFA feature switch (SYNAPSEDX_MFA_ENABLED fallback, default true).
# Escape sed-special chars (| & \ and ') so odd URLs can't break the substitution
# or inject JS into config.js.
if [ -n "$SYNAPSEONE_PUBLIC_BASE_URL" ]; then
  ESCAPED_URL=$(printf '%s' "$SYNAPSEONE_PUBLIC_BASE_URL" | sed -e "s/[|&\\\\]/\\\\&/g" -e "s/'/'\\\\''/g")
  sed -i "s|http://localhost:8080|${ESCAPED_URL}|g" /usr/share/nginx/html/config.js
fi
if [ -n "$CONSOLE_APP_URL" ]; then
  ESCAPED_APP=$(printf '%s' "$CONSOLE_APP_URL" | sed -e "s/[|&\\\\]/\\\\&/g" -e "s/'/'\\\\''/g")
  sed -i "s|http://localhost:3000|${ESCAPED_APP}|g" /usr/share/nginx/html/config.js
fi
MFA_INPUT=${SYNAPSEONE_MFA_ENABLED:-${SYNAPSEDX_MFA_ENABLED:-true}}
MFA_INPUT=$(printf '%s' "$MFA_INPUT" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
case "$MFA_INPUT" in
  true|1|yes|on) MFA_VALUE=true ;;
  false|0|no|off) MFA_VALUE=false ;;
  *) echo "Invalid SYNAPSEONE_MFA_ENABLED value; defaulting to true" >&2; MFA_VALUE=true ;;
esac
sed -i \
  -e "s/\(MFA_ENABLED[[:space:]]*:[[:space:]]*\)true/\1${MFA_VALUE}/" \
  -e "s/\(MFA_ENABLED[[:space:]]*:[[:space:]]*\)false/\1${MFA_VALUE}/" \
  /usr/share/nginx/html/config.js
exec "$@"
