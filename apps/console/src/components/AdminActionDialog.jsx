// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useEffect, useState } from 'react';
import { Btn, Err, Field, Input, Modal } from './ui.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';

/**
 * Confirmation dialog for platform actions. High-risk actions require a fresh
 * TOTP/recovery code; the resulting proof is single-use and bound to `action`.
 */
export default function AdminActionDialog({
  open,
  title,
  message,
  action,
  confirmLabel = 'Confirm',
  requireReason = false,
  minReasonLength = 1,
  requireStepUp = true,
  danger = true,
  onClose,
  onConfirm,
}) {
  const platform = usePlatformAuth();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setReason('');
    setErr(null);
    setBusy(false);
  }, [open]);

  if (!open) return null;
  const needsCode = requireStepUp && platform.stepUpRequired;
  const reasonTooShort = requireReason && reason.trim().length < minReasonLength;

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (reasonTooShort) {
        setErr(new Error(`Reason must be at least ${minReasonLength} characters.`));
        return;
      }
      const step = needsCode ? await platform.stepUp(code.trim(), action) : null;
      await onConfirm({ reason: reason.trim(), stepUpToken: step?.token, action });
      onClose();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-normal-text mb-4">{message}</p>
      <Err e={err} />
      <form onSubmit={submit}>
        {needsCode && (
          <Field label="Authenticator code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              placeholder="123456"
              autoFocus
            />
          </Field>
        )}
        {requireReason && (
          <Field label={`Reason (recorded in the audit log${minReasonLength > 1 ? `, min ${minReasonLength} chars` : ''})`}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this action needed?" />
          </Field>
        )}
        <div className="flex gap-2 mt-4">
          <Btn
            type="submit"
            kind={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={busy || (needsCode && !code.trim()) || reasonTooShort}
          >
            {confirmLabel}
          </Btn>
          <Btn kind="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
        </div>
      </form>
    </Modal>
  );
}
