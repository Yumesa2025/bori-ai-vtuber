/**
 * 방송 화면에 보일 닉네임 가림.
 * 2자 이하는 첫 글자 + "*", 3~4자는 앞 2자 + 나머지 "*", 5자 이상은 앞 3자 + "**"(길이를 감춘다).
 * 이모지·한글이 깨지지 않게 코드포인트 단위로 센다.
 */
export function maskNickname(nickname: string): string {
  const chars = Array.from(nickname);
  if (chars.length === 0) return "";
  if (chars.length <= 2) return `${chars[0]}*`;
  if (chars.length <= 4) return chars.slice(0, 2).join("") + "*".repeat(chars.length - 2);
  return `${chars.slice(0, 3).join("")}**`;
}
