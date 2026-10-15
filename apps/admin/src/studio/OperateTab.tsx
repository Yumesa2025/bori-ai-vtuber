import { useEffect, useRef, useState } from 'react';
import type { BroadcastState, LlmStatus, ShowState } from '@bori/shared';
import { isSubmitEnter } from '../keys';
import { createPoller, SETTINGS_POLL_MS } from '../poll';
import { readError } from '../form';
import { getJson, isServerUp, JSON_HEADERS, MUTATION_TIMEOUT_MS, openChzzkLogin, postAction, readJson, request, type ChzzkStatusView, type ObsStatusView } from './api';
import { connectionBadge, emptyShowLog, erSummary, isNextShortcut, llmConnection, mergeShowLog, nextLabel, obsUrls, stageLabel, ttsConnection, viewerChatBody, type ConnectionState, type ErStatusView, type ShowLog } from './operate';

/** 운영 탭 폴링 간격. 진행자가 단계·연결을 보고 바로 다음 동작을 정하므로 1초로 받는다. */
const OPERATE_POLL_MS = 1000;

type LlmView = { status: LlmStatus };
type TtsView = { settings: { enabled: boolean; provider: string }; hasApiKey: boolean; failureCount: number; lastError: string | null };

function Connection({ name, state, detail }: { name: string; state: ConnectionState; detail: string }) {
  const badge = connectionBadge(state);
  return <div className="connection-item"><span className="connection-name">{name}</span><span className={`badge badge-${badge.tone}`}>{badge.text}</span><span className="connection-detail">{detail}</span></div>;
}

