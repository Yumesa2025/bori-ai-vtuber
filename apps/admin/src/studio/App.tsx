import { useState } from 'react';
import OperateTab from './OperateTab';
import CompanionTab from './CompanionTab';
import SettingsTab from './SettingsTab';

type TabId = 'operate' | 'companion' | 'settings';
const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'operate', label: '방송 운영' },
  { id: 'companion', label: '1:1 대화' },
  { id: 'settings', label: '설정' },
];

/**
 * 보리 스튜디오. 방송 운영·1:1 대화·설정 세 탭.
 * 1:1·설정 탭은 처음 열 때 만들고 그 뒤에는 숨기기만 한다. 탭을 오가도 1:1 대화 화면과 설정 폼의 입력이 사라지지 않는다.
 */
export default function StudioApp() {
  const [current, setCurrent] = useState<TabId>('operate');
  const [opened, setOpened] = useState<ReadonlySet<TabId>>(() => new Set(['operate']));
  const open = (id: TabId) => { setCurrent(id); setOpened(previous => previous.has(id) ? previous : new Set([...previous, id])); };
  return <div className="studio">
    <nav className="studio-tabs" role="tablist" aria-label="보리 스튜디오">
      <span className="studio-name">보리 스튜디오</span>
      {tabs.map(tab => <button key={tab.id} role="tab" id={`tab-${tab.id}`} aria-selected={current === tab.id} aria-controls={`panel-${tab.id}`} className={current === tab.id ? 'active' : ''} onClick={() => open(tab.id)}>{tab.label}</button>)}
    </nav>
    {tabs.map(tab => opened.has(tab.id) && <div key={tab.id} role="tabpanel" id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} className={`studio-panel studio-panel-${tab.id}`} hidden={current !== tab.id}>
      {tab.id === 'operate' && <OperateTab active={current === 'operate'} />}
      {tab.id === 'companion' && <CompanionTab />}
      {tab.id === 'settings' && <SettingsTab />}
    </div>)}
  </div>;
}
