import { resolve } from "node:path";
import type { DashboardSettings } from "@bori/shared";
import { createConfigFile } from "../config-file.js";
import { cleanInputText, lengthOf } from "../input-text.js";

/**
 * 대시보드 설정 파일 `data/dashboard-settings.json`. 지금은 게임 닉네임 하나다.
 * 설정 파일 공통 방식(createConfigFile)으로 원자적으로 쓴다. 닉네임은 로그에 찍지 않는다.
 */

/** 닉네임 길이 상한(정리한 뒤 글자 수). 게임의 실제 상한은 확인하지 못해 넉넉히 잡았다. 스튜디오 입력칸도 같은 값이다. */
const MAX_NICKNAME_LENGTH = 32;

/** PUT /api/dashboard/settings 본문이 틀렸다. 라우트는 400으로 알린다. */
export class DashboardSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardSettingsError";
  }
}

/**
 * `{ nickname }`을 정리한다. 사람 입력 공통 정리(cleanInputText: 제어문자·NUL·방향 바꿈 문자·짝 없는 서로게이트)에
 * 더해 개행·탭도 지우고(닉네임에는 필요 없다) 앞뒤 공백을 자른다. 빈 문자열은 null. 틀리면 DashboardSettingsError.
 */
export function parseDashboardSettings(value: unknown): DashboardSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("nickname" in value)) {
    throw new DashboardSettingsError("설정은 { nickname } 모양이어야 합니다.");
  }
  const { nickname } = value as { nickname: unknown };
  if (nickname === null) return { nickname: null };
  if (typeof nickname !== "string") throw new DashboardSettingsError("닉네임은 문자열이거나 null이어야 합니다.");
  const trimmed = cleanInputText(nickname).replace(/[\n\t]/g, "").trim();
  if (lengthOf(trimmed) > MAX_NICKNAME_LENGTH) throw new DashboardSettingsError(`닉네임은 ${MAX_NICKNAME_LENGTH}자까지입니다.`);
  return { nickname: trimmed === "" ? null : trimmed };
}

export function createDashboardSettings(dataDir: string, warn?: (message: string) => void) {
  const file = createConfigFile(resolve(dataDir, "dashboard-settings.json"), "대시보드 설정", warn);
  let current: DashboardSettings = { nickname: null };

  const stored = file.read();
  if (stored) {
    try {
      current = parseDashboardSettings(stored);
    } catch {
      // 틀린 값은 닉네임 없음으로 시작한다. 다음 저장이 덮기 전에 원본을 남긴다.
      file.rejected(["nickname"]);
    }
  }

  return {
    get: (): DashboardSettings => ({ ...current }),
    /** 정리한 값을 저장한다. 쓰기가 실패하면 예외를 넘기고 지금 값은 그대로 둔다. */
    set(next: DashboardSettings) {
      const parsed = parseDashboardSettings(next);
      file.write(parsed);
      current = parsed;
    },
  };
}

export type DashboardSettingsStore = ReturnType<typeof createDashboardSettings>;
