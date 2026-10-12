import { readFileSync } from "node:fs";
import type { UsagePrice } from "@bori/shared";

export type ModelPrice = Omit<UsagePrice, "model" | "source">;

/** 기본 단가를 공식 가격 페이지에서 확인한 날짜. */
export const DEFAULT_PRICES_AS_OF = "2026-10-12";

/**
 * 모델별 기본 단가(USD, 1M 단위). 추정치다. 실제 청구액은 업체 대시보드가 기준이다.
 *
 * 출처(2026-10-12 확인, 표준 요금. 캐시·배치·우선 처리 할인과 할증은 반영하지 않는다)
 * - OpenAI: https://developers.openai.com/api/docs/pricing
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * 확인한 공식 가격만 넣는다. ElevenLabs는 크레딧 요금제라 글자당 USD가 정해져 있지 않고,
 * gpt-4o-mini-tts는 글자가 아니라 오디오 토큰으로 매겨 여기 방식으로 셀 수 없어 비워 둔다.
 * 표에 없는 모델은 비용을 null로 두고 "단가 없음"으로 표시한다.
 */
export const defaultPrices: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  // 임베딩은 출력 토큰 요금이 없다.
  "text-embedding-3-small": { inputPerMillionUsd: 0.02, outputPerMillionUsd: 0 },
  "text-embedding-3-large": { inputPerMillionUsd: 0.13, outputPerMillionUsd: 0 },
  "tts-1": { charactersPerMillionUsd: 15 },
  "tts-1-hd": { charactersPerMillionUsd: 30 },
  "claude-sonnet-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
  "claude-sonnet-5-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
  "claude-opus-5-5": { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
  "claude-haiku-4-5": { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
};

/** 단가 파일 형식 버전. */
export const PRICE_FILE_VERSION = 1;
const PRICE_FIELDS = ["inputPerMillionUsd", "outputPerMillionUsd", "charactersPerMillionUsd"] as const;

export type PriceTable = {
  prices: Map<string, UsagePrice>;
  fileLoaded: boolean;
  fileError: string | null;
};

/**
 * 단가 파일 한 항목을 검사한다. 0 이상의 유한한 숫자 필드만 받고, 모르는 필드가 있으면 틀린 것으로 본다.
 * 틀린 항목이 하나라도 있으면 파일 전체를 쓰지 않는다. 일부만 반영하면 어느 단가가 쓰였는지 헷갈린다.
 */
function parsePrice(value: unknown): ModelPrice | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const price: ModelPrice = {};
  for (const [key, field] of Object.entries(value)) {
    if (!(PRICE_FIELDS as readonly string[]).includes(key)) return null;
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) return null;
    price[key as (typeof PRICE_FIELDS)[number]] = field;
  }
  return Object.keys(price).length > 0 ? price : null;
}

/**
 * 기본 단가에 `data/usage-prices.json`을 덮어쓴 단가표. 같은 모델은 파일 값이 이기고, 나머지 기본값은 남는다.
 * 요청마다 읽어 파일을 고치면 서버를 다시 띄우지 않아도 반영된다. 파일이 없으면 기본값만 쓴다.
 *
 *   { "version": 1, "models": { "gpt-4o-mini": { "inputPerMillionUsd": 0.15, "outputPerMillionUsd": 0.6 } } }
 */
export function loadPriceTable(filePath: string): PriceTable {
  const prices = new Map<string, UsagePrice>(
    Object.entries(defaultPrices).map(([model, price]) => [model, { model, ...price, source: "default" }]),
  );

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { prices, fileLoaded: false, fileError: null };
  }

  let parsed: { version?: unknown; models?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { prices, fileLoaded: false, fileError: "단가 파일이 JSON 형식이 아닙니다." };
  }
  if (parsed?.version !== PRICE_FILE_VERSION) {
    return { prices, fileLoaded: false, fileError: `단가 파일 version은 ${PRICE_FILE_VERSION}이어야 합니다.` };
  }
  if (typeof parsed.models !== "object" || parsed.models === null || Array.isArray(parsed.models)) {
    return { prices, fileLoaded: false, fileError: "단가 파일에 models 객체가 없습니다." };
  }

  const overrides: UsagePrice[] = [];
  for (const [model, value] of Object.entries(parsed.models)) {
    const price = parsePrice(value);
    if (model.trim().length === 0 || !price) {
      return { prices, fileLoaded: false, fileError: `단가 항목이 올바르지 않습니다: ${model}` };
    }
    overrides.push({ model, ...price, source: "file" });
  }
  for (const price of overrides) prices.set(price.model, price);
  return { prices, fileLoaded: true, fileError: null };
}
