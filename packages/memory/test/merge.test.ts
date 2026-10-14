/**
 * 의미가 같은 기억 병합 검사.
 * 같은 뜻이면 한 건으로 합치는지, 다른 scope·소유자와는 절대 합치지 않는지, 부정·숫자가 다른 문장을 합치지 않는지 본다.
 * 파일은 모두 임시 디렉터리에 만든다. 실제 data/는 건드리지 않는다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSameMemoryText } from "../src/similar.js";
import { createMemoryStore } from "../src/store.js";
import type { EmbeddingProvider, MemoryCandidate, MemorySettings } from "../src/types.js";

const settings: MemorySettings = {
  enabled: true,
  maxMemories: 5,
  minSimilarity: 0.3,
  retentionDays: 30,
  embeddingModel: "test",
  privateDigestEveryMessages: 6,
};

/** 문장마다 정해 둔 벡터를 돌려준다. 정하지 않은 문장은 영벡터라 어떤 기억과도 유사도가 0이다. */
function embeddingOf(vectors: Record<string, number[]>): EmbeddingProvider & { calls: number } {
  return {
    name: "fake",
    calls: 0,
    isConfigured: () => true,
    async embed(texts) {
      this.calls += 1;
      return texts.map(text => vectors[text] ?? [0, 0]);
    },
  };
}

const failingEmbedding: EmbeddingProvider = {
  name: "failing",
  isConfigured: () => true,
  embed: async () => { throw new Error("임베딩 실패"); },
};

const base = { kind: "viewer" as const, importance: 0.5, confidence: 0.5 };
const privateOf = (text: string, ownerId = "companion:local"): MemoryCandidate => ({ ...base, text, scope: "private", ownerId });

