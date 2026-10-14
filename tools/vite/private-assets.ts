import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

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

/**
 * dev 요청이 가리키는 파일 경로. 폴더 밖이거나 include 밖이면 null이다.
 * 접두사 비교(startsWith)는 구분자를 보지 않아 형제 폴더(maolili-x/)를 통과시키므로 relative로 본다.
 */
function allowedFilePath(route: ReturnType<typeof assetRoutesFor>[number], url: string): string | null {
  const filePath = resolve(route.root, url.slice(route.prefix.length));
  const rel = relative(route.root, filePath);
  // 상위 경로로 빠져나가거나 다른 드라이브로 풀리는 요청은 거부한다.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  // 빌드가 include만 복사하므로 dev에서도 같은 파일만 내준다.
  if (route.include && !(route.include as readonly string[]).includes(rel.split(sep).join("/"))) return null;
  return filePath;
}

/**
 * 빌드에 필요한 비공개 폴더 중 없는 것. 상위 폴더가 없으면 그 아래 폴더는 따로 적지 않는다.
 * 번들 자체가 SDK 샘플 소스(@sdk-sample)를 import하므로 SDK가 없으면 dist를 만들 수 없다.
 */
export function missingPrivateFolders(projectRoot: string): string[] {
  const sdkRoot = resolve(projectRoot, sdkDir);
  const required = [
    resolve(projectRoot, "maolili"),
    sdkRoot,
    ...Object.values(privateAssetAliases(projectRoot)),
    ...assetRoutesFor(projectRoot).map(route => route.root),
  ];
  const missing = [...new Set(required)].filter(path => !existsSync(path));
  return missing.filter(path => !missing.some(parent => path.startsWith(`${parent}${sep}`)));
}

/** 비공개 자산이 없을 때 빌드가 보여 줄 안내. ENOENT 스택 대신 없는 폴더와 할 일을 적는다. */
export function missingAssetsMessage(projectRoot: string, missing: readonly string[]): string {
  const folders = missing.map(path => `  - ${relative(projectRoot, path).split(sep).join("/")}`).join("\n");
  return [
    "비공개 자산이 없어 이 화면을 빌드할 수 없습니다.",
    `없는 폴더:\n${folders}`,
    "구매 모델(maolili/)과 Cubism SDK for Web(private-assets/cubism-sdk/)을 README '실행 전 반드시 알아둘 것'대로 놓은 뒤 다시 빌드하세요.",
    "자산 없이 되는 빌드는 관리자 화면(npm run build:admin)뿐입니다.",
  ].join("\n");
}

export function privateAssets({ projectRoot, outDir }: { projectRoot: string; outDir: string }) {
  const assetRoutes = assetRoutesFor(projectRoot);
  let building = false;
  return {
    name: "bori-private-assets",
    configResolved(config: { command: string }) {
      building = config.command === "build";
    },
    // 자산이 없으면 번들을 만들기 전에 멈춘다. 예전에는 SDK import 실패나 realpath ENOENT 스택으로 끝났다.
    buildStart() {
      if (!building) return;
      const missing = missingPrivateFolders(projectRoot);
      if (missing.length === 0) return;
      // 스택은 node 내부 위치뿐이라 지운다. vite가 플러그인 이름을 붙여 메시지만 찍는다.
      const error = new Error(missingAssetsMessage(projectRoot, missing));
      error.stack = "";
      throw error;
    },
    // dev 서버에서는 비공개 폴더를 URL로 열어 준다. 파일을 프로젝트 안으로 복사하지 않는다.
    configureServer(server: { middlewares: { use: (handler: (request: any, response: any, next: () => void) => void) => void } }) {
      server.middlewares.use(async (request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        const route = assetRoutes.find(candidate => url.startsWith(candidate.prefix));
        if (!route) { next(); return; }

        const filePath = allowedFilePath(route, url);
        if (!filePath) { response.statusCode = 403; response.end(); return; }

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
      // 빌드가 실패해도 이 훅은 불린다. 자산이 없어 buildStart가 멈춘 경우 그 안내를 덮지 않게 그냥 끝낸다.
      if (assetRoutes.some(route => !existsSync(route.root))) return;
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
