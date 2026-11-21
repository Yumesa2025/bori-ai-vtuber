import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardState } from "@bori/shared";
import { api, ApiError, describeError } from "./api";
import { pollIntervalMs } from "./dashboard";
import { useDocumentVisible } from "./visibility";

/**
 * 대시보드 상태 폴링. 갱신 중에는 2초, 평소에는 30초마다 다시 받는다(설계 4절).
 * 탭이 숨겨져 있으면 늦추고, 다시 보이면 바로 받는다(점검 V2 14번).
 * 서버에 닿지 못하면 지난 상태를 그대로 두고 연결 안내를 띄운다.
 *
 * 안내는 둘로 나눈다(점검 V2 13번).
 * - loadNotice: 상태를 받다 난 오류. 다음에 받기가 성공하면 지운다.
 * - actionNotice: 갱신 버튼을 눌렀을 때의 안내. 다음에 누를 때 지운다.
 */
export function useDashboard() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  /** 받기를 시도할 때마다 오른다. 실패해서 state가 그대로여도 다음 폴링을 다시 잡는다. */
  const [attempt, setAttempt] = useState(0);
  const visible = useDocumentVisible();
  const wasVisible = useRef(visible);

  const load = useCallback(async () => {
    try {
      setState(await api.getDashboard());
      setDisconnected(false);
      setLoadNotice(null);
    } catch (error) {
      const lost = !(error instanceof ApiError) || error.kind === "disconnected";
      setDisconnected(lost);
      setLoadNotice(lost ? null : describeError(error));
      if (import.meta.env.DEV) console.warn("[dashboard] 상태를 받지 못했습니다", error);
    } finally {
      setAttempt(value => value + 1);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (attempt === 0) return;
    const timer = window.setTimeout(() => void load(), pollIntervalMs(state, !visible));
    return () => window.clearTimeout(timer);
  }, [attempt, load, state, visible]);

  // 숨겼다가 다시 보이면 늦춘 폴링을 기다리지 않고 바로 받는다.
  useEffect(() => {
    if (visible && !wasVisible.current && attempt > 0) void load();
    wasVisible.current = visible;
  }, [visible, attempt, load]);

  const refresh = useCallback(async () => {
    setRequesting(true);
    setActionNotice(null);
    try {
      const { started } = await api.refresh();
      if (!started) setActionNotice("지금은 갱신을 시작할 수 없어요. 이미 갱신 중이거나 키가 없어요.");
    } catch (error) {
      setActionNotice(describeError(error));
    } finally {
      setRequesting(false);
      await load();
    }
  }, [load]);

  return { state, disconnected, loadNotice, actionNotice, requesting, refresh, reload: load, visible };
}
