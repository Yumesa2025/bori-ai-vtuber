import { useCallback, useEffect, useState } from "react";
import type { DashboardState } from "@bori/shared";
import { api, ApiError, describeError } from "./api";
import { pollIntervalMs } from "./dashboard";

/**
 * 대시보드 상태 폴링. 갱신 중에는 2초, 평소에는 30초마다 다시 받는다(설계 4절).
 * 서버에 닿지 못하면 지난 상태를 그대로 두고 연결 안내를 띄운다.
 */
export function useDashboard() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  /** 받기를 시도할 때마다 오른다. 실패해서 state가 그대로여도 다음 폴링을 다시 잡는다. */
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    try {
      setState(await api.getDashboard());
      setDisconnected(false);
    } catch (error) {
      const lost = !(error instanceof ApiError) || error.kind === "disconnected";
      setDisconnected(lost);
      if (!lost) setNotice(describeError(error));
      if (import.meta.env.DEV) console.warn("[dashboard] 상태를 받지 못했습니다", error);
    } finally {
      setAttempt(value => value + 1);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (attempt === 0) return;
    const timer = window.setTimeout(() => void load(), pollIntervalMs(state));
    return () => window.clearTimeout(timer);
  }, [attempt, load, state]);

  const refresh = useCallback(async () => {
    setRequesting(true);
    setNotice(null);
    try {
      const { started } = await api.refresh();
      if (!started) setNotice("지금은 갱신을 시작할 수 없어요. 이미 갱신 중이거나 키가 없어요.");
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setRequesting(false);
      await load();
    }
  }, [load]);

  return { state, disconnected, notice, requesting, refresh, reload: load };
}
