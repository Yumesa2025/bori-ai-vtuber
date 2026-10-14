import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** 백업과 이전 로그를 남겨 두는 기간(일). 지나면 서버를 시작할 때 지운다. */
export const BACKUP_RETENTION_DAYS = 30;

/**
 * 지워도 되는 파일 이름. 데이터 디렉터리 바로 아래의 이 형식만 지운다.
 * 사용자 데이터 원본(memories.json, companion-conversations.json 등)과 지금 쓰는 로그는 여기에 걸리지 않는다.
 */
const DISPOSABLE_NAMES: readonly RegExp[] = [
  // 기억 파일 버전 1 → 2 마이그레이션 직전 원본(packages/memory store.ts)
  /^[\w-]+\.v1-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?\.json$/,
  // 읽지 못한 데이터·설정 파일 원본(기억·1:1 대화·설정, ADR-021)
  /^[\w-]+\.unreadable-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?\.json$/,
  // 관리자 앱이 시작할 때 넘겨 둔 이전 실행의 렌더러 로그(apps/admin/electron/main.cjs)
  /^admin-renderer\.previous\.log$/,
];

export const isDisposableFile = (name: string) => DISPOSABLE_NAMES.some(pattern => pattern.test(name));

/**
 * 원자적 쓰기의 임시 파일(`<파일>.<pid>.<uuid>.tmp`). rename 전에 프로세스가 죽으면 남는다(점검 L8).
 * 원본은 그대로이므로 남은 임시 파일은 쓸모가 없다. 다만 다른 서버 프로세스가 쓰는 중일 수 있어 조금 지난 것만 지운다.
 */
const TEMP_NAME = /^[\w-]+\.json\.(\d+)\.[0-9a-f-]{36}\.tmp$/;
export const TEMP_RETENTION_MS = 60 * 60_000;

/** 지난 실행이 남긴 임시 파일인지. 지금 프로세스의 임시 파일은 쓰는 중일 수 있어 아니라고 본다. */
export function isLeftoverTempFile(name: string, pid: number = process.pid): boolean {
  const match = TEMP_NAME.exec(name);
  return match !== null && Number(match[1]) !== pid;
}

/**
 * 보관 기간이 지난 백업·이전 로그와, 한 시간 넘게 남은 임시 파일을 지운다. 지운 파일 이름을 돌려준다.
 * 나이는 마지막 수정 시각으로 본다. 하위 디렉터리와 링크는 보지 않는다.
 * 실패해도 서버 시작을 막지 않는다. 다음 시작 때 다시 시도한다.
 */
export function purgeExpiredBackups(dir: string, options: { now?: number; retentionDays?: number } = {}): string[] {
  const now = options.now ?? Date.now();
  const cutoff = now - (options.retentionDays ?? BACKUP_RETENTION_DAYS) * 86_400_000;
  const tempCutoff = now - TEMP_RETENTION_MS;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 데이터 디렉터리가 아직 없다.
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const isTemp = isLeftoverTempFile(entry.name);
    if (!entry.isFile() || !(isTemp || isDisposableFile(entry.name))) continue;
    const path = join(dir, entry.name);
    try {
      if (statSync(path).mtimeMs >= (isTemp ? tempCutoff : cutoff)) continue;
      rmSync(path);
      removed.push(entry.name);
    } catch {
      // 다른 프로그램이 잡고 있는 등 지우지 못한 파일은 다음에 다시 본다.
    }
  }
  return removed;
}