/** 방송 운영 탭. 단계 진행·연결 상태·데이터 갱신·테스트 채팅·OBS 주소를 한 화면에 둔다. */
export default function OperateTab({ active }: { active: boolean }) {
  const [state, setState] = useState<BroadcastState | null>(null);
  const [show, setShow] = useState<ShowState | null>(null);
  const [serverOnline, setServerOnline] = useState(true);
  const [er, setEr] = useState<ErStatusView | null>(null);
  const [chzzk, setChzzk] = useState<ChzzkStatusView | null>(null);
  const [obs, setObs] = useState<ObsStatusView | null>(null);
  const [llm, setLlm] = useState<LlmView | null>(null);
  const [tts, setTts] = useState<TtsView | null>(null);
  const [log, setLog] = useState<ShowLog>(emptyShowLog);
  const [message, setMessage] = useState('');
  const [nickname, setNickname] = useState('시청자1');
  const [notice, setNotice] = useState('');
  const [moving, setMoving] = useState(false);
  const pollers = useRef<{ status: ReturnType<typeof createPoller>; slow: ReturnType<typeof createPoller> } | null>(null);

  async function refreshStatus() {
    const [stateResponse, nextEr, nextChzzk, nextObs, nextLlm] = await Promise.all([request('/api/state'), getJson<ErStatusView>('/api/er/status'), getJson<ChzzkStatusView>('/api/chzzk/status'), getJson<ObsStatusView>('/api/obs/status'), getJson<LlmView>('/api/llm')]);
    if (!isServerUp(stateResponse)) { setServerOnline(false); return; }
    setServerOnline(true);
    const nextState = stateResponse.ok ? await readJson<BroadcastState & { show?: ShowState }>(stateResponse) : null;
    if (nextState) {
      setState(nextState);
      if (nextState.show) setShow(nextState.show);
      setLog(current => mergeShowLog(current, nextState));
    }
    if (nextEr) setEr(nextEr);
    if (nextChzzk) setChzzk(nextChzzk);
    if (nextObs) setObs(nextObs);
    if (nextLlm) setLlm(nextLlm);
  }
  // 음성 설정(GET /api/tts)은 서버가 업체에 목소리 목록을 물어보므로 드물게 받는다(poll.ts).
  async function refreshSlow() {
    const nextTts = await getJson<TtsView>('/api/tts', MUTATION_TIMEOUT_MS);
    if (nextTts) setTts(nextTts);
  }
  useEffect(() => {
    const status = createPoller(refreshStatus, OPERATE_POLL_MS);
    const slow = createPoller(refreshSlow, SETTINGS_POLL_MS);
    pollers.current = { status, slow };
    return () => { status.stop(); slow.stop(); pollers.current = null; };
  }, []);

  // 버튼 비활성화는 다시 그린 뒤에야 걸리므로, 빠르게 두 번 누른 것은 ref로 막는다.
  const movingRef = useRef(false);
  /** 진행 동작을 보내고 돌려받은 진행 상태로 바로 맞춘다. 한 번에 하나만 보낸다. */
  async function moveShow(action: 'next' | 'prev' | 'reset', done: string) {
    if (movingRef.current) return;
    movingRef.current = true;
    setMoving(true);
    try {
      const response = await postAction(`/api/show/${action}`);
      if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; }
      if (!response.ok) { setNotice(`요청이 거부되었습니다. ${await readError(response, '')}`.trim()); return; }
      const next = await readJson<ShowState>(response);
      if (next) setShow(next);
      setNotice(done);
      pollers.current?.status.runNow();
    } finally {
      movingRef.current = false;
      setMoving(false);
    }
  }
  const stage = show?.stage ?? 'idle';
  const canNext = serverOnline && show !== null && stage !== 'ending' && !moving;
  const goNext = () => { if (canNext) void moveShow('next', `${nextLabel(stage)}을 눌렀습니다.`); };
  function goReset() {
    if (!window.confirm('처음으로 돌아갈까요? 방송 세션이 끝나고 보리는 대기 장면으로 돌아갑니다.')) return;
    void moveShow('reset', '처음으로 돌아갔습니다. 방송 세션을 끝냈습니다.');
  }

  // Space로 다음 단계. 이 탭이 보일 때만, 입력칸·버튼 밖에서만 받는다(operate.ts).
  const nextRef = useRef(goNext);
  nextRef.current = goNext;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!isNextShortcut({ key: event.key, repeat: event.repeat, isComposing: event.isComposing, target })) return;
      event.preventDefault();
      nextRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  async function refreshEr() {
    const response = await postAction('/api/er/refresh');
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; }
    const body = response.ok ? await readJson<{ started: boolean }>(response) : null;
    setNotice(body?.started ? '이터널리턴 데이터 갱신을 시작했습니다. 몇 분 걸릴 수 있습니다.' : '갱신을 시작하지 못했습니다. 이미 갱신 중이거나 ER_API_KEY가 없습니다.');
    pollers.current?.status.runNow();
  }
  async function connectChzzk() { setNotice((await openChzzkLogin()) ?? '기본 브라우저에서 치지직 로그인을 마친 뒤 이 창으로 돌아오세요.'); }
  async function submitTestChat() {
    const body = viewerChatBody(message, nickname);
    if (!body) return;
    if (state?.status !== 'live') { setNotice('먼저 "다음 단계"로 방송을 시작해 주세요.'); return; }
    const response = await request('/api/chat', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, MUTATION_TIMEOUT_MS);
    if (!isServerUp(response)) { setServerOnline(false); setNotice('서버에 연결할 수 없어 요청을 보내지 못했습니다.'); return; }
    if (!response.ok) { setNotice(`채팅을 넣지 못했습니다. ${await readError(response, '이미 들어온 채팅이거나 처리할 수 없는 채팅입니다.')}`); return; }
    setMessage('');
    setNotice(body.nickname ? `${body.nickname}의 채팅을 넣었습니다.` : '익명 채팅을 넣었습니다.');
    pollers.current?.status.runNow();
  }
  async function copyUrl(label: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice(`${label} 주소를 복사했습니다.`);
    } catch {
      setNotice(`복사하지 못했습니다. 주소를 직접 선택해 복사하세요: ${url}`);
    }
  }

  const summary = erSummary(er);
  const llmStatus = llm?.status ?? null;
  return <main className="admin-shell studio-tab">
    {!serverOnline && <div className="server-alert"><strong>서버에 연결할 수 없습니다.</strong> 진행 버튼이 동작하지 않습니다. 스튜디오를 다시 실행하거나 데이터 폴더의 <code>studio-server.log</code>를 확인하세요.</div>}
    <section className="panel stage-panel">
      <div className="stage-head"><div><p className="eyebrow">현재 단계</p><div className="stage-now">{show ? stageLabel(stage) : '확인 중'}</div>{show && <p className="hint">OBS 장면 {show.scene}{state?.status === 'live' ? ' · 방송 세션 중' : ''}</p>}</div></div>
      <div className="button-row">
        <button className="primary stage-next" onClick={goNext} disabled={!canNext}>{nextLabel(stage)}{stage !== 'ending' && <kbd>Space</kbd>}</button>
        <button onClick={() => void moveShow('prev', '이전 단계로 돌아갔습니다. 보리는 다시 말하지 않습니다.')} disabled={!serverOnline || stage === 'idle' || moving}>이전</button>
        <button onClick={goReset} disabled={!serverOnline || moving}>처음으로</button>
      </div>
      {show?.caption && <p className="caption-line">보리: {show.caption}</p>}
      {notice && <div className="notice" role="status">{notice}</div>}
    </section>
    <section className="control-grid">
      <article className="panel"><h2>연결 상태</h2>
        <div className="connection-grid">
          <Connection name="치지직" state={chzzk?.state ?? 'unknown'} detail={chzzk?.lastError ?? chzzk?.channelName ?? ''} />
          <Connection name="OBS" state={obs?.state ?? 'unknown'} detail={obs?.lastError ?? (obs?.currentScene ? `지금 장면: ${obs.currentScene}` : '')} />
          <Connection name="LLM" state={llmConnection(llmStatus)} detail={llmStatus?.lastError ?? llmStatus?.model ?? ''} />
          <Connection name="이터널리턴" state={show?.connections.er ?? 'unknown'} detail={er?.lastError ?? ''} />
          <Connection name="TTS" state={ttsConnection(tts)} detail={tts?.lastError ?? (tts ? `${tts.settings.provider} · 실패 ${tts.failureCount}회` : '')} />
        </div>
        <div className="button-row"><button onClick={() => void connectChzzk()}>치지직 연결</button></div>
        <p className="hint">기본 브라우저로 치지직 로그인이 열립니다. 치지직에 등록한 주소가 <code>localhost:4310</code>이라 기본 포트로 띄운 스튜디오에서만 로그인이 끝납니다.</p>
      </article>
      <article className="panel"><h2>이터널리턴 데이터</h2>
        <div className="er-title">{summary.title}</div>
        <p className="hint">{summary.updated}{summary.description ? ` · ${summary.description}` : ''}</p>
        {summary.progress && <div className="progress" role="progressbar" aria-valuenow={Math.round((er?.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${Math.round((er?.progress ?? 0) * 100)}%` }} /><span>{summary.progress}</span></div>}
        {er?.lastError && <div className="notice">마지막 갱신 오류: {er.lastError}</div>}
        <div className="button-row"><button onClick={() => void refreshEr()} disabled={!serverOnline || er?.refreshing === true}>데이터 갱신</button></div>
        <p className="hint">방송 전에 미리 갱신하세요. 갱신에 실패하면 마지막으로 저장한 데이터를 씁니다.</p>
      </article>
    </section>
    <section className="control-grid">
      <article className="panel"><h2>시청자 채팅</h2><p>리허설에서는 여기서 시청자 채팅을 칩니다. 닉네임은 방송 화면에 나오지 않고 시청자 구분에만 씁니다. 한 시청자의 채팅은 대기열에 3건까지라 여러 개를 빨리 칠 때는 닉네임을 바꿔 주세요.</p>
        <div className="chat-input-row"><input className="chat-nickname" value={nickname} onChange={event => setNickname(event.target.value)} placeholder="닉네임(비우면 익명)" aria-label="시청자 닉네임" maxLength={20} /><input value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (isSubmitEnter(event)) void submitTestChat(); }} placeholder="예: 재키 어때?" aria-label="시청자 채팅" /><button onClick={() => void submitTestChat()}>입력</button></div>
        <h2 className="subheading">최근 채팅·보리 답</h2>
        {log.lines.length === 0 ? <p className="hint">아직 채팅이 없습니다.</p> : <ol className="show-log">{log.lines.map(line => <li key={line.key} className={`log-${line.kind}`}><span>{line.kind === 'chat' ? '채팅' : '보리'}</span>{line.text}</li>)}</ol>}
      </article>
      <article className="panel"><h2>OBS 브라우저 소스 주소</h2><p>OBS 브라우저 소스에 붙여 넣습니다. 크기는 모두 1920×1080입니다. <code>npm run obs:setup</code>을 쓰면 장면과 소스를 한 번에 만듭니다.</p>
        <ul className="obs-urls">{obsUrls(window.location.origin).map(item => <li key={item.name}><span className="obs-label">{item.label}</span><code>{item.url}</code><button onClick={() => void copyUrl(item.label, item.url)}>복사</button></li>)}</ul>
      </article>
    </section>
  </main>;
}
