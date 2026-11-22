import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LlmProvider, LlmSettings, LlmStatus, UsageFeature, UsageMode, UsageReport, UsageRow, UsageTotals } from '@bori/shared';
import { buildPatch, clearSaved, pickDrafts, readError, savedSummary, shownText, type DraftValue, type Drafts, type FieldSpec } from '../form';
import { isSubmitEnter } from '../keys';
import { createPoller, SETTINGS_POLL_MS, STATUS_POLL_MS } from '../poll';
import { connectionBadge, erSummary, llmConnection, NICKNAME_MAX, nicknameBody, type ErDataView } from './status-view';
import { getJson, isServerUp, JSON_HEADERS, MUTATION_TIMEOUT_MS, postAction, readJson, request } from './api';

// 업체 표시 이름. 알 수 없는 값은 원문 그대로 보여 준다.
const providerLabels: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', elevenlabs: 'ElevenLabs', fish: 'Fish Audio' };
// 기능 표시 이름. 요약·기억 정리·임베딩은 1:1 대화를 쓰던 때의 기록이다.
const usageFeatureLabels: Record<UsageFeature, string> = { reply: '대사', summary: '요약(이전)', digest: '기억 정리(이전)', embedding: '임베딩(이전)', tts: '음성' };
// 모드 표시 이름. 이 앱이 새로 쓰는 모드는 narration뿐이고, 방송·1:1 줄은 예전 기록을 읽은 것이다.
const usageModeLabels: Record<string, string> = { narration: '읽어 주기', broadcast: '이전 방송', companion: '이전 1:1', none: '공통' };
const usageModeLabel = (mode: UsageMode) => usageModeLabels[mode] ?? mode;
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

type LlmView = { settings: LlmSettings; status: LlmStatus; providers: LlmProvider[]; defaultModels: Record<string, string> };
type TtsView = { settings: { enabled: boolean; provider: string; model: string; voice: string; speed: number; stability: number; similarity: number }; voices: { id: string; name: string; description?: string }[]; providers: string[]; defaultModels: Record<string, string>; hasApiKey: boolean; hasElevenLabsKey: boolean; hasFishKey?: boolean; failureCount: number; lastError: string | null };
/** GET/PUT /api/dashboard/settings. 서버 라우트는 마무리 단계에서 생긴다. 그 전에는 저장이 실패로 안내된다. */
type DashboardSettingsView = { nickname: string | null };

