/**
 * 최신 보리 대사 파일(data/narration.json). 다시 켰을 때 갱신 없이도 마지막 분석을 보여 주려고 남긴다(설계 3절 6).
 * 쓰기는 설정 파일 공통 방식(createConfigFile: 임시 파일 + rename, 깨진 파일은 원본을 남김)을 따른다.
 * 대사에는 닉네임이 들어가지 않는다(사실 목록에 없으므로).
 */
import type { Narration, NarrationLine } from "@bori/shared";
import { createConfigFile } from "../config-file.js";

export type NarrationStore = {
  /** 저장된 대사. 없거나 읽을 수 없거나 모양이 틀리면 null */
  load(): Narration | null;
  /** 실패하면 예외를 넘긴다 */
  save(narration: Narration): void;
};

const isLine = (value: unknown): value is NarrationLine => {
  const line = value as Partial<NarrationLine> | null;
  return typeof line?.text === "string" && typeof line.emotion === "string" && (line.audioId === undefined || typeof line.audioId === "string");
};

function toNarration(value: Record<string, unknown>): Narration | null {
  const { id, createdAt, source, lines } = value;
  if (typeof id !== "string" || typeof createdAt !== "string" || (source !== "llm" && source !== "template")) return null;
  if (!Array.isArray(lines) || !lines.every(isLine)) return null;
  return {
    id,
    createdAt,
    source,
    lines: lines.map(line => ({ text: line.text, emotion: line.emotion, ...(line.audioId ? { audioId: line.audioId } : {}) })),
  };
}

export function createNarrationStore(filePath: string, warn?: (message: string) => void): NarrationStore {
  const file = createConfigFile(filePath, "보리 대사", warn);
  return {
    load() {
      const value = file.read();
      if (value === null) return null;
      const narration = toNarration(value);
      // 모양이 틀린 파일은 다음 저장이 덮어쓰기 전에 원본을 남긴다.
      if (!narration) file.rejected(["narration"]);
      return narration;
    },
    save(narration) {
      file.write(narration);
    },
  };
}
