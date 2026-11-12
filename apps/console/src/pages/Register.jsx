// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Btn, Card, Err, Field, Input } from '../components/ui.jsx';
import SiteToggles from '../components/SiteToggles.jsx';

export default function Register() {
  const { auth, acceptInvite } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ token: '', password: '', confirm: '', displayName: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  if (auth) return <Navigate to="/dashboard" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (form.password !== form.confirm) {
      setErr(new Error('Passwords do not match.'));
      return;
    }
    if (form.password.length < 12) {
      setErr(new Error('Password must be at least 12 characters.'));
      return;
    }
    setBusy(true);
    try {
      await acceptInvite(form.token.trim(), form.password, form.displayName.trim() || undefined);
      nav('/security', { replace: true });
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <SiteToggles className="fixed top-3 right-3 sm:top-4 sm:right-4" />
      <div className="bg-white rounded-3xl shadow-md p-8 w-full max-w-md">
        <h1 className="text-3xl font-semibold text-center bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">
          Activate account
        </h1>
        <p className="text-center text-normal-text text-sm mt-2 mb-6">
          Enter the one-time activation code from your administrator, then choose a password.
        </p>
        <Err e={err} />
        <form onSubmit={submit}>
          <Field label="Activation code">
            <Input
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              placeholder="synapseone_invite_…"
              required
            />
          </Field>
          <Field label="Display name (optional)">
            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoComplete="name" />
          </Field>
          <Field label="Password (12+ characters)">
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" required />
          </Field>
          <Field label="Confirm password">
            <Input type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} autoComplete="new-password" required />
          </Field>
          <Btn type="submit" loading={busy} disabled={busy || !form.token.trim() || !form.password || !form.confirm} className="w-full">
            <span className="block w-full text-center">Activate account</span>
          </Btn>
        </form>
        <p className="text-xs text-normal-text mt-4 text-center">
          Already activated? <Link to="/login" className="text-main-blue">Sign in</Link>
        </p>
        <p className="text-xs text-normal-text mt-2 text-center">
          Activation codes are single-use and expire after 7 days.
        </p>
      </div>
    </div>
  );
}
