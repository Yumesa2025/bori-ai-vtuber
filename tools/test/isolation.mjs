/**
 * 기억 격리 검사.
 *
 * 방송에서 시청자 A의 기억이 B에게 하는 답변 문맥에 들어가지 않는지 실제 LLM 요청 본문으로 확인한다.
 * 고정 자료 memories.json은 일부러 예전(v1) 형식으로 둔다. 서버가 뜰 때 마이그레이션이 실제로 돌고,
 * 그 결과로 소유자 없는 기억은 지워지고 local: 시청자 기억은 그 시청자 소유로 남아야 한다.
 */
import { readdirSync } from "node:fs";
import { baseQueueSettings } from "./harness.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 고정 자료의 기억 문장 일부. 프롬프트에 들어갔는지 이 문자열로 찾는다. */
const SHARED_MEMORY = "잔잔한 인디 음악";
const A_MEMORY = "고양이 두 마리";
const VIRTUAL_MEMORY = "매운 떡볶이";
const NO_OWNER_MEMORY = "주말마다 등산";

const A = "viewer_a";
const B = "viewer_b";

export const meta = {
  name: "기억 격리",
  timing: { llm: 300, tts: 200, embed: 100 },
};

export async function run({ bori, mock, report, dataDir }) {
  // ── 서버 기동 시 마이그레이션 ──────────────────────────────
  {
    const memory = await bori.memory();
    const texts = memory.records.map(record => record.text);
    report.check("v1 기억 파일이 기동 시 옮겨진다 (4건 중 2건 남음)", memory.count === 2, `count=${memory.count}`);
    report.check("소유자 불명 기억(virtual-viewer, viewerId 없음)은 지워진다", !texts.some(text => text.includes(VIRTUAL_MEMORY) || text.includes(NO_OWNER_MEMORY)));

    const owned = memory.records.find(record => record.text.includes(A_MEMORY));
    const shared = memory.records.find(record => record.text.includes(SHARED_MEMORY));
    report.check(
      "/api/memory에 scope와 ownerId가 보인다",
      owned?.scope === "broadcast" && owned?.ownerId === `local:${A}` && shared?.scope === "broadcast" && shared?.ownerId === undefined,
      `A=${owned?.scope}/${owned?.ownerId} 요약=${shared?.scope}/${shared?.ownerId ?? "-"}`,
    );

    const backups = readdirSync(dataDir).filter(name => name.startsWith("memories.v1-backup-"));
    report.check("옮기기 전 원본 백업이 남는다", backups.length === 1, backups[0] ?? "없음");
  }

  await bori.patchSettings(baseQueueSettings);
  await bori.startSession();
  await mock.reset();

  /** 채팅 한 건을 보내고, 그 채팅에 대한 LLM 답변 요청 본문을 돌려준다. */
  async function promptFor(content, nickname) {
    await bori.chat(content, nickname);
    await bori.waitForReply();
    await bori.waitForIdle();
    return (await mock.answerCalls()).filter(entry => entry.user.includes(content)).at(-1)?.user ?? "";
  }

  // ── 방송 답변 문맥 격리 ────────────────────────────────────
  // 기억을 묻는 문장은 규칙을 건너뛰고 반드시 LLM으로 간다.
  {
    const forB = await promptFor("제가 전에 말한 거 기억하세요", B);
    report.check("B 채팅이 LLM으로 갔다", forB.length > 0);
    report.check("A의 기억이 B 채팅의 LLM 요청에 들어가지 않는다", !forB.includes(A_MEMORY));
    report.check("B 채팅에도 소유자 없는 방송 기억은 들어간다", forB.includes(SHARED_MEMORY));

    const forA = await promptFor("저번에 제가 한 얘기 기억나요", A);
    report.check("A의 기억이 A 채팅의 LLM 요청에는 들어간다", forA.includes(A_MEMORY));

    const forAnonymous = await promptFor("지난번 얘기 기억하시나요", undefined);
    report.check("익명 채팅의 LLM 요청에는 A의 기억이 들어가지 않는다", forAnonymous.length > 0 && !forAnonymous.includes(A_MEMORY));
    report.check("지워진 기억은 어떤 요청에도 들어가지 않는다", ![forA, forB, forAnonymous].some(user => user.includes(VIRTUAL_MEMORY) || user.includes(NO_OWNER_MEMORY)));
  }

  // ── 방송 종료 시 저장 ──────────────────────────────────────
  {
    const named = "저는 퇴근하고 피아노 연주곡 듣는 걸 좋아해요";
    const anonymous = "저는 주말마다 자전거 타는 걸 좋아해요";
    await promptFor(named, A);
    await promptFor(anonymous, undefined);
    await bori.endSession();

    // 저장은 방송 요약 호출 뒤에 끝나므로 잠시 기다린다.
    let records = [];
    for (let tries = 0; tries < 40; tries += 1) {
      records = (await bori.memory()).records;
      if (records.some(record => record.text === named)) break;
      await sleep(250);
    }
    const saved = records.find(record => record.text === named);
    report.check("이름 있는 시청자의 취향은 그 시청자 소유로 저장된다", saved?.scope === "broadcast" && saved?.ownerId === `local:${A}`, `${saved?.scope}/${saved?.ownerId}`);
    report.check("익명 발언은 기억으로 저장되지 않는다", !records.some(record => record.text.includes("자전거")));
  }
}