let dir: string;
let filePath: string;
const open = () => createMemoryStore(filePath, { log: () => {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-memory-merge-"));
  filePath = join(dir, "memories.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("문자열 규칙", () => {
  test("공백·문장부호·대소문자만 다르면 같은 뜻이다", () => {
    assert.ok(isSameMemoryText("고양이를 키운다.", "고양이를  키운다"));
    assert.ok(isSameMemoryText("Minecraft를 자주 해", "minecraft를 자주 해!"));
  });

  test("앞부분이 같고 끝의 높임·끝맺음만 다르면 같은 뜻이다", () => {
    assert.ok(isSameMemoryText("피아노를 좋아해요", "피아노를 좋아해"));
    assert.ok(isSameMemoryText("상대는 고양이를 좋아한다.", "상대는 고양이를 좋아함."));
    assert.ok(isSameMemoryText("상대의 강아지 이름은 콩이다", "상대의 강아지 이름은 콩이에요"));
  });

  test("정보가 더 붙은 문장은 합치지 않는다", () => {
    assert.equal(isSameMemoryText("피아노를 좋아해", "재즈 피아노를 좋아해"), false);
    assert.equal(isSameMemoryText("고양이를 키운다", "검은 고양이를 키운다고 했다"), false);
    assert.equal(isSameMemoryText("고양이를 키운다", "고양이를 키운다고 했다"), false);
  });

  test("부정이 한쪽에만 있으면 합치지 않는다", () => {
    assert.equal(isSameMemoryText("고양이를 좋아한다", "고양이를 안 좋아한다"), false);
    assert.equal(isSameMemoryText("좋아한다", "안 좋아한다"), false);
    assert.equal(isSameMemoryText("민트초코를 좋아해", "민트초코를 좋아하지 않아"), false);
    assert.equal(isSameMemoryText("오이를 먹는다", "오이를 못 먹는다"), false);
  });

  test("숫자가 다르면 합치지 않는다", () => {
    assert.equal(isSameMemoryText("고양이 2마리를 키운다", "고양이 3마리를 키운다"), false);
  });

  test("빈 문장은 어떤 문장과도 같지 않다", () => {
    assert.equal(isSameMemoryText("...", "!!!"), false);
  });
});

describe("실임베딩으로 0.92가 잘못 합친 쌍(점검 M-1, a2 보고서 4절)", () => {
  // text-embedding-3-small에서 cos 0.92 이상이었고 가드도 통과해 합쳐진 다른 사실들이다. 지금 규칙은 모두 따로 둔다.
  const wronglyMerged: readonly [string, string, number][] = [
    ["상대의 강아지 이름은 콩이다.", "상대의 강아지 이름은 콩떡이다.", 0.956],
    ["상대는 강아지 콩이를 키운다.", "상대는 강아지 콩떡이를 키운다.", 0.956],
    ["상대는 고양이를 좋아한다.", "상대는 고양이를 좋아했었다.", 0.975],
    ["상대는 매일 두 시간씩 게임을 한다.", "상대는 매일 다섯 시간씩 게임을 한다.", 0.927],
    ["상대는 스물다섯 살이다.", "상대는 스물여섯 살이다.", 0.942],
    ["상대는 공포 영화를 즐겨 본다.", "상대는 공포 영화를 꺼린다.", 0.954],
  ];
  for (const [a, b, cos] of wronglyMerged) {
    test(`${a} / ${b} (cos ${cos})`, () => {
      assert.equal(isSameMemoryText(a, b), false);
    });
  }

  test("시제·한글 수사만 달라도 가드가 막는다", () => {
    assert.equal(isSameMemoryText("상대는 피아노를 배우고 있다.", "상대는 피아노를 배웠다."), false);
    assert.equal(isSameMemoryText("고양이 두 마리를 키운다", "고양이 세 마리를 키운다"), false);
  });

  test("임베딩이 거의 같은 다른 문장도 저장소가 합치지 않는다", async () => {
    // 예전에는 문자열로 못 잡으면 임베딩 0.92로 한 번 더 합쳐 새 사실(콩떡)이 사라지고 옛 사실의 횟수가 올랐다.
    const sameVector: EmbeddingProvider = { name: "same", isConfigured: () => true, embed: async texts => texts.map(() => [1, 0]) };
    const store = open();
    await store.add([privateOf("상대의 강아지 이름은 콩이다.")], settings, sameVector);
    assert.equal(await store.add([privateOf("상대의 강아지 이름은 콩떡이다.")], settings, sameVector), 1);
    assert.deepEqual(store.all().map(record => [record.text, record.repeatCount]), [["상대의 강아지 이름은 콩이다.", 1], ["상대의 강아지 이름은 콩떡이다.", 1]]);
  });
});

describe("저장소 병합", () => {
  test("같은 뜻의 후보는 새로 만들지 않고 최신 문장으로 바꾼 뒤 횟수·마지막 시각을 올린다", async () => {
    const store = open();
    assert.equal(await store.add([privateOf("고양이를 키워.")], settings, null), 1);
    const [first] = store.all();

    assert.equal(await store.add([privateOf("고양이를 키워요")], settings, null), 0);
    const [merged] = store.all();
    assert.equal(store.count(), 1);
    // 점검 M-1: 예전에는 옛 문장을 남겨 새 문장이 버려졌다.
    assert.equal(merged.text, "고양이를 키워요");
    assert.equal(merged.repeatCount, 2);
    assert.equal(merged.createdAt, first.createdAt);
    assert.equal(typeof merged.lastSeenAt, "string");

    // 갱신한 시각과 횟수가 파일에도 남는다.
    const reopened = open();
    reopened.load();
    assert.equal(reopened.all()[0].repeatCount, 2);
    assert.equal(reopened.all()[0].lastSeenAt, merged.lastSeenAt);
  });

  test("한 묶음 안의 같은 뜻 후보도 한 건이 된다", async () => {
    const store = open();
    assert.equal(await store.add([privateOf("기타를 배우고 있어"), privateOf("기타를 배우고 있어요")], settings, null), 1);
    assert.equal(store.all()[0].repeatCount, 2);
  });

  test("부정이 다른 후보는 따로 저장한다", async () => {
    const store = open();
    await store.add([privateOf("오이를 좋아한다")], settings, null);
    assert.equal(await store.add([privateOf("오이를 안 좋아한다")], settings, null), 1);
    assert.equal(store.count(), 2);
  });

  test("임베딩이 가까운 바꿔 쓰기도 문장이 다르면 둘 다 남긴다(ADR-023)", async () => {
    // 바꿔 쓰기를 하나로 모으는 일은 LLM 정리의 replaces가 맡는다. 임베딩으로 합치면 다른 사실이 사라진다.
    const embedding = embeddingOf({ "주말마다 등산을 간다": [1, 0], "주말이면 산에 오른다": [0.99, 0.14] });
    const store = open();
    await store.add([privateOf("주말마다 등산을 간다")], settings, embedding);
    assert.equal(await store.add([privateOf("주말이면 산에 오른다")], settings, embedding), 1);
    assert.equal(store.count(), 2);
    // 후보 묶음마다 임베딩 호출은 한 번이다.
    assert.equal(embedding.calls, 2);
  });

  test("합치면서 문장이 바뀌면 임베딩도 새 문장으로 다시 만든다", async () => {
    const embedding = embeddingOf({ "피아노를 좋아해": [1, 0], "피아노를 좋아해요": [0, 1] });
    const store = open();
    await store.add([privateOf("피아노를 좋아해")], settings, embedding);
    assert.equal(await store.add([privateOf("피아노를 좋아해요")], settings, embedding), 0);
    assert.deepEqual(store.all().map(record => [record.text, record.embedding]), [["피아노를 좋아해요", [0, 1]]]);
  });

  test("replaces로 지정한 같은 소유자의 기억은 지우고 새 기억을 남긴다(점검 M-4)", async () => {
    const store = open();
    await store.add([privateOf("상대는 부산에 산다."), privateOf("상대는 오이를 싫어한다."), privateOf("상대는 부산에 산다.", "companion:other")], settings, null);
    const [busan, cucumber, others] = store.all();
    assert.equal(await store.add([{ ...privateOf("상대는 서울로 이사했다."), replaces: [busan.id, others.id, "없는-id"] }], settings, null), 1);
    assert.deepEqual(store.all().map(record => record.text).sort(), ["상대는 부산에 산다.", "상대는 서울로 이사했다.", "상대는 오이를 싫어한다."].sort());
    assert.ok(!store.all().some(record => record.id === busan.id), "내 옛 기억은 지운다");
    assert.ok(store.all().some(record => record.id === others.id), "남의 기억은 지우지 않는다");
    assert.ok(store.all().some(record => record.id === cucumber.id));
    // 파일에도 반영된다.
    const reopened = open();
    reopened.load();
    assert.equal(reopened.count(), 3);
  });

  test("대체하라고 한 기억과 같은 문장이면 지우지 않고 갱신한다", async () => {
    const store = open();
    await store.add([privateOf("상대는 고양이를 키운다")], settings, null);
    const [record] = store.all();
    assert.equal(await store.add([{ ...privateOf("상대는 고양이를 키운다."), replaces: [record.id] }], settings, null), 0);
    assert.deepEqual(store.all().map(entry => [entry.id, entry.repeatCount]), [[record.id, 2]]);
  });

  test("임베딩이 같아도 부정이 다르면 합치지 않는다", async () => {
    const embedding = embeddingOf({ "매운 음식을 좋아한다": [1, 0], "매운 음식을 좋아하지 않는다": [1, 0] });
    const store = open();
    await store.add([privateOf("매운 음식을 좋아한다")], settings, embedding);
    assert.equal(await store.add([privateOf("매운 음식을 좋아하지 않는다")], settings, embedding), 1);
    assert.equal(store.count(), 2);
  });

  test("임베딩이 실패해도 문자열 규칙으로 합치고 저장은 된다", async () => {
    const store = open();
    assert.equal(await store.add([privateOf("수영을 배우고 있어")], settings, failingEmbedding), 1);
    assert.equal(await store.add([privateOf("수영을 배우고 있어!")], settings, failingEmbedding), 0);
    assert.equal(await store.add([privateOf("요가를 배우고 있어")], settings, failingEmbedding), 1);
    assert.equal(store.count(), 2);
  });
});

describe("병합 격리", () => {
  // 모든 문장에 같은 벡터를 준다. scope·소유자 검사가 없으면 전부 한 건으로 합쳐진다.
  const sameVector: EmbeddingProvider = { name: "same", isConfigured: () => true, embed: async texts => texts.map(() => [1, 0]) };

  test("뜻이 같아도 소유자가 다르면 합치지 않는다", async () => {
    const store = open();
    await store.add([privateOf("고양이를 키운다", "companion:a")], settings, sameVector);
    assert.equal(await store.add([privateOf("고양이를 키운다.", "companion:b")], settings, sameVector), 1);
    assert.equal(await store.add([privateOf("고양이를 키운다!", "companion:b")], settings, sameVector), 0);
    assert.deepEqual(store.all().map(record => [record.ownerId, record.repeatCount]).sort(), [["companion:a", 1], ["companion:b", 2]]);
  });

  test("뜻이 같아도 scope가 다르면 합치지 않는다", async () => {
    const store = open();
    const candidates: MemoryCandidate[] = [
      { ...base, text: "게임 방송을 좋아한다", scope: "broadcast", ownerId: "local:a" },
      { ...base, text: "게임 방송을 좋아한다.", scope: "private", ownerId: "local:a" },
      { ...base, text: "게임 방송을 좋아한다!", scope: "broadcast" },
      { ...base, text: "게임 방송을 좋아해", kind: "broadcast", scope: "character" },
    ];
    assert.equal(await store.add(candidates, settings, sameVector), 4);
    assert.ok(store.all().every(record => record.repeatCount === 1));
  });

  test("1:1 개인 기억은 같은 사람의 방송 기억에 합쳐지지 않고, 그 반대도 아니다", async () => {
    const store = open();
    await store.add([{ ...base, text: "고양이를 키운다", scope: "broadcast", ownerId: "local:a" }], settings, sameVector);
    await store.add([privateOf("고양이를 키운다", "local:a")], settings, sameVector);
    await store.add([{ ...base, text: "고양이를 키운다.", scope: "broadcast", ownerId: "local:a" }], settings, sameVector);

    const broadcast = store.all().filter(record => record.scope === "broadcast");
    const personal = store.all().filter(record => record.scope === "private");
    assert.equal(broadcast.length, 1);
    assert.equal(broadcast[0].repeatCount, 2);
    assert.equal(personal.length, 1);
    assert.equal(personal[0].repeatCount, 1);
  });
});
