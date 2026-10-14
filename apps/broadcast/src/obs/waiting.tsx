/**
 * OBS waiting 페이지. 방송 시작 전 대기 화면이다. 불투명 배경에 은은한 빛무리가 천천히 움직인다.
 * 방송 제목은 소스 URL의 `?title=`로 바꿀 수 있다. 시즌 이름은 진행기의 집계 기준에서 읽는다.
 */
import { renderObsPage, useBroadcastState } from "./state";

const DEFAULT_TITLE = "보리의 이터널리턴 메타 브리핑";
const title = new URLSearchParams(location.search).get("title")?.trim() || DEFAULT_TITLE;

function WaitingPage() {
  const view = useBroadcastState().show?.dashboard;
  const seasonName = view && "basis" in view ? view.basis?.seasonName : undefined;
  return <main className="obs-fullscreen">
    <div className="obs-glow a" /><div className="obs-glow b" />
    <p className="obs-kicker">AI 버추얼 스트리머 보리</p>
    <h1 className="obs-headline">곧 시작합니다</h1>
    <p className="obs-show-title">{title}</p>
    {seasonName && <span className="obs-season-tag">{seasonName}</span>}
  </main>;
}

renderObsPage(WaitingPage, { transparent: false });
