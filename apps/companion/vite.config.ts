import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
// 비공개 자산 서빙은 방송 화면과 같이 쓴다.
import { privateAssetAliases, privateAssets } from "../../tools/vite/private-assets";
import { mockApi } from "./dev/mock-api";

const projectRoot = resolve(__dirname, "../..");
const api = { "/api": "http://127.0.0.1:4310" };

// `vite --mode mock`이면 서버 대신 계약대로 답하는 가짜 API를 붙인다. 빌드 산출물에는 들어가지 않는다.
export default defineConfig(({ mode }) => ({
  // 보리 서버가 빌드를 /companion/으로 내주고, 스튜디오 1:1 탭이 그 주소를 iframe으로 띄운다.
  base: "/companion/",
  resolve: { alias: privateAssetAliases(projectRoot) },
  plugins: [react(), privateAssets({ projectRoot, outDir: resolve(__dirname, "dist") }), ...(mode === "mock" ? [mockApi()] : [])],
  server: { host: "127.0.0.1", port: 4175, strictPort: true, proxy: api },
  // 빌드 산출물을 그대로 확인할 때도 API 프록시가 필요하다.
  preview: { host: "127.0.0.1", port: 4176, strictPort: true, proxy: api },
}));
