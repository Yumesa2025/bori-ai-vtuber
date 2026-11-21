import { useCallback, useEffect, useRef } from 'react';

/**
 * 대시보드 탭이 활성인지 iframe에 알리는 메시지 이름. apps/companion/src/studio-tab.ts의 STUDIO_TAB_MESSAGE와 같은 값이다.
 * 설정 탭에 있는 동안 숨긴 대시보드가 새 대사를 자동으로 읽지 않게 한다(Codex C2 6절).
 */
const STUDIO_TAB_MESSAGE = 'bori-studio-tab';

/**
 * 대시보드 탭. 서버가 /companion/으로 내주는 대시보드 앱 빌드를 그대로 띄운다.
 * 대시보드 앱은 API를 절대 경로(/api/...)로 부르므로 같은 서버 출처 안에서 그대로 동작한다.
 * 탭 활성 상태가 바뀔 때와 iframe을 다 불러왔을 때 같은 출처로만 postMessage를 보낸다.
 */
export default function DashboardTab({ active }: { active: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const notify = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: STUDIO_TAB_MESSAGE, active: activeRef.current }, window.location.origin);
  }, []);

  useEffect(() => { notify(); }, [active, notify]);

  return <iframe ref={frameRef} className="dashboard-frame" src="/companion/" title="이터널리턴 메타 대시보드" onLoad={notify} />;
}
