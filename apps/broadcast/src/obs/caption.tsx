/**
 * OBS caption 페이지. 화면 오른쪽 아래 흰 말풍선에 보리 자막을 두 줄씩 보여 준다.
 * 진행기의 자막이 있으면 그것, 없으면 보리의 현재 답이다.
 * 말풍선은 세 줄이 들어가는 크기라, 브라우저가 두 줄 묶음을 한 줄 더 길게 감싸도 잘리지 않는다(2026-10-15 사용자 요청: 세 줄로 나누면 아래가 계속 잘렸다).
 * 두 줄을 넘는 답은 두 줄 묶음으로 나눠 말하는 시간(currentSpeechMs)에 맞춰 차례로 넘긴다.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { captionPageDurations, captionText, paginateCaption } from "./view";
import { renderObsPage, useBroadcastState } from "./state";

/** 한 번에 보여 줄 줄 수. 말풍선(obs.css)은 한 줄 여유를 두고 세 줄 크기다. */
const CAPTION_LINES = 2;
/** 음성 길이를 모를 때 쓰는 말하는 시간(서버 말풍선 표시 시간과 같다). */
const FALLBACK_SPEECH_MS = 5000;

function CaptionPage() {
  const state = useBroadcastState();
  const text = captionText(state);
  const speechMs = state.currentSpeechMs ?? FALLBACK_SPEECH_MS;
  const box = useRef<HTMLParagraphElement>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [index, setIndex] = useState(0);

  // 말풍선의 실제 글꼴과 안쪽 폭으로 잰다. 배치(obs.css)가 바뀌어도 따라간다.
  useLayoutEffect(() => {
    setIndex(0);
    if (!text) { setPages([]); return; }
    const element = box.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!element || !context) { setPages([text]); return; }
    const style = getComputedStyle(element);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    // 브라우저 줄바꿈과 canvas 폭이 조금 달라 네 줄로 넘치면 아래가 잘린다. 폭을 6% 좁게 잡아 세 줄 안에 넣는다.
    const width = (element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) * 0.94;
    setPages(paginateCaption(text, value => context.measureText(value).width, width, CAPTION_LINES));
  }, [text]);

  useEffect(() => {
    if (pages.length <= 1) return;
    const durations = captionPageDurations(pages, speechMs);
    const timers: number[] = [];
    let at = 0;
    for (let page = 1; page < pages.length; page += 1) {
      at += durations[page - 1];
      timers.push(window.setTimeout(() => setIndex(page), at));
    }
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [pages, speechMs]);

  if (!text) return null;
  // 처음 재기 전에는 전체 글로 그려 폭을 얻는다.
  return <p className="obs-caption" key={`${text}#${index}`} ref={box}>{pages[index] ?? text}</p>;
}

renderObsPage(CaptionPage, { transparent: true });
