import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { hostname, userInfo } from "node:os";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc.v1:";
/**
 * 인증 태그 길이(바이트). 풀 때도 이 길이를 강제한다.
 * 지정하지 않으면 GCM이 4바이트까지 잘린 태그를 받아 주므로, 파일을 고친 사람이 위조한 값이 통과하기 쉬워진다.
 */
const AUTH_TAG_BYTES = 16;

/**
 * 로컬 저장용 키를 만든다.
 * 이 컴퓨터의 사용자와 호스트 이름에서 파생하므로, 설정 파일만 다른 컴퓨터로 옮겨도 풀리지 않는다.
 *
 * 한계: 같은 컴퓨터에서 이 코드를 실행할 수 있으면 복호화도 가능하다.
 * 파일 유출과 실수로 인한 공유를 막는 수준이고, 로컬 권한 침해까지 막지는 못한다.
 * OS 키체인을 쓰려면 Electron safeStorage로 옮겨야 하는데, 서버는 별도 프로세스라 바로 쓸 수 없다.
 */
function deriveKey(): Buffer {
  const material = `${userInfo().username}@${hostname()}:bori-ai-vtuber`;
  // salt를 재료에서 파생해 저장 없이 항상 같은 키가 나오게 한다.
  return scryptSync(material, "bori-secret-salt", 32);
}

export function encryptSecret(plain: string): string {
  if (plain.length === 0) return "";

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(), iv, { authTagLength: AUTH_TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * 저장된 값을 푼다.
 * 접두사가 없으면 이전 버전이 남긴 평문이므로 그대로 돌려준다. 다음 저장 때 암호문으로 바뀐다.
 */
export function decryptSecret(stored: string): string {
  if (stored.length === 0) return "";
  if (!stored.startsWith(PREFIX)) return stored;

  try {
    const [ivPart, tagPart, dataPart] = stored.slice(PREFIX.length).split(":");
    const decipher = createDecipheriv(ALGORITHM, deriveKey(), Buffer.from(ivPart, "base64"), { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // 다른 컴퓨터에서 만든 파일이거나 손상된 경우다. 키가 없는 것으로 본다.
    return "";
  }
}

export const isEncrypted = (stored: string): boolean => stored.startsWith(PREFIX);

/** 파일에서 읽은 키의 상태. plaintext면 이전 버전이 남긴 평문이라 바로 암호문으로 다시 써야 한다. */
export type StoredKeyState = "none" | "loaded" | "plaintext" | "unreadable";

/**
 * API 키 하나와 그 출처.
 * 화면(PATCH)에서 입력한 키만 파일에 저장하고, 환경변수 키는 메모리에서만 쓴다.
 * 저장된 키가 있으면 그것을 쓰고, 없을 때만 환경변수 키를 쓴다.
 * 출처를 따로 두지 않으면 설정만 바꿔도 환경변수 키가 파일에 써지고, 그 뒤로는 환경변수를 바꿔도 반영되지 않는다.
 */
export function createApiKeySlot(envKey: string | undefined) {
  const fromEnv = (envKey ?? "").trim();
  let saved = "";

  return {
    /** 지금 쓸 키. */
    current: () => saved || fromEnv,
    /** 파일에 남은 값을 읽는다. 풀지 못하면 저장된 키가 없는 것으로 본다. */
    load(stored: unknown): StoredKeyState {
      if (typeof stored !== "string" || stored.length === 0) return "none";
      const decrypted = decryptSecret(stored);
      if (decrypted.length === 0) return "unreadable";
      saved = decrypted;
      return isEncrypted(stored) ? "loaded" : "plaintext";
    },
    /** 화면에서 받은 키. 빈 문자열이면 저장한 키를 지우고 환경변수 키로 돌아간다. */
    set(value: string) { saved = value.trim(); },
    /** 파일에 쓸 값. 화면에서 넣은 키가 없으면 undefined라 JSON에 필드가 생기지 않는다. */
    stored: () => (saved.length > 0 ? encryptSecret(saved) : undefined),
  };
}

export type ApiKeySlot = ReturnType<typeof createApiKeySlot>;
