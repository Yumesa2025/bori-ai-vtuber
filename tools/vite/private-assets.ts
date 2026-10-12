import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";

/**
 * 구매 모델과 Cubism SDK를 저장소 밖 비공개 폴더에서 서빙하는 Vite 설정 조각.
 * 방송 화면과 1:1 대화 화면이 같은 URL 구조로 Live2D를 띄우므로 한 곳에서 정의한다.
 * 두 폴더 모두 재배포 금지라 저장소에는 넣지 않는다(.gitignore).
 */
const sdkDir = "private-assets/cubism-sdk/CubismSdkForWeb-5-r.5";

const mimeTypes: Record<string, string> = {
  ".json": "application/json",
  ".js": "text/javascript",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".frag": "text/plain",
  ".vert": "text/plain",
};

/**
 * SDK Framework와 데모 샘플 소스를 가리키는 별칭.
 * 별칭으로 두면 dev와 빌드 모두 같은 경로로 해석된다. URL 동적 import는 빌드에 포함되지 않는다.
 */
export function privateAssetAliases(projectRoot: string) {
  const sdkRoot = resolve(projectRoot, sdkDir);
  return {
    "@framework": resolve(sdkRoot, "Framework/src"),
    "@sdk-sample": resolve(sdkRoot, "Samples/TypeScript/Demo/src"),
  };
}

/**
 * URL 접두사와 실제 폴더의 대응. dev 서버와 빌드 산출물이 같은 URL 구조를 쓴다.
 * 이 경로들은 `lappdefine.ts`의 ResourcesPath·ShaderPath와 맞춰야 한다.
 */
function assetRoutesFor(projectRoot: string) {
  const sdkRoot = resolve(projectRoot, sdkDir);
  return [
    { prefix: "/private-model/maolili/", root: resolve(projectRoot, "maolili"), include: undefined },
    // Core는 런타임에 쓰는 스크립트와 라이선스만 내보낸다. 소스맵과 문서는 뺀다.
    { prefix: "/private-core/", root: resolve(sdkRoot, "Core"), include: ["live2dcubismcore.js", "LICENSE.md"] },
    // 셰이더는 Framework/src가 아니라 Framework 바로 아래에 있다.
    { prefix: "/private-framework/Shaders/WebGL/", root: resolve(sdkRoot, "Framework/Shaders/WebGL"), include: undefined },
  ] as const;
}

export function privateAssets({ projectRoot, outDir }: { projectRoot: string; outDir: string }) {
  const assetRoutes = assetRoutesFor(projectRoot);
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
        const target = resolve(outDir, route.prefix.slice(1));
        await mkdir(target, { recursive: true });
        // 비공개 폴더가 정션·심볼릭 링크로 연결되어 있으면 cp가 링크 자체를 복사하려다 실패한다.
        // 실제 경로로 풀어서 복사한다. 실제 폴더라면 경로가 그대로다.
        const source = await realpath(route.root);
        if (route.include) {
          for (const name of route.include) await cp(resolve(source, name), resolve(target, name));
        } else {
          await cp(source, target, { recursive: true });
        }
      }
    },
  };
}
