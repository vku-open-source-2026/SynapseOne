// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useEffect, useState } from 'react';
import {
  ArrowRight, CalendarDays, CheckCircle2, Clock3, Code2, ExternalLink,
  Mail, MapPin, Phone, Send, ShieldCheck, Sparkles, Trophy, Users,
} from 'lucide-react';
import PublicHeader from '../components/PublicHeader.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import { PRIMARY_BTN, SECONDARY_BTN } from '../components/public-styles.js';
import { api } from '../lib/api.js';
import './hackathon.css';

const CLOSE_AT = new Date('2026-11-28T10:00:00.000Z'); // 17:00 GMT+7
const API_KEY_AT = new Date('2026-11-29T05:00:00.000Z'); // 12:00 GMT+7
const PITCH_AT = new Date('2026-12-03T12:00:00.000Z'); // 19:00 GMT+7

const JURY = [
  { name: 'Hồ Sỹ Bảo Nhân', initials: 'BN', role: 'SynapseOne Core Team', avatar: '/avatars/nhan.jpg' },
  { name: 'Võ Thành Nam', initials: 'TN', role: 'SynapseOne Core Team' },
  { name: 'Trần Thị Thùy Dương', initials: 'TD', role: 'SynapseOne Core Team', avatar: '/avatars/duong.jpg' },
];

const SKILL_OPTIONS = [
  { value: 'competitive-programming', label: 'Lập trình thi đấu' },
  { value: 'practical-experience', label: 'Kinh nghiệm thực chiến' },
  { value: 'product-experience', label: 'Đã từng làm product' },
];

const TIMELINE = [
  { at: CLOSE_AT, title: 'Đóng đơn đăng ký', text: 'Hoàn tất form và chờ ban tổ chức xác nhận.', icon: CalendarDays },
  { at: API_KEY_AT, title: 'Phát API key', text: 'BTC gửi API key đến email đội trưởng đã đăng ký.', icon: ShieldCheck },
  { at: PITCH_AT, title: 'Vòng pitching', text: 'Các đội trình bày sản phẩm trước ban giám khảo.', icon: Trophy },
];

const FIELD_CLASS =
  'w-full rounded-2xl border border-s1-line bg-s1-surface px-3.5 py-2.5 text-sm text-s1-fg outline-none transition placeholder:text-s1-muted/70 focus:border-s1-accent focus:ring-2 focus:ring-s1-accent/15 disabled:cursor-not-allowed disabled:opacity-60';
const LABEL_CLASS = 'mb-1.5 block text-xs font-medium text-s1-muted';
const CARD_CLASS = 'rounded-2xl border border-s1-line bg-s1-surface p-6 shadow-sm';

