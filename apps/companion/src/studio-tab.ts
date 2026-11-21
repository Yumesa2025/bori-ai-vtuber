/**
 * 스튜디오 탭 활성 메시지(Codex C2 6절).
 * 보리 스튜디오(apps/admin)는 대시보드를 같은 출처 iframe(/companion/)으로 띄우고, 설정 탭으로 가면 iframe을 숨기기만 한다.
 * 숨긴 iframe의 document.visibilityState는 그대로 visible이라, 스튜디오가 탭 활성 상태를 postMessage로 알린다.
 * 대시보드는 같은 출처의 부모 창이 보낸 이 메시지만 믿는다. 메시지가 없으면(혼자 띄운 대시보드) 활성으로 본다.
 * 같은 모양을 apps/admin/src/studio/DashboardTab.tsx가 보낸다(두 앱이 공유 패키지 없이 같은 값을 둔다).
 */

export const STUDIO_TAB_MESSAGE = "bori-studio-tab";

export type StudioTabMessage = { type: typeof STUDIO_TAB_MESSAGE; active: boolean };

export const studioTabMessage = (active: boolean): StudioTabMessage => ({ type: STUDIO_TAB_MESSAGE, active });

/**
 * 받은 메시지가 스튜디오 탭 활성 알림이면 active 값, 아니면 null.
 * 출처가 자기 출처와 같고, 보낸 창이 부모 창이며, 부모가 자기 자신이 아닐 때만 읽는다.
 */
export function readStudioTabMessage(
  event: { origin: string; source: unknown; data: unknown },
  here: { origin: string; parent: unknown; self: unknown },
): boolean | null {
  if (here.parent === here.self || event.source !== here.parent || event.origin !== here.origin) return null;
  const data = event.data as Partial<StudioTabMessage> | null;
  if (typeof data !== "object" || data === null || data.type !== STUDIO_TAB_MESSAGE || typeof data.active !== "boolean") return null;
  return data.active;
}

/** 자동 읽기·빠른 폴링을 해도 되는지: 문서가 보이고 스튜디오 탭도 활성이어야 한다 */
export const pageActive = (documentVisible: boolean, tabActive: boolean) => documentVisible && tabActive;
