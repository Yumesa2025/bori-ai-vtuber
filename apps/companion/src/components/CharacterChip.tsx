/**
 * 캐릭터 이니셜 칩. 공식 캐릭터 그림 대신 이름 첫 글자와 색으로 구분한다.
 * 색은 캐릭터 번호(없으면 이름)로 고르므로 표·상세·전적에서 같은 캐릭터는 같은 색이다.
 * 글자는 화면 낭독기에 읽히지 않는다(옆에 이름이 늘 같이 있다).
 */
const TONES = 8;

const toneOf = (key: number | string) => {
  if (typeof key === "number") return Math.abs(key) % TONES;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % TONES;
};

type Props = { name: string; code?: number; size?: "sm" | "md" | "lg" };

export function CharacterChip({ name, code, size = "sm" }: Props) {
  return (
    <span className={`chip chip-${size} chip-tone-${toneOf(code ?? name)}`} aria-hidden="true">
      {Array.from(name.trim())[0] ?? "?"}
    </span>
  );
}
