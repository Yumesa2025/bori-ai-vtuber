/**
 * OBS chat 페이지. 대시보드 아래 띠에 최근 채팅 4줄을 보여 준다.
 * 닉네임은 표시하지 않는다(방송 화면 규칙). !전적 같은 명령은 금빛으로 강조한다.
 */
import { chatStripLines } from "./view";
import { renderObsPage, useBroadcastState } from "./state";

function ChatPage() {
  const lines = chatStripLines(useBroadcastState().visibleChats);
  if (lines.length === 0) return null;
  return <section className="obs-chat obs-panel" aria-label="채팅">
    {lines.map(line => <p key={line.id} className={`obs-chat-line${line.command ? " command" : ""}`}>{line.text}</p>)}
  </section>;
}

renderObsPage(ChatPage, { transparent: true });
