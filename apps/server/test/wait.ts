/**
 * 검사가 같이 쓰는 기다림 도우미. 파일 이름이 *.test.ts가 아니라 검사로 직접 돌지 않는다.
 */

/** 조건이 참이 될 때까지 기다린다. 시간이 지나면 실패한다. */
export async function waitFor(check: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`기다리다 시간이 지났습니다: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
