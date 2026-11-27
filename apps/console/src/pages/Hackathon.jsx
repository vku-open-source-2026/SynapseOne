// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useEffect, useState } from 'react';
import {
  ArrowRight, CalendarDays, CheckCircle2, Clock3, Code2, ExternalLink,
  Mail, MapPin, Phone, Send, ShieldCheck, Sparkles, Trophy, Users,
} from 'lucide-react';
import PublicHeader from '../components/PublicHeader.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import { api } from '../lib/api.js';
import './hackathon.css';

const CLOSE_AT = new Date('2026-11-28T10:00:00.000Z'); // 17:00 GMT+7
const API_KEY_AT = new Date('2026-11-29T05:00:00.000Z'); // 12:00 GMT+7
const PITCH_AT = new Date('2026-12-03T12:00:00.000Z'); // 19:00 GMT+7

const JURY = [
  { name: 'Hồ Sỹ Bảo Nhân', initials: 'BN', role: 'SynapseOne Core Team' },
  { name: 'Võ Thành Nam', initials: 'TN', role: 'SynapseOne Core Team' },
  { name: 'Trần Thị Thùy Dương', initials: 'TD', role: 'SynapseOne Core Team' },
];

const SKILL_OPTIONS = [
  { value: 'competitive-programming', label: 'Lập trình thi đấu' },
  { value: 'practical-experience', label: 'Kinh nghiệm thực chiến' },
  { value: 'product-experience', label: 'Đã từng làm product' },
];

