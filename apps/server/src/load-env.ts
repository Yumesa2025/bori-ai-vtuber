/**
 * 저장소 루트 `.env`를 process.env로 읽어 들인다.
 *
 * 다른 모듈이 import되는 순간 환경 변수를 읽으므로(`BORI_OPENAI_BASE_URL` 등) index.ts의 첫 import로 둔다.
 * - 파일이 없으면 조용히 넘어간다.
 * - 이미 설정된 환경 변수가 이긴다(`process.loadEnvFile`의 동작). 비어 있는 값으로 설정돼 있어도 그대로 둔다.
 * - `BORI_ENV_FILE`로 다른 파일을 가리킬 수 있고, 빈 문자열이면 읽지 않는다(통합 검사가 실제 키를 읽지 않게 한다).
 * 여기서 읽은 키도 환경 변수 키와 똑같이 메모리에서만 쓰고 data/에 저장하지 않는다(secret-store).
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 파일이 있으면 읽고 true를 돌려준다.
 * .env.example을 그대로 복사하면 `BORI_SERVER_PORT=`처럼 빈 값이 남는다. 빈 문자열은 `??` 기본값을 막아
 * 포트 0·빈 API 주소가 되므로, 파일에서 새로 생긴 빈 값은 지워 설정하지 않은 것으로 둔다.
 */
export function loadEnvFileIfPresent(path: string): boolean {
  if (path === "" || !existsSync(path)) return false;
  const before = new Set(Object.keys(process.env));
  process.loadEnvFile(path);
  for (const [name, value] of Object.entries(process.env)) {
    if (!before.has(name) && value === "") delete process.env[name];
  }
  return true;
}

loadEnvFileIfPresent(process.env.BORI_ENV_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"));
