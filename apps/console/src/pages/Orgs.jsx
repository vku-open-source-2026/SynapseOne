// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';

export default function Orgs() {
  const { headers, auth } = useAuth();
  const canAdmin = !!auth?.user?.is_org_admin;
  const [orgs, setOrgs] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');

  const load = () => {
    setErr(null);
    api.orgs(headers).then((v) => setOrgs(Array.isArray(v) ? v : [])).catch(setErr).finally(() => setLoaded(true));
  };
  useEffect(load, [headers]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormErr(null);
    setErr(null);
    try {
      await api.createOrg(slug, name, headers);
      setOpen(false);
      setSlug('');
      setName('');
      load();
    } catch (ex) {
      setFormErr(ex);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageTitle title="Organizations" sub="Root tenants, like AWS Organizations" right={canAdmin ? <Btn onClick={() => { setFormErr(null); setOpen(true); }}>+ New</Btn> : undefined} />
      <Err e={err} />
      <Card>
        {!loaded ? (
          <TableSkeleton rows={4} cols={3} />
        ) : orgs.length ? (
          <Table head={['Slug', 'Display name', 'ID']}>
            {orgs.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{o.slug}</td>
                <td className="py-2 pr-4">{o.display_name}</td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{o.id?.slice(0, 8)}…</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty />
        )}
      </Card>
      <p className="mt-3 text-xs text-normal-text">
        <Badge>Tip</Badge> Pick an org on the Accounts page to see its accounts.
      </p>
      {open && (
        <Modal title="New organization" onClose={() => { setOpen(false); setFormErr(null); }}>
          <form onSubmit={create}><Err e={formErr} />
            <Field label="Slug (unique)">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme" />
            </Field>
            <Field label="Display name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ACME Corp" />
            </Field>
            <Btn type="submit" loading={busy}>Create</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
