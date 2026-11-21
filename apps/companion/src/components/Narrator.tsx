import { useCallback, useEffect, useRef, useState } from "react";
import type { Narration } from "@bori/shared";
import { api, describeError } from "../api";
import { shouldAutoPlay } from "../dashboard";
import { formatCollectedAt } from "../format";
import { useBoriLive2D } from "../live2d/useBoriLive2D";
import { playNarration } from "../narration-player";
import { loadLastNarrationId, saveLastNarrationId } from "../preferences";
import { speechNotice, TEMPLATE_NARRATION_HINT } from "../ui";

type Props = { narration: Narration | null; ttsEnabled: boolean; onToggleTts: () => void; visible: boolean };

/** 자동 읽기를 시작하기 전 잠깐 기다린다. 개발 모드 StrictMode가 effect를 두 번 돌려도 한 번만 읽게 한다. */
const AUTO_PLAY_DELAY_MS = 300;

/**
 * 왼쪽 칸: 보리 Live2D, 지금 읽는 줄 자막, 다시 듣기.
 * 새 대사가 오면 한 번 자동으로 읽는다(음성 켜기 설정을 따른다). 줄마다 감정을 Live2D 표정에 보낸다.
 * 모델 파일이 없으면 캐릭터는 안 보여도 자막과 음성은 그대로 나온다.
 */
export function Narrator({ narration, ttsEnabled, onToggleTts, visible }: Props) {
  const live2d = useBoriLive2D();
  const [shown, setShown] = useState<Narration | null>(narration);
  const [lineIndex, setLineIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const signalRef = useRef<{ cancelled: boolean }>({ cancelled: true });
  const ttsRef = useRef(ttsEnabled);
  ttsRef.current = ttsEnabled;
  const { react, speakLine, stopSpeech } = live2d;

  // 재생 중이 아니면 최신 대사를 보여 준다.
  useEffect(() => { if (!playing) setShown(narration); }, [narration, playing]);

  const stop = useCallback(() => {
    signalRef.current.cancelled = true;
    stopSpeech();
  }, [stopSpeech]);

  const play = useCallback(async (target: Narration) => {
    stop();
    const signal = { cancelled: false };
    signalRef.current = signal;
    setShown(target);
    setPlaying(true);
    setNotice(null);
    const result = await playNarration(target.lines, {
      react: emotion => react({ primary: emotion }),
      speak: (line, useAudio) => speakLine(line.text, useAudio ? line.audioId : undefined),
      onLine: setLineIndex,
    }, { audio: ttsRef.current, signal });
    if (signalRef.current === signal) {
      setPlaying(false);
      setNotice(speechNotice(result));
    }
  }, [react, speakLine, stop]);

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

  const replay = async () => {
    setReplaying(true);
    try {
      const latest = await api.replayNarration();
      saveLastNarrationId(latest.id);
      void play(latest);
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setReplaying(false);
    }
  };

  const lines = shown?.lines ?? [];
  const current = lineIndex === null ? null : lines[lineIndex] ?? null;

  return (
    <section className="narrator" aria-label="보리">
      <div className="character-stage">
        <div className="live2d-layer" ref={live2d.layerRef} />
        {live2d.status.state !== "ready" && <p className="character-badge" role="status">{live2d.status.message}</p>}
      </div>
      <div className="subtitle" aria-live="polite">
        {current ? <p className="subtitle-now">{current.text}</p> : <p className="subtitle-idle">{lines.length > 0 ? "다시 듣기를 누르면 보리가 다시 읽어 드려요." : "데이터를 갱신하면 보리가 분석을 읽어 드려요."}</p>}
      </div>
      {lines.length > 0 && (
        <ol className="script" aria-label="보리 대사">
          {lines.map((line, index) => <li key={index} className={index === lineIndex ? "now" : ""}>{line.text}</li>)}
        </ol>
      )}
      {shown && <p className="narrator-hint">{formatCollectedAt(shown.createdAt)} 분석{shown.source === "template" ? ` · ${TEMPLATE_NARRATION_HINT}` : ""}</p>}
      {notice && <p className="narrator-notice" role="status">{notice}</p>}
      <div className="narrator-actions">
        {playing
          ? <button type="button" className="ghost-button" onClick={() => { stop(); setPlaying(false); setLineIndex(null); }}>멈추기</button>
          : <button type="button" className="primary-button" disabled={!narration || replaying} onClick={() => void replay()}>다시 듣기</button>}
        {/* 이름은 "음성"으로 고정하고 켜짐 여부는 aria-pressed로 알린다. 글자와 상태가 겹쳐 읽히지 않게 한다. */}
        <button type="button" className="ghost-button toggle-button" aria-pressed={ttsEnabled} onClick={onToggleTts}>음성<span className="toggle-state" aria-hidden="true">{ttsEnabled ? "켬" : "끔"}</span></button>
      </div>
    </section>
  );
}
