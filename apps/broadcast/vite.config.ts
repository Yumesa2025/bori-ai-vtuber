import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
// 비공개 자산 서빙은 1:1 대화 화면과 같이 쓴다.
import { privateAssetAliases, privateAssets } from "../../tools/vite/private-assets";

const projectRoot = resolve(__dirname, "../..");
/** OBS 브라우저 소스 페이지. 주소는 /obs/<이름>.html이다. */
const obsPages = ["character", "dashboard", "caption", "chat", "waiting", "ending"];

export default defineConfig({
  resolve: { alias: privateAssetAliases(projectRoot) },
  plugins: [react(), privateAssets({ projectRoot, outDir: resolve(__dirname, "dist") })],
  // 방송 화면과 채팅 화면, OBS 페이지 6종을 각각 진입점으로 만든다. 채팅은 다른 창이나 휴대폰에서 연다.
  // 서버는 /obs/ 아래만 내주므로(apps/server/src/http/static.ts) 스크립트·스타일도 obs/assets에 둔다.
  build: {
    assetsDir: "obs/assets",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        chat: resolve(__dirname, "chat.html"),
        ...Object.fromEntries(obsPages.map(name => [`obs-${name}`, resolve(__dirname, `obs/${name}.html`)])),
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:4310" } },
  // 빌드 산출물을 그대로 확인할 때도 API 프록시가 필요하다.
  preview: { host: "127.0.0.1", port: 4174, proxy: { "/api": "http://127.0.0.1:4310" } },
});
