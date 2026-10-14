/**
 * 관리자 설정 폼의 편집 중 값(draft) 다루기.
 *
 * 서버 값과 편집 중 값을 나눠 둔다. 화면은 사용자가 고친 칸만 draft를 보여 주고 나머지는 서버 값을 보여 준다.
 * 그래서 상태 폴링이 서버 값을 새로 받아도 편집 중인 칸은 덮이지 않고, 저장이 성공한 칸만 draft에서 빠진다.
 * 숫자 칸도 입력한 글자 그대로 들고 있다가 저장할 때 검사한다. 빈칸이 Number("") = 0으로 저장되지 않는다.
 * React에 묶이지 않아 화면 밖 단위 검사(test/form.test.ts)에서 그대로 부른다.
 */

export type DraftValue = string | boolean;
export type Drafts = Readonly<Record<string, DraftValue>>;
export type FieldSpec = { key: string; label: string; kind: "number" | "text" | "boolean" };
export type PatchValue = string | number | boolean;

/** 입력칸에 보일 값. 고친 칸은 고친 글자를, 아니면 서버 값을 보여 준다. */
export function shownText(drafts: Drafts, key: string, serverValue: string | number): string {
  const draft = drafts[key];
  return typeof draft === "string" ? draft : String(serverValue);
}

export function shownChecked(drafts: Drafts, key: string, serverValue: boolean): boolean {
  const draft = drafts[key];
  return typeof draft === "boolean" ? draft : serverValue;
}

/**
 * 고친 칸만 골라 서버로 보낼 patch를 만든다.
 * 빈칸·숫자가 아닌 값이 하나라도 있으면 아무것도 보내지 않고 이유를 돌려준다. 범위 검사는 서버가 한다.
 */
export function buildPatch(drafts: Drafts, fields: readonly FieldSpec[]):
  | { ok: true; patch: Record<string, PatchValue>; keys: string[] }
  | { ok: false; error: string } {
  const patch: Record<string, PatchValue> = {};
  for (const field of fields) {
    const draft = drafts[field.key];
    if (draft === undefined) continue;
    if (field.kind === "boolean") { patch[field.key] = draft === true; continue; }

    const text = String(draft).trim();
    if (text === "") return { ok: false, error: `${field.label} 칸이 비어 있습니다. 값을 넣은 뒤 저장해 주세요.` };
    if (field.kind === "text") { patch[field.key] = text; continue; }

    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false, error: `${field.label}에는 숫자를 넣어 주세요.` };
    patch[field.key] = value;
  }
  return { ok: true, patch, keys: Object.keys(patch) };
}

/**
 * 저장한 draft를 지운다.
 * 저장을 기다리는 사이 같은 칸을 또 고쳤으면(값이 달라졌으면) 그 칸은 남긴다. 새로 고친 값을 잃지 않는다.
 */
export function clearSaved(current: Drafts, saved: Drafts): Drafts {
  const next: Record<string, DraftValue> = { ...current };
  for (const [key, value] of Object.entries(saved)) {
    if (next[key] === value) delete next[key];
  }
  return next;
}

/** draft 중 keys에 해당하는 것만 남긴다. clearSaved에 넘길 "이번에 저장한 값"을 만든다. */
export function pickDrafts(drafts: Drafts, keys: readonly string[]): Drafts {
  const picked: Record<string, DraftValue> = {};
  for (const key of keys) if (drafts[key] !== undefined) picked[key] = drafts[key];
  return picked;
}

/**
 * 저장 성공 문구. 보낸 값이 아니라 서버가 돌려준 실제 저장 값으로 쓴다.
 * 예: "채팅 큐 설정을 저장했습니다. (최소 대기(초) 3 · 최대 대기(초) 10)"
 */
export function savedSummary(prefix: string, fields: readonly FieldSpec[], keys: readonly string[], saved: Readonly<Record<string, unknown>>): string {
  const parts = fields
    .filter(field => keys.includes(field.key))
    .map(field => {
      const value = saved[field.key];
      const shown = typeof value === "boolean" ? (value ? "켜짐" : "꺼짐") : String(value);
      return `${field.label} ${shown}`;
    });
  return parts.length > 0 ? `${prefix} (${parts.join(" · ")})` : prefix;
}

/**
 * 실패 응답에서 서버가 준 이유를 꺼낸다. 서버는 거절 이유를 { error } 한국어 문장으로 준다.
 * 본문이 JSON이 아니거나 error가 없으면 fallback을 쓴다.
 */
export async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown } | null;
    return typeof body?.error === "string" && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 장기 기억 목록에 보일 문장.
 * 1:1 private 기억은 방송 중 관리자 창을 캡처·공유하면 그대로 노출되므로 기본으로 가린다. 서버 응답은 그대로 둔다.
 */
export function memoryTextFor(record: { scope: string; text: string }, revealPrivate: boolean): string {
  return record.scope === "private" && !revealPrivate ? "1:1 기억 · 내용 가림" : record.text;
}
