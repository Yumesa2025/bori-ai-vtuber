/**
 * OBS character 페이지. 보리 Live2D를 화면 왼쪽 1/3에 투명 배경으로 그리고 TTS 음성을 낸다.
 * OBS에서 이 소스만 "Control audio via OBS"를 켠다.
 */
import { useEffect, useRef, useState } from "react";
import type { ModelStatus } from "../live2d-status";
import { createLive2DStage, type Live2DStage } from "../live2d/stage";
import { renderObsPage, useBroadcastState } from "./state";

function CharacterPage() {
  const state = useBroadcastState();
  const [stage, setStage] = useState<Live2DStage | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: "loading", message: "모델 확인 중" });
  const [audioBlocked, setAudioBlocked] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // 렌더러는 전역 싱글톤이라 StrictMode의 첫 실행은 취소하고 정리한다(옛 방송 화면과 같다).
  useEffect(() => {
    const signal = { cancelled: false };
    let created: Live2DStage | null = null;

    createLive2DStage(container.current!, { transparent: true, signal, onAudioBlockedChange: setAudioBlocked })
      .then(next => {
        if (signal.cancelled) { next.dispose(); return; }
        created = next;
        setStage(next);
        setModelStatus(next.status());
      })
      .catch(error => {
        if (signal.cancelled) return;
        console.error(error);
        setModelStatus({ state: "failed", message: error instanceof Error ? error.message : "Live2D를 초기화하지 못했습니다." });
      });

    return () => { signal.cancelled = true; created?.dispose(); };
  }, []);

  useEffect(() => {
    if (!stage) return;
    const response = state.currentResponse;
    if (!response) { stage.clearResponse(); return; }
    void stage.applyResponse(response, state.currentAudioId ? `/api/tts/${state.currentAudioId}` : undefined);
  }, [stage, state.currentResponse, state.currentAudioId]);

  useEffect(() => {
    const latest = state.visibleChats.at(-1);
    if (latest) stage?.noticeChat(latest.id);
  }, [stage, state.visibleChats]);

  useEffect(() => {
    if (state.lastTestAction) stage?.applyTestAction(state.lastTestAction);
  }, [stage, state.lastTestAction]);

  useEffect(() => {
    if (state.status !== "live") stage?.resetEmotion();
  }, [stage, state.status]);

  // 진단 배지와 "소리 켜기"는 문제가 있을 때만 보인다. OBS는 자동 재생을 막지 않으므로 송출 화면에는 평소 아무것도 없다.
  return <>
    <div className="obs-character" ref={container} />
    {modelStatus.state === "failed" && <div className="obs-badge" role="status">{modelStatus.message}</div>}
    {audioBlocked && <button className="obs-audio-unlock" onClick={() => stage?.unlockAudio()}>소리 켜기</button>}
  </>;
}

renderObsPage(CharacterPage, { transparent: true });
