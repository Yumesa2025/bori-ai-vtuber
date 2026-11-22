import { useCallback, useEffect, useRef, useState } from "react";
import type { Narration } from "@bori/shared";
import { api, describeError } from "../api";
import { shouldAutoPlay } from "../dashboard";
import { formatCollectedAt } from "../format";
import { useBoriLive2D } from "../live2d/useBoriLive2D";
import { createGeneration, createPlayback, type Playback } from "../narration-player";
import { loadLastNarrationId, saveLastNarrationId } from "../preferences";
import { speechNotice, TEMPLATE_NARRATION_HINT } from "../ui";
import { StagePortrait } from "./StagePortrait";

type Props = {
  narration: Narration | null;
  ttsEnabled: boolean;
  onToggleTts: () => void;
  onSpokenLine: (line: string | null) => void;
  /** 화면이 보이고 스튜디오 탭도 활성인지. 아니면 자동 읽기를 미룬다 */
  visible: boolean;
  /** 스튜디오에서 대시보드 탭이 활성인지. 다른 탭으로 가면 읽던 대사를 멈춘다(Codex C2 6절) */
  tabActive: boolean;
};

/** 자동 읽기를 시작하기 전 잠깐 기다린다. 개발 모드 StrictMode가 effect를 두 번 돌려도 한 번만 읽게 한다. */
const AUTO_PLAY_DELAY_MS = 300;

/**
 * 왼쪽 칸: 보리 Live2D, 지금 읽는 줄 자막, 다시 듣기.
 * 새 대사가 오면 한 번 자동으로 읽는다(음성 켜기 설정을 따른다). 줄마다 감정을 Live2D 표정에 보낸다.
 * 모델 파일이 없으면 캐릭터는 안 보여도 자막과 음성은 그대로 나온다.
 *
 * 재생은 재생 제어기(createPlayback)가 맡는다(Codex C2 4·5·7).
 * - 음성 켜기·끄기를 바꾸면 지금 줄부터 바로 맞춘다.
 * - 새 대사가 재생을 바꾸면 이전 재생의 콜백은 무시한다.
 * - 언마운트하면 전체 재생을 취소하고, 늦게 온 다시 듣기 응답은 무시한다.
 */
