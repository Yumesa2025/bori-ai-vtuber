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
 * 사용자 이름·컴퓨터 이름과 공개된 고정 salt로 파생한다. 이 식별 정보를 알면
 * 설정 파일을 다른 컴퓨터에서도 복호화할 수 있어 파일 유출·공유를 막지 못한다.
 * 후속 과제: Windows DPAPI 또는 Electron safeStorage로 무작위 비밀을 보호하고
 * 기존 enc.v1을 마이그레이션한다. 호환성을 위해 현재 키 파생 재료는 유지한다.
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
 * 키 문자열을 다듬는다. 붙여 넣을 때 섞인 공백·개행·제로폭 같은 서식 문자(Cf)를 모두 지운다.
 * 키에는 공백이 들어가지 않으므로 지워도 키가 바뀌지 않는다. 남은 값에 보이지 않는 문자가 있으면 null이다.
 * 개행이 섞인 키는 HTTP 헤더 오류 메시지에 키 전체가 그대로 실린다(점검 L-4).
 */
export function normalizeApiKey(value: string): string | null {
  const compact = value.replace(/[\s\p{Cf}]/gu, "");
  return /^[\x21-\x7E]*$/.test(compact) ? compact : null;
}

/**
 * API 키 하나와 그 출처.
 * 화면(PATCH)에서 입력한 키만 파일에 저장하고, 환경변수 키는 메모리에서만 쓴다.
 * 저장된 키가 있으면 그것을 쓰고, 없을 때만 환경변수 키를 쓴다.
 * 출처를 따로 두지 않으면 설정만 바꿔도 환경변수 키가 파일에 써지고, 그 뒤로는 환경변수를 바꿔도 반영되지 않는다.
 *
 * 풀지 못한 암호문은 지우지 않고 그대로 들고 있다가 다시 쓴다. PC 이름이 바뀌어 풀리지 않는 키를
 * 설정 하나 바꿨다고 지우면 원래 PC로 돌아가도 되살릴 수 없다. 화면에서 새 키를 넣거나 지우면 그때 버린다.
 */
export function createApiKeySlot(envKey: string | undefined) {
  const fromEnv = (envKey ?? "").trim();
  let saved = "";
  /** 풀지 못한 암호문 원문. 새 키를 넣거나 지우기 전까지 파일에 그대로 다시 쓴다. */
  let unreadable: string | null = null;

  return {
    /** 지금 쓸 키. */
    current: () => saved || fromEnv,
    /** 파일에 남은 값을 읽는다. 풀지 못하면 저장된 키가 없는 것으로 보고 원문만 보관한다. */
    load(stored: unknown): StoredKeyState {
      saved = "";
      unreadable = null;
      if (typeof stored !== "string" || stored.length === 0) return "none";
      const decrypted = decryptSecret(stored);
      if (decrypted.length === 0) {
        unreadable = stored;
        return "unreadable";
      }
      saved = decrypted;
      return isEncrypted(stored) ? "loaded" : "plaintext";
    },
    /** 화면에서 받은 키. 빈 문자열이면 저장한 키를 지우고 환경변수 키로 돌아간다. 공백은 모두 지운다. */
    set(value: string) {
      saved = normalizeApiKey(value) ?? "";
      unreadable = null;
    },
    /** 파일에 쓸 값. 화면에서 넣은 키도, 풀지 못한 원문도 없으면 undefined라 JSON에 필드가 생기지 않는다. */
    stored: () => (saved.length > 0 ? encryptSecret(saved) : unreadable ?? undefined),
    /** 저장된 키를 풀지 못해 보관만 하고 있는지. 관리자 화면에 알린다. */
    isUnreadable: () => unreadable !== null,
    /** 지금 상태로 되돌리는 함수. 설정 저장에 실패했을 때 바꾼 키를 되돌린다. */
    checkpoint() {
      const previous = { saved, unreadable };
      return () => { saved = previous.saved; unreadable = previous.unreadable; };
    },
  };
}

export type ApiKeySlot = ReturnType<typeof createApiKeySlot>;
