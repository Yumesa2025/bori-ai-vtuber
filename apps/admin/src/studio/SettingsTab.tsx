import { useEffect, useRef, useState } from 'react';
import type { BroadcastState, CompanionStats, LlmProvider, LlmSettings, LlmStatus, MacroStatus, QueueSettings, UsageFeature, UsageMode, UsageReport, UsageRow, UsageTotals } from '@bori/shared';
import { boriExpressionLabels, boriExpressionNames, boriMotionGroupNames, boriMotionLabels } from '@bori/live2d';
import { buildPatch, clearSaved, memoryTextFor, pickDrafts, readError, savedSummary, shownChecked, shownText, type DraftValue, type Drafts, type FieldSpec } from '../form';
import { isSubmitEnter } from '../keys';
import { createPoller, SETTINGS_POLL_MS, STATUS_POLL_MS } from '../poll';
import { connectionBadge } from './operate';
import { getJson, isServerUp, JSON_HEADERS, MUTATION_TIMEOUT_MS, openChzzkLogin, postAction, readJson, request, type ChzzkStatusView, type ObsStatusView } from './api';

const initialState: BroadcastState = { status: 'idle', layout: 'chat', currentEmotion: 'calm', queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };
// 기억 공개 범위 표시 이름. 알 수 없는 값은 원문 그대로 보여 준다.
const memoryScopeLabels: Record<string, string> = { character: '캐릭터', broadcast: '방송', private: '1:1' };
// 감정·업체 표시 이름. 알 수 없는 값은 원문 그대로 보여 준다.
const emotionLabels: Record<string, string> = { calm: '평온', happy: '기쁨', excited: '신남', greeting: '인사', gaming: '게임', crying: '울음', angry: '화남', sad: '슬픔', embarrassed: '당황', awkward: '어색함', curious: '호기심' };
const providerLabels: Record<string, string> = { openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
const usageFeatureLabels: Record<UsageFeature, string> = { reply: '답변', summary: '요약', digest: '기억 정리', embedding: '임베딩', tts: '음성' };
const usageModeLabels: Record<UsageMode, string> = { broadcast: '방송', companion: '1:1', none: '공통' };
// 추정 비용 표시. 계산할 수 있는 것이 없으면 추정 불가, 일부만 계산했으면 +를 붙인다.
function formatCost(cost: number | null, complete: boolean): string {
  if (cost === null) return '추정 불가';
  const value = cost > 0 && cost < 0.0001 ? '<$0.0001' : `$${cost.toFixed(4)}`;
  return complete ? value : `${value}+`;
}
// 줄 단위 비용은 빠진 이유(단가 없음, 토큰 정보 없음)를 그대로 보여 준다.
function formatRowCost(row: UsageRow): string {
  if (row.estimatedCostUsd === null) return row.costNote ?? '추정 불가';
  return row.costNote ? `${formatCost(row.estimatedCostUsd, row.costComplete)} (${row.costNote})` : formatCost(row.estimatedCostUsd, row.costComplete);
}
const formatTokens = (totals: UsageTotals) => `${totals.inputTokens.toLocaleString()} / ${totals.outputTokens.toLocaleString()}`;

type LlmView = { settings: LlmSettings; status: LlmStatus; companionStatus?: LlmStatus; providers: LlmProvider[]; defaultModels: Record<string, string>; macro: MacroStatus; systemPromptChars: number };
type TtsView = { settings: { enabled: boolean; provider: string; model: string; voice: string; speed: number; stability: number; similarity: number }; voices: { id: string; name: string; description?: string }[]; providers: string[]; defaultModels: Record<string, string>; hasApiKey: boolean; hasElevenLabsKey: boolean; failureCount: number; lastError: string | null };
type MemorySettings = { enabled: boolean; maxMemories: number; minSimilarity: number; retentionDays: number };
type MemoryView = { settings: MemorySettings; count: number; records: { id: string; text: string; kind: string; scope: string; ownerId?: string; importance: number; repeatCount: number; createdAt: string }[] };

// 폼 칸 정의. 이름은 저장 실패·성공 문구에도 그대로 쓴다.
const queueFields: FieldSpec[] = [
  { key: 'responseDelayMinSeconds', label: '최소 대기(초)', kind: 'number' },
  { key: 'responseDelayMaxSeconds', label: '최대 대기(초)', kind: 'number' },
  { key: 'maxQueueSize', label: '최대 큐', kind: 'number' },
  { key: 'visibleChatLimit', label: '화면 채팅 수', kind: 'number' },
  { key: 'sameReplyCooldownMinutes', label: '같은 답변 금지(분)', kind: 'number' },
];
const monologueFields: FieldSpec[] = [
  { key: 'monologueEnabled', label: '혼잣말 사용', kind: 'boolean' },
  { key: 'monologueMinSeconds', label: '최소 간격(초)', kind: 'number' },
  { key: 'monologueMaxSeconds', label: '최대 간격(초)', kind: 'number' },
];
const llmFields = {
  model: { key: 'model', label: '모델', kind: 'text' },
  maxReplyLength: { key: 'maxReplyLength', label: '최대 답변 길이', kind: 'number' },
  timeoutMs: { key: 'timeoutMs', label: '응답 제한(ms)', kind: 'number' },
  rollingSummaryTurns: { key: 'rollingSummaryTurns', label: '요약 주기(턴)', kind: 'number' },
} satisfies Record<string, FieldSpec>;
const ttsFields = {
  model: { key: 'model', label: '모델', kind: 'text' },
  speed: { key: 'speed', label: '속도', kind: 'number' },
  stability: { key: 'stability', label: '안정성', kind: 'number' },
  similarity: { key: 'similarity', label: '유사도', kind: 'number' },
} satisfies Record<string, FieldSpec>;
const memoryFields = {
  maxMemories: { key: 'maxMemories', label: '전달할 기억 수', kind: 'number' },
  minSimilarity: { key: 'minSimilarity', label: '최소 유사도', kind: 'number' },
  retentionDays: { key: 'retentionDays', label: '보관 기간(일)', kind: 'number' },
} satisfies Record<string, FieldSpec>;

type DraftGroup = { drafts: Drafts; set: (key: string, value: DraftValue) => void; clear: (saved: Drafts) => void };
/** 폼 묶음 하나의 편집 중 값. 서버 값과 따로 두어 폴링이 덮지 못하게 한다(form.ts). */
function useDrafts(): DraftGroup {
  const [drafts, setDrafts] = useState<Drafts>({});
  return {
    drafts,
    set: (key, value) => setDrafts(current => ({ ...current, [key]: value })),
    clear: saved => setDrafts(current => clearSaved(current, saved)),
  };
}

/** 스튜디오 설정 탭. 예전 관리자 화면을 그대로 옮기고 치지직·OBS 연결 칸을 더했다. */
export default function SettingsTab() {
  const [state, setState] = useState<BroadcastState>(initialState);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState<QueueSettings | null>(null);
  const [serverOnline, setServerOnline] = useState(true);
  const [llm, setLlm] = useState<LlmView | null>(null);
  // API 키는 서버가 돌려주지 않으므로 입력값만 화면에서 관리한다.
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [tts, setTts] = useState<TtsView | null>(null);
  const [elevenKeyInput, setElevenKeyInput] = useState('');
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [companionStats, setCompanionStats] = useState<CompanionStats | null>(null);
  const [memory, setMemory] = useState<MemoryView | null>(null);
  // 1:1 기억 원문은 방송 중 화면 공유로 새지 않게 기본으로 가린다.
  const [revealPrivate, setRevealPrivate] = useState(false);
  const [chzzk, setChzzk] = useState<ChzzkStatusView | null>(null);
  const [obs, setObs] = useState<ObsStatusView | null>(null);
  const queueDrafts = useDrafts();
  const llmDrafts = useDrafts();
  const ttsDrafts = useDrafts();
  const memoryDrafts = useDrafts();
  const pollers = useRef<{ status: ReturnType<typeof createPoller>; settings: ReturnType<typeof createPoller> } | null>(null);
  // 자주 바뀌는 숫자(방송 상태·대기 채팅·LLM 회로·1:1 통계·치지직·OBS 연결)만 짧은 간격으로 받는다.
  async function refreshStatus() {
    const [stateResponse, llmResponse, statsResponse, nextChzzk, nextObs] = await Promise.all([request('/api/state'), request('/api/llm'), request('/api/companion/stats'), getJson<ChzzkStatusView>('/api/chzzk/status'), getJson<ObsStatusView>('/api/obs/status')]);
    if (!isServerUp(stateResponse)) { setServerOnline(false); return; }
    setServerOnline(true);
    const nextState = stateResponse.ok ? await readJson<BroadcastState>(stateResponse) : null;
    if (nextState) setState(nextState);
    const nextLlm = llmResponse?.ok ? await readJson<LlmView>(llmResponse) : null;
    if (nextLlm) setLlm(nextLlm);
    const nextStats = statsResponse?.ok ? await readJson<CompanionStats>(statsResponse) : null;
    if (nextStats) setCompanionStats(nextStats);
    if (nextChzzk) setChzzk(nextChzzk);
    if (nextObs) setObs(nextObs);
  }
  // 설정·기억 목록·사용량·음성 설정은 드물게 받는다. 이 화면에서 저장하면 저장 응답으로 바로 맞춘다.
  async function refreshSettings() {
    const [settingsResponse, memoryResponse, usageResponse, ttsResponse] = await Promise.all([request('/api/settings'), request('/api/memory'), request('/api/usage'), request('/api/tts', undefined, MUTATION_TIMEOUT_MS)]);
    const nextSettings = settingsResponse?.ok ? await readJson<QueueSettings>(settingsResponse) : null;
    if (nextSettings) setSettings(nextSettings);
    const nextMemory = memoryResponse?.ok ? await readJson<MemoryView>(memoryResponse) : null;
    if (nextMemory) setMemory(nextMemory);
    const nextUsage = usageResponse?.ok ? await readJson<UsageReport>(usageResponse) : null;
    if (nextUsage) setUsage(nextUsage);
    const nextTts = ttsResponse?.ok ? await readJson<TtsView>(ttsResponse) : null;
    if (nextTts) setTts(nextTts);
  }
  /** PATCH를 보내고, 실패하면 서버가 준 이유를 그대로 안내한다. 성공한 응답만 돌려준다. */
  async function sendPatch(path: string, body: unknown, failPrefix: string): Promise<Response | null> {
    const response = await request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, MUTATION_TIMEOUT_MS);
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 저장하지 못했습니다.'); return null; }
    if (!response.ok) { setNotice(`${failPrefix} ${await readError(response, '서버가 값을 받지 않았습니다.')}`); return null; }
    return response;
  }
  /**
   * 고친 칸만 저장한다. 성공하면 그 칸의 draft를 지우고 서버가 실제로 저장한 값으로 안내한다.
   * 실패하면 draft를 남겨 입력한 값이 그대로 보인다(폴링이 되돌리지 않는다).
   * quiet면 바뀐 칸이 없을 때 아무 말도 하지 않는다(칸에서 포커스만 빠진 경우).
   */
  async function saveDrafts<T>(group: DraftGroup, fields: readonly FieldSpec[], path: string, name: string, apply: (body: T) => Readonly<Record<string, unknown>>, quiet = false) {
    const built = buildPatch(group.drafts, fields);
    if (!built.ok) { setNotice(built.error); return; }
    if (built.keys.length === 0) { if (!quiet) setNotice('바뀐 값이 없습니다.'); return; }
    const sent = pickDrafts(group.drafts, built.keys);
    const response = await sendPatch(path, built.patch, `${name} 저장하지 못했습니다.`);
    if (!response) return;
    const body = await readJson<T>(response);
    group.clear(sent);
    if (!body) { setNotice(`${name} 저장했습니다.`); pollers.current?.settings.runNow(); return; }
    setNotice(savedSummary(`${name} 저장했습니다.`, fields, built.keys, apply(body)));
  }
  const applyLlm = (body: LlmView) => { setLlm(body); return body.settings; };
  const applyTts = (body: TtsView) => { setTts(body); return body.settings; };
  // 기억 설정 PATCH는 목록 없이 설정과 개수만 돌려준다.
  const applyMemory = (body: { settings: MemorySettings; count: number }) => { setMemory(current => current && { ...current, settings: body.settings, count: body.count }); return body.settings; };
  const saveLlmField = (field: FieldSpec) => void saveDrafts(llmDrafts, [field], '/api/llm', 'LLM 설정을', applyLlm, true);
  const saveTtsField = (field: FieldSpec) => void saveDrafts(ttsDrafts, [field], '/api/tts', '음성 설정을', applyTts, true);
  const saveMemoryField = (field: FieldSpec) => void saveDrafts(memoryDrafts, [field], '/api/memory', '기억 설정을', applyMemory, true);
  async function saveTts(patch: Record<string, unknown>) {
    const response = await sendPatch('/api/tts', patch, '음성 설정을 저장하지 못했습니다.');
    if (!response) return;
    const body = await readJson<TtsView>(response);
    if (body) setTts(body);
    if (patch.elevenLabsApiKey !== undefined) setElevenKeyInput('');
    setNotice(patch.elevenLabsApiKey === '' ? '저장한 ElevenLabs 키를 지웠습니다.' : '음성 설정을 저장했습니다.');
  }
  async function saveMemory(patch: Record<string, unknown>) {
    const response = await sendPatch('/api/memory', patch, '기억 설정을 저장하지 못했습니다.');
    if (!response) return;
    const body = await readJson<{ settings: MemorySettings; count: number }>(response);
    if (body) applyMemory(body);
    setNotice('기억 설정을 저장했습니다.');
  }
  async function deleteMemory(id: string) {
    const response = await request(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }, MUTATION_TIMEOUT_MS);
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 지우지 못했습니다.'); return; }
    // 없는 기억은 404다. 지운 것처럼 안내하지 않고 목록을 서버와 맞춘다.
    if (response.status === 404) setNotice('기억을 찾을 수 없습니다. 이미 지워졌을 수 있습니다.');
    else if (!response.ok) setNotice(`기억을 지우지 못했습니다. ${await readError(response, '서버가 요청을 거부했습니다.')}`);
    else setNotice(id === 'all' ? '기억을 모두 지웠습니다.' : '기억을 지웠습니다.');
    pollers.current?.settings.runNow();
  }
  async function saveLlm(patch: Partial<LlmSettings> & { apiKey?: string }) {
    const response = await sendPatch('/api/llm', patch, 'LLM 설정을 저장하지 못했습니다.');
    if (!response) return;
    const body = await readJson<LlmView>(response);
    if (body) setLlm(body);
    if (patch.apiKey !== undefined) setApiKeyInput('');
    setNotice(patch.apiKey === undefined ? 'LLM 설정을 저장했습니다.' : patch.apiKey ? 'API 키를 저장했습니다.' : '저장한 API 키를 지웠습니다.');
  }
  async function reloadMacros() {
    const response = await request('/api/macros/reload', { method: 'POST' }, MUTATION_TIMEOUT_MS);
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; }
    const result = await readJson<MacroStatus>(response);
    if (!result) setNotice('매크로를 다시 읽었지만 결과를 확인하지 못했습니다.');
    else setNotice(response.ok ? `매크로 ${result.loaded}건을 다시 읽었습니다.` : `매크로 파일을 읽지 못했습니다: ${result.error ?? '알 수 없는 오류'}`);
    pollers.current?.status.runNow();
  }
  async function connectChzzk() { setNotice((await openChzzkLogin()) ?? '기본 브라우저에서 치지직 로그인을 마친 뒤 이 창으로 돌아오세요.'); }
  async function disconnectChzzk() {
    const response = await postAction('/api/chzzk/disconnect');
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; }
    setNotice(response.ok ? '치지직 채팅 연결을 끊었습니다. 저장한 로그인은 남아 있어 서버를 다시 켜면 다시 연결됩니다.' : `치지직 연결을 해제하지 못했습니다. ${await readError(response, '')}`.trim());
    pollers.current?.status.runNow();
  }
  async function sessionAction(action: 'start' | 'end') { const response = await request(`/api/session/${action}`, { method: 'POST' }, MUTATION_TIMEOUT_MS); if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; } if (!response.ok) { setNotice(`요청이 거부되었습니다. ${await readError(response, '')}`.trim()); return; } const next = await readJson<BroadcastState>(response); if (next) setState(next); setNotice(action === 'start' ? '방송 세션을 시작했습니다.' : '방송 세션을 종료했습니다.'); }
  async function submitTestChat() { if (!message.trim() || state.status !== 'live') { setNotice('먼저 방송을 시작해 주세요.'); return; } const response = await request('/api/chat', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ content: message }) }, MUTATION_TIMEOUT_MS); if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; } if (!response.ok) { setNotice(`채팅을 넣지 못했습니다. ${await readError(response, '이미 들어온 채팅이거나 처리할 수 없는 채팅입니다.')}`); return; } const next = await readJson<BroadcastState>(response); if (next) setState(next); setMessage(''); setNotice('채팅을 후보 큐에 넣었습니다.'); }
  async function runTestAction(kind: 'expression' | 'motion', name: string) { const response = await request('/api/live2d/test', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ kind, name }) }, MUTATION_TIMEOUT_MS); if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; } if (response.ok) { const next = await readJson<BroadcastState>(response); if (next) setState(next); setNotice(`${kind === 'expression' ? '표정' : '모션'} ${kind === 'expression' ? boriExpressionLabels[name as keyof typeof boriExpressionLabels] : boriMotionLabels[name as keyof typeof boriMotionLabels]} 실행`); } else setNotice(await readError(response, '등록되지 않은 표정·모션입니다.')); }
  // 폴링은 앞 요청이 끝난 뒤에 다음 요청을 예약해 겹치지 않는다(poll.ts).
  useEffect(() => {
    const status = createPoller(refreshStatus, STATUS_POLL_MS);
    const slow = createPoller(refreshSettings, SETTINGS_POLL_MS);
    pollers.current = { status, settings: slow };
    return () => { status.stop(); slow.stop(); pollers.current = null; };
  }, []);
  const monologueOn = settings ? shownChecked(queueDrafts.drafts, 'monologueEnabled', settings.monologueEnabled) : false;
  const companion = llm?.companionStatus;
  const privateCount = memory?.records.filter(record => record.scope === 'private').length ?? 0;
  // 숫자·글자 입력칸. 고친 값은 draft로만 들고 있고, 서버 값은 고치지 않은 칸에만 보인다.
  const numberInput = (group: DraftGroup, field: FieldSpec, serverValue: number, props: { min?: string; max?: string; step?: string; disabled?: boolean; onBlur?: () => void } = {}) =>
    <input type="number" {...props} value={shownText(group.drafts, field.key, serverValue)} onChange={event => group.set(field.key, event.target.value)} />;
  return <main className="admin-shell">
    <header className="admin-header"><div><p className="eyebrow">BORI AI VTUBER</p><h1>설정</h1></div><span className={`status status-${serverOnline ? state.status : 'offline'}`}>{!serverOnline ? '서버 끊김' : state.status === 'live' ? '방송 중' : '대기 중'}</span></header>
    {!serverOnline && <div className="server-alert"><strong>API 서버에 연결할 수 없습니다.</strong> 방송 시작을 포함한 모든 조작이 동작하지 않습니다. 스튜디오가 띄운 서버가 꺼졌다면 스튜디오를 다시 실행하세요. 서버 로그는 데이터 폴더의 <code>studio-server.log</code>에 있습니다.</div>}
    <section className="control-grid">
      <article className="panel"><h2>방송 세션</h2><p>관리자가 시작한 동안에만 보리가 채팅 후보를 처리합니다.</p><div className="button-row"><button className="primary" onClick={() => void sessionAction('start')} disabled={!serverOnline || state.status === 'live'}>방송 시작</button><button onClick={() => void sessionAction('end')} disabled={!serverOnline || state.status !== 'live'}>방송 종료</button></div>{serverOnline && state.status === 'live' && <div className="notice">이미 방송 중이라 시작 버튼이 꺼져 있습니다. 다시 시작하려면 먼저 종료하세요.</div>}{notice && <div className="notice" role="status">{notice}</div>}</article>
      <article className="panel"><h2>현재 상태</h2><div className="metrics"><div><strong>{state.queueSize}</strong><span>대기 채팅</span></div><div><strong>{state.visibleChatCount}</strong><span>화면 채팅</span></div><div><strong>{emotionLabels[state.currentEmotion] ?? state.currentEmotion}</strong><span>감정 상태</span></div></div>{state.lastError && <div className="notice">방송 마지막 오류: {state.lastError}</div>}</article>
    </section>
    <section className="panel"><h2>가상 채팅 테스트</h2><p>닉네임 없이 익명 채팅으로 후보 큐에 넣어 흐름을 확인합니다.</p><div className="chat-input-row"><input value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (isSubmitEnter(event)) void submitTestChat(); }} placeholder="테스트 채팅을 입력하세요" aria-label="테스트 채팅" /><button onClick={() => void submitTestChat()}>입력</button></div></section>
    {settings && <section className="panel"><h2>채팅 큐 설정</h2><div className="settings-grid">{queueFields.map(field => <label key={field.key}>{field.label}{numberInput(queueDrafts, field, settings[field.key as keyof QueueSettings] as number, { min: field.key === 'responseDelayMinSeconds' || field.key === 'sameReplyCooldownMinutes' ? '0' : '1' })}</label>)}</div><button className="primary" onClick={() => void saveDrafts(queueDrafts, queueFields, '/api/settings', '채팅 큐 설정을', (body: QueueSettings) => { setSettings(body); return body; })}>설정 저장</button></section>}
    {settings && <section className="panel"><h2>혼잣말</h2><p>채팅이 없을 때만 실행됩니다. 대기 중에 채팅이 들어오면 혼잣말을 건너뛰고 채팅에 먼저 반응합니다.</p><label className="toggle-row"><input type="checkbox" checked={monologueOn} onChange={event => queueDrafts.set('monologueEnabled', event.target.checked)} /><span>혼잣말 사용</span></label><div className="settings-grid"><label>최소 간격(초){numberInput(queueDrafts, monologueFields[1], settings.monologueMinSeconds, { min: '5', disabled: !monologueOn })}</label><label>최대 간격(초){numberInput(queueDrafts, monologueFields[2], settings.monologueMaxSeconds, { min: '5', disabled: !monologueOn })}</label></div><button className="primary" onClick={() => void saveDrafts(queueDrafts, monologueFields, '/api/settings', '혼잣말 설정을', (body: QueueSettings) => { setSettings(body); return body; })}>설정 저장</button></section>}
    <section className="panel"><h2>치지직·OBS 연결</h2><p>치지직 채팅과 OBS 장면 전환 상태입니다. OBS 주소·비밀번호와 치지직 앱 키는 저장소 루트의 <code>.env</code>에서 읽습니다.</p>
      <div className="connection-grid">
        <div className="connection-item"><span className="connection-name">치지직</span><span className={`badge badge-${connectionBadge(chzzk?.state ?? 'unknown').tone}`}>{connectionBadge(chzzk?.state ?? 'unknown').text}</span><span className="connection-detail">{chzzk?.lastError ?? chzzk?.channelName ?? ''}</span></div>
        <div className="connection-item"><span className="connection-name">OBS</span><span className={`badge badge-${connectionBadge(obs?.state ?? 'unknown').tone}`}>{connectionBadge(obs?.state ?? 'unknown').text}</span><span className="connection-detail">{obs?.lastError ?? (obs?.currentScene ? `지금 장면: ${obs.currentScene}` : '')}</span></div>
      </div>
      <div className="button-row"><button onClick={() => void connectChzzk()}>치지직 연결</button><button onClick={() => void disconnectChzzk()} disabled={!chzzk || chzzk.state === 'off'}>치지직 연결 해제</button></div>
      {obs?.state === 'off' && <p className="hint">OBS 연결이 꺼져 있습니다. OBS의 WebSocket 서버를 켜고 <code>.env</code>에 <code>OBS_WEBSOCKET_PASSWORD</code>를 넣은 뒤 스튜디오를 다시 실행하세요.</p>}
    </section>
    {llm && <section className="panel"><h2>외부 LLM</h2><p>방송에서는 규칙에 없는 채팅만 LLM으로 넘깁니다. 1:1 대화는 규칙 문장 없이 항상 LLM이 답하므로, 여기서 끄면 1:1은 기본 문장으로만 답합니다. 위험 주제는 LLM 호출 전에 차단되고, 응답은 감정·모션 allowlist로 검증한 뒤에만 실행됩니다. 검증에 실패하면 기본 문장으로 대신 답합니다.</p>
      <label className="toggle-row"><input type="checkbox" checked={llm.settings.enabled} onChange={event => void saveLlm({ enabled: event.target.checked })} /><span>LLM 사용</span></label>
      <div className="settings-grid">
        <label>제공 업체<select value={llm.settings.provider} onChange={event => void saveLlm({ provider: event.target.value as LlmProvider })}>{llm.providers.map(provider => <option key={provider} value={provider}>{providerLabels[provider] ?? provider}</option>)}</select></label>
        <label>모델<input value={shownText(llmDrafts.drafts, 'model', llm.settings.model)} onChange={event => llmDrafts.set('model', event.target.value)} onBlur={() => saveLlmField(llmFields.model)} /></label>
        <label>최대 답변 길이{numberInput(llmDrafts, llmFields.maxReplyLength, llm.settings.maxReplyLength, { min: '20', onBlur: () => saveLlmField(llmFields.maxReplyLength) })}</label>
        <label>응답 제한(ms){numberInput(llmDrafts, llmFields.timeoutMs, llm.settings.timeoutMs, { min: '1000', step: '500', onBlur: () => saveLlmField(llmFields.timeoutMs) })}</label>
      </div>
      <p className="hint">매 턴 그대로 들어가는 시스템 프롬프트는 {llm.systemPromptChars}자입니다. 이 부분은 검색되지 않고 항상 전달되므로 짧을수록 좋습니다.</p>
      <label className="toggle-row"><input type="checkbox" checked={llm.settings.rollingSummaryEnabled} onChange={event => void saveLlm({ rollingSummaryEnabled: event.target.checked })} /><span>방송 중 누적 요약</span></label>
      <p className="hint">보리는 최근 몇 턴만 그대로 기억합니다. 켜 두면 일정 턴마다 지금까지의 대화를 짧게 접어 문맥에 계속 넣으므로, 긴 방송에서 초반 이야기를 잊지 않습니다. 답변과 별개로 호출되며 답변 속도에는 영향을 주지 않습니다.</p>
      <div className="settings-grid">
        <label>요약 주기(턴){numberInput(llmDrafts, llmFields.rollingSummaryTurns, llm.settings.rollingSummaryTurns, { min: '4', disabled: !llm.settings.rollingSummaryEnabled, onBlur: () => saveLlmField(llmFields.rollingSummaryTurns) })}</label>
      </div>
      <label className="toggle-row"><input type="checkbox" checked={llm.settings.macroEnabled} onChange={event => void saveLlm({ macroEnabled: event.target.checked })} /><span>키워드 매크로</span></label>
      <p className="hint">채팅에 등록한 키워드가 나오면 해당 설명을 바로 문맥에 붙입니다. 게임 이름이나 캐릭터명처럼 철자가 정해진 대상은 기억 검색보다 정확하고, 임베딩 왕복이 없어 빠릅니다. <code>{llm.macro.path}</code>를 직접 편집한 뒤 다시 읽기를 누르세요.</p>
      <div className="metrics llm-metrics"><div><strong>{llm.macro.loaded}</strong><span>등록된 매크로</span></div><div><strong>{llm.macro.active.length}</strong><span>지금 켜진 것</span></div></div>
      {llm.macro.active.length > 0 && <p className="hint">켜진 매크로: {llm.macro.active.map(entry => `${entry.id}(${entry.remainingTurns}턴)`).join(', ')}</p>}
      {llm.macro.error && <div className="notice">매크로 파일 오류: {llm.macro.error}</div>}
      <button onClick={() => void reloadMacros()}>매크로 다시 읽기</button>
      <div className="chat-input-row"><input type="password" value={apiKeyInput} onChange={event => setApiKeyInput(event.target.value)} aria-label="OpenAI API 키" placeholder={llm.status.hasApiKey ? 'API 키가 저장되어 있습니다. 바꾸려면 새 키를 입력하세요' : 'API 키를 입력하세요'} /><button onClick={() => void saveLlm({ apiKey: apiKeyInput })} disabled={!apiKeyInput.trim()}>키 저장</button>{llm.status.hasApiKey && <button onClick={() => void saveLlm({ apiKey: '' })}>키 지우기</button>}</div>
      <div className="metrics llm-metrics"><div><strong>{llm.status.hasApiKey ? '있음' : '없음'}</strong><span>API 키</span></div><div><strong>{llm.status.callCount}</strong><span>방송 호출</span></div><div><strong>{llm.status.failureCount}</strong><span>호출 실패</span></div><div><strong>{llm.status.validationFailureCount}</strong><span>검증 실패</span></div><div><strong>{llm.status.averageLatencyMs}ms</strong><span>평균 지연</span></div></div>
      {llm.status.circuitOpen && <div className="notice">방송: 연속 실패로 LLM 호출을 잠시 멈췄습니다. {llm.settings.cooldownSeconds}초 뒤 다시 시도합니다.</div>}
      {llm.status.lastError && <div className="notice">방송 마지막 오류: {llm.status.lastError}</div>}
      <p className="hint">화면에서 입력한 API 키는 데이터 폴더(<code>BORI_DATA_DIR</code>, 기본 <code>data/</code>)의 <code>llm-config.json</code>에 암호화해 저장하며 다시 표시하지 않습니다. 환경변수 <code>OPENAI_API_KEY</code>로 준 키는 파일에 쓰지 않고, "키 지우기"를 눌러도 환경변수 키로 돌아갑니다. 데이터 폴더는 Git에서 제외되어 있습니다.</p>
    </section>}
    {(companionStats || companion) && <section className="panel"><h2>1:1 대화</h2><p>1:1 대화는 방송과 LLM 회로·통계를 따로 셉니다.</p>
      {companionStats && <div className="metrics"><div><strong>{companionStats.conversations}</strong><span>대화</span></div><div><strong>{companionStats.messages}</strong><span>메시지</span></div><div><strong>{companionStats.privateMemories}</strong><span>1:1 기억</span></div></div>}
      {companion && <div className="metrics llm-metrics"><div><strong>{companion.enabled && companion.hasApiKey ? (companion.circuitOpen ? '쉬는 중' : '사용 중') : '못 씀'}</strong><span>1:1 LLM</span></div><div><strong>{companion.callCount}</strong><span>호출</span></div><div><strong>{companion.failureCount}</strong><span>호출 실패</span></div><div><strong>{companion.validationFailureCount}</strong><span>검증 실패</span></div><div><strong>{companion.averageLatencyMs}ms</strong><span>평균 지연</span></div></div>}
      {companion && !(companion.enabled && companion.hasApiKey) && <div className="notice">LLM이 꺼져 있거나 API 키가 없어 1:1 대화는 기본 문장으로만 답합니다. 위 "외부 LLM"에서 켜고 키를 확인하세요.</div>}
      {companion?.circuitOpen && <div className="notice">1:1: 연속 실패로 LLM 호출을 잠시 멈췄습니다. {llm?.settings.cooldownSeconds}초 뒤 다시 시도합니다.</div>}
      {companion?.lastError && <div className="notice">1:1 마지막 오류: {companion.lastError}</div>}
    </section>}
    {usage && <section className="panel"><h2>API 사용량</h2><p>LLM·임베딩·음성 호출을 기능과 모드별로 셉니다. 숫자만 기록하고 대화 내용은 남기지 않습니다. 비용은 단가표로 계산한 추정치입니다.</p>
      <div className="metrics llm-metrics"><div><strong>{usage.today.totals.calls}</strong><span>오늘 호출</span></div><div><strong>{usage.today.totals.failures}</strong><span>오늘 실패</span></div><div><strong>{formatTokens(usage.today.totals)}</strong><span>오늘 입력/출력 토큰</span></div><div><strong>{usage.today.totals.characters.toLocaleString()}</strong><span>오늘 음성 글자</span></div><div><strong>{formatCost(usage.today.totals.estimatedCostUsd, usage.today.totals.costComplete)}</strong><span>오늘 추정 비용</span></div></div>
      <div className="metrics llm-metrics"><div><strong>{usage.last7Days.totals.calls}</strong><span>7일 호출</span></div><div><strong>{usage.last7Days.totals.failures}</strong><span>7일 실패</span></div><div><strong>{formatTokens(usage.last7Days.totals)}</strong><span>7일 입력/출력 토큰</span></div><div><strong>{usage.last7Days.totals.characters.toLocaleString()}</strong><span>7일 음성 글자</span></div><div><strong>{formatCost(usage.last7Days.totals.estimatedCostUsd, usage.last7Days.totals.costComplete)}</strong><span>7일 추정 비용</span></div></div>
      {usage.last7Days.rows.length > 0 && <table className="usage-table"><thead><tr><th>기능</th><th>모드</th><th>모델</th><th>호출</th><th>실패</th><th>입력/출력 토큰·글자</th><th>7일 추정 비용</th></tr></thead><tbody>{usage.last7Days.rows.map(row => <tr key={`${row.feature}-${row.mode}-${row.model}`}><td>{usageFeatureLabels[row.feature]}</td><td>{usageModeLabels[row.mode]}</td><td>{row.model}</td><td>{row.calls}</td><td>{row.failures}</td><td>{row.feature === 'tts' ? `${row.characters.toLocaleString()}자` : formatTokens(row)}</td><td>{formatRowCost(row)}</td></tr>)}</tbody></table>}
      {usage.last7Days.unpricedModels.length > 0 && <div className="notice">단가 없음: {usage.last7Days.unpricedModels.join(', ')}. 이 모델의 비용은 합계에서 빠졌습니다. 데이터 폴더의 <code>usage-prices.json</code>에 단가를 넣으면 계산합니다.</div>}
      {usage.prices.fileError && <div className="notice">단가 파일 오류: {usage.prices.fileError} 기본 단가만 씁니다.</div>}
      <p className="hint">{usage.prices.note} 단가 파일 {usage.prices.fileLoaded ? '적용 중' : '없음'}. 금액 뒤의 +는 단가나 토큰 정보가 없어 일부 호출이 빠졌다는 뜻입니다. 최근 31일 호출 {usage.last31Days.totals.calls}회, 추정 {formatCost(usage.last31Days.totals.estimatedCostUsd, usage.last31Days.totals.costComplete)}.</p>
    </section>}
    {tts && <section className="panel"><h2>음성 (TTS)</h2><p>보리의 답변을 고른 업체(OpenAI·ElevenLabs)의 음성으로 읽습니다. 방송 화면에서 재생되고 입 모양도 소리에 맞춰 움직입니다. OpenAI는 LLM과 같은 API 키를 씁니다.</p>
      <label className="toggle-row"><input type="checkbox" checked={tts.settings.enabled} disabled={!tts.hasApiKey} onChange={event => void saveTts({ enabled: event.target.checked })} /><span>음성 사용{!tts.hasApiKey && ' (API 키를 먼저 저장하세요)'}</span></label>
      <div className="settings-grid">
        <label>업체<select value={tts.settings.provider} onChange={event => void saveTts({ provider: event.target.value })}>{tts.providers.map(provider => <option key={provider} value={provider}>{providerLabels[provider] ?? provider}</option>)}</select></label>
        <label>목소리<select value={tts.settings.voice} onChange={event => void saveTts({ voice: event.target.value })}>{tts.voices.length === 0 && <option value={tts.settings.voice}>{tts.settings.voice}</option>}{tts.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}{voice.description ? ` — ${voice.description}` : ''}</option>)}</select></label>
        <label>모델<input value={shownText(ttsDrafts.drafts, 'model', tts.settings.model)} onChange={event => ttsDrafts.set('model', event.target.value)} onBlur={() => saveTtsField(ttsFields.model)} /></label>
        <label>합성 실패<input value={`${tts.failureCount}회`} readOnly /></label>
      </div>
      {tts.settings.provider === 'openai'
        ? <div className="settings-grid"><label>속도{numberInput(ttsDrafts, ttsFields.speed, tts.settings.speed, { min: '0.25', max: '4', step: '0.05', onBlur: () => saveTtsField(ttsFields.speed) })}</label></div>
        : <>
          <div className="settings-grid">
            <label>안정성{numberInput(ttsDrafts, ttsFields.stability, tts.settings.stability, { min: '0', max: '1', step: '0.05', onBlur: () => saveTtsField(ttsFields.stability) })}</label>
            <label>유사도{numberInput(ttsDrafts, ttsFields.similarity, tts.settings.similarity, { min: '0', max: '1', step: '0.05', onBlur: () => saveTtsField(ttsFields.similarity) })}</label>
          </div>
          <div className="chat-input-row"><input type="password" value={elevenKeyInput} onChange={event => setElevenKeyInput(event.target.value)} aria-label="ElevenLabs API 키" placeholder={tts.hasElevenLabsKey ? 'ElevenLabs 키가 저장되어 있습니다' : 'ElevenLabs API 키를 입력하세요'} /><button onClick={() => void saveTts({ elevenLabsApiKey: elevenKeyInput })} disabled={!elevenKeyInput.trim()}>키 저장</button>{tts.hasElevenLabsKey && <button onClick={() => void saveTts({ elevenLabsApiKey: '' })}>키 지우기</button>}</div>
          <p className="hint">안정성이 낮을수록 감정 표현이 커지고, 높을수록 톤이 일정해집니다. 목소리 목록은 ElevenLabs 계정에 담긴 것만 나옵니다. Voice Library에서 마음에 드는 목소리를 내 계정에 추가하면 여기에 표시됩니다.</p>
        </>}
      {tts.settings.enabled && <p className="hint">음성이 준비된 뒤에 말풍선이 뜨므로 답변까지 1~2초 더 걸립니다. 합성에 실패하면 소리 없이 방송이 이어집니다.</p>}
      {tts.lastError && <div className="notice">마지막 오류: {tts.lastError}</div>}
    </section>}
    {memory && <section className="panel"><h2>장기 기억</h2><p>방송이 끝날 때 대화에서 취향과 경험을 추려 저장합니다. 다음 방송에서 관련 있는 기억만 골라 보리에게 전달합니다. 위험 주제와 개인정보는 저장하지 않습니다. 1:1 대화에서 생긴 기억은 방송 중 화면 공유로 새지 않게 기본으로 내용을 가립니다.</p>
      <label className="toggle-row"><input type="checkbox" checked={memory.settings.enabled} onChange={event => void saveMemory({ enabled: event.target.checked })} /><span>기억 사용</span></label>
      <div className="settings-grid">
        <label>전달할 기억 수{numberInput(memoryDrafts, memoryFields.maxMemories, memory.settings.maxMemories, { min: '1', max: '20', onBlur: () => saveMemoryField(memoryFields.maxMemories) })}</label>
        <label>최소 유사도{numberInput(memoryDrafts, memoryFields.minSimilarity, memory.settings.minSimilarity, { min: '0', max: '1', step: '0.05', onBlur: () => saveMemoryField(memoryFields.minSimilarity) })}</label>
        <label>보관 기간(일){numberInput(memoryDrafts, memoryFields.retentionDays, memory.settings.retentionDays, { min: '1', onBlur: () => saveMemoryField(memoryFields.retentionDays) })}</label>
        <label>저장된 기억<input value={`${memory.count}건`} readOnly /></label>
      </div>
      {privateCount > 0 && <button onClick={() => setRevealPrivate(current => !current)} aria-pressed={revealPrivate}>{revealPrivate ? '1:1 기억 내용 가리기' : `1:1 기억 내용 보기 (${privateCount}건)`}</button>}
      {memory.records.length > 0 && <ul className="memory-list">{memory.records.map(record => <li key={record.id}><span className={`memory-text${record.scope === 'private' && !revealPrivate ? ' masked' : ''}`}>{memoryTextFor(record, revealPrivate)}</span><span className="memory-meta">{memoryScopeLabels[record.scope] ?? record.scope} · {record.ownerId ?? '소유자 없음'} · 중요도 {record.importance.toFixed(2)} · {record.repeatCount}회</span><button onClick={() => void deleteMemory(record.id)}>지우기</button></li>)}</ul>}
      {memory.count > 0 && <button onClick={() => void deleteMemory('all')}>기억 모두 지우기</button>}
    </section>}
    <section className="panel"><h2>표정·모션 테스트</h2><p>방송 시작 전에도 방송 화면에서 바로 실행됩니다. 표정은 효과를 켠 채 <strong>멈춰 있고</strong>, 모션은 같은 효과를 <strong>계속 움직입니다</strong>. 정지 화면으로는 구분되지 않고 움직임으로만 차이가 납니다.</p><div className="action-group"><span className="action-label">표정<br />정지</span><div className="action-buttons">{boriExpressionNames.map(name => <button key={name} onClick={() => void runTestAction('expression', name)}>{boriExpressionLabels[name]}</button>)}</div></div><div className="action-group"><span className="action-label">모션<br />움직임</span><div className="action-buttons">{boriMotionGroupNames.map(name => <button key={name} onClick={() => void runTestAction('motion', name)}>{boriMotionLabels[name]}</button>)}</div></div><p className="hint">같은 이름이 양쪽에 있으면 모션 버튼이 상위 버전입니다. 예를 들어 화남은 표정 버튼이 김이 멈춘 상태, 모션 버튼이 김이 계속 뿜어지는 상태입니다. 슬픔·어이없음·멍함·긴 머리는 모션이 없어 표정만 있습니다.</p></section>
  </main>;
}
