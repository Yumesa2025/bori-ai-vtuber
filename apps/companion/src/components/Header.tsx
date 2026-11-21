import type { DashboardState } from "@bori/shared";
import { connectionBadge, refreshView } from "../dashboard";
import { formatCollectedAt, formatCount } from "../format";

type Props = { state: DashboardState | null; requesting: boolean; notice: string | null; onRefresh: () => void };

/** 위 띠: 기준 정보, 데이터 상태 배지, 갱신 버튼과 진행률(설계 2.1). */
export function Header({ state, requesting, notice, onRefresh }: Props) {
  const basis = state?.basis ?? null;
  const badge = state ? connectionBadge(state) : { tone: "muted" as const, label: "불러오는 중" };
  const view = state ? refreshView(state) : null;
  const message = notice ?? view?.notice ?? null;

  return (
    <header className="dash-header">
      <div className="dash-title">
        <h1>보리의 이터널리턴 메타</h1>
        <span className={`badge badge-${badge.tone}`} role="status">{badge.label}</span>
        {basis?.patchChanged && <span className="badge badge-warn" title="직전 갱신과 시즌이나 패치가 달라요. 지난번 대비 수치는 참고만 해 주세요.">패치 바뀜</span>}
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
            <div className="progress-bar" style={{ width: `${Math.round((view.progress ?? 0.05) * 100)}%` }} />
            <span>{view.progressText}</span>
          </div>
        )}
        <button type="button" className="primary-button" disabled={!view || view.disabled || requesting} onClick={onRefresh}>{view?.buttonLabel ?? "갱신"}</button>
      </div>
      {message && <p className={`header-notice${state && !state.refresh.available ? " header-notice-error" : ""}`} role="alert">{message}</p>}
    </header>
  );
}
