import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
// 비공개 자산(Live2D 모델·Cubism SDK) 서빙
import { privateAssetAliases, privateAssets } from "../../tools/vite/private-assets";
import { mockApi } from "./dev/mock-api";

const projectRoot = resolve(__dirname, "../..");
const api = { "/api": "http://127.0.0.1:4310" };
const devServer = { host: "127.0.0.1", port: 4175 };
/** 보리 서버가 빌드를 /companion/으로 내주고, 스튜디오 대시보드 탭이 그 주소를 iframe으로 띄운다. */
const base = "/companion/";

/**
 * 개발 서버용 CSP 보정(스튜디오 apps/admin/vite.config.ts와 같은 방식).
 * React Fast Refresh는 준비 코드를 인라인 script로 넣는데, index.html의 CSP는 인라인 script를 막는다.
 * 'unsafe-inline'을 열지 않고 그 코드의 해시만 허용하고, HMR 웹소켓 주소를 더한다. 빌드 산출물은 index.html 그대로다.
 */
function devCsp(): Plugin {
  const preamble = react.preambleCode.replace("__BASE__", base);
  const hash = createHash("sha256").update(preamble).digest("base64");
  return {
    name: "bori-dashboard-dev-csp",
    apply: "serve",
    transformIndexHtml: html => html
      .replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`)
      .replace("connect-src 'self'", `connect-src 'self' ws://${devServer.host}:${devServer.port}`),
  };
}

// `vite --mode mock`이면 서버 대신 계약대로 답하는 가짜 API를 붙인다. 빌드 산출물에는 들어가지 않는다.
export default defineConfig(({ mode }) => ({
  base,
  resolve: { alias: privateAssetAliases(projectRoot) },
  plugins: [react(), devCsp(), privateAssets({ projectRoot, outDir: resolve(__dirname, "dist") }), ...(mode === "mock" ? [mockApi()] : [])],
  server: { ...devServer, strictPort: true, proxy: api },
  // 빌드 산출물을 그대로 확인할 때도 API 프록시가 필요하다.
  preview: { host: "127.0.0.1", port: 4176, strictPort: true, proxy: api },
}));