function formatDate(date) {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function SkillCheckboxes({ value, onChange, disabled, legend }) {
  return (
    <fieldset className="sm:col-span-2">
      <legend className={`${LABEL_CLASS} px-0`}>{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {SKILL_OPTIONS.map((skill) => {
          const checked = value.includes(skill.value);
          return (
            <label
              key={skill.value}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-[11px] font-medium transition focus-within:ring-2 focus-within:ring-s1-accent/20 ${
                checked
                  ? 'border-s1-accent bg-s1-accent-soft text-s1-accent'
                  : 'border-s1-line bg-s1-surface text-s1-muted hover:border-s1-accent hover:text-s1-accent'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(checked ? value.filter((item) => item !== skill.value) : [...value, skill.value])}
              />
              {checked ? '✓ ' : ''}{skill.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Countdown({ now }) {
  const diff = Math.max(0, CLOSE_AT.getTime() - now);
  const total = Math.floor(diff / 1000);
  const values = [
    { label: 'NGÀY', value: Math.floor(total / 86400) },
    { label: 'GIỜ', value: Math.floor((total % 86400) / 3600) },
    { label: 'PHÚT', value: Math.floor((total % 3600) / 60) },
    { label: 'GIÂY', value: total % 60 },
  ];
  return (
    <div className="flex items-end justify-center gap-2 sm:gap-3" role="timer" aria-label="Thời gian còn lại đến khi đóng đơn đăng ký">
      {values.map((item, index) => (
        <React.Fragment key={item.label}>
          <div className="min-w-[4.25rem] rounded-2xl border border-s1-line bg-s1-surface px-2 py-3 text-center shadow-sm sm:min-w-[5.5rem] sm:px-4 sm:py-4">
            <div className="text-2xl font-semibold tabular-nums text-s1-fg sm:text-4xl">{String(item.value).padStart(2, '0')}</div>
            <div className="mt-1 text-[9px] font-semibold tracking-[0.18em] text-s1-accent sm:text-[10px]">{item.label}</div>
          </div>
          {index < values.length - 1 && <span className="pb-3 text-lg font-light text-s1-muted/50 sm:pb-5 sm:text-2xl">:</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

function JuryAvatar({ person }) {
  const [failed, setFailed] = useState(false);
  if (person.avatar && !failed) {
    return (
      <img
        src={person.avatar}
        alt=""
        onError={() => setFailed(true)}
        className="h-20 w-20 shrink-0 rounded-full object-cover ring-4 ring-sky-100 dark:ring-sky-900"
      />
    );
  }
  return (
    <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-blue-200 text-xl font-semibold text-sky-700 ring-4 ring-sky-100 dark:from-sky-900 dark:to-blue-900 dark:text-sky-200 dark:ring-sky-900">
      {person.initials}
    </span>
  );
}

const initialForm = {
  registrationType: 'team',
  teamName: '',
  captainName: '',
  captainEmail: '',
  captainPhone: '',
  captainStudentId: '',
  captainYear: '',
  captainSkills: [],
  member2: '',
  member2Year: '',
  member2Skills: [],
  member3: '',
  member3Year: '',
  member3Skills: [],
  projectIdea: '',
  acceptedRules: false,
  website: '',
};

export default function Hackathon() {
  const [now, setNow] = useState(CLOSE_AT.getTime());
  const [form, setForm] = useState(initialForm);
  const [showMember3, setShowMember3] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);
  const closed = now >= CLOSE_AT.getTime();

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError('');
  };

  const memberCount = form.registrationType === 'individual' ? 1 : (showMember3 ? 3 : 2);

  const submit = async (event) => {
    event.preventDefault();
    if (busy || closed) return;
    setError('');
    if (!form.acceptedRules) {
      setError('Bạn cần đồng ý với thể lệ trước khi gửi đơn.');
      return;
    }
    if (!form.captainYear) {
      setError('Vui lòng chọn năm học cho đội trưởng/thí sinh.');
      return;
    }
    if (form.registrationType === 'team' && (!form.teamName.trim() || !form.member2.trim() || !form.member2Year || (showMember3 && (!form.member3.trim() || !form.member3Year)))) {
      setError('Vui lòng nhập đầy đủ tên đội, thành viên và năm học.');
      return;
    }
    setBusy(true);
    try {
      const team = form.registrationType === 'team';
      const result = await api.call('POST', '/v1/hackathon/registrations', {
        registrationType: form.registrationType,
        teamName: team ? form.teamName.trim() : undefined,
        captainName: form.captainName.trim(),
        captainEmail: form.captainEmail.trim(),
        captainPhone: form.captainPhone.trim(),
        captainStudentId: form.captainStudentId.trim(),
        members: team ? [form.member2.trim(), ...(showMember3 ? [form.member3.trim()] : [])] : [],
        memberYears: team
          ? [Number(form.captainYear), Number(form.member2Year), ...(showMember3 ? [Number(form.member3Year)] : [])]
          : [Number(form.captainYear)],
        memberSkills: team
          ? [form.captainSkills, form.member2Skills, ...(showMember3 ? [form.member3Skills] : [])]
          : [form.captainSkills],
        projectIdea: form.projectIdea.trim() || undefined,
        acceptedRules: true,
        website: form.website,
      });
      setSuccess(result.registration);
      setForm(initialForm);
    } catch (e) {
      const messages = {
        registration_closed: 'Đã hết thời hạn đăng ký.',
        registration_exists: 'Tên đội hoặc email đội trưởng đã được đăng ký.',
        registration_full: 'Số lượng đội đã đủ. Vui lòng liên hệ ban tổ chức.',
        rate_limited: 'Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau.',
        invalid_body: 'Thông tin đăng ký chưa hợp lệ. Vui lòng kiểm tra tên đội, email, SĐT, MSV và thành viên.',
      };
      setError(messages[e.body?.error] || e.message || 'Không thể gửi đơn đăng ký. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hackathon-page min-h-screen bg-s1-bg text-s1-fg">
      <div className="hackathon-orb hackathon-orb-one" aria-hidden="true" />
      <div className="hackathon-orb hackathon-orb-two" aria-hidden="true" />
      <PublicHeader />

      <main className="relative mx-auto max-w-6xl px-4 pb-24 pt-28 sm:pt-32">
        <section className="mx-auto max-w-4xl text-center">
          <div className="hackathon-reveal inline-flex items-center gap-2 rounded-full border border-s1-accent/25 bg-s1-accent-soft px-4 py-1.5 text-xs font-semibold text-s1-accent">
            <Sparkles className="h-3.5 w-3.5" />
            VIC HACKATHON #1 · 28/11 — 03/12/2026
          </div>
          <h1 className="hackathon-reveal hackathon-reveal-delay-1 mt-6 text-4xl font-semibold leading-[1.08] tracking-tight text-balance sm:text-6xl">
            Biến ý tưởng thành<br />
            <span className="bg-gradient-to-r from-sky-500 to-blue-600 bg-clip-text text-transparent dark:from-sky-400 dark:to-blue-500">sản phẩm thật.</span>
          </h1>
          <p className="hackathon-reveal hackathon-reveal-delay-2 mx-auto mt-6 max-w-2xl text-base leading-relaxed text-s1-muted sm:text-lg">
            Hành trình 2–3 người, một sản phẩm và hàng trăm API mạnh mẽ từ SynapseOne.
            Xây dựng giải pháp của riêng bạn và chinh phục ban giám khảo VIC.
          </p>
          <div className="hackathon-reveal hackathon-reveal-delay-3 mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a href="#dang-ky" className={PRIMARY_BTN}>
              Đăng ký ngay <ArrowRight className="h-4 w-4" />
            </a>
            <a href="#the-le" className={SECONDARY_BTN}>Xem thể lệ</a>
          </div>
          <p className="mt-4 text-xs text-s1-muted">Không cần tài khoản SynapseOne để đăng ký · Dành cho thành viên CLB Lập trình VIC</p>
        </section>

        <section className={`${CARD_CLASS} hackathon-reveal mx-auto mt-14 max-w-3xl p-5 sm:p-7`}>
          <div className="mb-4 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-s1-accent">
            <Clock3 className="h-4 w-4" /> Đóng đơn sau
          </div>
          <Countdown now={now} />
          <p className="mt-4 text-center text-sm text-s1-muted">
            {closed ? 'Đã hết thời hạn đăng ký.' : `Hạn chót: ${formatDate(CLOSE_AT)} (giờ Việt Nam)`}
          </p>
        </section>

        <section className="mt-16 grid gap-4 sm:grid-cols-3">
          {[
            { icon: Users, value: '2–3', label: 'thành viên / đội' },
            { icon: Code2, value: 'SynapseOne', label: 'nền tảng phát triển' },
            { icon: Trophy, value: '1.000.000₫', label: 'tổng giá trị giải thưởng' },
          ].map(({ icon: Icon, value, label }) => (
            <div key={label} className={`${CARD_CLASS} text-center`}>
              <Icon className="mx-auto h-6 w-6 text-s1-accent" />
              <div className="mt-3 text-2xl font-semibold text-s1-fg">{value}</div>
              <div className="mt-1 text-sm text-s1-muted">{label}</div>
            </div>
          ))}
        </section>

        <section className="mt-24">
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-s1-accent">Hành trình hackathon</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Ba mốc, một sản phẩm</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-s1-muted">Tất cả thời gian dưới đây được tính theo giờ Việt Nam (UTC+7).</p>
          </div>
          <ol className="mx-auto mt-10 grid max-w-5xl gap-4 md:grid-cols-3">
            {TIMELINE.map(({ at, title, text, icon: Icon }, index) => (
              <li key={title} className={`${CARD_CLASS} relative flex flex-col`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-s1-accent-soft text-s1-accent">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-xs text-s1-muted">0{index + 1}</span>
                </div>
                <time className="mt-5 text-xs font-semibold text-s1-accent">{formatDate(at)}</time>
                <h3 className="mt-2 text-lg font-semibold text-s1-fg">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-s1-muted">{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="the-le" className="mt-24 scroll-mt-24">
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-s1-accent">Thể lệ</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Xây từ SynapseOne, thể hiện điều khác biệt</h2>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {[
              { icon: Users, title: 'Team 2–3 người hoặc đăng ký cá nhân', text: 'Dành cho thành viên CLB Lập trình VIC. Nếu chưa có team, hãy đăng ký cá nhân; BTC sẽ gợi ý ghép đội theo năm học và kỹ năng.' },
              { icon: Code2, title: 'Phát triển sản phẩm từ SynapseOne', text: 'Sử dụng API, workflow, dữ liệu hoặc các dịch vụ của SynapseOne để tạo sản phẩm có giá trị thực tế.' },
              { icon: ShieldCheck, title: 'Làm việc công bằng, an toàn', text: 'Tôn trọng bản quyền, không phá hoại hệ thống, không lạm dụng API key và tuân thủ hướng dẫn của ban tổ chức.' },
              { icon: Trophy, title: 'Pitching trước ban giám khảo', text: 'Trình bày sản phẩm, cách dùng SynapseOne và giá trị mà đội mang lại. Ban tổ chức sẽ hướng dẫn chi tiết thời lượng.' },
            ].map(({ icon: Icon, title, text }) => (
              <article key={title} className={CARD_CLASS}>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-s1-accent-soft text-s1-accent">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-s1-fg">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-s1-muted">{text}</p>
              </article>
            ))}
          </div>
          <div className={`${CARD_CLASS} mt-4 text-sm leading-relaxed text-s1-muted`}>
            <strong className="text-s1-fg">Lưu ý:</strong> API key được BTC tạo và gửi thủ công đến email đội trưởng sau khi duyệt.
            Không chia sẻ API key công khai. Mọi thay đổi về lịch trình sẽ được ban tổ chức thông báo qua email đã đăng ký.
          </div>
        </section>

        <section className="mt-24">
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-s1-accent">Giải thưởng</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Dành cho những sản phẩm xuất sắc</h2>
          </div>
          <div className="mt-10 grid items-stretch gap-4 md:grid-cols-3">
            {[
              { rank: 'GIẢI NHÌ', prize: '300.000₫' },
              { rank: 'GIẢI NHẤT', prize: '500.000₫' },
              { rank: 'GIẢI BA', prize: '200.000₫' },
            ].map(({ rank, prize }) => (
              <div key={rank} className={`${CARD_CLASS} text-center ${rank === 'GIẢI NHẤT' ? 'border-amber-300 bg-amber-50/40 dark:border-amber-700 dark:bg-amber-950/20' : ''}`}>
                <Trophy className={`mx-auto h-8 w-8 ${rank === 'GIẢI NHẤT' ? 'text-amber-500' : 'text-s1-muted'}`} />
                <div className="mt-4 text-xs font-bold tracking-[0.2em] text-s1-muted">{rank}</div>
                <div className="mt-2 text-3xl font-semibold text-s1-fg">{prize}</div>
                <div className="mt-1 text-xs text-s1-muted">VND</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-24">
          <div className="flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-s1-accent">Ban giám khảo</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight">Đội ngũ xây dựng và duy trì SynapseOne</h2>
              <p className="mt-2 text-sm text-s1-muted">VKU.VIC · Những người đồng hành cùng nền tảng và cộng đồng.</p>
            </div>
            <a href="https://cloud.synapseone.space/about" target="_blank" rel="noreferrer" className={SECONDARY_BTN}>
              Về đội ngũ <ExternalLink className="h-4 w-4" />
            </a>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {JURY.map((person) => (
              <article key={person.name} className={`${CARD_CLASS} flex items-center gap-4 text-left sm:flex-col sm:text-center`}>
                <JuryAvatar person={person} />
                <div>
                  <h3 className="font-semibold text-s1-fg">{person.name}</h3>
                  <p className="mt-1 text-xs text-s1-muted">{person.role}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="dang-ky" className="mt-24 scroll-mt-24">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-s1-accent">Đăng ký</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Tập hợp đội hình,<br />bắt đầu hành trình.</h2>
              <p className="mt-4 text-sm leading-relaxed text-s1-muted">
                Điền thông tin đội trưởng và các thành viên. Ban tổ chức sẽ dùng email của đội trưởng để gửi xác nhận và API key.
              </p>
              <div className="mt-6 space-y-3 text-sm text-s1-fg">
                <div className="flex items-center gap-3"><CheckCircle2 className="h-4 w-4 text-s1-accent" /> Không cần đăng nhập</div>
                <div className="flex items-center gap-3"><CheckCircle2 className="h-4 w-4 text-s1-accent" /> Mỗi đội 2–3 thành viên</div>
                <div className="flex items-center gap-3"><CheckCircle2 className="h-4 w-4 text-s1-accent" /> BTC gửi API key qua email</div>
              </div>
              <div className={`${CARD_CLASS} mt-8 text-sm text-s1-muted`}>
                <div className="flex items-center gap-2 font-semibold text-s1-fg"><MapPin className="h-4 w-4 text-s1-accent" /> Vòng pitching</div>
                <p className="mt-2">{formatDate(PITCH_AT)} (giờ Việt Nam)</p>
              </div>
            </div>

            <div className={`${CARD_CLASS} p-6 sm:p-8`}>
              {success ? (
                <div className="py-8 text-center" role="status" aria-live="polite">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-8 w-8" />
                  </div>
                  <h3 className="mt-5 text-2xl font-semibold text-s1-fg">Đơn đăng ký đã được gửi!</h3>
                  <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-s1-muted">
                    {success.registrationType === 'individual' ? (
                      <>Thí sinh <strong className="text-s1-accent">{success.captainName}</strong> đang chờ ban tổ chức sắp xếp team.</>
                    ) : (
                      <>Đội <strong className="text-s1-accent">{success.teamName}</strong> đang chờ ban tổ chức xác nhận.</>
                    )}
                    {' '}BTC sẽ liên hệ qua <strong className="text-s1-accent">{success.captainEmail}</strong>.
                  </p>
                  <div className="mx-auto mt-5 max-w-sm rounded-2xl border border-s1-line bg-s1-bg p-4 text-left text-xs text-s1-muted">
                    <div>Mã đăng ký</div>
                    <div className="mt-1 break-all font-mono text-s1-fg">{success.id}</div>
                  </div>
                  <button type="button" onClick={() => setSuccess(null)} className={`${SECONDARY_BTN} mt-6`}>Đăng ký khác</button>
                </div>
              ) : (
                <form onSubmit={submit} noValidate>
                  <div className="mb-6 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-xl font-semibold text-s1-fg">{form.registrationType === 'team' ? 'Form đăng ký đội' : 'Form đăng ký cá nhân'}</h3>
                      <p className="mt-1 text-xs text-s1-muted">Các trường có dấu * là bắt buộc</p>
                    </div>
                    <div className="rounded-full bg-s1-accent-soft px-3 py-1 text-xs font-semibold text-s1-accent">{form.registrationType === 'individual' ? 'Cá nhân' : `${memberCount} thành viên`}</div>
                  </div>

                  {closed && <div className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">Đã hết thời hạn đăng ký. Bạn vẫn có thể xem thông tin sự kiện tại trang này.</div>}
                  {error && <div className="mb-5 rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200" role="alert">{error}</div>}

                  <div className="mb-6 grid gap-2 sm:grid-cols-2">
                    <button type="button" onClick={() => update('registrationType', 'team')} className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${form.registrationType === 'team' ? 'border-s1-accent bg-s1-accent-soft text-s1-accent' : 'border-s1-line bg-s1-surface text-s1-muted hover:border-s1-accent'}`}>
                      <strong className="block">Đã có team</strong>
                      <span className="mt-1 block text-[11px]">Đăng ký 2–3 thành viên</span>
                    </button>
                    <button type="button" onClick={() => update('registrationType', 'individual')} className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${form.registrationType === 'individual' ? 'border-s1-accent bg-s1-accent-soft text-s1-accent' : 'border-s1-line bg-s1-surface text-s1-muted hover:border-s1-accent'}`}>
                      <strong className="block">Chưa có team</strong>
                      <span className="mt-1 block text-[11px]">BTC sẽ sắp xếp team phù hợp</span>
                    </button>
                  </div>

                  {form.registrationType === 'individual' && (
                    <div className="mb-5 rounded-2xl border border-s1-accent/20 bg-s1-accent-soft p-4 text-xs leading-relaxed text-s1-accent">
                      Hệ thống sẽ gợi ý ghép team cho admin dựa trên năm học và kỹ năng nâng cao, ưu tiên một sinh viên năm 2 hoặc người có kỹ năng nổi bật làm anchor.
                    </div>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    {form.registrationType === 'team' && (
                      <label className="block sm:col-span-2">
                        <span className={LABEL_CLASS}>Tên đội *</span>
                        <input className={FIELD_CLASS} value={form.teamName} onChange={(e) => update('teamName', e.target.value)} placeholder="Ví dụ: Synapse Builders" maxLength={100} required disabled={closed} />
                      </label>
                    )}
                    <label className="block">
                      <span className={LABEL_CLASS}>{form.registrationType === 'team' ? 'Họ tên đội trưởng *' : 'Họ tên thí sinh *'}</span>
                      <input className={FIELD_CLASS} value={form.captainName} onChange={(e) => update('captainName', e.target.value)} placeholder="Nguyễn Văn A" maxLength={100} required disabled={closed} />
                    </label>
                    <label className="block">
                      <span className={LABEL_CLASS}>Sinh viên năm thứ *</span>
                      <select className={FIELD_CLASS} value={form.captainYear} onChange={(e) => update('captainYear', e.target.value)} required disabled={closed}>
                        <option value="">Chọn năm học</option>
                        {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>Năm {year}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className={LABEL_CLASS}>MSV *</span>
                      <input className={FIELD_CLASS} value={form.captainStudentId} onChange={(e) => update('captainStudentId', e.target.value)} placeholder="123456789" maxLength={32} required disabled={closed} />
                    </label>
                    <label className="block">
                      <span className={LABEL_CLASS}>Email *</span>
                      <div className="relative">
                        <Mail className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-s1-muted" />
                        <input type="email" className={`${FIELD_CLASS} pl-10`} value={form.captainEmail} onChange={(e) => update('captainEmail', e.target.value)} placeholder="captain@example.com" maxLength={320} required disabled={closed} />
                      </div>
                    </label>
                    <label className="block">
                      <span className={LABEL_CLASS}>Số điện thoại *</span>
                      <div className="relative">
                        <Phone className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-s1-muted" />
                        <input type="tel" className={`${FIELD_CLASS} pl-10`} value={form.captainPhone} onChange={(e) => update('captainPhone', e.target.value)} placeholder="0912 345 678" maxLength={20} required disabled={closed} />
                      </div>
                    </label>
                    <SkillCheckboxes legend={form.registrationType === 'team' ? 'Kỹ năng nâng cao của đội trưởng' : 'Kỹ năng nâng cao của bạn'} value={form.captainSkills} onChange={(value) => update('captainSkills', value)} disabled={closed} />

                    {form.registrationType === 'team' && (
                      <>
                        <label className="block">
                          <span className={LABEL_CLASS}>Thành viên 2 *</span>
                          <input className={FIELD_CLASS} value={form.member2} onChange={(e) => update('member2', e.target.value)} placeholder="Trần Thị B" maxLength={100} required disabled={closed} />
                        </label>
                        <label className="block">
                          <span className={LABEL_CLASS}>Sinh viên năm thứ *</span>
                          <select className={FIELD_CLASS} value={form.member2Year} onChange={(e) => update('member2Year', e.target.value)} required disabled={closed}>
                            <option value="">Chọn năm học</option>
                            {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>Năm {year}</option>)}
                          </select>
                        </label>
                        <SkillCheckboxes legend="Kỹ năng nâng cao của thành viên 2" value={form.member2Skills} onChange={(value) => update('member2Skills', value)} disabled={closed} />
                        {showMember3 ? (
                          <>
                            <label className="block">
                              <span className={LABEL_CLASS}>Thành viên 3 *</span>
                              <input className={FIELD_CLASS} value={form.member3} onChange={(e) => update('member3', e.target.value)} placeholder="Lê Văn C" maxLength={100} required disabled={closed} />
                            </label>
                            <label className="block">
                              <span className={LABEL_CLASS}>Sinh viên năm thứ *</span>
                              <select className={FIELD_CLASS} value={form.member3Year} onChange={(e) => update('member3Year', e.target.value)} required disabled={closed}>
                                <option value="">Chọn năm học</option>
                                {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>Năm {year}</option>)}
                              </select>
                            </label>
                            <SkillCheckboxes legend="Kỹ năng nâng cao của thành viên 3" value={form.member3Skills} onChange={(value) => update('member3Skills', value)} disabled={closed} />
                          </>
                        ) : (
                          <button type="button" onClick={() => setShowMember3(true)} disabled={closed} className="self-end rounded-2xl border border-dashed border-s1-accent/40 px-4 py-2.5 text-sm font-medium text-s1-accent transition hover:bg-s1-accent-soft disabled:opacity-50">
                            + Thêm thành viên thứ 3
                          </button>
                        )}
                      </>
                    )}
                    <label className="block sm:col-span-2">
                      <span className={LABEL_CLASS}>Ý tưởng sản phẩm (không bắt buộc)</span>
                      <textarea className={`${FIELD_CLASS} min-h-[110px] resize-y`} value={form.projectIdea} onChange={(e) => update('projectIdea', e.target.value)} placeholder={form.registrationType === 'team' ? 'Đội dự định xây dựng gì với SynapseOne?' : 'Bạn muốn xây dựng gì hoặc có kinh nghiệm gì nổi bật?'} maxLength={2000} disabled={closed} />
                    </label>
                  </div>

                  <div className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
                    <label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => update('website', e.target.value)} /></label>
                  </div>

                  <label className="mt-5 flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-s1-muted">
                    <input type="checkbox" checked={form.acceptedRules} onChange={(e) => update('acceptedRules', e.target.checked)} className="mt-0.5 h-4 w-4 accent-sky-500" required disabled={closed} />
                    <span>Tôi xác nhận thông tin chính xác, đồng ý với <a href="#the-le" className="font-semibold text-s1-accent underline underline-offset-2">thể lệ VIC Hackathon #1</a>{form.registrationType === 'individual' ? ' và để BTC hỗ trợ sắp xếp team' : ''}.</span>
                  </label>

                  <button type="submit" disabled={busy || closed} className={`${PRIMARY_BTN} mt-6 w-full disabled:cursor-not-allowed disabled:opacity-60`}>
                    {busy ? 'Đang gửi đơn…' : closed ? 'Đã đóng đăng ký' : 'Gửi đơn đăng ký'}
                    {!busy && !closed && <Send className="h-4 w-4" />}
                  </button>
                  <p className="mt-3 text-center text-[11px] leading-relaxed text-s1-muted">Thông tin chỉ được ban tổ chức sử dụng để liên hệ và tổ chức sự kiện.</p>
                </form>
              )}
            </div>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
