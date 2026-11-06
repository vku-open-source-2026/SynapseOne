// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faBook,
  faCode,
  faCodeBranch,
  faCube,
  faCubes,
  faScaleBalanced,
} from '@fortawesome/free-solid-svg-icons';
import { ArrowRight, Plug, Scale, Server, ShieldCheck } from 'lucide-react';
import PublicHeader from '../components/PublicHeader.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import { useI18n } from '../lib/i18n-context.js';

const REPO = 'https://github.com/vku-open-source-2026/SynapseOne';

// Each link shows the host it opens, so readers know where they are going.
const LINKS = [
  { key: 'repo', icon: faCodeBranch, host: 'github.com', href: REPO },
  { key: 'docs', icon: faBook, host: 'github.com', href: `${REPO}/tree/main/docs` },
  { key: 'api', icon: faCode, host: '/api-docs', href: '/api-docs' },
  { key: 'npm', icon: faCube, host: 'npmjs.com', href: 'https://www.npmjs.com/package/@synapseone/sdk' },
  { key: 'pypi', icon: faCubes, host: 'pypi.org', href: 'https://pypi.org/project/synapseone-sdk/' },
  { key: 'license', icon: faScaleBalanced, host: 'github.com', href: `${REPO}/blob/main/LICENSE` },
];

// Icons in the same order as `about.principles` in src/locales.
const PRINCIPLE_ICONS = [Scale, Plug, Server, ShieldCheck];
// Where each principle shows up in the repo or the running stack (not translated: names and commands).
const PRINCIPLE_PROOF = ['LICENSE · tools/license-check', 'OIDC · NGSI-LD · S3 · REST', 'docker compose up -d', 'x-synapseone-* headers'];

// Team order as on the other Synapse sites.
const TEAM = [
  { name: 'Hồ Sỹ Bảo Nhân', avatar: '/avatars/nhan.jpg' },
  { name: 'Võ Thành Nam' },
  { name: 'Trần Thị Thùy Dương', avatar: '/avatars/duong.jpg' },
];

const PARTNERS = [
  { key: 'vku', href: 'https://vku.udn.vn', logo: '/vku-logo.svg' },
  { key: 'vic', href: 'https://www.facebook.com/vic.club.vku?locale=vi_VN', logo: '/vic-logo.svg' },
];

const H2 = 'text-2xl font-semibold tracking-tight text-balance';

function Avatar({ member }) {
  const [failed, setFailed] = useState(false);
  if (member.avatar && !failed) {
    return (
      <img
        src={member.avatar}
        alt=""
        onError={() => setFailed(true)}
        className="h-24 w-24 shrink-0 rounded-full object-cover ring-4 ring-sky-100 dark:ring-sky-900"
      />
    );
  }
  // No photo: the given name's initial.
  return (
    <span className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-blue-200 text-3xl font-semibold text-sky-700 ring-4 ring-sky-100 dark:from-sky-900 dark:to-blue-900 dark:text-sky-200 dark:ring-sky-900">
      {member.name.split(' ').pop().charAt(0)}
    </span>
  );
}

