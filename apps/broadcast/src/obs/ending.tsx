/**
 * OBS ending 페이지. 오늘 이야기한 캐릭터(진행기의 summary)와 마무리 인사를 불투명 배경에 그린다.
 */
import { renderObsPage, useBroadcastState } from "./state";

function EndingPage() {
  const view = useBroadcastState().show?.dashboard;
  const characters = view?.kind === "summary" ? view.characters : [];
  return <main className="obs-fullscreen">
    <div className="obs-glow a" /><div className="obs-glow b" />
    <p className="obs-kicker">오늘 나온 캐릭터</p>
    {characters.length > 0
      ? <ul className="obs-summary obs-ending-list">{characters.map(name => <li key={name}>{name}</li>)}</ul>
      : <p className="obs-show-title">오늘은 캐릭터 이야기가 없었어요</p>}
    <h1 className="obs-headline">함께해 줘서 고마워요</h1>
    <p className="obs-thanks">다음 방송에서 또 만나요!</p>
  </main>;
}

renderObsPage(EndingPage, { transparent: false });
