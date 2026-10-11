import type { MemoryAccess, MemoryRecord } from "./types.js";

/** 닉네임 없이 들어온 채팅의 viewerId. 서로 다른 사람이 같은 값을 쓰므로 소유자로 볼 수 없다. */
export const ANONYMOUS_VIEWER_ID = "virtual-viewer";

/** 익명 발언인지. 익명 발언은 누구의 기억으로도 남기지 않고, 소유 기억도 꺼내지 않는다. */
export function isAnonymousViewer(viewerId: string | undefined): boolean {
  return !viewerId || viewerId === ANONYMOUS_VIEWER_ID;
}

/**
 * 이 기억을 지금 답변 문맥에 넣어도 되는지.
 *
 *   scope      owner  방송(A 발언)  방송(B 발언)  1:1(A)  1:1(B)
 *   character  -      O             O             O       O
 *   broadcast  -      O             O             X       X
 *   broadcast  A      O             X             X       X
 *   private    A      X             X             O       X
 *
 * 표에 없는 조합(알 수 없는 scope, 소유자가 비어 있는 private 등)은 모두 막는다.
 */
export function canAccessMemory(record: MemoryRecord, access: MemoryAccess): boolean {
  if (!access) return false;

  const owner = record.ownerId;
  // 소유자 칸에 값이 있는데 쓸 수 없는 값이면 누구 것인지 모르는 기억이다.
  if (owner !== undefined && (typeof owner !== "string" || owner.length === 0)) return false;

  switch (record.scope) {
    case "character":
      // 캐릭터 기억은 공용이다. 소유자가 붙어 있으면 표에 없는 경우라 막는다.
      return owner === undefined;
    case "broadcast":
      if (access.mode !== "broadcast") return false;
      if (owner === undefined) return true;
      return !isAnonymousViewer(access.speakerId) && access.speakerId === owner;
    case "private":
      if (access.mode !== "private") return false;
      return owner !== undefined && access.userId.length > 0 && access.userId === owner;
    default:
      return false;
  }
}
