/**
 * 대시보드 탭. 서버가 /companion/으로 내주는 대시보드 앱 빌드를 그대로 띄운다.
 * 대시보드 앱은 API를 절대 경로(/api/...)로 부르므로 같은 서버 출처 안에서 그대로 동작한다.
 */
export default function DashboardTab() {
  return <iframe className="dashboard-frame" src="/companion/" title="이터널리턴 메타 대시보드" />;
}
