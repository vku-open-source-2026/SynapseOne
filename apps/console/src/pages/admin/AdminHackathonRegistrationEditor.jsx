// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Btn, Err, Field, Input, Modal } from '../../components/ui.jsx';
import {
  blankHackathonMember,
  editFormToPayload,
  registrationToEditForm,
  validateHackathonEditForm,
} from '../../lib/hackathon-registration.js';

const FIELD_CLASS = 'w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm text-main-text outline-none focus:border-main-blue';
const SKILL_OPTIONS = [
  { value: 'competitive-programming', label: 'Lập trình thi đấu' },
  { value: 'practical-experience', label: 'Kinh nghiệm thực chiến' },
  { value: 'product-experience', label: 'Đã từng làm product' },
];

function SkillCheckboxes({ value, onChange, legend }) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 block text-xs font-medium text-normal-text">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {SKILL_OPTIONS.map((skill) => {
          const checked = value.includes(skill.value);
          return (
            <label key={skill.value} className={`cursor-pointer rounded-full border px-3 py-1.5 text-[11px] font-medium ${checked ? 'border-main-blue bg-blue-50 text-main-blue' : 'border-slate-200 text-normal-text'}`}>
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
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

export default function AdminHackathonRegistrationEditor({ platform, registration, onClose, onSaved }) {
  const [form, setForm] = useState(() => registrationToEditForm(registration));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const title = registration.registrationType === 'individual' ? `Cá nhân: ${registration.captainName}` : registration.teamName;

  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErr(null);
  };
  const updateMember = (index, key, value) => {
    setForm((current) => ({
      ...current,
      members: current.members.map((member, memberIndex) => memberIndex === index ? { ...member, [key]: value } : member),
    }));
    setErr(null);
  };
  const changeType = (registrationType) => {
    setForm((current) => ({
      ...current,
      registrationType,
      teamName: registrationType === 'team' ? current.teamName : '',
      members: registrationType === 'team'
        ? (current.members.length ? current.members : [blankHackathonMember()])
        : [],
    }));
    setErr(null);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const validationError = validateHackathonEditForm(form);
    if (validationError) {
      setErr(new Error(validationError));
      return;
    }
    if (platform.stepUpRequired && !code.trim()) {
      setErr(new Error('Vui lòng nhập mã authenticator để xác nhận.'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const step = platform.stepUpRequired ? await platform.stepUp(code.trim(), 'hackathon:update') : null;
      const out = await platform.request(`/v1/platform/hackathon/registrations/${registration.id}`, {
        method: 'PUT',
        body: editFormToPayload(form),
        stepUpToken: step?.token,
      });
      await onSaved(out.registration);
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };

  const emailChanged = form.captainEmail.trim().toLowerCase() !== String(registration.captainEmail || '').toLowerCase();

  return (
    <Modal title={`Sửa thông tin — ${title}`} onClose={() => !busy && onClose()}>
      <form onSubmit={submit}>
        <p className="mb-4 text-sm text-normal-text">Chỉnh sửa thông tin đăng ký. Trạng thái duyệt, ghi chú và thời điểm gửi API key được giữ nguyên.</p>
        {registration.apiKeySentAt && emailChanged && (
          <div className="mb-4 rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
            Email đã được đánh dấu gửi API key. Nếu đổi email, hãy kiểm tra và gửi lại API key theo quy trình vận hành.
          </div>
        )}
        <Err e={err} />
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Field label="Loại đăng ký">
            <select className={FIELD_CLASS} value={form.registrationType} onChange={(event) => changeType(event.target.value)} disabled={busy}>
              <option value="team">Đội (2–3 người)</option>
              <option value="individual">Solo / cá nhân</option>
            </select>
          </Field>
          {form.registrationType === 'team' && (
            <Field label="Tên đội">
              <Input value={form.teamName} onChange={(event) => update('teamName', event.target.value)} maxLength={100} required disabled={busy} />
            </Field>
          )}
          <Field label="Tên đội trưởng/thí sinh">
            <Input value={form.captainName} onChange={(event) => update('captainName', event.target.value)} maxLength={100} required disabled={busy} />
          </Field>
          <Field label="Email liên hệ">
            <Input type="email" value={form.captainEmail} onChange={(event) => update('captainEmail', event.target.value)} maxLength={320} required disabled={busy} />
          </Field>
          <Field label="Số điện thoại">
            <Input value={form.captainPhone} onChange={(event) => update('captainPhone', event.target.value)} maxLength={20} required disabled={busy} />
          </Field>
          <Field label="Mã số sinh viên">
            <Input value={form.captainStudentId} onChange={(event) => update('captainStudentId', event.target.value)} maxLength={32} required disabled={busy} />
          </Field>
          <Field label="Năm học đội trưởng/thí sinh">
            <select className={FIELD_CLASS} value={form.captainYear} onChange={(event) => update('captainYear', event.target.value)} required disabled={busy}>
              <option value="">Chọn năm học</option>
              {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>Năm {year}</option>)}
            </select>
          </Field>
        </div>
        <SkillCheckboxes value={form.captainSkills} onChange={(value) => update('captainSkills', value)} legend="Kỹ năng nâng cao đội trưởng/thí sinh" />

        {form.registrationType === 'team' && (
          <div className="mb-3">
            <div className="mb-2 text-xs font-semibold text-main-text">Thành viên còn lại</div>
            <div className="space-y-3">
              {form.members.map((member, index) => (
                <div key={index} className="rounded-2xl border border-slate-200 p-3">
                  <div className="grid gap-x-3 sm:grid-cols-[1fr_140px]">
                    <Field label={`Thành viên ${index + 2}`}>
                      <Input value={member.name} onChange={(event) => updateMember(index, 'name', event.target.value)} maxLength={100} required disabled={busy} />
                    </Field>
                    <Field label="Năm học">
                      <select className={FIELD_CLASS} value={member.year} onChange={(event) => updateMember(index, 'year', event.target.value)} required disabled={busy}>
                        <option value="">Chọn</option>
                        {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>Năm {year}</option>)}
                      </select>
                    </Field>
                  </div>
                  <SkillCheckboxes value={member.skills} onChange={(value) => updateMember(index, 'skills', value)} legend="Kỹ năng nâng cao" />
                  {form.members.length > 1 && (
                    <Btn kind="secondary" type="button" disabled={busy} onClick={() => update('members', form.members.filter((_, memberIndex) => memberIndex !== index))}>Xóa thành viên</Btn>
                  )}
                </div>
              ))}
            </div>
            {form.members.length < 2 && (
              <Btn kind="secondary" type="button" className="mt-2" disabled={busy} onClick={() => update('members', [...form.members, blankHackathonMember()])}>Thêm thành viên</Btn>
            )}
          </div>
        )}

        <Field label="Ý tưởng sản phẩm (không bắt buộc)">
          <textarea className={`${FIELD_CLASS} min-h-[100px] resize-y`} value={form.projectIdea} onChange={(event) => update('projectIdea', event.target.value)} maxLength={2000} disabled={busy} />
        </Field>
        {platform.stepUpRequired && (
          <Field label="Mã authenticator để xác nhận">
            <Input value={code} onChange={(event) => { setCode(event.target.value); setErr(null); }} autoComplete="one-time-code" placeholder="123456" required disabled={busy} />
          </Field>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Btn kind="secondary" type="button" onClick={onClose} disabled={busy}>Hủy</Btn>
          <Btn type="submit" loading={busy}>Lưu thay đổi</Btn>
        </div>
      </form>
    </Modal>
  );
}
