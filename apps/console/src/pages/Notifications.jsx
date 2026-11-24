// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';

const statusTone = (status) => (status === 'delivered' ? 'green' : ['failed', 'dead'].includes(status) ? 'red' : status === 'cancelled' ? 'gray' : 'amber');
const recipientLabel = (recipient) => {
  if (typeof recipient === 'string') return recipient;
  if (!recipient || typeof recipient !== 'object') return '–';
  return recipient.email || recipient.phone || recipient.url || recipient.webhookUrl || recipient.pushToken || recipient.userId || JSON.stringify(recipient);
};

export default function Notifications() {
  const { headers } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [form, setForm] = useState({ channel: 'email', recipient: '', subject: '', body: '', idempotencyKey: '' });
  const [selected, setSelected] = useState(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefsRecipient, setPrefsRecipient] = useState('');
  const [prefs, setPrefs] = useState(null);
  const [prefsBusy, setPrefsBusy] = useState(false);
  const [prefsErr, setPrefsErr] = useState(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplRows, setTplRows] = useState([]);
  const [tplErr, setTplErr] = useState(null);
  const [tplBusy, setTplBusy] = useState(false);
  const [tplForm, setTplForm] = useState({ slug: '', name: '', subject: '', body: '' });
  const [tplPreview, setTplPreview] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const out = await api.notifications({ limit: 50 }, headers);
      setItems(Array.isArray(out) ? out : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { load(); }, [load]);

  const send = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormErr(null);
    try {
      const value = form.recipient.trim();
      const recipient = form.channel === 'email' ? { email: value }
        : form.channel === 'sms' ? { phone: value }
          : form.channel === 'webhook' ? { url: value }
            : { pushToken: value };
      await api.sendNotification({
        channels: [form.channel],
        recipient,
        ...(form.subject.trim() ? { subject: form.subject.trim() } : {}),
        body: form.body,
        ...(form.idempotencyKey.trim() ? { idempotencyKey: form.idempotencyKey.trim() } : {}),
      }, headers);
      setOpen(false);
      setForm({ channel: 'email', recipient: '', subject: '', body: '', idempotencyKey: '' });
      await load();
    } catch (ex) {
      setFormErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (n) => {
    try { setSelected(await api.notification(n.id, headers)); } catch (e) { setErr(e); }
  };

  const cancel = async (n) => {
    if (!window.confirm(`Cancel notification ${n.id}?`)) return;
    try { await api.cancelNotification(n.id, headers); await load(); } catch (e) { setErr(e); }
  };

  const loadPrefs = async (recipient = prefsRecipient) => {
    if (!recipient.trim()) return;
    setPrefsBusy(true);
    setPrefsErr(null);
    try {
      setPrefs(await api.notificationPreferences(recipient.trim(), headers));
    } catch (e) {
      setPrefsErr(e);
    } finally {
      setPrefsBusy(false);
    }
  };

  const savePrefs = async (e) => {
    e.preventDefault();
    if (!prefsRecipient.trim()) return;
    setPrefsBusy(true);
    setPrefsErr(null);
    try {
      const saved = await api.setNotificationPreferences(prefsRecipient.trim(), {
        channels: prefs?.channels || [],
        unsubscribed: !!prefs?.unsubscribed,
      }, headers);
      setPrefs(saved);
    } catch (ex) {
      setPrefsErr(ex);
    } finally {
      setPrefsBusy(false);
    }
  };

  const loadTemplates = async () => {
    setTplErr(null);
    try {
      const out = await api.notificationTemplates({ limit: 100 }, headers);
      setTplRows(Array.isArray(out?.items) ? out.items : []);
    } catch (e) {
      setTplErr(e);
    }
  };

  const createTemplate = async (e) => {
    e.preventDefault();
    if (tplBusy) return;
    setTplBusy(true);
    setTplErr(null);
    try {
      await api.createNotificationTemplate(tplForm, headers);
      setTplForm({ slug: '', name: '', subject: '', body: '' });
      await loadTemplates();
    } catch (ex) {
      setTplErr(ex);
    } finally {
      setTplBusy(false);
    }
  };

  const archiveTemplate = async (t) => {
    if (!window.confirm(`Archive template "${t.slug}"? Existing queued notifications keep their rendered content.`)) return;
    try {
      await api.deleteNotificationTemplate(t.id, headers);
      await loadTemplates();
    } catch (e) {
      setTplErr(e);
    }
  };

  const previewTemplate = async (t) => {
    const raw = window.prompt('Preview data JSON', '{"city":"Hanoi","level":2.5}');
    if (raw === null) return;
    try {
      setTplPreview(await api.previewNotificationTemplate(t.id, JSON.parse(raw || '{}'), headers));
    } catch (e) {
      setTplErr(e);
    }
  };

  const retry = async (n) => {
    if (!window.confirm(`Retry notification ${n.id} with a fresh attempt budget?`)) return;
    try { setSelected(await api.retryNotification(n.id, headers)); await load(); } catch (e) { setErr(e); }
  };

  return (
    <>
      <PageTitle
        title="Notifications"
        sub="Tenant-scoped outbox, delivery status and cancellation"
        right={(
          <div className="flex items-center gap-2">
            <Btn kind="secondary" onClick={() => { setPrefsErr(null); setPrefsOpen(true); }}>Preferences</Btn>
            <Btn kind="secondary" onClick={() => { setTplErr(null); setTplOpen(true); loadTemplates(); }}>Templates</Btn>
            <Btn onClick={() => { setFormErr(null); setOpen(true); }}>+ Send</Btn>
          </div>
        )}
      />
      <Err e={err} />
      <Card>
        {loading ? <TableSkeleton rows={5} cols={5} /> : items.length ? (
          <Table head={['Recipient', 'Channel', 'Status', 'Attempts', 'Created', 'Actions']}>
            {items.map((n) => (
              <tr key={n.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 text-main-text">{recipientLabel(n.recipient)}</td>
                <td className="py-2 pr-4 text-xs text-normal-text">{n.channel}</td>
                <td className="py-2 pr-4"><Badge tone={statusTone(n.status)}>{n.status}</Badge></td>
                <td className="py-2 pr-4 text-xs text-normal-text">{n.attempts ?? 0}</td>
                <td className="py-2 pr-4 text-xs text-normal-text">{n.created_at || n.createdAt || '–'}</td>
                <td className="py-2 pr-4">
                  <button className="text-xs text-main-blue hover:underline mr-3" onClick={() => inspect(n)}>Inspect</button>
                  {['queued', 'failed'].includes(n.status) && <button className="text-xs text-red-500 hover:underline mr-3" onClick={() => cancel(n)}>Cancel</button>}
                  {['failed', 'dead'].includes(n.status) && <button className="text-xs text-main-blue hover:underline" onClick={() => retry(n)}>Retry</button>}
                </td>
              </tr>
            ))}
          </Table>
        ) : <Empty text="No notifications yet" />}
      </Card>
      {selected && (
        <Card className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-main-text">Delivery detail</h2>
            <Btn kind="ghost" onClick={() => setSelected(null)}>Close</Btn>
          </div>
          <Code data={selected} />
        </Card>
      )}
      {tplOpen && (
        <Modal title="Notification templates" onClose={() => { setTplOpen(false); setTplPreview(null); }}>
          <Err e={tplErr} />
          <div className="space-y-2 mb-4">
            {tplRows.length ? tplRows.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-2 text-sm border-b border-slate-100 pb-2">
                <span className="font-mono text-xs">{t.slug}</span>
                <span className="text-normal-text flex-1">{t.name}</span>
                <Badge tone="gray">v{t.version}</Badge>
                <button type="button" className="text-xs text-main-blue hover:underline" onClick={() => previewTemplate(t)}>Preview</button>
                <button type="button" className="text-xs text-red-500 hover:underline" onClick={() => archiveTemplate(t)}>Archive</button>
              </div>
            )) : <p className="text-xs text-normal-text">No templates yet.</p>}
          </div>
          {tplPreview && (
            <Card className="mb-3">
              <div className="text-xs text-normal-text mb-1">Preview · subject: {tplPreview.subject}</div>
              <Code data={{ body: tplPreview.body, missing: tplPreview.missing }} />
            </Card>
          )}
          <form onSubmit={createTemplate} className="space-y-2">
            <Field label="Slug"><Input value={tplForm.slug} onChange={(e) => setTplForm({ ...tplForm, slug: e.target.value })} placeholder="flood-alert" /></Field>
            <Field label="Name"><Input value={tplForm.name} onChange={(e) => setTplForm({ ...tplForm, name: e.target.value })} placeholder="Flood alert" /></Field>
            <Field label="Subject"><Input value={tplForm.subject} onChange={(e) => setTplForm({ ...tplForm, subject: e.target.value })} placeholder="Flood in {{city}}" /></Field>
            <Field label="Body"><textarea value={tplForm.body} onChange={(e) => setTplForm({ ...tplForm, body: e.target.value })} rows={3} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm" placeholder="Level {{level}}m" /></Field>
            <Btn type="submit" loading={tplBusy} disabled={!tplForm.slug.trim() || !tplForm.name.trim() || !tplForm.body.trim()}>Create template</Btn>
          </form>
        </Modal>
      )}
      {prefsOpen && (
        <Modal title="Recipient preferences" onClose={() => { setPrefsOpen(false); setPrefs(null); }}>
          <Err e={prefsErr} />
          <Field label="Recipient key" desc="The same key used in the notification recipient (email, phone, URL, user id).">
            <div className="flex gap-2">
              <Input value={prefsRecipient} onChange={(e) => setPrefsRecipient(e.target.value)} placeholder="ops@example.test" />
              <Btn kind="secondary" onClick={() => loadPrefs()} loading={prefsBusy}>Load</Btn>
            </div>
          </Field>
          {prefs && (
            <form onSubmit={savePrefs}>
              <div className="mb-3">
                <div className="text-xs uppercase tracking-wide text-normal-text mb-2">Allowed channels (empty = all)</div>
                {['email', 'sms', 'webhook', 'push', 'log'].map((channel) => (
                  <label key={channel} className="flex items-center gap-2 text-sm mr-4 inline-flex">
                    <input
                      type="checkbox"
                      checked={(prefs.channels || []).includes(channel)}
                      onChange={(e) => setPrefs({
                        ...prefs,
                        channels: e.target.checked
                          ? [...(prefs.channels || []), channel]
                          : (prefs.channels || []).filter((c) => c !== channel),
                      })}
                    />
                    {channel}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm mb-3">
                <input type="checkbox" checked={!!prefs.unsubscribed} onChange={(e) => setPrefs({ ...prefs, unsubscribed: e.target.checked })} />
                Unsubscribed (blocks all future sends)
              </label>
              <Btn type="submit" loading={prefsBusy}>Save preferences</Btn>
            </form>
          )}
        </Modal>
      )}
      {open && (
        <Modal title="Send notification" onClose={() => { setOpen(false); setFormErr(null); }}>
          <form onSubmit={send}>
            <Err e={formErr} />
            <Field label="Channel">
              <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm">
                <option value="email">email</option>
                <option value="sms">sms</option>
                <option value="push">push</option>
                <option value="webhook">webhook</option>
              </select>
            </Field>
            <Field label="Recipient"><Input value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} placeholder="user@example.test" /></Field>
            <Field label="Subject (optional)"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
            <Field label="Body"><textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={4} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm" /></Field>
            <Field label="Idempotency key (optional)" desc="A retry with the same key is deduplicated by the service."><Input value={form.idempotencyKey} onChange={(e) => setForm({ ...form, idempotencyKey: e.target.value })} /></Field>
            <Btn type="submit" loading={busy} disabled={!form.recipient.trim() || !form.body.trim()}>Queue notification</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