export function Narrator({ narration, ttsEnabled, onToggleTts, visible, tabActive, onSpokenLine }: Props) {
  const live2d = useBoriLive2D();
  const [shown, setShown] = useState<Narration | null>(narration);
  const [lineIndex, setLineIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const ttsRef = useRef(ttsEnabled);
  ttsRef.current = ttsEnabled;
  const live2dRef = useRef(live2d);
  live2dRef.current = live2d;
  const playbackRef = useRef<Playback | null>(null);
  const replayGeneration = useRef(createGeneration()).current;

  // 재생 제어기는 마운트마다 만들고 언마운트 때 해제한다. 개발 모드 StrictMode가 effect를 두 번 돌려도 새로 만든다.
  useEffect(() => {
    const playback = createPlayback({
      react: emotion => live2dRef.current.react({ primary: emotion }),
      speak: (line, useAudio) => live2dRef.current.speakLine(line.text, useAudio ? line.audioId : undefined),
      onLine: setLineIndex,
      stopSpeech: () => live2dRef.current.stopSpeech(),
    });
    playbackRef.current = playback;
    return () => {
      playback.dispose();
      playbackRef.current = null;
      replayGeneration.invalidate();
    };
  }, [replayGeneration]);

  // 재생 중이 아니면 최신 대사를 보여 준다.
  useEffect(() => { if (!playing) setShown(narration); }, [narration, playing]);

  // 음성 켜기·끄기는 읽는 중인 줄에도 바로 맞춘다(Codex C2 4절).
  useEffect(() => { playbackRef.current?.audioModeChanged(); }, [ttsEnabled]);

  const stop = useCallback(() => {
    playbackRef.current?.stop();
    setPlaying(false);
    setLineIndex(null);
  }, []);

  const play = useCallback(async (target: Narration) => {
    const playback = playbackRef.current;
    if (!playback) return;
    setShown(target);
    setPlaying(true);
    setNotice(null);
    const result = await playback.play(target.lines, () => ttsRef.current);
    // 멈춤·다른 재생으로 바뀜·해제는 그쪽에서 화면을 정리한다.
    if (result === "cancelled") return;
    setPlaying(false);
    setNotice(speechNotice(result));
  }, []);

  // 스튜디오에서 다른 탭으로 가면 숨긴 화면 뒤에서 읽지 않게 멈춘다(Codex C2 6절).
  useEffect(() => { if (!tabActive && playbackRef.current?.playing) stop(); }, [tabActive, stop]);

  // 새 대사는 한 번만 자동으로 읽는다. 캐릭터 준비(또는 모델 없음 확정)를 기다려 첫 표정부터 맞춘다.
  // 화면이 보이지 않으면 미룬다. 숨긴 채 읽고 "읽음"으로 저장하면 돌아왔을 때 다시 읽지 않는다.
  const narrationId = narration?.id;
  const live2dSettled = live2d.status.state !== "loading";
  useEffect(() => {
    if (!narration || !live2dSettled || !shouldAutoPlay(narration, loadLastNarrationId(), visible)) return;
    const timer = window.setTimeout(() => {
      saveLastNarrationId(narration.id);
      void play(narration);
    }, AUTO_PLAY_DELAY_MS);
    return () => window.clearTimeout(timer);
    // narration 객체는 폴링마다 새로 오므로 id로만 판단한다.
  }, [narrationId, live2dSettled, play, visible]);

  // 응답이 언마운트 뒤나 다음 요청 뒤에 늦게 오면 무시한다(Codex C2 7절).
  const replay = async () => {
    const generation = replayGeneration.next();
    setReplaying(true);
    try {
      const latest = await api.replayNarration();
      if (!replayGeneration.isCurrent(generation)) return;
      saveLastNarrationId(latest.id);
      void play(latest);
    } catch (error) {
      if (replayGeneration.isCurrent(generation)) setNotice(describeError(error));
    } finally {
      if (replayGeneration.isCurrent(generation)) setReplaying(false);
    }
  };

  const lines = shown?.lines ?? [];
  const current = lineIndex === null ? null : lines[lineIndex] ?? null;

  useEffect(() => { onSpokenLine(current?.text ?? null); }, [current?.text, onSpokenLine]);

  return (
    <section className="narrator" aria-label="보리">
      <div className="character-stage">
        <div className="stage-heading">
          <h2>보리</h2>
          {current && <span className="stage-speaking"><span aria-hidden="true" />읽는 중</span>}
        </div>
        {live2d.status.state !== "ready" && <StagePortrait />}
        <div className="live2d-layer" ref={live2d.layerRef} />
        {live2d.status.state !== "ready" && <p className="character-badge" role="status">{live2d.status.message}</p>}
      </div>
      <div className="subtitle" aria-live="polite" data-speaking={current !== null}>
        {current ? <p className="subtitle-now">{current.text}</p> : <p className="subtitle-idle">{lines.length > 0 ? "다시 듣기를 누르면 보리가 다시 읽어 드려요." : "데이터를 갱신하면 보리가 분석을 읽어 드려요."}</p>}
      </div>
      <div className="narrator-actions">
        {playing
          ? <button type="button" className="ghost-button" onClick={stop}>멈추기</button>
          : <button type="button" className="primary-button" disabled={!narration || replaying} onClick={() => void replay()}>다시 듣기</button>}
        {/* 이름은 "음성"으로 고정하고 켜짐 여부는 aria-pressed로 알린다. 글자와 상태가 겹쳐 읽히지 않게 한다. */}
        <button type="button" className="ghost-button toggle-button" aria-pressed={ttsEnabled} onClick={onToggleTts}>음성<span className="toggle-state" aria-hidden="true">{ttsEnabled ? "켬" : "끔"}</span></button>
      </div>
      {lines.length > 0 && (
        <details className="script-panel" open>
          <summary>보리 대사</summary>
          <ol className="script" aria-label="보리 대사">
            {lines.map((line, index) => <li key={index} aria-current={index === lineIndex ? "true" : undefined}>{line.text}</li>)}
          </ol>
        </details>
      )}
      {shown && <p className="narrator-hint">{formatCollectedAt(shown.createdAt)} 분석{shown.source === "template" ? ` · ${TEMPLATE_NARRATION_HINT}` : ""}</p>}
      {notice && <p className="narrator-notice" role="status">{notice}</p>}
    </section>
  );
}
