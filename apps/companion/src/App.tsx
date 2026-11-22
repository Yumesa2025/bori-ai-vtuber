import { useMemo, useState } from "react";
import type { ErComboStat } from "@bori/shared";
import { comboKey } from "./dashboard";
import { loadTtsEnabled, saveTtsEnabled } from "./preferences";
import { useDashboard } from "./useDashboard";
import { CharacterDetail } from "./components/CharacterDetail";
import { Header } from "./components/Header";
import { MetaTable } from "./components/MetaTable";
import { Movers } from "./components/Movers";
import { Narrator } from "./components/Narrator";
import { PlayerCard } from "./components/PlayerCard";
import { Spotlight } from "./components/Spotlight";

/**
 * 이터널리턴 메타 대시보드(설계 2.1). 1920×1080 창 기준.
 * 위 띠: 기준·상태·갱신 / 왼쪽: 보리 / 가운데: 메타 1위·오르고 내린 조합(위), 메타 TOP(아래) / 오른쪽: 캐릭터 상세·내 전적
 */
export function App() {
  const { state, disconnected, loadNotice, actionNotice, requesting, refresh, reload, visible, tabActive } = useDashboard();
  const [ttsEnabled, setTtsEnabled] = useState(loadTtsEnabled);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const combos = useMemo(() => state?.combos ?? [], [state]);

  // 고른 조합이 새 집계에 없으면(또는 아직 고르지 않았으면) 픽률 1위 조합을 보여 준다.
  const selected = combos.find(combo => comboKey(combo) === selectedKey) ?? combos.find(combo => !combo.lowSample) ?? combos[0] ?? null;
  const select = (combo: ErComboStat) => setSelectedKey(comboKey(combo));

  const toggleTts = () => setTtsEnabled(current => { saveTtsEnabled(!current); return !current; });

  return (
    <div className="dashboard-shell">
      {disconnected && (
        <div className="connection-banner" role="alert">
          <span>서버에 연결할 수 없어요. 서버가 켜져 있는지 확인해 주세요.{state ? " 지난 화면을 보여 드리고 있어요." : ""}</span>
          <button type="button" className="ghost-button" onClick={() => void reload()}>다시 연결</button>
        </div>
      )}
      <Header state={state} requesting={requesting} loadNotice={loadNotice} actionNotice={actionNotice} onRefresh={() => void refresh()} />
      <main className="dashboard-body">
        <Narrator narration={state?.narration ?? null} ttsEnabled={ttsEnabled} onToggleTts={toggleTts} visible={visible} tabActive={tabActive} />
        {/* 큰 창에서는 칸으로 펼치고(display: contents), 좁은 창에서는 이 둘만 세로로 스크롤한다. 보리 칸은 늘 보인다. */}
        <div className="dashboard-main">
          <div className="dashboard-center">
            <div className="overview">
              <Spotlight combos={combos} onSelect={select} />
              <Movers combos={combos} onSelect={select} />
            </div>
            <MetaTable combos={combos} basis={state?.basis ?? null} selectedKey={selected ? comboKey(selected) : null} onSelect={select} />
          </div>
          <div className="dashboard-side">
            <CharacterDetail combos={combos} selected={selected} onSelect={select} />
            <PlayerCard player={state?.player ?? null} erAvailable={state?.refresh.available ?? true} />
          </div>
        </div>
      </main>
    </div>
  );
}
