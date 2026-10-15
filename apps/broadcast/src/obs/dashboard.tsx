/**
 * OBS dashboard 페이지. 화면 오른쪽 큰 패널에 진행 단계별 카드(시즌·TOP 5·캐릭터·전적·요약)를 그린다.
 * 방송 진행기가 꺼져 있으면(show 없음) 아무것도 그리지 않는다.
 */
import type { DashboardView, ErCharacterStat, ErMetaBasis, ErPlayerReport } from "@bori/shared";
import { formatPercent, formatRank, playerStatusText, visibleTop5 } from "./view";
import { renderObsPage, useBroadcastState } from "./state";

function Stat({ label, value, small = false }: { label: string; value: string; small?: boolean }) {
  return <div className="obs-stat"><span className="obs-stat-label">{label}</span><span className={`obs-stat-value${small ? " small" : ""}`}>{value}</span></div>;
}

function SeasonCard({ basis }: { basis: ErMetaBasis | null }) {
  if (!basis) return <div className="obs-pending"><p className="obs-message dim">이터널리턴 데이터를 준비하고 있어요</p></div>;
  return <div className="obs-season">
    <p className="obs-season-name">{basis.seasonName}</p>
    <p className="obs-message">상위 랭커 데이터로 요즘 메타를 살펴봐요</p>
    <ul className="obs-steps"><li>메타 TOP 5</li><li>캐릭터 질문</li><li>!전적 진단</li></ul>
  </div>;
}

function Top5Card({ items, revealed }: { items: ErCharacterStat[]; revealed: number }) {
  const rows = visibleTop5(items, revealed);
  return <>
    <div className="obs-top5-head"><span>순위</span><span>캐릭터</span><span>픽률</span><span>평균 순위</span><span>1등 비율</span><span>주 무기</span></div>
    <ol className="obs-top5">
      {rows.map((item, index) => <li key={item.code} className={`obs-top5-row${index === 0 ? " first" : ""}`}>
        <span className="obs-rank">{index + 1}</span>
        <span>{item.name}</span>
        <span className="obs-num">{formatPercent(item.pickRate)}</span>
        <span className="obs-num">{formatRank(item.avgRank)}</span>
        <span className="obs-num">{formatPercent(item.top1Rate)}</span>
        <span>{item.mainWeapon || "-"}</span>
      </li>)}
    </ol>
  </>;
}

function CharacterCard({ query, stat, suggestions }: { query: string; stat: ErCharacterStat | null; suggestions: string[] }) {
  if (!stat) return <>
    <p className="obs-message">'{query}'은(는) 데이터에서 찾지 못했어요</p>
    {suggestions.length > 0 && <>
      <p className="obs-message dim spaced">혹시 이 캐릭터인가요?</p>
      <ul className="obs-suggestions">{suggestions.map(name => <li key={name}>{name}</li>)}</ul>
    </>}
  </>;
  return <div className="obs-character-card">
    <Stat label="랭커 픽률" value={formatPercent(stat.pickRate)} />
    <Stat label="평균 순위" value={formatRank(stat.avgRank)} />
    <Stat label="1등 비율" value={formatPercent(stat.top1Rate)} />
    <Stat label="주 무기" value={stat.mainWeapon || "-"} small />
  </div>;
}

function PlayerReport({ report }: { report: ErPlayerReport }) {
  return <div className="obs-player">
    <div className="obs-character-card">
      <Stat label="게임 수" value={`${report.games}판`} />
      <Stat label="평균 순위" value={formatRank(report.avgRank)} />
      <Stat label="1등 비율" value={formatPercent(report.top1Rate)} />
    </div>
    <div>
      <p className="obs-sub">최근 경기 순위 (왼쪽이 최신)</p>
      <ul className="obs-ranks">{report.recentRanks.map((rank, index) => <li key={index} className={rank === 1 ? "top" : ""}>{rank}</li>)}</ul>
    </div>
    <div>
      <p className="obs-sub">주력 캐릭터</p>
      <ul className="obs-mains">{report.mainCharacters.map(main => <li key={main.name}>{main.name} <span>{main.games}판 · {formatRank(main.avgRank)}</span></li>)}</ul>
    </div>
  </div>;
}

/** 카드 머리의 제목과 오른쪽 작은 글씨. */
function headOf(view: DashboardView): { title: string; eyebrow: string } {
  switch (view.kind) {
    case "season": return { title: "오늘의 메타 브리핑", eyebrow: "이터널리턴" };
    case "top5": return { title: "랭커 픽 TOP 5", eyebrow: view.basis?.seasonName ?? "" };
    case "character": return { title: view.stat?.name ?? view.query, eyebrow: "캐릭터 카드" };
    case "player": return { title: "전적 진단", eyebrow: view.report ? `${view.report.maskedNickname} · ${view.report.seasonName}` : "" };
    case "summary": return { title: "오늘 나온 캐릭터", eyebrow: "" };
  }
}

function DashboardBody({ view }: { view: DashboardView }) {
  switch (view.kind) {
    case "season": return <SeasonCard basis={view.basis} />;
    case "top5": return <Top5Card items={view.items} revealed={view.revealed} />;
    case "character": return <CharacterCard query={view.query} stat={view.stat} suggestions={view.suggestions} />;
    case "player": {
      const text = playerStatusText(view.status);
      if (text || !view.report) return <div className="obs-pending">{view.status === "loading" && <div className="obs-spinner" aria-hidden="true" />}<p className={`obs-message${view.status === "loading" ? " obs-dots" : ""}`}>{text ?? playerStatusText("not-found")}</p></div>;
      return <PlayerReport report={view.report} />;
    }
    case "summary":
      if (view.characters.length === 0) return <p className="obs-message dim">오늘은 캐릭터 이야기가 없었어요</p>;
      return <ul className="obs-summary">{view.characters.map(name => <li key={name}>{name}</li>)}</ul>;
  }
}

function DashboardPage() {
  const view = useBroadcastState().show?.dashboard;
  if (!view) return null;
  const head = headOf(view);
  // 집계 기준은 화면에 항상 밝힌다(표본 기준이라는 한계).
  const basis = "basis" in view ? view.basis : null;
  // 카드 종류가 바뀌면 새로 그려 등장 애니메이션이 다시 돈다.
  return <section className="obs-dashboard obs-panel" key={view.kind}>
    <header className="obs-dashboard-head"><h1 className="obs-title">{head.title}</h1>{head.eyebrow && <span className="obs-eyebrow">{head.eyebrow}</span>}</header>
    <div className="obs-dashboard-body"><DashboardBody view={view} /></div>
    {basis && <p className="obs-basis">{basis.description}</p>}
  </section>;
}

renderObsPage(DashboardPage, { transparent: true });
