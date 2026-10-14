/**
 * 사람이 입력한 글(방송 채팅·닉네임, 1:1 메시지·제목)을 받을 때 공통으로 거치는 정리.
 *
 * 점검(a1 M3·L6)에서 NUL·제어문자·RTL override·짝 없는 서로게이트가 그대로 저장되고 화면에 나갔다.
 * RTL override는 목록 표시를 뒤집을 수 있다. 줄바꿈과 탭은 글의 일부라 남긴다.
 */

/** 지우는 문자: 탭·줄바꿈을 뺀 C0 제어문자, DEL, 방향 바꿈 문자(U+202A~202E, U+2066~2069), BOM. */
const invisibleControlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩﻿]/g;
/** 짝 없는 서로게이트. 저장하면 JSON을 다시 읽을 때 깨진 글자가 된다. */
const loneSurrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanInputText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(invisibleControlPattern, "").replace(loneSurrogatePattern, "");
}

/** 글자 수. 한글 한 글자도, 이모지 하나도 한 글자로 센다. */
export const lengthOf = (text: string) => Array.from(text).length;
