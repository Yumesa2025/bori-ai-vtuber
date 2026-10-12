/**
 * 1:1 관계 맥락 문장의 형식. 서버가 저장된 1:1 기록에서 사실만 계산해 [대화 상황]에 넣는 문장이다.
 * 서버 작업과 공유하는 계약이라 문구를 그대로 옮겼다. 서버 내부를 import하지 않으려고 여기에 형식만 둔다.
 *
 *   첫 대화       이 사람과는 오늘 처음 대화한다.
 *   재방문        이 사람과는 {N}번째 대화다. 처음 대화한 지 {D}일 지났다.  (D가 0이면 둘째 문장이 "처음 대화한 날이 오늘이다.")
 *   마지막 간격   마지막 대화는 {G}일 전이었다.  (G가 0이면 "마지막 대화는 오늘 앞서 있었다.")
 *   지난 대화     지난 대화 요약: {요약}
 */
export const relationshipLineFormats: readonly { label: string; pattern: RegExp }[] = [
  { label: "첫 대화", pattern: /^이 사람과는 오늘 처음 대화한다\.$/ },
  { label: "재방문", pattern: /^이 사람과는 ([2-9]|[1-9]\d+)번째 대화다\. (처음 대화한 지 [1-9]\d*일 지났다|처음 대화한 날이 오늘이다)\.$/ },
  { label: "마지막 대화 간격", pattern: /^마지막 대화는 ([1-9]\d*일 전이었다|오늘 앞서 있었다)\.$/ },
  { label: "지난 대화 요약", pattern: /^지난 대화 요약: \S.*$/ },
];

/** 계약 형식의 관계 문장인지. */
export function isRelationshipLine(line: string): boolean {
  return relationshipLineFormats.some(format => format.pattern.test(line));
}

/**
 * 프롬프트 어디에든 관계 문장 조각이 들어 있는지 찾는다. 방송 프롬프트에 새어 들어갔는지 볼 때 쓴다.
 * 줄 단위가 아니라 문장 조각으로 찾아, 앞에 "- "가 붙거나 다른 문장과 이어져 있어도 잡는다.
 */
const relationshipFragments: readonly RegExp[] = [
  /이 사람과는 (오늘 처음 대화한다|\d+번째 대화다)/,
  /처음 대화한 (지 \d+일 지났다|날이 오늘이다)/,
  /마지막 대화는 (\d+일 전이었다|오늘 앞서 있었다)/,
  /지난 대화 요약:/,
];

export function findRelationshipFragments(text: string): string[] {
  return relationshipFragments.flatMap(pattern => {
    const match = pattern.exec(text);
    return match ? [match[0]] : [];
  });
}
