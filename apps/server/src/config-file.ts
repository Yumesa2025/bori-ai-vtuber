import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { backupFile, isMissingFileError, writeFileAtomically } from "@bori/memory";

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code ?? "오류";

/**
 * 설정 파일 하나(llm-config·tts-config·memory-config.json). 데이터 파일 공통 방식(ADR-021)을 따른다.
 * - 파일이 없으면 기본값으로 시작한다.
 * - 깨진 파일과 일부 값을 버린 파일은 `*.unreadable-<시각>.json`으로 원본을 남긴 뒤 경고한다. 내용과 키는 찍지 않는다.
 * - 있는데 읽지 못한 파일(잠김·권한)은 이번 실행 동안 덮어쓰지 않는다. 저장된 키를 지우지 않기 위해서다.
 * - 쓰기는 임시 파일 + rename이고, 실패하면 예외를 넘긴다. 라우트가 500으로 알린다.
 */
export function createConfigFile(filePath: string, label: string, warn: (message: string) => void = message => console.warn(`[bori-server] ${message}`)) {
  let writable = true;

  /** 원본을 남긴다. 남기지 못하면 덮어쓰지 않는다. */
  function preserve(reason: string) {
    try {
      warn(`${reason} 원본: ${basename(backupFile(filePath, "unreadable"))}`);
    } catch (error) {
      writable = false;
      warn(`${reason} 원본을 남기지 못해 이번 실행에서는 ${label} 파일에 쓰지 않습니다. (${errorCode(error)})`);
    }
  }

  return {
    /** 파일의 JSON 객체. 파일이 없거나 읽지 못했으면 null이다. */
    read(): Record<string, unknown> | null {
      writable = true;
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch (error) {
        if (isMissingFileError(error)) return null;
        writable = false;
        warn(`${label} 파일을 읽지 못했습니다. 기본값으로 시작하고 이번 실행에서는 덮어쓰지 않습니다. (${errorCode(error)})`);
        return null;
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // 아래에서 원본을 남긴다.
      }
      preserve(`${label} 파일을 읽지 못해 기본값으로 시작합니다.`);
      return null;
    },

    /** 읽은 값 일부가 틀려 기본값으로 바꿨다. 다음 저장이 덮어쓰기 전에 원본을 남긴다. 키 이름만 알린다. */
    rejected(keys: readonly string[]) {
      if (keys.length > 0) preserve(`${label} 중 잘못된 값(${keys.join(", ")})을 기본값으로 바꿉니다.`);
    },

    write(value: unknown) {
      if (!writable) throw new Error(`${label} 파일을 읽지 못해 이번 실행에서는 저장하지 않습니다.`);
      writeFileAtomically(filePath, JSON.stringify(value, null, 2));
    },
  };
}

export type ConfigFile = ReturnType<typeof createConfigFile>;
