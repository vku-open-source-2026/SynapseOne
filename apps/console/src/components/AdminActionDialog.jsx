// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Btn, Err, Field, Input, Modal } from './ui.jsx';
import { usePlatformAuth } from '../lib/platform-auth.jsx';

/** Confirmation dialog for destructive/platform actions: fresh TOTP + reason. */
export default function AdminActionDialog({ open, title, message, confirmLabel = 'Confirm', requireReason = false, onClose, onConfirm }) {
  const platform = usePlatformAuth();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const step = await platform.stepUp(code.trim());
      await onConfirm({ reason: reason.trim(), stepUpToken: step.token });
      setCode('');
      setReason('');
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
        <Field label="Authenticator code">
          <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456" autoFocus />
        </Field>
        {requireReason && (
          <Field label="Reason (recorded in the audit log)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this action needed?" />
          </Field>
        )}
        <div className="flex gap-2 mt-4">
          <Btn type="submit" kind="danger" loading={busy} disabled={!code.trim() || (requireReason && !reason.trim())}>{confirmLabel}</Btn>
          <Btn kind="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
        </div>
      </form>
    </Modal>
  );
}
