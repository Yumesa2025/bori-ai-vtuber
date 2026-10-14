/**
 * 관리자 설정 폼 단위 검사.
 * 폴링으로 서버 값을 새로 받아도 편집 중인 칸이 덮이지 않는지, 빈칸이 0으로 저장되지 않는지,
 * 저장 실패 이유와 성공 문구를 서버 응답 기준으로 만드는지 본다. 브라우저를 띄우지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildPatch, clearSaved, memoryTextFor, pickDrafts, readError, savedSummary, shownChecked, shownText, type FieldSpec } from "../src/form";
import { isSubmitEnter } from "../src/keys";

const fields: FieldSpec[] = [
  { key: "responseDelayMinSeconds", label: "최소 대기(초)", kind: "number" },
  { key: "responseDelayMaxSeconds", label: "최대 대기(초)", kind: "number" },
  { key: "monologueEnabled", label: "혼잣말 사용", kind: "boolean" },
  { key: "model", label: "모델", kind: "text" },
];

describe("편집 중인 칸과 서버 값", () => {
  test("고친 칸은 폴링으로 받은 서버 값이 와도 고친 값을 보여 준다", () => {
    // 점검 A5-03: 1.5초 폴링이 폼 상태를 통째로 바꿔 입력이 되돌아가고, 옛 값을 "저장했습니다"로 저장했다.
    const drafts = { responseDelayMinSeconds: "3" };
    assert.equal(shownText(drafts, "responseDelayMinSeconds", 5), "3");
    // 고치지 않은 칸은 서버 값을 따른다.
    assert.equal(shownText(drafts, "responseDelayMaxSeconds", 12), "12");
    assert.equal(shownChecked({ monologueEnabled: false }, "monologueEnabled", true), false);
    assert.equal(shownChecked({}, "monologueEnabled", true), true);
  });

  test("저장할 때는 고친 칸만 보낸다", () => {
    const built = buildPatch({ responseDelayMinSeconds: "3", monologueEnabled: false }, fields);
    assert.deepEqual(built, { ok: true, patch: { responseDelayMinSeconds: 3, monologueEnabled: false }, keys: ["responseDelayMinSeconds", "monologueEnabled"] });
  });

  test("빈칸·숫자 아님은 저장하지 않고 이유를 준다(빈칸이 0으로 저장되지 않는다)", () => {
    // 점검 A5-04: 칸을 비우고 저장하면 Number("") = 0이 저장되고 "저장했습니다"가 떴다.
    const empty = buildPatch({ responseDelayMinSeconds: "  " }, fields);
    assert.equal(empty.ok, false);
    assert.match(!empty.ok ? empty.error : "", /최소 대기\(초\) 칸이 비어/);
    const nan = buildPatch({ responseDelayMaxSeconds: "abc" }, fields);
    assert.match(!nan.ok ? nan.error : "", /숫자를 넣어/);
    const blankText = buildPatch({ model: "" }, fields);
    assert.equal(blankText.ok, false);
  });

  test("저장이 끝나면 저장한 칸만 비우고, 그사이 다시 고친 칸은 남긴다", () => {
    const sent = pickDrafts({ responseDelayMinSeconds: "3", model: "gpt" }, ["responseDelayMinSeconds"]);
    assert.deepEqual(sent, { responseDelayMinSeconds: "3" });
    assert.deepEqual(clearSaved({ responseDelayMinSeconds: "3", model: "gpt" }, sent), { model: "gpt" });
    assert.deepEqual(clearSaved({ responseDelayMinSeconds: "4" }, sent), { responseDelayMinSeconds: "4" });
  });
});

describe("저장 결과 안내", () => {
  test("성공 문구는 서버가 실제로 저장한 값으로 쓴다", () => {
    const text = savedSummary("채팅 큐 설정을 저장했습니다.", fields, ["responseDelayMinSeconds", "monologueEnabled"], { responseDelayMinSeconds: 3, monologueEnabled: false });
    assert.equal(text, "채팅 큐 설정을 저장했습니다. (최소 대기(초) 3 · 혼잣말 사용 꺼짐)");
  });

  test("실패하면 서버가 준 이유를 꺼내고, 없으면 기본 문구를 쓴다", async () => {
    // 점검 A5-04: 서버 이유를 버리고 "저장하지 못했습니다"만 보였다.
    const reason = "responseDelayMinSeconds는 0~120 사이 숫자여야 합니다.";
    assert.equal(await readError(new Response(JSON.stringify({ error: reason }), { status: 400 }), "기본"), reason);
    assert.equal(await readError(new Response(JSON.stringify({ count: 0 }), { status: 404 }), "기본"), "기본");
    assert.equal(await readError(new Response("<html>", { status: 502 }), "기본"), "기본");
  });
});

describe("장기 기억 목록", () => {
  test("1:1 private 기억은 기본으로 가리고, 보기를 누르면 보여 준다", () => {
    // 점검 A5-28: 방송 중 관리자 창을 캡처하면 1:1 기억 원문이 그대로 보였다.
    assert.equal(memoryTextFor({ scope: "private", text: "민트초코를 좋아한다" }, false), "1:1 기억 · 내용 가림");
    assert.equal(memoryTextFor({ scope: "private", text: "민트초코를 좋아한다" }, true), "민트초코를 좋아한다");
    assert.equal(memoryTextFor({ scope: "broadcast", text: "게임 이야기" }, false), "게임 이야기");
  });
});

describe("테스트 채팅 Enter", () => {
  test("한글 조합 중 Enter는 보내지 않는다", () => {
    assert.equal(isSubmitEnter({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: true } }), false);
    assert.equal(isSubmitEnter({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } }), true);
  });
});
