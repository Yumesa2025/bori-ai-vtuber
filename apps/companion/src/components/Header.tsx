import type { DashboardState } from "@bori/shared";
import { connectionBadge, headerNotices, refreshView } from "../dashboard";
import { formatCollectedAt, formatCount } from "../format";

type Props = { state: DashboardState | null; requesting: boolean; loadNotice: string | null; actionNotice: string | null; onRefresh: () => void };

/** 위 띠: 기준 정보, 데이터 상태 배지, 갱신 버튼과 진행률(설계 2.1). */
export function Header({ state, requesting, loadNotice, actionNotice, onRefresh }: Props) {
  const basis = state?.basis ?? null;
  const badge = state ? connectionBadge(state) : { tone: "muted" as const, label: "불러오는 중" };
  const view = state ? refreshView(state) : null;
  // 받기 오류·버튼 안내·상태 안내(키 없음·지난 실패)를 모두 보인다. 하나가 다른 것을 가리지 않는다.
  const messages = headerNotices({ load: loadNotice, action: actionNotice, view: view?.notice ?? null });

  return (
    <header className="dash-header">
      <div className="dash-header-row">
        <div className="dash-title">
          <svg className="brand-mark" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
            <rect x="3" y="13" width="4" height="8" rx="1" />
            <rect x="10" y="8" width="4" height="13" rx="1" />
            <rect x="17" y="3" width="4" height="18" rx="1" />
          </svg>
          <h1>보리의 이터널리턴 메타</h1>
          <span className={`badge badge-${badge.tone}`} role="status"><i className="badge-dot" aria-hidden="true" />{badge.label}</span>
          {basis?.patchChanged && <span className="badge badge-warn" title="직전 갱신과 시즌이나 패치가 달라요. 지난번 대비 수치는 참고만 해 주세요."><i className="badge-dot" aria-hidden="true" />패치 바뀜</span>}
        </div>
        <dl className="basis">
          {basis ? (
            <>
              <div><dt>시즌</dt><dd>{basis.seasonName}</dd></div>
              <div><dt>패치</dt><dd>{basis.patch ?? "—"}</dd></div>
              <div><dt>경기</dt><dd>{formatCount(basis.games)}판</dd></div>
              <div><dt>참가자</dt><dd>{formatCount(basis.participants)}명</dd></div>
              <div><dt>표본</dt><dd>랭커 {formatCount(basis.rankers)}명 × {basis.gamesPerRanker}판</dd></div>
              <div><dt>수집</dt><dd>{formatCollectedAt(basis.collectedAt)}</dd></div>
            </>
          ) : (
            <div><dt>기준</dt><dd>{state ? "아직 집계한 데이터가 없어요" : "—"}</dd></div>
          )}
        </dl>
        <div className="refresh">
          {view?.progressText && (
            <div className="progress" role="progressbar" aria-label="갱신 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.progress === null ? undefined : Math.round(view.progress * 100)}>
              <span className="progress-text">{view.progressText}</span>
              <span className="progress-track"><span className="progress-bar" style={{ width: `${Math.round((view.progress ?? 0.05) * 100)}%` }} /></span>
            </div>
          )}
          <button type="button" className="primary-button" disabled={!view || view.disabled || requesting} onClick={onRefresh}>
            <svg className={`refresh-icon${view?.progressText ? " spinning" : ""}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M12.6 1.8v2.9H9.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {view?.buttonLabel ?? "갱신"}
          </button>
        </div>
      </div>
      {messages.map(message => (
        <p key={message} className={`header-notice${state && !state.refresh.available ? " header-notice-error" : ""}`} role="alert" title={message === view?.notice ? view.noticeDetail : undefined}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 4.5v4.2M8 11.2v.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          <span>{message}</span>
        </p>
      ))}
    </header>
  );
}
