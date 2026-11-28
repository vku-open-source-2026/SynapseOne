// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatformAuth } from '../../lib/platform-auth.jsx';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../../components/ui.jsx';
import AdminHackathonRegistrationEditor from './AdminHackathonRegistrationEditor.jsx';

const PAGE = 25;
const STATUS_LABELS = { pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối' };
const SKILL_LABELS = {
  'competitive-programming': 'Lập trình thi đấu',
  'practical-experience': 'Kinh nghiệm thực chiến',
  'product-experience': 'Đã từng làm product',
};

function formatDate(value) {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '–' : new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export default function AdminHackathon() {
  const platform = usePlatformAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ items: [], total: 0, counts: {} });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [detail, setDetail] = useState(null);
  const [editor, setEditor] = useState(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorErr, setEditorErr] = useState(null);
  const [action, setAction] = useState(null);
  const [code, setCode] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsErr, setSuggestionsErr] = useState(null);
  const seqRef = useRef(0);
  const editorSeqRef = useRef(0);
  const canReview = platform.role === 'operator' || platform.role === 'owner';

  const load = useCallback(async (nextOffset = offset) => {
    const seq = ++seqRef.current;
    setErr(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      if (query) params.set('q', query);
      if (status) params.set('status', status);
      const out = await platform.request(`/v1/platform/hackathon/registrations?${params}`);
      if (seq !== seqRef.current) return;
      setData({ items: Array.isArray(out.items) ? out.items : [], total: Number(out.total) || 0, counts: out.counts || {} });
    } catch (e) {
      if (seq === seqRef.current) setErr(e);
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [platform, query, status, offset]);

  useEffect(() => { load(); }, [load]);

  const search = (event) => {
    event.preventDefault();
    setOffset(0);
    setQuery(q.trim());
    if (q.trim() === query && offset === 0) load(0);
  };

  const loadSuggestions = async () => {
    setSuggestionsLoading(true);
    setSuggestionsErr(null);
    try {
      const out = await platform.request('/v1/platform/hackathon/match-suggestions');
      setSuggestions(out);
      setSuggestionsOpen(true);
    } catch (e) {
      setSuggestionsErr(e);
      setSuggestionsOpen(true);
    } finally {
      setSuggestionsLoading(false);
    }
  };

  const openEditor = async (registration) => {
    const seq = ++editorSeqRef.current;
    setDetail(null);
    setEditor(registration);
    setEditorLoading(true);
    setEditorErr(null);
    try {
      const out = await platform.request(`/v1/platform/hackathon/registrations/${registration.id}`);
      if (seq !== editorSeqRef.current) return;
      setEditor(out.registration);
    } catch (e) {
      if (seq !== editorSeqRef.current) return;
      setEditor(null);
      setEditorErr(e);
    } finally {
      if (seq === editorSeqRef.current) setEditorLoading(false);
    }
  };

  const closeEditor = () => {
    editorSeqRef.current++;
    setEditor(null);
    setEditorLoading(false);
  };

  const saveEditor = async (registration) => {
    editorSeqRef.current++;
    setEditor(null);
    setEditorLoading(false);
    setDetail(registration);
    await load();
  };

  const openAction = (registration, type) => {
    setAction({ registration, type });
    setCode('');
    setReviewNote(registration.reviewNote || '');
    setActionErr(null);
  };

  const performAction = async (event) => {
    event.preventDefault();
    if (!action || busy) return;
    setBusy(true);
    setActionErr(null);
    try {
      const actionName = action.type === 'sent' ? 'hackathon:api-key-sent' : 'hackathon:review';
      const step = platform.stepUpRequired ? await platform.stepUp(code.trim(), actionName) : null;
      if (action.type === 'sent') {
        await platform.request(`/v1/platform/hackathon/registrations/${action.registration.id}/api-key-sent`, {
          method: 'POST', body: {}, stepUpToken: step?.token,
        });
      } else {
        await platform.request(`/v1/platform/hackathon/registrations/${action.registration.id}`, {
          method: 'PATCH',
          body: { status: action.type === 'approve' ? 'approved' : 'rejected', reviewNote: reviewNote.trim() || undefined },
          stepUpToken: step?.token,
        });
      }
      setAction(null);
      setDetail(null);
      if (offset === 0) await load(0);
      else await load();
    } catch (e) {
      setActionErr(e);
    } finally {
      setBusy(false);
    }
  };

  const pages = Math.max(1, Math.ceil(data.total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <>
      <PageTitle
        title="VIC Hackathon #1"
        sub="Đơn đăng ký team/cá nhân, gợi ý ghép đội và trạng thái gửi API key"
        right={<><Btn kind="secondary" onClick={loadSuggestions} loading={suggestionsLoading}>Gợi ý ghép team</Btn><Btn kind="secondary" onClick={() => load()} loading={loading}>Làm mới</Btn></>}
      />
      {!canReview && <div className="mb-4 rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700">Tài khoản auditor chỉ có thể xem đơn. Cần operator hoặc owner để sửa thông tin, duyệt và cập nhật API key.</div>}
      <div className="mb-4 grid gap-3 sm:grid-cols-5">
        {[
          ['Chờ duyệt', data.counts.pending || 0],
          ['Đã duyệt', data.counts.approved || 0],
          ['Đăng ký solo', data.counts.individuals || 0],
          ['Đã gửi API key', data.counts.apiKeySent || 0],
          ['Từ chối', data.counts.rejected || 0],
        ].map(([label, value]) => (
          <Card key={label} className="!p-4"><div className="text-xs text-normal-text">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div></Card>
        ))}
      </div>
      <Err e={err} />
      <Err e={editorErr} />
      <Card className="mb-4">
        <form onSubmit={search} className="flex flex-wrap items-end gap-2">
          <Field label="Tìm tên đội, đội trưởng, email hoặc MSV">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Synapse Builders" />
          </Field>
          <Field label="Trạng thái">
            <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm text-main-text outline-none focus:border-main-blue">
              <option value="">Tất cả</option>
              <option value="pending">Chờ duyệt</option>
              <option value="approved">Đã duyệt</option>
              <option value="rejected">Từ chối</option>
            </select>
          </Field>
          <Btn type="submit" kind="secondary" className="mb-3" loading={loading}>Tìm kiếm</Btn>
          <Btn type="button" kind="secondary" className="mb-3" onClick={() => { setQ(''); setQuery(''); setStatus(''); setOffset(0); }}>Xóa lọc</Btn>
        </form>
      </Card>
      <Card>
        {!loaded ? <TableSkeleton rows={6} cols={7} /> : data.items.length ? (
          <Table head={['Đội', 'Đội trưởng', 'Liên hệ', 'Thành viên', 'Trạng thái', 'API key', 'Ngày gửi']}>
            {data.items.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 align-top">
                <td className="py-3 pr-4">
                  <button type="button" disabled={editorLoading} onClick={() => { editorSeqRef.current++; setDetail(row); }} className="text-left font-semibold text-main-blue hover:underline disabled:opacity-50">{row.registrationType === 'individual' ? `Cá nhân: ${row.captainName}` : row.teamName}</button>
                  <p className="max-w-[220px] truncate text-xs text-normal-text">{row.registrationType === 'individual' ? `Năm ${row.memberYears?.[0] || '–'} · ${(row.memberSkills?.[0] || []).map((skill) => SKILL_LABELS[skill] || skill).join(', ') || 'Chưa có kỹ năng nâng cao'}` : (row.projectIdea || 'Chưa có ý tưởng')}</p>
                </td>
                <td className="py-3 pr-4"><div>{row.captainName}</div><div className="font-mono text-xs text-normal-text">{row.captainStudentId}</div></td>
                <td className="py-3 pr-4 text-xs"><a className="block text-main-blue hover:underline" href={`mailto:${row.captainEmail}`}>{row.captainEmail}</a><span className="block text-normal-text">{row.captainPhone}</span></td>
                <td className="py-3 pr-4 text-xs">{(row.memberNames || []).length} người</td>
                <td className="py-3 pr-4"><Badge tone={row.status === 'approved' ? 'green' : row.status === 'rejected' ? 'red' : 'amber'}>{STATUS_LABELS[row.status] || row.status}</Badge></td>
                <td className="py-3 pr-4 text-xs">{row.apiKeySentAt ? <span className="text-emerald-600">Đã gửi</span> : <span className="text-normal-text">Chưa gửi</span>}</td>
                <td className="py-3 pr-4 whitespace-nowrap text-xs text-normal-text">{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </Table>
        ) : <Empty text="Chưa có đơn đăng ký phù hợp" />}
        {data.total > PAGE && (
          <div className="mt-4 flex items-center justify-between text-xs text-normal-text">
            <span>{data.total} đơn đăng ký</span>
            <div className="flex items-center gap-2">
              <Btn kind="secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Trước</Btn>
              <span className="px-2 py-2">{page} / {pages}</span>
              <Btn kind="secondary" disabled={offset + PAGE >= data.total || loading} onClick={() => setOffset(offset + PAGE)}>Sau</Btn>
            </div>
          </div>
        )}
      </Card>

      {detail && (
        <Modal title={detail.registrationType === 'individual' ? `Cá nhân: ${detail.captainName}` : detail.teamName} onClose={() => setDetail(null)}>
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2"><Badge tone={detail.status === 'approved' ? 'green' : detail.status === 'rejected' ? 'red' : 'amber'}>{STATUS_LABELS[detail.status] || detail.status}</Badge>{detail.apiKeySentAt && <Badge tone="green">Đã gửi API key</Badge>}</div>
            <div className="rounded-2xl bg-background p-4">
              <div className="font-semibold">Đội trưởng</div>
              <div>{detail.captainName} · MSV {detail.captainStudentId}</div>
              <div className="mt-1"><a className="text-main-blue hover:underline" href={`mailto:${detail.captainEmail}`}>{detail.captainEmail}</a> · {detail.captainPhone}</div>
            </div>
            <div>
              <div className="font-semibold">Thành viên</div>
              <ul className="mt-1 list-disc pl-5 text-normal-text">{(detail.memberNames || []).map((name, index) => <li key={`${name}-${index}`}>{name}{index === 0 ? (detail.registrationType === 'individual' ? '' : ' (đội trưởng)') : ''} · Năm {detail.memberYears?.[index] || '–'}{(detail.memberSkills?.[index]?.length ? ` · ${detail.memberSkills[index].map((skill) => SKILL_LABELS[skill] || skill).join(', ')}` : '')}</li>)}</ul>
            </div>
            <div><div className="font-semibold">Ý tưởng sản phẩm</div><p className="mt-1 whitespace-pre-wrap text-normal-text">{detail.projectIdea || 'Chưa cung cấp.'}</p></div>
            {detail.reviewNote && <div><div className="font-semibold">Ghi chú duyệt</div><p className="mt-1 whitespace-pre-wrap text-normal-text">{detail.reviewNote}</p></div>}
            <div className="text-xs text-normal-text">Gửi lúc {formatDate(detail.createdAt)}{detail.reviewedAt ? ` · Duyệt lúc ${formatDate(detail.reviewedAt)}` : ''}{detail.apiKeySentAt ? ` · API key gửi lúc ${formatDate(detail.apiKeySentAt)}` : ''}</div>
            {canReview && (
              <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                <Btn kind="secondary" onClick={() => openEditor(detail)}>Sửa thông tin</Btn>
                {detail.status !== 'approved' && <Btn kind="success" onClick={() => openAction(detail, 'approve')}>Duyệt đơn</Btn>}
                {detail.status !== 'rejected' && <Btn kind="danger" onClick={() => openAction(detail, 'reject')}>Từ chối</Btn>}
                {detail.status === 'approved' && !detail.apiKeySentAt && <Btn onClick={() => openAction(detail, 'sent')}>Đánh dấu đã gửi API key</Btn>}
                <a href={`mailto:${detail.captainEmail}?subject=${encodeURIComponent('VIC Hackathon #1 — SynapseOne API key')}`} className="inline-flex items-center rounded-2xl bg-slate-100 px-4 py-2 text-sm font-medium text-main-text hover:bg-slate-200">Soạn email</a>
              </div>
            )}
          </div>
        </Modal>
      )}

      {editor && !editorLoading && (
        <AdminHackathonRegistrationEditor
          platform={platform}
          registration={editor}
          onClose={closeEditor}
          onSaved={saveEditor}
        />
      )}

      {suggestionsOpen && (
        <Modal title="Gợi ý ghép team cho thí sinh chưa có đội" onClose={() => setSuggestionsOpen(false)}>
          <Err e={suggestionsErr} />
          {suggestions && (
            <div className="space-y-4 text-sm">
              <div className="rounded-2xl bg-background p-4 text-normal-text">
                {suggestions.summary?.individuals || 0} thí sinh cá nhân · {suggestions.summary?.suggestedTeams || 0} team gợi ý · {suggestions.summary?.unmatched || 0} chưa xếp được
              </div>
              {(suggestions.suggestions || []).map((team) => (
                <div key={team.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="font-semibold text-main-text">{team.pattern}</div>
                  <ul className="mt-2 space-y-1 text-normal-text">
                    {team.members.map((member) => <li key={member.id}>{member.name} · Năm {member.year || '–'}{member.skills?.length ? ` · ${member.skills.map((skill) => SKILL_LABELS[skill] || skill).join(', ')}` : ''}</li>)}
                  </ul>
                </div>
              ))}
              {!suggestions.suggestions?.length && <Empty text="Chưa đủ thí sinh để tạo team 3 người theo tiêu chí anchor năm 2/kỹ năng." />}
              {!!suggestions.unmatched?.length && (
                <div>
                  <div className="font-semibold">Chưa có gợi ý phù hợp</div>
                  <p className="mt-1 text-normal-text">{suggestions.unmatched.map((row) => `${row.captainName} (năm ${row.memberYears?.[0] || '–'})`).join(', ')}</p>
                </div>
              )}
              <p className="text-xs text-normal-text">Đây chỉ là gợi ý không thay đổi dữ liệu. Admin cần liên hệ và cập nhật team sau khi thống nhất.</p>
            </div>
          )}
        </Modal>
      )}

      {action && (
        <Modal title={action.type === 'approve' ? 'Duyệt đơn đăng ký' : action.type === 'reject' ? 'Từ chối đơn đăng ký' : 'Xác nhận đã gửi API key'} onClose={() => !busy && setAction(null)}>
          <form onSubmit={performAction}>
            <p className="mb-4 text-sm text-normal-text"><strong className="text-main-text">{action.registration.registrationType === 'individual' ? `Cá nhân: ${action.registration.captainName}` : action.registration.teamName}</strong> · {action.registration.captainEmail}</p>
            {action.type !== 'sent' && <Field label="Ghi chú (không bắt buộc)"><textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} maxLength={1000} className="w-full min-h-[90px] px-3 py-2 rounded-2xl border border-slate-200 text-sm outline-none focus:border-main-blue" /></Field>}
            {platform.stepUpRequired && <Field label="Mã authenticator để xác nhận"><Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456" required autoFocus /></Field>}
            <Err e={actionErr} />
            <div className="mt-4 flex justify-end gap-2"><Btn kind="secondary" type="button" onClick={() => setAction(null)} disabled={busy}>Hủy</Btn><Btn type="submit" kind={action.type === 'reject' ? 'danger' : 'success'} loading={busy}>Xác nhận</Btn></div>
          </form>
        </Modal>
      )}
    </>
  );
}
