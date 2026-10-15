/**
 * OBS background 페이지. 메인·전적 장면 맨 아래에 깔리는 불투명 배경이다.
 * 다른 메인 페이지는 투명이라 이것이 없으면 송출 화면이 검은 바탕이 된다. 대기·엔딩과 같은 빛무리를 쓴다.
 */
import { renderObsPage } from "./state";

function BackgroundPage() {
  return <main className="obs-fullscreen">
    <div className="obs-glow a" /><div className="obs-glow b" />
  </main>;
}

renderObsPage(BackgroundPage, { transparent: false });
