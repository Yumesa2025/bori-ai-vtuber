import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { execFile } from "node:child_process";
import { chmodSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { backupFile, isMissingFileError, writeFileAtomically } from "./atomic-file.js";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc.v2:";
const LEGACY_PREFIX = "enc.v1:";
let masterKey: Buffer | null = null;
/**
 * 인증 태그 길이(바이트). 풀 때도 이 길이를 강제한다.
 * 지정하지 않으면 GCM이 4바이트까지 잘린 태그를 받아 주므로, 파일을 고친 사람이 위조한 값이 통과하기 쉬워진다.
 */
const AUTH_TAG_BYTES = 16;

/** Legacy v1 read-only derivation: preserve all inputs for compatibility. */
function deriveKey(): Buffer {
  const material = `${userInfo().username}@${hostname()}:bori-ai-vtuber`;
  // salt를 재료에서 파생해 저장 없이 항상 같은 키가 나오게 한다.
  return scryptSync(material, "bori-secret-salt", 32);
}

export function encryptSecret(plain: string): string {
  if (plain.length === 0) return "";

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, requireMasterKey(), iv, { authTagLength: AUTH_TAG_BYTES });
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
  if (!isEncrypted(stored)) return stored;

  try {
    const [ivPart, tagPart, dataPart] = stored.slice(PREFIX.length).split(":");
    const decipher = createDecipheriv(ALGORITHM, stored.startsWith(LEGACY_PREFIX) ? deriveKey() : requireMasterKey(), Buffer.from(ivPart, "base64"), { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // 다른 컴퓨터에서 만든 파일이거나 손상된 경우다. 키가 없는 것으로 본다.
    return "";
  }
}

export const isEncrypted = (stored: string): boolean => stored.startsWith(PREFIX) || stored.startsWith(LEGACY_PREFIX);

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
/** OS 보호기는 시작 시에만 호출하며 값 암호화는 메모리의 무작위 마스터 키를 쓴다. */
export interface SecretProtector {
  readonly name: string;
  protect(value: Buffer): Promise<Buffer>;
  unprotect(value: Buffer): Promise<Buffer>;
}
function dpapi(value: Buffer, operation: "Protect" | "Unprotect"): Promise<Buffer> {
  // 인자는 고정이다. 비밀은 stdin으로만 전달하고 자식 오류/출력은 로그에 넘기지 않는다.
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ` +
    `$v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ` +
    `$r=[System.Security.Cryptography.ProtectedData]::${operation}($v,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
        if (error || !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout.trim())) reject(new Error("OS 비밀 보호 작업에 실패했습니다."));
        else resolve(Buffer.from(stdout.trim(), "base64"));
      });
    child.stdin?.on("error", () => reject(new Error("OS 비밀 보호 입력에 실패했습니다.")));
    child.stdin?.end(value.toString("base64"));
  });
}
export const windowsProtector: SecretProtector = {
  name: "dpapi-current-user", protect: value => dpapi(value, "Protect"), unprotect: value => dpapi(value, "Unprotect"),
};
// 비Windows에는 OS 암호화 보호가 없다. 파일/임시 파일의 0600 권한만으로 제한한다.
const fileProtector: SecretProtector = {
  name: "file-0600", async protect(value) { return value; }, async unprotect(value) { return value; },
};
function requireMasterKey(): Buffer {
  if (!masterKey) throw new Error("마스터 키를 읽을 수 없어 API 키를 저장하지 않습니다.");
  return masterKey;
}
/** 서버가 키 슬롯을 읽기 전에 한 번 호출한다. 실패하면 기존 파일을 보존한다. */
export async function initializeSecretStore(dataRoot: string, protector: SecretProtector = process.platform === "win32" ? windowsProtector : fileProtector): Promise<void> {
  masterKey = null;
  try {
    const configs = ["llm-config.json", "tts-config.json"].map(name => {
      const path = join(dataRoot, name);
      try { return { path, raw: readFileSync(path, "utf8") }; }
      catch (error) { if (isMissingFileError(error)) return { path, raw: "" }; throw error; }
    });
    // JSON이 손상돼도 v2 흔적이 있으면 새 키로 덮지 않는다.
    const hasV2 = configs.some(config => {
      if (config.raw.includes(PREFIX)) return true;
      try { return JSON.stringify(JSON.parse(config.raw)).includes(PREFIX); }
      catch { return false; }
    });
    const path = join(dataRoot, "secret-master.v2");
    let raw: string | null = null;
    try { raw = readFileSync(path, "utf8"); }
    catch (error) { if (!isMissingFileError(error)) throw error; }
    let key: Buffer;
    if (raw !== null) {
      const wrapped = JSON.parse(raw);
      if (wrapped.protection !== protector.name || typeof wrapped.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(wrapped.data)) throw new Error();
      key = await protector.unprotect(Buffer.from(wrapped.data, "base64"));
      if (key.length !== 32) throw new Error();
    } else {
      if (hasV2) throw new Error();
      key = randomBytes(32);
      const wrapped = await protector.protect(key);
      const mask = process.platform === "win32" ? null : process.umask(0o077);
      try {
        writeFileAtomically(path, JSON.stringify({ protection: protector.name, data: wrapped.toString("base64") }), {
          rename(from, to) { if (process.platform !== "win32") chmodSync(from, 0o600); renameSync(from, to); },
        });
      } finally { if (mask !== null) process.umask(mask); }
    }
    masterKey = key;
    for (const config of configs) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(config.raw); } catch { continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      let changed = false;
      for (const field of ["apiKey", "elevenLabsApiKey"]) {
        const stored = parsed[field];
        if (typeof stored !== "string" || !stored.startsWith(LEGACY_PREFIX)) continue;
        const plain = decryptSecret(stored);
        if (!plain) continue;
        parsed[field] = encryptSecret(plain);
        changed = true;
      }
      if (changed) {
        backupFile(config.path, "v1-backup");
        writeFileAtomically(config.path, JSON.stringify(parsed, null, 2));
      }
    }
  } catch {
    masterKey = null;
    // 보호기가 비밀을 담은 오류를 던져도 메시지·cause를 전파하지 않는다.
    throw new Error("마스터 키 초기화 또는 이전에 실패했습니다. 기존 파일을 보존합니다. 백업 복구 절차를 확인하세요.");
  }
}