/** Releases from the CHANGELOG, then work in progress, then the open ROADMAP items. */
function Timeline({ a }) {
  return (
    <ol className="relative mt-6 ml-1.5 border-l border-s1-line pl-6">
      {a.timeline.map((r) => (
        <li key={r.version} className="relative pb-5">
          <span
            className="absolute -left-[1.85rem] top-1 h-3 w-3 rounded-full border-2 border-s1-bg bg-sky-400"
            aria-hidden="true"
          />
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm font-semibold text-s1-fg">{r.version}</span>
            <span className="text-xs text-s1-muted">{r.date}</span>
          </p>
          <p className="mt-1 text-sm leading-relaxed text-s1-muted">{r.text}</p>
        </li>
      ))}
      <li className="relative pb-5">
        <span
          className="absolute -left-[1.98rem] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-s1-accent-soft"
          aria-hidden="true"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-s1-accent" />
        </span>
        <p className="text-sm font-semibold text-s1-accent">{a.unreleasedLabel}</p>
        <p className="mt-1 text-sm leading-relaxed text-s1-muted">{a.unreleasedText}</p>
      </li>
      <li className="relative">
        <span
          className="absolute -left-[1.85rem] top-1 h-3 w-3 rounded-full border-2 border-dashed border-s1-muted bg-s1-bg"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold text-s1-fg">{a.nextLabel}</p>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-s1-muted">
          {a.next.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <a
          href={`${REPO}/blob/main/ROADMAP.md`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-s1-accent hover:underline"
        >
          {a.roadmap}
          <ArrowRight className="h-4 w-4" />
        </a>
      </li>
    </ol>
  );
}

export default function About() {
  const { m } = useI18n();
  const a = m.about;
  return (
    <div className="min-h-screen bg-s1-bg text-s1-fg">
      <PublicHeader />
      <main className="mx-auto max-w-6xl px-4 pt-28 sm:pt-32 pb-20">
        <header className="max-w-3xl">
          <p className="text-sm font-medium text-s1-accent">{a.kicker}</p>
          <h1 className="mt-3 text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">{a.title}</h1>
          <p className="mt-5 text-lg leading-relaxed text-s1-muted">{a.intro}</p>
        </header>

        {/* A1: why the project exists: the problem, then the answer. */}
        <section className="mt-20">
          <h2 className={H2}>{a.whyTitle}</h2>
          <div className="mt-6 grid gap-6 md:grid-cols-[1fr_auto_1fr] md:items-stretch md:gap-8">
            <div className="min-w-0 rounded-2xl border border-s1-line bg-s1-surface p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-s1-muted">{a.whyProblem}</p>
              <p className="mt-3 leading-relaxed text-s1-fg">{a.why[0]}</p>
            </div>
            <div className="flex items-center justify-center" aria-hidden="true">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25">
                <ArrowRight className="h-5 w-5 rotate-90 md:rotate-0" />
              </span>
            </div>
            <div className="min-w-0 rounded-2xl border border-sky-300 bg-s1-surface p-6 shadow-lg shadow-sky-500/10 dark:border-sky-700">
              <p className="text-xs font-semibold uppercase tracking-wider text-s1-accent">{a.whyAnswer}</p>
              <p className="mt-3 leading-relaxed text-s1-fg">{a.why[1]}</p>
            </div>
          </div>
        </section>

        {/* A2: principles. Same card family as the Home features, plus a mono line naming where each one shows up. */}
        <section className="mt-20">
          <h2 className={H2}>{a.principlesTitle}</h2>
          <ul className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {a.principles.map((p, i) => {
              const Icon = PRINCIPLE_ICONS[i];
              return (
                <li
                  key={p.title}
                  className="flex min-w-0 flex-col rounded-2xl border border-s1-line bg-s1-surface p-6 transition duration-200 hover:-translate-y-1 hover:border-sky-300 hover:shadow-lg hover:shadow-sky-500/10 dark:hover:border-sky-700"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25">
                    <Icon className="h-6 w-6" strokeWidth={1.75} />
                  </span>
                  <h3 className="mt-5 font-semibold text-balance">{p.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-s1-muted">{p.text}</p>
                  <p className="mt-auto pt-5 font-mono text-[11px] text-s1-accent">{PRINCIPLE_PROOF[i]}</p>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Open-source links beside A3, the release timeline. */}
        <section className="mt-20 grid gap-12 lg:grid-cols-2">
          <div className="min-w-0">
            <h2 className={H2}>{a.openSourceTitle}</h2>
            <p className="mt-3 leading-relaxed text-s1-muted">{a.openSourceText}</p>
            <ul className="mt-6 divide-y divide-s1-line border-y border-s1-line">
              {LINKS.map((l) => {
                const external = !l.href.startsWith('/');
                const inner = (
                  <>
                    <FontAwesomeIcon icon={l.icon} className="w-4 text-s1-muted transition group-hover:text-s1-accent" />
                    <span className="min-w-0 flex-1 truncate font-medium">{a.links[l.key]}</span>
                    <span className="shrink-0 font-mono text-xs text-s1-muted">{l.host}</span>
                    {external && <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="text-[10px] text-s1-muted" />}
                  </>
                );
                const cls = 'group flex items-center gap-3 py-3 text-sm transition hover:text-s1-accent';
                return (
                  <li key={l.href}>
                    {external ? (
                      <a href={l.href} target="_blank" rel="noreferrer" className={cls}>{inner}</a>
                    ) : (
                      <Link to={l.href} className={cls}>{inner}</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="min-w-0">
            <h2 className={H2}>{a.timelineTitle}</h2>
            <p className="mt-3 text-s1-muted">{a.timelineLead}</p>
            <Timeline a={a} />
          </div>
        </section>

        {/* A4: team and partners. Vertical cards like the SynapseCity About page, so the sites match. */}
        <section className="mt-20">
          <h2 className={H2}>{a.teamTitle}</h2>
          <p className="mt-2 text-s1-muted">{a.teamLead}</p>
          <ul className="mt-8 grid gap-5 sm:grid-cols-3">
            {TEAM.map((member) => (
              <li
                key={member.name}
                className="flex flex-col items-center rounded-2xl border border-s1-line bg-s1-surface px-5 py-8 text-center transition duration-200 hover:-translate-y-1 hover:border-sky-300 hover:shadow-lg hover:shadow-sky-500/10 dark:hover:border-sky-700"
              >
                <Avatar member={member} />
                <span className="mt-4 font-semibold">{member.name}</span>
                {member.role && <span className="mt-1 text-sm text-s1-muted">{member.role}</span>}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-20">
          <h2 className={H2}>{a.partnersTitle}</h2>
          <p className="mt-2 text-s1-muted">{a.partnersLead}</p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PARTNERS.map((p) => (
              <li key={p.key}>
                <a
                  href={p.href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-4 rounded-xl border border-s1-line bg-s1-surface p-3 transition hover:border-s1-accent"
                >
                  {/* Logos are drawn for white, so the tile stays white in dark mode. */}
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#fff] p-1.5">
                    <img src={p.logo} alt="" className="max-h-full max-w-full object-contain" />
                  </span>
                  <span className="font-medium">{a.partners[p.key]}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
