import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, rename as renameAsync, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/**
 * 데이터 파일 공통 쓰기(ADR-021).
 * 기억·1:1 대화·사용량·설정 파일이 모두 이 방식으로 쓴다. 임시 파일에 다 쓰고 디스크에 내린 뒤 rename으로 바꾼다.
 * 중간에 멈춰도 이전 파일이 그대로 남는다. 서버가 기억 패키지에 이미 의존하므로 새 패키지를 만들지 않고 여기에 둔다.
 */

/** 임시 파일 이름. 프로세스 ID를 넣어 두어, 지울 때 지금 프로세스가 쓰는 중인 파일을 건드리지 않는다. */
export function temporaryPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

/** 파일이 없어서 난 오류인지. 없으면 기본값으로 시작하고, 그 밖의 오류는 덮어쓰지 않도록 따로 다룬다. */
export function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export type AtomicWriteOptions = {
  /** 임시 파일을 제자리로 옮기는 함수. 테스트에서 쓰기 실패를 주입할 때 바꾼다. */
  rename?: (from: string, to: string) => void;
};

/** 동기판. 실패하면 임시 파일을 지우고 예외를 그대로 던진다. 서버 시작처럼 기다려도 되는 곳과 작은 파일에 쓴다. */
export function writeFileAtomically(filePath: string, content: string, options: AtomicWriteOptions = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = temporaryPathFor(filePath);
  try {
    const fd = openSync(tempPath, "w");
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    (options.rename ?? renameSync)(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export type AtomicWriteAsyncOptions = {
  rename?: (from: string, to: string) => void | Promise<void>;
};

/**
 * 비동기판. 내용을 조각으로 받아 차례로 쓴다.
 * 조각 사이마다 이벤트 루프가 다른 요청을 처리하고, 전체를 문자열 하나로 만들지 않아 문자열 길이 한계에도 걸리지 않는다.
 */
export async function writeFileAtomicallyAsync(filePath: string, chunks: Iterable<string>, options: AtomicWriteAsyncOptions = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = temporaryPathFor(filePath);
  try {
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(chunks, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await (options.rename ?? renameAsync)(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * 원본을 `<이름>.<label>-<시각>.json`으로 같은 디렉터리에 복사해 남긴다. 파일 이름에 콜론을 쓰지 않는다.
 * label이 unreadable이면 보관 기간(retention.ts)이 지난 뒤 지워진다. 복사하지 못하면 예외를 던진다.
 */
export function backupFile(filePath: string, label: string, now: number = Date.now()): string {
  const stem = basename(filePath, extname(filePath));
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  let backupPath = join(dirname(filePath), `${stem}.${label}-${stamp}.json`);
  // 같은 밀리초에 두 번 남기는 일은 드물지만, 있어도 이전 백업을 덮지 않는다.
  for (let suffix = 1; existsSync(backupPath); suffix += 1) {
    backupPath = join(dirname(filePath), `${stem}.${label}-${stamp}-${suffix}.json`);
  }
  copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * 이 파일의 남은 조각을 지운다. 지운 수와 지우지 못한 수를 돌려준다.
 * - 다른 프로세스(이전 실행)가 남긴 임시 파일. 지금 프로세스의 임시 파일은 쓰는 중일 수 있어 두고, 실패하면 쓴 쪽이 지운다.
 * - unreadable이 true면 읽지 못해 남겨 둔 원본 백업(`<이름>.unreadable-*.json`)도 지운다.
 */
export function removeLeftoverFiles(filePath: string, options: { unreadable: boolean }): { removed: number; failed: number } {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const unreadablePrefix = `${basename(filePath, extname(filePath))}.unreadable-`;
  const ownTempPrefix = `${name}.${process.pid}.`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if (isMissingFileError(error)) return { removed: 0, failed: 0 };
    return { removed: 0, failed: 1 };
  }

  const result = { removed: 0, failed: 0 };
  for (const entry of entries) {
    const isTemp = entry.startsWith(`${name}.`) && entry.endsWith(".tmp") && !entry.startsWith(ownTempPrefix);
    const isUnreadable = options.unreadable && entry.startsWith(unreadablePrefix) && entry.endsWith(".json");
    if (!isTemp && !isUnreadable) continue;
    try {
      rmSync(join(dir, entry), { force: true });
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
