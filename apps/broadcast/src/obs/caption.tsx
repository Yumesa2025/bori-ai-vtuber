/**
 * OBS caption 페이지. 화면 아래 가운데 흰 말풍선에 보리 자막을 두 줄까지 보여 준다.
 * 진행기의 자막이 있으면 그것, 없으면 보리의 현재 답이다.
 */
import { captionText } from "./view";
import { renderObsPage, useBroadcastState } from "./state";

function CaptionPage() {
  const text = captionText(useBroadcastState());
  if (!text) return null;
  return <p className="obs-caption" key={text}>{text}</p>;
}

renderObsPage(CaptionPage, { transparent: true });
