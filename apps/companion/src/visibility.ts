import { useEffect, useState } from "react";

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
