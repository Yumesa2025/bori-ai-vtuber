/**
 * 1:1 대화 탭. 서버가 /companion/으로 내주는 1:1 앱 빌드를 그대로 띄운다.
 * 1:1 앱은 API를 절대 경로(/api/...)로 부르므로 같은 서버 출처 안에서 그대로 동작한다.
 */
export default function CompanionTab() {
  return <iframe className="companion-frame" src="/companion/" title="보리와 1:1 대화" />;
}