function SkillCheckboxes({ value, onChange, disabled, legend }) {
  return (
    <fieldset className="sm:col-span-2">
      <legend className="mb-1.5 block text-xs font-medium text-slate-300">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {SKILL_OPTIONS.map((skill) => {
          const checked = value.includes(skill.value);
          return (
            <label key={skill.value} className={`cursor-pointer rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${checked ? 'border-cyan-300/60 bg-cyan-300/15 text-cyan-100' : 'border-white/15 bg-white/5 text-slate-400 hover:bg-white/10'}`}>
              <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={() => onChange(checked ? value.filter((item) => item !== skill.value) : [...value, skill.value])} />
              {checked ? '✓ ' : ''}{skill.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const TIMELINE = [
  { at: CLOSE_AT, title: 'Đóng đơn đăng ký', text: 'Hoàn tất form và chờ ban tổ chức xác nhận.' },
  { at: API_KEY_AT, title: 'Phát API key', text: 'BTC gửi API key đến email đội trưởng đã đăng ký.' },
  { at: PITCH_AT, title: 'Vòng pitching', text: 'Các đội trình bày sản phẩm trước ban giám khảo.' },
];

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
    <div className="flex items-end justify-center gap-2 sm:gap-4" role="timer" aria-label="Thời gian còn lại đến khi đóng đơn đăng ký">
      {values.map((item, index) => (
        <React.Fragment key={item.label}>
          <div className="hackathon-countdown-cell rounded-2xl px-2 py-3 text-center sm:min-w-[5.5rem] sm:px-4 sm:py-4">
            <div className="text-2xl font-bold tabular-nums text-white sm:text-4xl">{String(item.value).padStart(2, '0')}</div>
            <div className="mt-1 text-[9px] font-semibold tracking-[0.2em] text-cyan-200/70 sm:text-[10px]">{item.label}</div>
          </div>
          {index < values.length - 1 && <span className="pb-3 text-xl font-light text-cyan-200/50 sm:pb-5 sm:text-3xl">:</span>}
        </React.Fragment>
      ))}
    </div>
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
    <div className="hackathon-page min-h-screen">
      <div className="hackathon-orb hackathon-orb-one" />
      <div className="hackathon-orb hackathon-orb-two" />
      <PublicHeader />

      <main className="relative mx-auto max-w-6xl px-4 pb-24 pt-28 sm:pt-32">
        <section className="mx-auto max-w-4xl text-center">
          <div className="hackathon-reveal inline-flex items-center gap-2 rounded-full border border-cyan-300/25 bg-cyan-300/10 px-4 py-1.5 text-xs font-semibold text-cyan-100">
            <Sparkles className="h-3.5 w-3.5" />
            VIC HACKATHON #1 · 28/11 — 03/12/2026
          </div>
          <h1 className="hackathon-reveal hackathon-reveal-delay-1 mt-6 text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
            Biến ý tưởng thành<br />
            <span className="hackathon-gradient-text">sản phẩm thật.</span>
          </h1>
          <p className="hackathon-reveal hackathon-reveal-delay-2 mx-auto mt-6 max-w-2xl text-base leading-relaxed text-slate-300 sm:text-lg">
            Hành trình 2–3 người, một sản phẩm và hàng trăm API mạnh mẽ từ SynapseOne.
            Xây dựng giải pháp của riêng bạn và chinh phục ban giám khảo VIC.
          </p>
          <div className="hackathon-reveal hackathon-reveal-delay-3 mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a href="#dang-ky" className="hackathon-primary-btn inline-flex items-center justify-center gap-2 rounded-full px-7 py-3 text-sm font-bold text-white">
              Đăng ký ngay <ArrowRight className="h-4 w-4" />
            </a>
            <a href="#the-le" className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-7 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10">
              Xem thể lệ
            </a>
          </div>
          <p className="mt-4 text-xs text-slate-400">Không cần tài khoản SynapseOne để đăng ký · Dành cho thành viên CLB Lập trình VIC</p>
        </section>

        <section className="hackathon-reveal mx-auto mt-14 max-w-3xl rounded-3xl p-5 sm:p-7">
          <div className="mb-4 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">
            <Clock3 className="h-4 w-4" /> Đóng đơn sau
          </div>
          <Countdown now={now} />
          <p className="mt-4 text-center text-sm text-slate-400">
            {closed ? 'Đã hết thời hạn đăng ký.' : `Hạn chót: ${formatDate(CLOSE_AT)} (giờ Việt Nam)`}
          </p>
        </section>

        <section className="mt-16 grid gap-4 sm:grid-cols-3">
          {[
            { icon: Users, value: '2–3', label: 'thành viên / đội' },
            { icon: Code2, value: 'SynapseOne', label: 'nền tảng phát triển' },
            { icon: Trophy, value: '1.000.000₫', label: 'tổng giá trị giải thưởng' },
          ].map(({ icon: Icon, value, label }) => (
            <div key={label} className="hackathon-glass rounded-3xl p-6 text-center">
              <Icon className="mx-auto h-6 w-6 text-cyan-300" />
              <div className="mt-3 text-2xl font-bold text-white">{value}</div>
              <div className="mt-1 text-sm text-slate-400">{label}</div>
            </div>
          ))}
        </section>

        <section className="mt-24">
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">Hành trình hackathon</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Ba mốc, một sản phẩm</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">Tất cả thời gian dưới đây được tính theo giờ Việt Nam (UTC+7).</p>
          </div>
          <div className="relative mx-auto mt-12 max-w-3xl">
            <div className="hackathon-timeline-line absolute bottom-8 left-4 top-8 w-px sm:left-1/2" />
            <div className="space-y-8">
              {TIMELINE.map(({ at, title, text }, index) => (
                <div key={title} className={`relative flex items-start gap-5 sm:w-1/2 ${index % 2 ? 'sm:ml-auto sm:flex-row-reverse sm:text-right' : ''}`}>
                  <div className="relative z-10 mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cyan-300/40 bg-[#0b1b2d] text-cyan-200 shadow-[0_0_25px_rgba(34,211,238,0.18)] sm:absolute sm:left-[-4.5rem] sm:top-0">
                    {index === 0 ? <CalendarDays className="h-4 w-4" /> : index === 1 ? <ShieldCheck className="h-4 w-4" /> : <Trophy className="h-4 w-4" />}
                  </div>
                  <div className="hackathon-glass flex-1 rounded-3xl p-5 sm:absolute sm:left-8 sm:right-[-2.5rem]">
                    <div className="text-xs font-semibold text-cyan-200">{formatDate(at)}</div>
                    <h3 className="mt-2 text-lg font-bold text-white">{title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-slate-400">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="the-le" className="mt-24 scroll-mt-24">
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-violet-300">Thể lệ</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Xây từ SynapseOne, thể hiện điều khác biệt</h2>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {[
              { icon: Users, title: 'Team 2–3 người hoặc đăng ký cá nhân', text: 'Dành cho thành viên CLB Lập trình VIC. Nếu chưa có team, hãy đăng ký cá nhân; BTC sẽ gợi ý ghép đội theo năm học và kỹ năng.' },
              { icon: Code2, title: 'Phát triển sản phẩm từ SynapseOne', text: 'Sử dụng API, workflow, dữ liệu hoặc các dịch vụ của SynapseOne để tạo sản phẩm có giá trị thực tế.' },
              { icon: ShieldCheck, title: 'Làm việc công bằng, an toàn', text: 'Tôn trọng bản quyền, không phá hoại hệ thống, không lạm dụng API key và tuân thủ hướng dẫn của ban tổ chức.' },
              { icon: Trophy, title: 'Pitching trước ban giám khảo', text: 'Trình bày sản phẩm, cách dùng SynapseOne và giá trị mà đội mang lại. Ban tổ chức sẽ hướng dẫn chi tiết thời lượng.' },
            ].map(({ icon: Icon, title, text }) => (
              <article key={title} className="hackathon-glass rounded-3xl p-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-400/10 text-violet-200">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{text}</p>
              </article>
            ))}
          </div>
          <div className="hackathon-glass mt-4 rounded-3xl p-6 text-sm leading-relaxed text-slate-300">
            <strong className="text-white">Lưu ý:</strong> API key được BTC tạo và gửi thủ công đến email đội trưởng sau khi duyệt.
            Không chia sẻ API key công khai. Mọi thay đổi về lịch trình sẽ được ban tổ chức thông báo qua email đã đăng ký.
          </div>
        </section>

        <section className="mt-24">
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-amber-300">Giải thưởng</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Dành cho những sản phẩm xuất sắc</h2>
          </div>
          <div className="mt-10 grid items-end gap-4 md:grid-cols-3">
            {[
              { rank: 'GIẢI NHÌ', prize: '300.000₫', extra: 'VND', style: '' },
              { rank: 'GIẢI NHẤT', prize: '500.000₫', extra: 'VND', style: 'hackathon-prize-first md:-translate-y-4' },
              { rank: 'GIẢI BA', prize: '200.000₫', extra: 'VND', style: '' },
            ].map(({ rank, prize, extra, style }) => (
              <div key={rank} className={`hackathon-glass rounded-3xl p-7 text-center ${style}`}>
                <Trophy className={`mx-auto h-8 w-8 ${rank === 'GIẢI NHẤT' ? 'text-amber-300' : 'text-slate-300'}`} />
                <div className="mt-4 text-xs font-bold tracking-[0.2em] text-slate-400">{rank}</div>
                <div className="mt-2 text-3xl font-black text-white">{prize}</div>
                <div className="mt-1 text-xs text-slate-500">{extra}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-24">
          <div className="flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">Ban giám khảo</p>
              <h2 className="mt-3 text-3xl font-bold">Đội ngũ xây dựng và duy trì SynapseOne</h2>
              <p className="mt-2 text-sm text-slate-400">VKU.VIC · Những người đồng hành cùng nền tảng và cộng đồng.</p>
            </div>
            <a href="https://cloud.synapseone.space/about" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/15 px-5 py-2 text-sm font-semibold text-cyan-100 hover:bg-white/5">
              Về đội ngũ <ExternalLink className="h-4 w-4" />
            </a>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {JURY.map((person) => (
              <article key={person.name} className="hackathon-glass rounded-3xl p-6 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400/25 to-violet-500/25 text-lg font-bold text-cyan-100 ring-1 ring-cyan-200/25">
                  {person.initials}
                </div>
                <h3 className="mt-4 font-bold text-white">{person.name}</h3>
                <p className="mt-1 text-xs text-slate-400">{person.role}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="dang-ky" className="mt-24 scroll-mt-24">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">Đăng ký</p>
              <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Tập hợp đội hình,<br />bắt đầu hành trình.</h2>
              <p className="mt-4 text-sm leading-relaxed text-slate-400">
                Điền thông tin đội trưởng và các thành viên. Ban tổ chức sẽ dùng email của đội trưởng để gửi xác nhận và API key.
              </p>
              <div className="mt-6 space-y-3 text-sm text-slate-300">
                <div className="flex items-center gap-3"><CheckCircle2 className="h-4 w-4 text-cyan-300" /> Không cần đăng nhập</div>
                <div className="flex items-center gap-3"><CheckCircle2 className="h-4 w-4 text-cyan-300" /> Mỗi đội 2–3 thành viên</div>
                <div className="flex items-center gap-3"><CheckCircle2 className="h-4 w-4 text-cyan-300" /> BTC gửi API key qua email</div>
              </div>
              <div className="hackathon-glass mt-8 rounded-3xl p-5 text-sm text-slate-300">
                <div className="flex items-center gap-2 font-semibold text-white"><MapPin className="h-4 w-4 text-cyan-300" /> Vòng pitching</div>
                <p className="mt-2 text-slate-400">{formatDate(PITCH_AT)} (giờ Việt Nam)</p>
              </div>
            </div>

            <div className="hackathon-glass rounded-3xl p-6 sm:p-8">
              {success ? (
                <div className="py-8 text-center" role="status" aria-live="polite">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                    <CheckCircle2 className="h-8 w-8" />
                  </div>
                  <h3 className="mt-5 text-2xl font-bold text-white">Đơn đăng ký đã được gửi!</h3>
                  <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-400">
                    {success.registrationType === 'individual' ? (
                      <>Thí sinh <strong className="text-cyan-200">{success.captainName}</strong> đang chờ ban tổ chức sắp xếp team.</>
                    ) : (
                      <>Đội <strong className="text-cyan-200">{success.teamName}</strong> đang chờ ban tổ chức xác nhận.</>
                    )}
                    {' '}BTC sẽ liên hệ qua <strong className="text-cyan-200">{success.captainEmail}</strong>.
                  </p>
                  <div className="mx-auto mt-5 max-w-sm rounded-2xl border border-white/10 bg-black/20 p-4 text-left text-xs text-slate-400">
                    <div>Mã đăng ký</div>
                    <div className="mt-1 break-all font-mono text-slate-200">{success.id}</div>
                  </div>
                  <button type="button" onClick={() => setSuccess(null)} className="mt-6 rounded-full border border-white/15 px-6 py-2.5 text-sm font-semibold text-white hover:bg-white/5">
                    Đăng ký khác
                  </button>
                </div>
              ) : (
                <form onSubmit={submit} noValidate>
                  <div className="mb-6 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-xl font-bold text-white">{form.registrationType === 'team' ? 'Form đăng ký đội' : 'Form đăng ký cá nhân'}</h3>
                      <p className="mt-1 text-xs text-slate-400">Các trường có dấu * là bắt buộc</p>
                    </div>
                    <div className="rounded-full bg-cyan-300/10 px-3 py-1 text-xs font-semibold text-cyan-200">{form.registrationType === 'individual' ? 'Cá nhân' : `${memberCount} thành viên`}</div>
                  </div>

                  {closed && <div className="mb-5 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">Đã hết thời hạn đăng ký. Bạn vẫn có thể xem thông tin sự kiện tại trang này.</div>}
                  {error && <div className="mb-5 rounded-2xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-100" role="alert">{error}</div>}

                  <div className="mb-6 grid gap-2 sm:grid-cols-2">
                    <button type="button" onClick={() => update('registrationType', 'team')} className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${form.registrationType === 'team' ? 'border-cyan-300/60 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10'}`}>
                      <strong className="block">Đã có team</strong>
                      <span className="mt-1 block text-[11px]">Đăng ký 2–3 thành viên</span>
                    </button>
                    <button type="button" onClick={() => update('registrationType', 'individual')} className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${form.registrationType === 'individual' ? 'border-cyan-300/60 bg-cyan-300/10 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10'}`}>
                      <strong className="block">Chưa có team</strong>
                      <span className="mt-1 block text-[11px]">BTC sẽ sắp xếp team phù hợp</span>
                    </button>
                  </div>

                  {form.registrationType === 'individual' && (
                    <div className="mb-5 rounded-2xl border border-violet-300/20 bg-violet-300/10 p-4 text-xs leading-relaxed text-violet-100">
                      Hệ thống sẽ gợi ý ghép team cho admin dựa trên năm học và kỹ năng nâng cao, ưu tiên một sinh viên năm 2 hoặc người có kỹ năng nổi bật làm anchor.
                    </div>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    {form.registrationType === 'team' && (
                      <label className="block sm:col-span-2">
                        <span className="mb-1.5 block text-xs font-medium text-slate-300">Tên đội *</span>
                        <input className="hackathon-form-input" value={form.teamName} onChange={(e) => update('teamName', e.target.value)} placeholder="Ví dụ: Synapse Builders" maxLength={100} required disabled={closed} />
                      </label>
                    )}
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-300">{form.registrationType === 'team' ? 'Họ tên đội trưởng *' : 'Họ tên thí sinh *'}</span>
                      <input className="hackathon-form-input" value={form.captainName} onChange={(e) => update('captainName', e.target.value)} placeholder="Nguyễn Văn A" maxLength={100} required disabled={closed} />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-300">Sinh viên năm thứ *</span>
                      <select className="hackathon-form-input" value={form.captainYear} onChange={(e) => update('captainYear', e.target.value)} required disabled={closed}>
                        <option value="">Chọn năm học</option>
                        {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>Năm {year}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-300">MSV *</span>
                      <input className="hackathon-form-input" value={form.captainStudentId} onChange={(e) => update('captainStudentId', e.target.value)} placeholder="123456789" maxLength={32} required disabled={closed} />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-300">Email *</span>
                      <div className="relative"><Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" /><input type="email" className="hackathon-form-input pl-9" value={form.captainEmail} onChange={(e) => update('captainEmail', e.target.value)} placeholder="captain@example.com" maxLength={320} required disabled={closed} /></div>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-300">Số điện thoại *</span>
                      <div className="relative"><Phone className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" /><input type="tel" className="hackathon-form-input pl-9" value={form.captainPhone} onChange={(e) => update('captainPhone', e.target.value)} placeholder="0912 345 678" maxLength={20} required disabled={closed} /></div>
                    </label>
                    <SkillCheckboxes legend={form.registrationType === 'team' ? 'Kỹ năng nâng cao của đội trưởng' : 'Kỹ năng nâng cao của bạn'} value={form.captainSkills} onChange={(value) => update('captainSkills', value)} disabled={closed} />

                    {form.registrationType === 'team' && (
                      <>
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-slate-300">Thành viên 2 *</span>
                          <input className="hackathon-form-input" value={form.member2} onChange={(e) => update('member2', e.target.value)} placeholder="Trần Thị B" maxLength={100} required disabled={closed} />
                        </label>
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-slate-300">Sinh viên năm thứ *</span>
                          <select className="hackathon-form-input" value={form.member2Year} onChange={(e) => update('member2Year', e.target.value)} required disabled={closed}>
                            <option value="">Chọn năm học</option>
                            {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>Năm {year}</option>)}
                          </select>
                        </label>
                        <SkillCheckboxes legend="Kỹ năng nâng cao của thành viên 2" value={form.member2Skills} onChange={(value) => update('member2Skills', value)} disabled={closed} />
                        {showMember3 ? (
                          <>
                            <label className="block">
                              <span className="mb-1.5 block text-xs font-medium text-slate-300">Thành viên 3 *</span>
                              <input className="hackathon-form-input" value={form.member3} onChange={(e) => update('member3', e.target.value)} placeholder="Lê Văn C" maxLength={100} required disabled={closed} />
                            </label>
                            <label className="block">
                              <span className="mb-1.5 block text-xs font-medium text-slate-300">Sinh viên năm thứ *</span>
                              <select className="hackathon-form-input" value={form.member3Year} onChange={(e) => update('member3Year', e.target.value)} required disabled={closed}>
                                <option value="">Chọn năm học</option>
                                {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>Năm {year}</option>)}
                              </select>
                            </label>
                            <SkillCheckboxes legend="Kỹ năng nâng cao của thành viên 3" value={form.member3Skills} onChange={(value) => update('member3Skills', value)} disabled={closed} />
                          </>
                        ) : (
                          <button type="button" onClick={() => setShowMember3(true)} disabled={closed} className="self-end rounded-2xl border border-dashed border-cyan-300/30 px-4 py-2.5 text-sm font-medium text-cyan-200 hover:bg-cyan-300/5 disabled:opacity-50">
                            + Thêm thành viên thứ 3
                          </button>
                        )}
                      </>
                    )}
                    <label className="block sm:col-span-2">
                      <span className="mb-1.5 block text-xs font-medium text-slate-300">Ý tưởng sản phẩm (không bắt buộc)</span>
                      <textarea className="hackathon-form-input min-h-[110px] resize-y" value={form.projectIdea} onChange={(e) => update('projectIdea', e.target.value)} placeholder={form.registrationType === 'team' ? 'Đội dự định xây dựng gì với SynapseOne?' : 'Bạn muốn xây dựng gì hoặc có kinh nghiệm gì nổi bật?'} maxLength={2000} disabled={closed} />
                    </label>
                  </div>

                  <div className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
                    <label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => update('website', e.target.value)} /></label>
                  </div>

                  <label className="mt-5 flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-slate-400">
                    <input type="checkbox" checked={form.acceptedRules} onChange={(e) => update('acceptedRules', e.target.checked)} className="mt-0.5 h-4 w-4 accent-cyan-400" required disabled={closed} />
                    <span>Tôi xác nhận thông tin chính xác, đồng ý với <a href="#the-le" className="font-semibold text-cyan-200 underline underline-offset-2">thể lệ VIC Hackathon #1</a>{form.registrationType === 'individual' ? ' và để BTC hỗ trợ sắp xếp team' : ''}.</span>
                  </label>

                  <button type="submit" disabled={busy || closed} className="hackathon-primary-btn mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl px-6 py-3.5 text-sm font-bold text-white">
                    {busy ? 'Đang gửi đơn…' : closed ? 'Đã đóng đăng ký' : 'Gửi đơn đăng ký'}
                    {!busy && !closed && <Send className="h-4 w-4" />}
                  </button>
                  <p className="mt-3 text-center text-[11px] leading-relaxed text-slate-500">Thông tin chỉ được ban tổ chức sử dụng để liên hệ và tổ chức sự kiện.</p>
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
