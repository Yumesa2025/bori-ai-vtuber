import { resolve } from "node:path";
import type { StaticRoute } from "./static.js";

/**
 * 서버가 내주는 빌드 화면. 스튜디오(Electron)와 브라우저가 Vite 없이 서버 주소 하나로 연다.
 * Live2D 모델·Core·셰이더(/private-*)는 대시보드 빌드가 dist 아래 같은 경로로 복사한다(tools/vite/private-assets.ts).
 * 예전에는 방송 화면 빌드(apps/broadcast/dist)에서 내줬다. 방송 화면을 지우면서 대시보드 빌드로 옮겼다(위험 R1).
 */
export function staticRoutesFor(projectRoot: string): StaticRoute[] {
  const companionDist = resolve(projectRoot, "apps/companion/dist");
  const build = "npm run build:companion";
  return [
    { prefix: "/private-model/", root: companionDist, build },
    { prefix: "/private-core/", root: companionDist, build },
    { prefix: "/private-framework/", root: companionDist, build },
    { prefix: "/companion/", root: companionDist, build, stripPrefix: true },
    { prefix: "/studio/", root: resolve(projectRoot, "apps/admin/dist"), build: "npm run build:admin", stripPrefix: true },
  ];
}
