/**
 * OBS chat 페이지. 대시보드 아래 띠에 최근 채팅 4줄을 보여 준다.
 * 닉네임은 표시하지 않는다(방송 화면 규칙). !전적 같은 명령은 금빛으로 강조한다.
 * 채팅이 없어도 띠는 남기고 단계별 참여 안내를 보여 준다.
 */
import { chatEmptyHint, chatStripLines } from "./view";
import { renderObsPage, useBroadcastState } from "./state";

function ChatPage() {
  const state = useBroadcastState();
  const lines = chatStripLines(state.visibleChats);
  return <section className="obs-chat obs-panel" aria-label="채팅">
    {lines.length === 0
      ? <p className="obs-chat-empty">{chatEmptyHint(state.show?.stage)}</p>
      : lines.map(line => <p key={line.id} className={`obs-chat-line${line.command ? " command" : ""}`}>{line.text}</p>)}
  </section>;
}

renderObsPage(ChatPage, { transparent: true });
