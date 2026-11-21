import { useState } from 'react';
import DashboardTab from './DashboardTab';
import SettingsTab from './SettingsTab';

type TabId = 'dashboard' | 'settings';
const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'settings', label: '설정' },
];

/**
 * 보리 스튜디오. 대시보드·설정 두 탭.
 * 설정 탭은 처음 열 때 만들고 그 뒤에는 숨기기만 한다. 탭을 오가도 대시보드 화면과 설정 폼의 입력이 사라지지 않는다.
 * 숨긴 대시보드 iframe은 문서 가시성이 그대로라 탭 활성 상태를 따로 알린다(DashboardTab).
 */
export default function StudioApp() {
  const [current, setCurrent] = useState<TabId>('dashboard');
  const [opened, setOpened] = useState<ReadonlySet<TabId>>(() => new Set(['dashboard']));
  const open = (id: TabId) => { setCurrent(id); setOpened(previous => previous.has(id) ? previous : new Set([...previous, id])); };
  return <div className="studio">
    <nav className="studio-tabs" role="tablist" aria-label="보리 스튜디오">
      <span className="studio-name">보리 스튜디오</span>
      {tabs.map(tab => <button key={tab.id} role="tab" id={`tab-${tab.id}`} aria-selected={current === tab.id} aria-controls={`panel-${tab.id}`} className={current === tab.id ? 'active' : ''} onClick={() => open(tab.id)}>{tab.label}</button>)}
    </nav>
    {tabs.map(tab => opened.has(tab.id) && <div key={tab.id} role="tabpanel" id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} className={`studio-panel studio-panel-${tab.id}`} hidden={current !== tab.id}>
      {tab.id === 'dashboard' && <DashboardTab active={current === 'dashboard'} />}
      {tab.id === 'settings' && <SettingsTab />}
    </div>)}
  </div>;
}