// 폼 칸 정의. 이름은 저장 실패·성공 문구에도 그대로 쓴다.
const llmFields = {
  model: { key: 'model', label: '모델', kind: 'text' },
  timeoutMs: { key: 'timeoutMs', label: '응답 제한(ms)', kind: 'number' },
} satisfies Record<string, FieldSpec>;
const ttsFields = {
  model: { key: 'model', label: '모델', kind: 'text' },
  speed: { key: 'speed', label: '속도', kind: 'number' },
  stability: { key: 'stability', label: '안정성', kind: 'number' },
  similarity: { key: 'similarity', label: '유사도', kind: 'number' },
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

/** 스튜디오 설정 탭. 이터널리턴 데이터·게임 닉네임·외부 LLM·음성·API 사용량. */
export default function SettingsTab() {
  const [notice, setNotice] = useState('');
  const [serverOnline, setServerOnline] = useState(true);
  const [llm, setLlm] = useState<LlmView | null>(null);
  // API 키는 서버가 돌려주지 않으므로 입력값만 화면에서 관리한다.
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [tts, setTts] = useState<TtsView | null>(null);
  const [elevenKeyInput, setElevenKeyInput] = useState('');
  const [fishVoiceInput, setFishVoiceInput] = useState('');
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [er, setEr] = useState<ErDataView | null>(null);
  const [nickname, setNickname] = useState<string | null>(null);
  const [nicknameInput, setNicknameInput] = useState('');
  const llmDrafts = useDrafts();
  const ttsDrafts = useDrafts();
  const pollers = useRef<{ status: ReturnType<typeof createPoller>; settings: ReturnType<typeof createPoller> } | null>(null);
  // 자주 바뀌는 것(LLM 회로·이터널리턴 갱신 진행률)만 짧은 간격으로 받는다. 서버 끊김은 /api/llm 응답으로 본다.
  async function refreshStatus() {
    // 가벼운 상태 경로(연결·갱신·기준만). 자동 갱신 판정은 대시보드 화면이 여는 /api/dashboard에만 있다.
    const [llmResponse, nextStatus] = await Promise.all([request('/api/llm'), getJson<ErDataView>('/api/dashboard/status')]);
    if (!isServerUp(llmResponse)) { setServerOnline(false); return; }
    setServerOnline(true);
    const nextLlm = llmResponse.ok ? await readJson<LlmView>(llmResponse) : null;
    if (nextLlm) setLlm(nextLlm);
    if (nextStatus) setEr({ connection: nextStatus.connection, refresh: nextStatus.refresh, basis: nextStatus.basis });
  }
  // 사용량·음성 설정·닉네임은 드물게 받는다. 이 화면에서 저장하면 저장 응답으로 바로 맞춘다.
  async function refreshSettings() {
    const [usageResponse, ttsResponse, nextDashboard] = await Promise.all([request('/api/usage'), request('/api/tts', undefined, MUTATION_TIMEOUT_MS), getJson<DashboardSettingsView>('/api/dashboard/settings')]);
    const nextUsage = usageResponse?.ok ? await readJson<UsageReport>(usageResponse) : null;
    if (nextUsage) setUsage(nextUsage);
    const nextTts = ttsResponse?.ok ? await readJson<TtsView>(ttsResponse) : null;
    if (nextTts) setTts(nextTts);
    if (nextDashboard) setNickname(nextDashboard.nickname);
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
  const saveLlmField = (field: FieldSpec) => void saveDrafts(llmDrafts, [field], '/api/llm', 'LLM 설정을', applyLlm, true);
  const saveTtsField = (field: FieldSpec) => void saveDrafts(ttsDrafts, [field], '/api/tts', '음성 설정을', applyTts, true);
  async function saveTts(patch: Record<string, unknown>) {
    const response = await sendPatch('/api/tts', patch, '음성 설정을 저장하지 못했습니다.');
    if (!response) return;
    const body = await readJson<TtsView>(response);
    if (body) setTts(body);
    if (patch.elevenLabsApiKey !== undefined) setElevenKeyInput('');
    setNotice(patch.elevenLabsApiKey === '' ? '저장한 ElevenLabs 키를 지웠습니다.' : '음성 설정을 저장했습니다.');
  }
  async function saveLlm(patch: Partial<LlmSettings> & { apiKey?: string }) {
    const response = await sendPatch('/api/llm', patch, 'LLM 설정을 저장하지 못했습니다.');
    if (!response) return;
    const body = await readJson<LlmView>(response);
    if (body) setLlm(body);
    if (patch.apiKey !== undefined) setApiKeyInput('');
    setNotice(patch.apiKey === undefined ? 'LLM 설정을 저장했습니다.' : patch.apiKey ? 'API 키를 저장했습니다.' : '저장한 API 키를 지웠습니다.');
  }
  /**
   * 게임 닉네임을 저장하거나(문자열) 지운다(빈칸). 서버가 전적을 다시 조회한다.
   * 서버 라우트가 아직 없으면 404 이유를 그대로 안내한다.
   */
  async function saveNickname(input: string) {
    const built = nicknameBody(input);
    if (!built.ok) { setNotice(built.error); return; }
    const response = await request('/api/dashboard/settings', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(built.body) }, MUTATION_TIMEOUT_MS);
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 저장하지 못했습니다.'); return; }
    if (!response.ok) { setNotice(`게임 닉네임을 저장하지 못했습니다. ${await readError(response, '서버가 값을 받지 않았습니다.')}`); return; }
    const body = await readJson<DashboardSettingsView>(response);
    setNickname(body ? body.nickname : built.body.nickname);
    setNicknameInput('');
    setNotice(built.body.nickname === null ? '저장한 게임 닉네임을 지웠습니다.' : '게임 닉네임을 저장했습니다. 대시보드의 내 전적 칸이 다시 조회합니다.');
  }
  async function refreshEr() {
    const response = await postAction('/api/er/refresh');
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; }
    const body = response.ok ? await readJson<{ started: boolean }>(response) : null;
    setNotice(body?.started ? '이터널리턴 데이터 갱신을 시작했습니다. 몇 분 걸릴 수 있습니다.' : '갱신을 시작하지 못했습니다. 이미 갱신 중이거나 ER_API_KEY가 없습니다.');
    pollers.current?.status.runNow();
  }
  // 폴링은 앞 요청이 끝난 뒤에 다음 요청을 예약해 겹치지 않는다(poll.ts).
  useEffect(() => {
    const status = createPoller(refreshStatus, STATUS_POLL_MS);
    const slow = createPoller(refreshSettings, SETTINGS_POLL_MS);
    pollers.current = { status, settings: slow };
    return () => { status.stop(); slow.stop(); pollers.current = null; };
  }, []);
  const summary = erSummary(er);
  const llmBadge = connectionBadge(llmConnection(llm?.status ?? null));
  // 숫자·글자 입력칸. 고친 값은 draft로만 들고 있고, 서버 값은 고치지 않은 칸에만 보인다.
  const numberInput = (group: DraftGroup, field: FieldSpec, serverValue: number, props: { min?: string; max?: string; step?: string; disabled?: boolean; onBlur?: () => void } = {}) =>
    <input type="number" {...props} value={shownText(group.drafts, field.key, serverValue)} onChange={event => group.set(field.key, event.target.value)} />;
  const erProgress = Math.round((er?.refresh.progress ?? 0) * 100);
  // 숫자 묶음(호출·실패 등). 라벨 위, 값 아래로 대시보드의 수치 칸과 같은 모양이다.
  const stats = (items: Array<[label: string, value: string | number]>) =>
    <dl className="stats">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
  // 설정 한 묶음: 왼쪽에 제목·설명, 오른쪽에 조작. 묶음 사이는 얇은 선으로만 나눈다(시안 B).
  const section = (id: string, title: ReactNode, intro: ReactNode, body: ReactNode) =>
    <section className="settings-section" aria-labelledby={`settings-${id}`}>
      <div className="section-intro"><h2 id={`settings-${id}`}>{title}</h2>{intro}</div>
      <div className="section-body">{body}</div>
    </section>;
  return <main className="admin-shell">
    <header className="admin-header">
      <div><p className="eyebrow">이터널리턴 메타 · 보리</p><h1>설정</h1></div>
      <span className={`status ${serverOnline ? 'status-online' : 'status-offline'}`}><i className="status-dot" aria-hidden="true" />{serverOnline ? '서버 연결됨' : '서버 끊김'}</span>
    </header>
    {!serverOnline && <div className="server-alert"><strong>API 서버에 연결할 수 없습니다.</strong> 대시보드와 설정이 동작하지 않습니다. 스튜디오가 띄운 서버가 꺼졌다면 스튜디오를 다시 실행하세요. 서버 로그는 데이터 폴더의 <code>studio-server.log</code>에 있습니다.</div>}
    {notice && <div className="notice-bar" role="status">{notice}</div>}

    {section('er', '이터널리턴 데이터',
      <p>이터널리턴 Open API 키는 저장소 루트 <code>.env</code>의 <code>ER_API_KEY</code>에서 읽습니다. 키가 없으면 상태가 "데이터 없음"이고 갱신 버튼이 꺼집니다. 갱신에 실패하면 마지막으로 저장한 데이터를 그대로 씁니다.</p>,
      <>
        <div className="er-status">
          <span className={`badge badge-${summary.badge.tone}`}><i className="badge-dot" aria-hidden="true" />{summary.badge.text}</span>
          <div className="er-title">{summary.title}</div>
          <p className="hint">{summary.updated}{summary.description ? ` · ${summary.description}` : ''}</p>
        </div>
        {summary.progress && <div className="progress" role="progressbar" aria-valuenow={erProgress} aria-valuemin={0} aria-valuemax={100}>
          <span className="progress-text">{summary.progress}</span>
          <span className="progress-track"><span className="progress-bar" style={{ width: `${erProgress}%` }} /></span>
        </div>}
        {summary.lastError && <div className="notice notice-error">마지막 갱신 오류: {summary.lastError}</div>}
        <div className="button-row"><button className="primary-button" onClick={() => void refreshEr()} disabled={!serverOnline || !summary.canRefresh}>데이터 갱신</button></div>
      </>)}

    {section('nickname', '게임 닉네임',
      <p>대시보드 "내 전적" 칸에 쓸 이터널리턴 닉네임입니다. 이 컴퓨터의 데이터 폴더에만 저장하고, 로그와 보리 대사에는 넣지 않습니다.</p>,
      <>
        <div className="current-value"><span>지금 저장된 닉네임</span><strong>{nickname ?? '없음'}</strong></div>
        <div className="input-row"><input value={nicknameInput} onChange={event => setNicknameInput(event.target.value)} onKeyDown={event => { if (isSubmitEnter(event)) void saveNickname(nicknameInput); }} aria-label="게임 닉네임" placeholder="게임 닉네임" maxLength={NICKNAME_MAX} /><button className="primary-button" onClick={() => void saveNickname(nicknameInput)} disabled={!serverOnline || !nicknameInput.trim()}>저장</button>{nickname && <button className="ghost-button" onClick={() => void saveNickname('')} disabled={!serverOnline}>지우기</button>}</div>
      </>)}

    {llm && section('llm', '외부 LLM',
      <>
        <p>메타 분석을 갱신하면 보리가 읽을 대사를 LLM이 수치 목록만 근거로 씁니다. 꺼져 있거나 실패하면 정해진 문장으로 읽습니다. 대화 기능은 없습니다.</p>
        <p className="hint">화면에서 입력한 API 키는 데이터 폴더(<code>BORI_DATA_DIR</code>, 기본 <code>data/</code>)의 <code>llm-config.json</code>에 암호화해 저장하며 다시 표시하지 않습니다. 환경변수 <code>OPENAI_API_KEY</code>로 준 키는 파일에 쓰지 않고, "키 지우기"를 눌러도 환경변수 키로 돌아갑니다. 데이터 폴더는 Git에서 제외되어 있습니다.</p>
      </>,
      <>
        <div className="section-toolbar">
          <label className="toggle-row"><input type="checkbox" className="switch" checked={llm.settings.enabled} onChange={event => void saveLlm({ enabled: event.target.checked })} /><span>LLM 사용</span></label>
          <div className="connection-item"><span className={`badge badge-${llmBadge.tone}`}><i className="badge-dot" aria-hidden="true" />{llmBadge.text}</span><span className="connection-detail">{llm.status.lastError ?? llm.settings.model}</span></div>
        </div>
        <div className="settings-grid">
          <label>제공 업체<select value={llm.settings.provider} onChange={event => void saveLlm({ provider: event.target.value as LlmProvider })}>{llm.providers.map(provider => <option key={provider} value={provider}>{providerLabels[provider] ?? provider}</option>)}</select></label>
          <label>모델<input value={shownText(llmDrafts.drafts, 'model', llm.settings.model)} onChange={event => llmDrafts.set('model', event.target.value)} onBlur={() => saveLlmField(llmFields.model)} /></label>
          <label>응답 제한(ms){numberInput(llmDrafts, llmFields.timeoutMs, llm.settings.timeoutMs, { min: '1000', step: '500', onBlur: () => saveLlmField(llmFields.timeoutMs) })}</label>
        </div>
        <div className="input-row"><input type="password" value={apiKeyInput} onChange={event => setApiKeyInput(event.target.value)} aria-label="LLM API 키" placeholder={llm.status.hasApiKey ? 'API 키가 저장되어 있습니다. 바꾸려면 새 키를 입력하세요' : 'API 키를 입력하세요'} /><button className="primary-button" onClick={() => void saveLlm({ apiKey: apiKeyInput })} disabled={!apiKeyInput.trim()}>키 저장</button>{llm.status.hasApiKey && <button className="ghost-button" onClick={() => void saveLlm({ apiKey: '' })}>키 지우기</button>}</div>
        {stats([['API 키', llm.status.hasApiKey ? '있음' : '없음'], ['호출', llm.status.callCount], ['호출 실패', llm.status.failureCount], ['검증 실패', llm.status.validationFailureCount], ['평균 지연', `${llm.status.averageLatencyMs}ms`]])}
        {llm.status.circuitOpen && <div className="notice notice-warn">연속 실패로 LLM 호출을 잠시 멈췄습니다. {llm.settings.cooldownSeconds}초 뒤 다시 시도합니다.</div>}
      </>)}

    {tts && section('tts', '음성 (TTS)',
      <p>보리가 메타 분석 대사를 고른 업체(OpenAI·ElevenLabs·Fish Audio)의 음성으로 읽습니다. 대시보드에서 재생되고 입 모양도 소리에 맞춰 움직입니다. OpenAI는 LLM과 같은 API 키를 쓰고, Fish Audio는 .env의 FISH_API_KEY를 씁니다.</p>,
      <>
        <div className="section-toolbar">
          <label className="toggle-row"><input type="checkbox" className="switch" checked={tts.settings.enabled} disabled={!tts.hasApiKey} onChange={event => void saveTts({ enabled: event.target.checked })} /><span>음성 사용{!tts.hasApiKey && ' (API 키를 먼저 저장하세요)'}</span></label>
        </div>
        <div className="settings-grid">
          <label>업체<select value={tts.settings.provider} onChange={event => void saveTts({ provider: event.target.value })}>{tts.providers.map(provider => <option key={provider} value={provider}>{providerLabels[provider] ?? provider}</option>)}</select></label>
          <label>목소리<select value={tts.settings.voice} onChange={event => void saveTts({ voice: event.target.value })}>{tts.voices.length === 0 && <option value={tts.settings.voice}>{tts.settings.voice}</option>}{tts.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}{voice.description ? ` — ${voice.description}` : ''}</option>)}</select></label>
          <label>모델<input value={shownText(ttsDrafts.drafts, 'model', tts.settings.model)} onChange={event => ttsDrafts.set('model', event.target.value)} onBlur={() => saveTtsField(ttsFields.model)} /></label>
          <label>합성 실패<input value={`${tts.failureCount}회`} readOnly /></label>
        </div>
        {tts.settings.provider === 'openai'
          ? <div className="settings-grid"><label>속도{numberInput(ttsDrafts, ttsFields.speed, tts.settings.speed, { min: '0.25', max: '4', step: '0.05', onBlur: () => saveTtsField(ttsFields.speed) })}</label></div>
          : tts.settings.provider === 'fish'
          ? <>
            <div className="settings-grid">
              <label>속도{numberInput(ttsDrafts, ttsFields.speed, tts.settings.speed, { min: '0.5', max: '2', step: '0.05', onBlur: () => saveTtsField(ttsFields.speed) })}</label>
              <label>안정성{numberInput(ttsDrafts, ttsFields.stability, tts.settings.stability, { min: '0', max: '1', step: '0.05', onBlur: () => saveTtsField(ttsFields.stability) })}</label>
            </div>
            <div className="input-row"><input value={fishVoiceInput} onChange={event => setFishVoiceInput(event.target.value)} aria-label="Fish Audio 목소리 ID" placeholder="목소리 ID 32자리 (fish.audio/m/ 뒤의 값)" /><button className="primary-button" onClick={() => { void saveTts({ voice: fishVoiceInput.trim() }); setFishVoiceInput(''); }} disabled={!fishVoiceInput.trim()}>목소리 적용</button></div>
            <p className="hint">{tts.hasFishKey ? 'Fish Audio 키를 .env에서 읽었습니다.' : '.env에 FISH_API_KEY를 넣고 스튜디오를 다시 켜 주세요.'} 목록에는 내 계정에서 만든 목소리만 나옵니다. 공개 목소리는 fish.audio 목소리 페이지 주소(fish.audio/m/…)의 ID를 위 칸에 넣습니다. 속도는 0.5~2.0입니다. 목소리가 합성마다 달라지면 안정성을 0.7~0.8로 올려 보세요(높을수록 일정하고, 낮을수록 표현이 커집니다).</p>
          </>
          : <>
            <div className="settings-grid">
              <label>안정성{numberInput(ttsDrafts, ttsFields.stability, tts.settings.stability, { min: '0', max: '1', step: '0.05', onBlur: () => saveTtsField(ttsFields.stability) })}</label>
              <label>유사도{numberInput(ttsDrafts, ttsFields.similarity, tts.settings.similarity, { min: '0', max: '1', step: '0.05', onBlur: () => saveTtsField(ttsFields.similarity) })}</label>
            </div>
            <div className="input-row"><input type="password" value={elevenKeyInput} onChange={event => setElevenKeyInput(event.target.value)} aria-label="ElevenLabs API 키" placeholder={tts.hasElevenLabsKey ? 'ElevenLabs 키가 저장되어 있습니다' : 'ElevenLabs API 키를 입력하세요'} /><button className="primary-button" onClick={() => void saveTts({ elevenLabsApiKey: elevenKeyInput })} disabled={!elevenKeyInput.trim()}>키 저장</button>{tts.hasElevenLabsKey && <button className="ghost-button" onClick={() => void saveTts({ elevenLabsApiKey: '' })}>키 지우기</button>}</div>
            <p className="hint">안정성이 낮을수록 감정 표현이 커지고, 높을수록 톤이 일정해집니다. 목소리 목록은 ElevenLabs 계정에 담긴 것만 나옵니다. Voice Library에서 마음에 드는 목소리를 내 계정에 추가하면 여기에 표시됩니다.</p>
          </>}
        {tts.settings.enabled && <p className="hint">합성에 실패한 줄은 자막만 보입니다.</p>}
        {tts.lastError && <div className="notice notice-error">마지막 오류: {tts.lastError}</div>}
      </>)}

    {usage && section('usage', 'API 사용량',
      <p>LLM·음성 호출을 기능과 모드별로 셉니다. 숫자만 기록하고 대사 내용은 남기지 않습니다. 방송·1:1 대화를 쓰던 때의 기록은 '이전 방송'·'이전 1:1'로 보입니다. 비용은 단가표로 계산한 추정치입니다.</p>,
      <>
        <h3>오늘</h3>
        {stats([['호출', usage.today.totals.calls], ['실패', usage.today.totals.failures], ['입력/출력 토큰', formatTokens(usage.today.totals)], ['음성 글자', usage.today.totals.characters.toLocaleString()], ['추정 비용', formatCost(usage.today.totals.estimatedCostUsd, usage.today.totals.costComplete)]])}
        <h3>최근 7일</h3>
        {stats([['호출', usage.last7Days.totals.calls], ['실패', usage.last7Days.totals.failures], ['입력/출력 토큰', formatTokens(usage.last7Days.totals)], ['음성 글자', usage.last7Days.totals.characters.toLocaleString()], ['추정 비용', formatCost(usage.last7Days.totals.estimatedCostUsd, usage.last7Days.totals.costComplete)]])}
        {usage.last7Days.rows.length > 0 && <table className="usage-table"><thead><tr><th>기능</th><th>모드</th><th>모델</th><th className="num">호출</th><th className="num">실패</th><th className="num">입력/출력 토큰·글자</th><th className="num">7일 추정 비용</th></tr></thead><tbody>{usage.last7Days.rows.map(row => <tr key={`${row.feature}-${row.mode}-${row.model}`}><td>{usageFeatureLabels[row.feature]}</td><td>{usageModeLabel(row.mode)}</td><td className="model">{row.model}</td><td className="num">{row.calls}</td><td className="num">{row.failures}</td><td className="num">{row.feature === 'tts' ? `${row.characters.toLocaleString()}자` : formatTokens(row)}</td><td className="num">{formatRowCost(row)}</td></tr>)}</tbody></table>}
        {usage.last7Days.unpricedModels.length > 0 && <div className="notice notice-warn">단가 없음: {usage.last7Days.unpricedModels.join(', ')}. 이 모델의 비용은 합계에서 빠졌습니다. 데이터 폴더의 <code>usage-prices.json</code>에 단가를 넣으면 계산합니다.</div>}
        {usage.prices.fileError && <div className="notice notice-error">단가 파일 오류: {usage.prices.fileError} 기본 단가만 씁니다.</div>}
        <p className="hint">{usage.prices.note} 단가 파일 {usage.prices.fileLoaded ? '적용 중' : '없음'}. 금액 뒤의 +는 단가나 토큰 정보가 없어 일부 호출이 빠졌다는 뜻입니다. 최근 31일 호출 {usage.last31Days.totals.calls}회, 추정 {formatCost(usage.last31Days.totals.estimatedCostUsd, usage.last31Days.totals.costComplete)}.</p>
      </>)}
  </main>;
}
