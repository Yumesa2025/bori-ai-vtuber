import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BroadcastState, CompanionStats, LlmProvider, LlmSettings, LlmStatus, MacroStatus, QueueSettings, UsageFeature, UsageMode, UsageReport, UsageRow, UsageTotals } from '@bori/shared';
import { boriExpressionLabels, boriExpressionNames, boriMotionGroupNames, boriMotionLabels } from '@bori/live2d';
import './styles.css';

const initialState: BroadcastState = { status: 'idle', layout: 'chat', currentEmotion: 'calm', queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };
// 기억 공개 범위 표시 이름. 알 수 없는 값은 원문 그대로 보여 준다.
const memoryScopeLabels: Record<string, string> = { character: '캐릭터', broadcast: '방송', private: '1:1' };
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

export default function AdminApp() {
  const [state, setState] = useState<BroadcastState>(initialState);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState<QueueSettings>({ responseDelayMinSeconds: 5, responseDelayMaxSeconds: 10, maxQueueSize: 100, visibleChatLimit: 8, duplicateWindowMinutes: 5, sameReplyCooldownMinutes: 5, monologueEnabled: true, monologueMinSeconds: 30, monologueMaxSeconds: 60 });
  const [serverOnline, setServerOnline] = useState(true);
  const [llm, setLlm] = useState<{ settings: LlmSettings; status: LlmStatus; providers: LlmProvider[]; defaultModels: Record<string, string>; macro: MacroStatus; systemPromptChars: number } | null>(null);
  // API 키는 서버가 돌려주지 않으므로 입력값만 화면에서 관리한다.
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [tts, setTts] = useState<{ settings: { enabled: boolean; provider: string; model: string; voice: string; speed: number; stability: number; similarity: number }; voices: { id: string; name: string; description?: string }[]; providers: string[]; defaultModels: Record<string, string>; hasApiKey: boolean; hasElevenLabsKey: boolean; failureCount: number; lastError: string | null } | null>(null);
  const [elevenKeyInput, setElevenKeyInput] = useState('');
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [companionStats, setCompanionStats] = useState<CompanionStats | null>(null);
  const [memory, setMemory] = useState<{ settings: { enabled: boolean; maxMemories: number; minSimilarity: number; retentionDays: number }; count: number; records: { id: string; text: string; kind: string; scope: string; ownerId?: string; importance: number; repeatCount: number; createdAt: string }[] } | null>(null);
  // 서버가 죽으면 버튼을 눌러도 아무 일이 없어 원인을 알 수 없다.
  // Vite dev 프록시는 백엔드가 죽어도 5xx 응답을 돌려주므로, fetch 예외만으로는 판단할 수 없다.
  async function request(path: string, init?: RequestInit): Promise<Response | null> {
    try { return await fetch(path, init); } catch { return null; }
  }
  // 타입 가드로 두면 이 검사를 통과한 뒤에는 response를 그대로 쓸 수 있다.
  const isServerUp = (response: Response | null): response is Response => response !== null && response.status < 500;
  async function refresh() {
    const response = await request('/api/state');
    if (!isServerUp(response)) { setServerOnline(false); return; }
    setServerOnline(true);
    if (response.ok) setState(await response.json() as BroadcastState);
    const settingsResponse = await request('/api/settings');
    if (settingsResponse?.ok) setSettings(await settingsResponse.json() as QueueSettings);
    const llmResponse = await request('/api/llm');
    if (llmResponse?.ok) setLlm(await llmResponse.json() as typeof llm);
    const memoryResponse = await request('/api/memory');
    if (memoryResponse?.ok) setMemory(await memoryResponse.json() as typeof memory);
    const ttsResponse = await request('/api/tts');
    if (ttsResponse?.ok) setTts(await ttsResponse.json() as typeof tts);
    const usageResponse = await request('/api/usage');
    if (usageResponse?.ok) setUsage(await usageResponse.json() as UsageReport);
    const statsResponse = await request('/api/companion/stats');
    if (statsResponse?.ok) setCompanionStats(await statsResponse.json() as CompanionStats);
  }
  async function saveTts(patch: Record<string, unknown>) {
    const response = await request('/api/tts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 저장하지 못했습니다.'); return; }
    if (!response.ok) { setNotice('음성 설정을 저장하지 못했습니다.'); return; }
    setTts(await response.json() as typeof tts);
    if (patch.elevenLabsApiKey !== undefined) setElevenKeyInput('');
    setNotice('음성 설정을 저장했습니다.');
  }
  async function saveMemory(patch: Record<string, unknown>) {
    const response = await request('/api/memory', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 저장하지 못했습니다.'); return; }
    setNotice(response.ok ? '기억 설정을 저장했습니다.' : '기억 설정을 저장하지 못했습니다.');
    void refresh();
  }
  async function deleteMemory(id: string) {
    const response = await request(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 삭제하지 못했습니다.'); return; }
    setNotice(id === 'all' ? '기억을 모두 삭제했습니다.' : '기억을 삭제했습니다.');
    void refresh();
  }
  async function saveLlm(patch: Partial<LlmSettings> & { apiKey?: string }) {
    const response = await request('/api/llm', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 저장하지 못했습니다.'); return; }
    if (!response.ok) { setNotice('LLM 설정을 저장하지 못했습니다.'); return; }
    setLlm(await response.json() as typeof llm);
    if (patch.apiKey !== undefined) setApiKeyInput('');
    setNotice('LLM 설정을 저장했습니다.');
  }
  async function reloadMacros() {
    const response = await request('/api/macros/reload', { method: 'POST' });
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; }
    const result = await response.json() as MacroStatus;
    setNotice(response.ok ? `매크로 ${result.loaded}건을 다시 읽었습니다.` : `매크로 파일을 읽지 못했습니다: ${result.error ?? '알 수 없는 오류'}`);
    void refresh();
  }
  async function sessionAction(action: 'start' | 'end') { const response = await request(`/api/session/${action}`, { method: 'POST' }); if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; } if (!response.ok) { setNotice('서버가 요청을 거부했습니다.'); return; } setState(await response.json() as BroadcastState); setNotice(action === 'start' ? '방송 세션을 시작했습니다.' : '방송 세션을 종료했습니다.'); }
  async function submitTestChat() { if (!message.trim() || state.status !== 'live') { setNotice('먼저 방송을 시작해 주세요.'); return; } const response = await request('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }) }); if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; } if (!response.ok) { setNotice('이미 들어온 채팅이거나 처리할 수 없는 채팅입니다.'); return; } setState(await response.json() as BroadcastState); setMessage(''); setNotice('채팅을 후보 큐에 넣었습니다.'); }
  async function saveSettings() { const response = await request('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }); if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 저장하지 못했습니다.'); return; } setNotice(response.ok ? '채팅 큐 설정을 저장했습니다.' : '설정을 저장하지 못했습니다.'); }
  async function runTestAction(kind: 'expression' | 'motion', name: string) { const response = await request('/api/live2d/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, name }) }); if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; } if (response.ok) { setState(await response.json() as BroadcastState); setNotice(`${kind === 'expression' ? '표정' : '모션'} ${kind === 'expression' ? boriExpressionLabels[name as keyof typeof boriExpressionLabels] : boriMotionLabels[name as keyof typeof boriMotionLabels]} 실행`); } else setNotice('등록되지 않은 표정·모션입니다.'); }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1500); return () => window.clearInterval(timer); }, []);
  return <main className="admin-shell">
    <header className="admin-header"><div><p className="eyebrow">BORI AI VTUBER</p><h1>보리 방송 관리자</h1></div><span className={`status status-${serverOnline ? state.status : 'offline'}`}>{!serverOnline ? '서버 끊김' : state.status === 'live' ? '방송 중' : '대기 중'}</span></header>
    {!serverOnline && <div className="server-alert"><strong>API 서버에 연결할 수 없습니다.</strong> 방송 시작을 포함한 모든 조작이 동작하지 않습니다. 터미널에서 <code>npm.cmd run dev:server</code>가 실행 중인지 확인하세요. 포트 4310이 이미 사용 중이면 기존 서버를 먼저 종료해야 합니다.</div>}
    <section className="control-grid">
      <article className="panel"><h2>방송 세션</h2><p>관리자가 시작한 동안에만 보리가 채팅 후보를 처리합니다.</p><div className="button-row"><button className="primary" onClick={() => void sessionAction('start')} disabled={!serverOnline || state.status === 'live'}>방송 시작</button><button onClick={() => void sessionAction('end')} disabled={!serverOnline || state.status !== 'live'}>방송 종료</button></div>{serverOnline && state.status === 'live' && <div className="notice">이미 방송 중이라 시작 버튼이 꺼져 있습니다. 다시 시작하려면 먼저 종료하세요.</div>}{notice && <div className="notice">{notice}</div>}</article>
      <article className="panel"><h2>현재 상태</h2><div className="metrics"><div><strong>{state.queueSize}</strong><span>대기 채팅</span></div><div><strong>{state.visibleChatCount}</strong><span>화면 채팅</span></div><div><strong>{state.currentEmotion}</strong><span>감정 상태</span></div></div></article>
    </section>
    <section className="panel"><h2>가상 채팅 테스트</h2><p>초기 단계에서는 닉네임 없이 직접 입력한 채팅으로 흐름을 검증합니다.</p><div className="chat-input-row"><input value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => event.key === 'Enter' && submitTestChat()} placeholder="테스트 채팅을 입력하세요" /><button onClick={submitTestChat}>입력</button></div></section>
    <section className="panel"><h2>채팅 큐 설정</h2><div className="settings-grid"><label>최소 대기(초)<input type="number" min="0" value={settings.responseDelayMinSeconds} onChange={event => setSettings({ ...settings, responseDelayMinSeconds: Number(event.target.value) })} /></label><label>최대 대기(초)<input type="number" min="1" value={settings.responseDelayMaxSeconds} onChange={event => setSettings({ ...settings, responseDelayMaxSeconds: Number(event.target.value) })} /></label><label>최대 큐<input type="number" min="1" value={settings.maxQueueSize} onChange={event => setSettings({ ...settings, maxQueueSize: Number(event.target.value) })} /></label><label>화면 채팅 수<input type="number" min="1" value={settings.visibleChatLimit} onChange={event => setSettings({ ...settings, visibleChatLimit: Number(event.target.value) })} /></label><label>같은 답변 금지(분)<input type="number" min="0" value={settings.sameReplyCooldownMinutes} onChange={event => setSettings({ ...settings, sameReplyCooldownMinutes: Number(event.target.value) })} /></label></div><button className="primary" onClick={() => void saveSettings()}>설정 저장</button></section>
    <section className="panel"><h2>혼잣말</h2><p>채팅이 없을 때만 실행됩니다. 대기 중에 채팅이 들어오면 혼잣말을 건너뛰고 채팅에 먼저 반응합니다.</p><label className="toggle-row"><input type="checkbox" checked={settings.monologueEnabled} onChange={event => setSettings({ ...settings, monologueEnabled: event.target.checked })} /><span>혼잣말 사용</span></label><div className="settings-grid"><label>최소 간격(초)<input type="number" min="5" value={settings.monologueMinSeconds} disabled={!settings.monologueEnabled} onChange={event => setSettings({ ...settings, monologueMinSeconds: Number(event.target.value) })} /></label><label>최대 간격(초)<input type="number" min="5" value={settings.monologueMaxSeconds} disabled={!settings.monologueEnabled} onChange={event => setSettings({ ...settings, monologueMaxSeconds: Number(event.target.value) })} /></label></div><button className="primary" onClick={() => void saveSettings()}>설정 저장</button></section>
    {llm && <section className="panel"><h2>외부 LLM</h2><p>규칙에 없는 채팅만 LLM으로 넘깁니다. 위험 주제는 LLM 호출 전에 차단되고, 응답은 감정·모션 allowlist로 검증한 뒤에만 실행됩니다. 검증에 실패하면 규칙 문장으로 대신 답합니다.</p>
      <label className="toggle-row"><input type="checkbox" checked={llm.settings.enabled} onChange={event => void saveLlm({ enabled: event.target.checked })} /><span>LLM 사용</span></label>
      <div className="settings-grid">
        <label>제공 업체<select value={llm.settings.provider} onChange={event => void saveLlm({ provider: event.target.value as LlmProvider })}>{llm.providers.map(provider => <option key={provider} value={provider}>{provider}</option>)}</select></label>
        <label>모델<input value={llm.settings.model} onChange={event => setLlm({ ...llm, settings: { ...llm.settings, model: event.target.value } })} onBlur={() => void saveLlm({ model: llm.settings.model })} /></label>
        <label>최대 답변 길이<input type="number" min="20" value={llm.settings.maxReplyLength} onChange={event => setLlm({ ...llm, settings: { ...llm.settings, maxReplyLength: Number(event.target.value) } })} onBlur={() => void saveLlm({ maxReplyLength: llm.settings.maxReplyLength })} /></label>
        <label>응답 제한(ms)<input type="number" min="1000" step="500" value={llm.settings.timeoutMs} onChange={event => setLlm({ ...llm, settings: { ...llm.settings, timeoutMs: Number(event.target.value) } })} onBlur={() => void saveLlm({ timeoutMs: llm.settings.timeoutMs })} /></label>
      </div>
      <p className="hint">매 턴 그대로 들어가는 시스템 프롬프트는 {llm.systemPromptChars}자입니다. 이 부분은 검색되지 않고 항상 전달되므로 짧을수록 좋습니다.</p>
      <label className="toggle-row"><input type="checkbox" checked={llm.settings.rollingSummaryEnabled} onChange={event => void saveLlm({ rollingSummaryEnabled: event.target.checked })} /><span>방송 중 누적 요약</span></label>
      <p className="hint">보리는 최근 몇 턴만 그대로 기억합니다. 켜 두면 일정 턴마다 지금까지의 대화를 짧게 접어 문맥에 계속 넣으므로, 긴 방송에서 초반 이야기를 잊지 않습니다. 답변과 별개로 호출되며 답변 속도에는 영향을 주지 않습니다.</p>
      <div className="settings-grid">
        <label>요약 주기(턴)<input type="number" min="4" value={llm.settings.rollingSummaryTurns} disabled={!llm.settings.rollingSummaryEnabled} onChange={event => setLlm({ ...llm, settings: { ...llm.settings, rollingSummaryTurns: Number(event.target.value) } })} onBlur={() => void saveLlm({ rollingSummaryTurns: llm.settings.rollingSummaryTurns })} /></label>
      </div>
      <label className="toggle-row"><input type="checkbox" checked={llm.settings.macroEnabled} onChange={event => void saveLlm({ macroEnabled: event.target.checked })} /><span>키워드 매크로</span></label>
      <p className="hint">채팅에 등록한 키워드가 나오면 해당 설명을 바로 문맥에 붙입니다. 게임 이름이나 캐릭터명처럼 철자가 정해진 대상은 기억 검색보다 정확하고, 임베딩 왕복이 없어 빠릅니다. <code>{llm.macro.path}</code>를 직접 편집한 뒤 다시 읽기를 누르세요.</p>
      <div className="metrics llm-metrics"><div><strong>{llm.macro.loaded}</strong><span>등록된 매크로</span></div><div><strong>{llm.macro.active.length}</strong><span>지금 켜진 것</span></div></div>
      {llm.macro.active.length > 0 && <p className="hint">켜진 매크로: {llm.macro.active.map(entry => `${entry.id}(${entry.remainingTurns}턴)`).join(', ')}</p>}
      {llm.macro.error && <div className="notice">매크로 파일 오류: {llm.macro.error}</div>}
      <button onClick={() => void reloadMacros()}>매크로 다시 읽기</button>
      <div className="chat-input-row"><input type="password" value={apiKeyInput} onChange={event => setApiKeyInput(event.target.value)} placeholder={llm.status.hasApiKey ? 'API 키가 저장되어 있습니다. 바꾸려면 새 키를 입력하세요' : 'API 키를 입력하세요'} /><button onClick={() => void saveLlm({ apiKey: apiKeyInput })} disabled={!apiKeyInput.trim()}>키 저장</button>{llm.status.hasApiKey && <button onClick={() => void saveLlm({ apiKey: '' })}>키 삭제</button>}</div>
      <div className="metrics llm-metrics"><div><strong>{llm.status.hasApiKey ? '있음' : '없음'}</strong><span>API 키</span></div><div><strong>{llm.status.callCount}</strong><span>호출</span></div><div><strong>{llm.status.failureCount}</strong><span>호출 실패</span></div><div><strong>{llm.status.validationFailureCount}</strong><span>검증 실패</span></div><div><strong>{llm.status.averageLatencyMs}ms</strong><span>평균 지연</span></div></div>
      {llm.status.circuitOpen && <div className="notice">연속 실패로 LLM 호출을 잠시 멈췄습니다. {llm.settings.cooldownSeconds}초 뒤 다시 시도합니다.</div>}
      {llm.status.lastError && <div className="notice">마지막 오류: {llm.status.lastError}</div>}
      <p className="hint">API 키는 <code>data/llm-config.json</code>에 저장되며 관리자 화면으로 다시 표시되지 않습니다. 이 파일은 Git에서 제외되어 있습니다.</p>
    </section>}
    {usage && <section className="panel"><h2>API 사용량</h2><p>LLM·임베딩·음성 호출을 기능과 모드별로 셉니다. 숫자만 기록하고 대화 내용은 남기지 않습니다. 비용은 단가표로 계산한 추정치입니다.</p>
      <div className="metrics llm-metrics"><div><strong>{usage.today.totals.calls}</strong><span>오늘 호출</span></div><div><strong>{usage.today.totals.failures}</strong><span>오늘 실패</span></div><div><strong>{formatTokens(usage.today.totals)}</strong><span>오늘 입력/출력 토큰</span></div><div><strong>{usage.today.totals.characters.toLocaleString()}</strong><span>오늘 음성 글자</span></div><div><strong>{formatCost(usage.today.totals.estimatedCostUsd, usage.today.totals.costComplete)}</strong><span>오늘 추정 비용</span></div></div>
      <div className="metrics llm-metrics"><div><strong>{usage.last7Days.totals.calls}</strong><span>7일 호출</span></div><div><strong>{usage.last7Days.totals.failures}</strong><span>7일 실패</span></div><div><strong>{formatTokens(usage.last7Days.totals)}</strong><span>7일 입력/출력 토큰</span></div><div><strong>{usage.last7Days.totals.characters.toLocaleString()}</strong><span>7일 음성 글자</span></div><div><strong>{formatCost(usage.last7Days.totals.estimatedCostUsd, usage.last7Days.totals.costComplete)}</strong><span>7일 추정 비용</span></div></div>
      {usage.last7Days.rows.length > 0 && <table className="usage-table"><thead><tr><th>기능</th><th>모드</th><th>모델</th><th>호출</th><th>실패</th><th>입력/출력 토큰·글자</th><th>7일 추정 비용</th></tr></thead><tbody>{usage.last7Days.rows.map(row => <tr key={`${row.feature}-${row.mode}-${row.model}`}><td>{usageFeatureLabels[row.feature]}</td><td>{usageModeLabels[row.mode]}</td><td>{row.model}</td><td>{row.calls}</td><td>{row.failures}</td><td>{row.feature === 'tts' ? `${row.characters.toLocaleString()}자` : formatTokens(row)}</td><td>{formatRowCost(row)}</td></tr>)}</tbody></table>}
      {usage.last7Days.unpricedModels.length > 0 && <div className="notice">단가 없음: {usage.last7Days.unpricedModels.join(', ')}. 이 모델의 비용은 합계에서 빠졌습니다. <code>data/usage-prices.json</code>에 단가를 넣으면 계산합니다.</div>}
      {usage.prices.fileError && <div className="notice">단가 파일 오류: {usage.prices.fileError} 기본 단가만 씁니다.</div>}
      <p className="hint">{usage.prices.note} 단가 파일 {usage.prices.fileLoaded ? '적용 중' : '없음'}. 금액 뒤의 +는 단가나 토큰 정보가 없어 일부 호출이 빠졌다는 뜻입니다. 최근 31일 호출 {usage.last31Days.totals.calls}회, 추정 {formatCost(usage.last31Days.totals.estimatedCostUsd, usage.last31Days.totals.costComplete)}.</p>
      {companionStats && <><h2 className="subheading">1:1 대화</h2><div className="metrics"><div><strong>{companionStats.conversations}</strong><span>대화</span></div><div><strong>{companionStats.messages}</strong><span>메시지</span></div><div><strong>{companionStats.privateMemories}</strong><span>1:1 기억</span></div></div></>}
    </section>}
    {tts && <section className="panel"><h2>음성 (TTS)</h2><p>보리의 답변을 OpenAI 음성으로 읽습니다. 방송 화면에서 재생되고 입 모양도 소리에 맞춰 움직입니다. LLM과 같은 API 키를 씁니다.</p>
      <label className="toggle-row"><input type="checkbox" checked={tts.settings.enabled} disabled={!tts.hasApiKey} onChange={event => void saveTts({ enabled: event.target.checked })} /><span>음성 사용{!tts.hasApiKey && ' (API 키를 먼저 저장하세요)'}</span></label>
      <div className="settings-grid">
        <label>업체<select value={tts.settings.provider} onChange={event => void saveTts({ provider: event.target.value })}>{tts.providers.map(provider => <option key={provider} value={provider}>{provider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'}</option>)}</select></label>
        <label>목소리<select value={tts.settings.voice} onChange={event => void saveTts({ voice: event.target.value })}>{tts.voices.length === 0 && <option value={tts.settings.voice}>{tts.settings.voice}</option>}{tts.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}{voice.description ? ` — ${voice.description}` : ''}</option>)}</select></label>
        <label>모델<input value={tts.settings.model} onChange={event => setTts({ ...tts, settings: { ...tts.settings, model: event.target.value } })} onBlur={() => void saveTts({ model: tts.settings.model })} /></label>
        <label>합성 실패<input value={`${tts.failureCount}회`} readOnly /></label>
      </div>
      {tts.settings.provider === 'openai'
        ? <div className="settings-grid"><label>속도<input type="number" min="0.25" max="4" step="0.05" value={tts.settings.speed} onChange={event => setTts({ ...tts, settings: { ...tts.settings, speed: Number(event.target.value) } })} onBlur={() => void saveTts({ speed: tts.settings.speed })} /></label></div>
        : <>
          <div className="settings-grid">
            <label>안정성<input type="number" min="0" max="1" step="0.05" value={tts.settings.stability} onChange={event => setTts({ ...tts, settings: { ...tts.settings, stability: Number(event.target.value) } })} onBlur={() => void saveTts({ stability: tts.settings.stability })} /></label>
            <label>유사도<input type="number" min="0" max="1" step="0.05" value={tts.settings.similarity} onChange={event => setTts({ ...tts, settings: { ...tts.settings, similarity: Number(event.target.value) } })} onBlur={() => void saveTts({ similarity: tts.settings.similarity })} /></label>
          </div>
          <div className="chat-input-row"><input type="password" value={elevenKeyInput} onChange={event => setElevenKeyInput(event.target.value)} placeholder={tts.hasElevenLabsKey ? 'ElevenLabs 키가 저장되어 있습니다' : 'ElevenLabs API 키를 입력하세요'} /><button onClick={() => void saveTts({ elevenLabsApiKey: elevenKeyInput })} disabled={!elevenKeyInput.trim()}>키 저장</button>{tts.hasElevenLabsKey && <button onClick={() => void saveTts({ elevenLabsApiKey: '' })}>키 삭제</button>}</div>
          <p className="hint">안정성이 낮을수록 감정 표현이 커지고, 높을수록 톤이 일정해집니다. 목소리 목록은 ElevenLabs 계정에 담긴 것만 나옵니다. Voice Library에서 마음에 드는 목소리를 내 계정에 추가하면 여기에 표시됩니다.</p>
        </>}
      {tts.settings.enabled && <p className="hint">음성이 준비된 뒤에 말풍선이 뜨므로 답변까지 1~2초 더 걸립니다. 합성에 실패하면 소리 없이 방송이 이어집니다.</p>}
      {tts.lastError && <div className="notice">마지막 오류: {tts.lastError}</div>}
    </section>}
    {memory && <section className="panel"><h2>장기 기억</h2><p>방송이 끝날 때 대화에서 취향과 경험을 추려 저장합니다. 다음 방송에서 관련 있는 기억만 골라 보리에게 전달합니다. 위험 주제와 개인정보는 저장하지 않습니다.</p>
      <label className="toggle-row"><input type="checkbox" checked={memory.settings.enabled} onChange={event => void saveMemory({ enabled: event.target.checked })} /><span>기억 사용</span></label>
      <div className="settings-grid">
        <label>전달할 기억 수<input type="number" min="1" max="20" value={memory.settings.maxMemories} onChange={event => setMemory({ ...memory, settings: { ...memory.settings, maxMemories: Number(event.target.value) } })} onBlur={() => void saveMemory({ maxMemories: memory.settings.maxMemories })} /></label>
        <label>최소 유사도<input type="number" min="0" max="1" step="0.05" value={memory.settings.minSimilarity} onChange={event => setMemory({ ...memory, settings: { ...memory.settings, minSimilarity: Number(event.target.value) } })} onBlur={() => void saveMemory({ minSimilarity: memory.settings.minSimilarity })} /></label>
        <label>보관 기간(일)<input type="number" min="1" value={memory.settings.retentionDays} onChange={event => setMemory({ ...memory, settings: { ...memory.settings, retentionDays: Number(event.target.value) } })} onBlur={() => void saveMemory({ retentionDays: memory.settings.retentionDays })} /></label>
        <label>저장된 기억<input value={`${memory.count}건`} readOnly /></label>
      </div>
      {memory.records.length > 0 && <ul className="memory-list">{memory.records.map(record => <li key={record.id}><span className="memory-text">{record.text}</span><span className="memory-meta">{memoryScopeLabels[record.scope] ?? record.scope} · {record.ownerId ?? '소유자 없음'} · 중요도 {record.importance.toFixed(2)} · {record.repeatCount}회</span><button onClick={() => void deleteMemory(record.id)}>삭제</button></li>)}</ul>}
      {memory.count > 0 && <button onClick={() => void deleteMemory('all')}>기억 전체 삭제</button>}
    </section>}
    <section className="panel"><h2>표정·모션 테스트</h2><p>방송 시작 전에도 방송 화면에서 바로 실행됩니다. 표정은 효과를 켠 채 <strong>멈춰 있고</strong>, 모션은 같은 효과를 <strong>계속 움직입니다</strong>. 정지 화면으로는 구분되지 않고 움직임으로만 차이가 납니다.</p><div className="action-group"><span className="action-label">표정<br />정지</span><div className="action-buttons">{boriExpressionNames.map(name => <button key={name} onClick={() => void runTestAction('expression', name)}>{boriExpressionLabels[name]}</button>)}</div></div><div className="action-group"><span className="action-label">모션<br />움직임</span><div className="action-buttons">{boriMotionGroupNames.map(name => <button key={name} onClick={() => void runTestAction('motion', name)}>{boriMotionLabels[name]}</button>)}</div></div><p className="hint">같은 이름이 양쪽에 있으면 모션 버튼이 상위 버전입니다. 예를 들어 화남은 표정 버튼이 김이 멈춘 상태, 모션 버튼이 김이 계속 뿜어지는 상태입니다. 슬픔·어이없음·멍함·긴 머리는 모션이 없어 표정만 있습니다.</p></section>
    <section className="panel"><h2>구현 진행</h2><div className="roadmap"><span className="done">기본 골격</span><span>채팅 큐</span><span>규칙 응답</span><span>Live2D 연결</span><span>LLM 어댑터</span></div></section>
  </main>;
}

// 관리자 화면 마운트. 이 호출이 없으면 index.html의 로딩 문구가 그대로 남는다.
const container = document.getElementById('root');
if (!container) throw new Error('#root element not found in admin index.html');
createRoot(container).render(<StrictMode><AdminApp /></StrictMode>);
