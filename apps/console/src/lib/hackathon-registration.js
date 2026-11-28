// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
export const HACKATHON_SKILL_VALUES = [
  'competitive-programming',
  'practical-experience',
  'product-experience',
];

export function blankHackathonMember() {
  return { name: '', year: '', skills: [] };
}

/** Convert the captain-first API row into the admin editor's form shape. */
export function registrationToEditForm(registration) {
  const names = Array.isArray(registration.memberNames) ? registration.memberNames : [];
  const years = Array.isArray(registration.memberYears) ? registration.memberYears : [];
  const skills = Array.isArray(registration.memberSkills) ? registration.memberSkills : [];
  return {
    registrationType: registration.registrationType === 'individual' ? 'individual' : 'team',
    teamName: registration.teamName || '',
    captainName: registration.captainName || '',
    captainEmail: registration.captainEmail || '',
    captainPhone: registration.captainPhone || '',
    captainStudentId: registration.captainStudentId || '',
    captainYear: years[0] == null ? '' : String(years[0]),
    captainSkills: Array.isArray(skills[0]) ? [...skills[0]] : [],
    members: names.slice(1).map((name, index) => ({
      name: name || '',
      year: years[index + 1] == null ? '' : String(years[index + 1]),
      skills: Array.isArray(skills[index + 1]) ? [...skills[index + 1]] : [],
    })),
    projectIdea: registration.projectIdea || '',
    expectedUpdatedAt: registration.updatedAt,
  };
}

/** Build the full PUT payload; the captain is first in years/skills but not in members. */
export function editFormToPayload(form) {
  const team = form.registrationType === 'team';
  const members = team ? form.members : [];
  return {
    registrationType: team ? 'team' : 'individual',
    teamName: team ? form.teamName.trim() : null,
    captainName: form.captainName.trim(),
    captainEmail: form.captainEmail.trim(),
    captainPhone: form.captainPhone.trim(),
    captainStudentId: form.captainStudentId.trim(),
    members: members.map((member) => member.name.trim()),
    memberYears: [Number(form.captainYear), ...members.map((member) => Number(member.year))],
    memberSkills: [form.captainSkills, ...members.map((member) => member.skills)],
    projectIdea: form.projectIdea.trim() || null,
    expectedUpdatedAt: form.expectedUpdatedAt,
  };
}

export function validateHackathonEditForm(form) {
  const team = form.registrationType === 'team';
  const members = team ? form.members : [];
  if (team && (form.teamName.trim().length < 2 || form.teamName.trim().length > 100)) {
    return 'Tên đội cần từ 2 đến 100 ký tự.';
  }
  if (form.captainName.trim().length < 2 || form.captainName.trim().length > 100) {
    return 'Tên đội trưởng/thí sinh cần từ 2 đến 100 ký tự.';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.captainEmail.trim()) || form.captainEmail.trim().length > 320) {
    return 'Email đội trưởng/thí sinh không hợp lệ.';
  }
  if (!/^[0-9+().\-\s]{8,20}$/.test(form.captainPhone.trim())) {
    return 'Số điện thoại không hợp lệ.';
  }
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(form.captainStudentId.trim())) {
    return 'Mã số sinh viên cần 3–32 ký tự, chỉ gồm chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.';
  }
  if (team && (members.length < 1 || members.length > 2)) {
    return 'Đội cần 1–2 thành viên còn lại ngoài đội trưởng.';
  }
  const years = [form.captainYear, ...members.map((member) => member.year)];
  if (years.some((year) => !Number.isInteger(Number(year)) || Number(year) < 1 || Number(year) > 5)) {
    return 'Vui lòng chọn năm học 1–5 cho từng thành viên.';
  }
  if (members.some((member) => member.name.trim().length < 2 || member.name.trim().length > 100)) {
    return 'Tên từng thành viên cần từ 2 đến 100 ký tự.';
  }
  const skillRows = [form.captainSkills, ...members.map((member) => member.skills)];
  if (skillRows.some((row) => !Array.isArray(row) || row.length > 3 || row.some((skill) => !HACKATHON_SKILL_VALUES.includes(skill)))) {
    return 'Danh sách kỹ năng không hợp lệ.';
  }
  if (form.projectIdea.length > 2000) return 'Ý tưởng sản phẩm tối đa 2.000 ký tự.';
  return null;
}
