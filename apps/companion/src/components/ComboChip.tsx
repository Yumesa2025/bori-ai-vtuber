import type { CSSProperties } from "react";

/**
 * 캐릭터 표시 칩: 이름 첫 글자와 캐릭터 번호로 정한 색. 게임 아트(초상화) 대신 쓴다.
 * 같은 캐릭터는 어디서나 같은 색이라 표·상세·하이라이트를 눈으로 이어 볼 수 있다. 글자 정보는 옆 이름이 이미 주므로 낭독기에서는 숨긴다.
 */
const hueOf = (code: number) => (code * 47 + 190) % 360;

export function ComboChip({ code, name, size = "md" }: { code: number; name: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`chip chip-${size}`} style={{ "--chip-hue": hueOf(code) } as CSSProperties} aria-hidden="true">
      {Array.from(name)[0] ?? "?"}
    </span>
  );
}
