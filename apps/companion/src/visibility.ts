import { useEffect, useState } from "react";
import { readStudioTabMessage } from "./studio-tab";

/** 지금 화면이 보이는지. 브라우저 탭을 숨기거나 창을 내리면 false다(점검 V2 14번). */
const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * 보리 스튜디오에서 대시보드 탭이 활성인지(Codex C2 6절). 스튜디오가 postMessage로 알린다(studio-tab.ts).
 * 메시지가 없으면(혼자 띄운 대시보드, 스튜디오가 아직 알리지 않음) 활성으로 본다.
 */
export function useStudioTabActive(): boolean {
  const [active, setActive] = useState(true);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const value = readStudioTabMessage(event, { origin: window.location.origin, parent: window.parent, self: window });
      if (value !== null) setActive(value);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return active;
}
