import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cp, mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const projectRoot = resolve(__dirname, "../..");
const sdkRoot = resolve(projectRoot, "private-assets/cubism-sdk/CubismSdkForWeb-5-r.5");
const privateModelRoot = resolve(projectRoot, "maolili");
const privateCoreRoot = resolve(sdkRoot, "Core");
const privateFrameworkSrc = resolve(sdkRoot, "Framework/src");
// 셰이더는 Framework/src가 아니라 Framework 바로 아래에 있다.
const privateShaderRoot = resolve(sdkRoot, "Framework/Shaders/WebGL");
const privateSampleRoot = resolve(sdkRoot, "Samples/TypeScript/Demo/src");

const mimeTypes: Record<string, string> = {
  ".json": "application/json",
  ".js": "text/javascript",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".frag": "text/plain",
  ".vert": "text/plain",
};

/**
 * URL 접두사와 실제 폴더의 대응. dev 서버와 빌드 산출물이 같은 URL 구조를 쓴다.
 * 이 경로들은 `lappdefine.ts`의 ResourcesPath·ShaderPath와 맞춰야 한다.
 */
const assetRoutes = [
  { prefix: "/private-model/maolili/", root: privateModelRoot, include: undefined },
  // Core는 런타임에 쓰는 스크립트와 라이선스만 내보낸다. 소스맵과 문서는 뺀다.
  { prefix: "/private-core/", root: privateCoreRoot, include: ["live2dcubismcore.js", "LICENSE.md"] },
  { prefix: "/private-framework/Shaders/WebGL/", root: privateShaderRoot, include: undefined },
] as const;

function privateAssets() {
  return {
    name: "bori-private-assets",
    // dev 서버에서는 비공개 폴더를 URL로 열어 준다. 파일을 프로젝트 안으로 복사하지 않는다.
    configureServer(server: { middlewares: { use: (handler: (request: any, response: any, next: () => void) => void) => void } }) {
      server.middlewares.use(async (request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        const route = assetRoutes.find(candidate => url.startsWith(candidate.prefix));
        if (!route) { next(); return; }

        const filePath = resolve(route.root, url.slice(route.prefix.length));
        // 상위 경로로 빠져나가는 요청은 거부한다.
        if (!filePath.startsWith(route.root)) { response.statusCode = 403; response.end(); return; }

        try {
          const data = await readFile(filePath);
          response.statusCode = 200;
          response.setHeader("Content-Type", mimeTypes[extname(url)] ?? "application/octet-stream");
          response.end(data);
        } catch {
          response.statusCode = 404;
          response.end();
        }
      });
    },
    // 빌드 산출물에도 같은 구조로 복사한다. 구매 모델과 SDK가 들어가므로 dist는 공개하지 않는다.
    async closeBundle() {
      for (const route of assetRoutes) {
        const target = resolve(__dirname, "dist", route.prefix.slice(1));
        await mkdir(target, { recursive: true });
        if (route.include) {
          for (const name of route.include) await cp(resolve(route.root, name), resolve(target, name));
        } else {
          await cp(route.root, target, { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "@framework": privateFrameworkSrc,
      // 별칭으로 두면 dev와 빌드 모두 같은 경로로 해석된다. URL 동적 import는 빌드에 포함되지 않는다.
      "@sdk-sample": privateSampleRoot,
    },
  },
  plugins: [react(), privateAssets()],
  // 방송 화면과 채팅 화면을 각각 진입점으로 만든다. 채팅은 다른 창이나 휴대폰에서 연다.
  build: { rollupOptions: { input: { main: resolve(__dirname, "index.html"), chat: resolve(__dirname, "chat.html") } } },
  server: { proxy: { "/api": "http://127.0.0.1:4310" } },
  // 빌드 산출물을 그대로 확인할 때도 API 프록시가 필요하다.
  preview: { host: "127.0.0.1", port: 4174, proxy: { "/api": "http://127.0.0.1:4310" } },
});
