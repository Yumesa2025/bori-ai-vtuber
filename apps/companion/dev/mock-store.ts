/**
 * 개발·검증용 가짜 1:1 대화 API의 상태와 규칙.
 * 실제 서버(`apps/server`)가 아직 없을 때 화면을 계약대로 확인하려고 둔다. 빌드 산출물에는 들어가지 않는다.
 * 답변은 고정 문장이고 LLM을 부르지 않는다.
 *
 * 메시지 내용에 아래 표시를 넣으면 해당 상황을 흉내 낸다.
 * - `#slow`  답변을 4초 늦춘다. 그 사이 같은 대화에 또 보내면 409가 난다
 * - `#409`   바로 409를 돌려준다
 * - `#500`   500을 돌려준다
 * - `#fail`  LLM 실패를 흉내 내 폴백 답변과 failure를 돌려준다
 * - `#bad`   allowlist 밖 감정·모션 이름을 섞어 보낸다(화면이 실행하지 않아야 한다)
 */

export type MockConversation = { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number };
export type MockMessage = {
  id: string;
  role: "user" | "bori";
  content: string;
  createdAt: string;
  emotion?: { primary: string; intensity: number; durationSeconds: number };
  actions?: { name: string; layer: string; priority: number }[];
  source?: "llm" | "rule" | "fallback" | "blocked";
};
export type MockMemory = { id: string; text: string; createdAt: string; expiresAt: string | null };

export type MockResult = { status: number; body: unknown; delayMs?: number };

const MAX_LENGTH = 500;
const now = () => new Date().toISOString();

type Script = Pick<MockMessage, "content" | "emotion" | "actions" | "source">;

/** 키워드별 고정 답변. 표정·모션 실행을 확인하려고 감정과 actions를 다르게 둔다. */
function scriptFor(content: string): Script {
  if (content.includes("#fail")) {
    return { content: "앗, 잠깐 생각이 엉켰어요. 한 번만 다시 말해 줄래요?", emotion: { primary: "awkward", intensity: 0.4, durationSeconds: 3 }, actions: [], source: "fallback" };
  }
  if (content.includes("#bad")) {
    return { content: "음… 이건 어떤 표정을 지어야 할지 모르겠어요.", emotion: { primary: "ecstatic", intensity: 2, durationSeconds: 999 }, actions: [{ name: "backflip", layer: "body", priority: 99 }, { name: "../../etc", layer: "body", priority: 3 }], source: "llm" };
  }
  if (/게임|이터널/.test(content)) {
    return { content: "게임 이야기라면 언제든 좋아요! 요즘은 뭐 하고 있어요?", emotion: { primary: "gaming", intensity: 0.7, durationSeconds: 4 }, actions: [{ name: "shoushi", layer: "body", priority: 2 }], source: "llm" };
  }
  if (/슬퍼|힘들|우울/.test(content)) {
    return { content: "많이 힘들었겠어요. 천천히 이야기해 줘도 괜찮아요. 제가 들을게요.", emotion: { primary: "sad", intensity: 0.6, durationSeconds: 5 }, actions: [], source: "llm" };
  }
  if (/화나|짜증/.test(content)) {
    return { content: "흥, 그건 저도 좀 발끈하게 되네요!", emotion: { primary: "angry", intensity: 0.5, durationSeconds: 3 }, actions: [{ name: "shengqi", layer: "body", priority: 2 }], source: "llm" };
  }
  return { content: "반가워요! 오늘 하루는 어땠어요? 무슨 이야기든 들려줘요.", emotion: { primary: "happy", intensity: 0.6, durationSeconds: 4 }, actions: [{ name: "xingxingyan", layer: "body", priority: 2 }], source: "llm" };
}

export function createMockStore() {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1).toString(36)}`;
  const conversations = new Map<string, MockConversation>();
  const messages = new Map<string, MockMessage[]>();
  const busy = new Set<string>();
  const audio = new Set<string>();
  const memories: MockMemory[] = [
    { id: "mem-seed-1", text: "민트초코를 좋아한다고 했다.", createdAt: "2026-10-01T09:00:00.000Z", expiresAt: null },
    { id: "mem-seed-2", text: "주말마다 산책을 한다고 했다.", createdAt: "2026-10-05T12:30:00.000Z", expiresAt: "2027-04-05T12:30:00.000Z" },
  ];

  const notFound = (): MockResult => ({ status: 404, body: { error: "대화를 찾을 수 없습니다." } });

  return {
    hasAudio: (id: string) => audio.has(id),

    listConversations(): MockResult {
      const list = [...conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { status: 200, body: { conversations: list } };
    },

    createConversation(body: unknown): MockResult {
      const title = typeof (body as { title?: unknown } | null)?.title === "string" ? (body as { title: string }).title.trim().slice(0, 60) : "";
      const time = now();
      const conversation: MockConversation = { id: nextId("conv"), title: title || "새 대화", createdAt: time, updatedAt: time, messageCount: 0 };
      conversations.set(conversation.id, conversation);
      messages.set(conversation.id, []);
      return { status: 201, body: { conversation } };
    },

    getMessages(id: string): MockResult {
      const conversation = conversations.get(id);
      if (!conversation) return notFound();
      return { status: 200, body: { conversation, messages: messages.get(id) ?? [] } };
    },

    deleteConversation(id: string): MockResult {
      if (!conversations.delete(id)) return notFound();
      messages.delete(id);
      return { status: 200, body: { deleted: true } };
    },

    /**
     * 메시지를 받아 답변을 만든다. 실제 서버처럼 같은 대화의 답변 생성이 겹치면 409를 준다.
     * 답변을 기다리는 시간은 delayMs로 돌려주고, finish를 부를 때 기록한다.
     */
    sendMessage(id: string, body: unknown): MockResult & { finish?: () => MockResult } {
      const conversation = conversations.get(id);
      if (!conversation) return notFound();
      const raw = (body as { content?: unknown } | null)?.content;
      if (typeof raw !== "string" || raw.trim().length === 0 || raw.trim().length > MAX_LENGTH) {
        return { status: 400, body: { error: "메시지는 1자 이상 500자 이하여야 합니다." } };
      }
      const content = raw.trim();
      if (busy.has(id) || content.includes("#409")) return { status: 409, body: { error: "이 대화는 답변을 만드는 중입니다." } };
      if (content.includes("#500")) return { status: 500, body: { error: "내부 오류" } };

      busy.add(id);
      const wantsTts = (body as { tts?: unknown } | null)?.tts === true;
      return {
        status: 200,
        body: null,
        delayMs: content.includes("#slow") ? 4000 : 1200,
        finish: () => {
          busy.delete(id);
          // 그 사이 대화가 지워졌으면 실제 서버처럼 404로 끝낸다.
          if (!conversations.has(id)) return notFound();
          const script = scriptFor(content);
          const userMessage: MockMessage = { id: nextId("msg"), role: "user", content, createdAt: now() };
          const reply: MockMessage = { id: nextId("msg"), role: "bori", createdAt: now(), ...script };
          messages.get(id)!.push(userMessage, reply);
          conversation.messageCount += 2;
          conversation.updatedAt = reply.createdAt;
          if (content.includes("기억해")) memories.unshift({ id: nextId("mem"), text: content.replace(/기억해(줘|요)?/g, "").trim() || content, createdAt: now(), expiresAt: null });

          const result: Record<string, unknown> = { userMessage, reply };
          if (wantsTts) { const audioId = nextId("tts"); audio.add(audioId); result.audioId = audioId; }
          if (script.source === "fallback") result.failure = { kind: "llm_error" };
          return { status: 200, body: result };
        },
      };
    },

    listMemories(): MockResult {
      return { status: 200, body: { memories: [...memories] } };
    },

    deleteMemory(id: string): MockResult {
      const index = memories.findIndex(memory => memory.id === id);
      if (index < 0) return { status: 404, body: { error: "기억을 찾을 수 없습니다." } };
      memories.splice(index, 1);
      return { status: 200, body: { deleted: true } };
    },

    deleteAllMemories(): MockResult {
      const count = memories.length;
      memories.length = 0;
      return { status: 200, body: { deleted: count } };
    },

    /** 1:1 기록 모두 지우기. 대화·메시지·기억을 한 번에 지우고 개수를 돌려준다. */
    deleteAllData(): MockResult {
      const deleted = {
        conversations: conversations.size,
        messages: [...messages.values()].reduce((sum, list) => sum + list.length, 0),
        memories: memories.length,
      };
      conversations.clear();
      messages.clear();
      memories.length = 0;
      return { status: 200, body: { deleted } };
    },

    profile(): MockResult {
      return { status: 200, body: { name: "보리", personaLines: ["가짜 API가 돌려주는 예시 문장입니다."], companionPolicyTitle: "1:1 대화" } };
    },

    catalog(): MockResult {
      return {
        status: 200,
        body: {
          emotions: ["happy", "excited", "greeting", "gaming", "crying", "angry", "sad", "embarrassed", "awkward", "calm", "curious"],
          expressions: ["xingxingyan", "kuqi", "shangxin", "shengqi", "shoushi", "wuyu", "chidai", "changfa"],
          motions: [{ name: "xingxingyan", description: "반짝이는 눈" }, { name: "kuqi", description: "울음" }, { name: "shengqi", description: "화남" }, { name: "shoushi", description: "게임패드" }],
        },
      };
    },
  };
}

export type MockStore = ReturnType<typeof createMockStore>;

/** 립싱크 확인용 음성. 1.6초 동안 크기가 오르내리는 사인파 WAV를 만든다. */
export function createToneWav(seconds = 1.6, sampleRate = 16000): Uint8Array {
  const samples = Math.floor(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeText(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); writeText(8, "WAVE");
  writeText(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, "data"); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    // 음절처럼 들리도록 초당 5번 크기를 오르내린다.
    const envelope = Math.abs(Math.sin(Math.PI * 5 * t));
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 220 * t) * envelope * 0.4 * 32767), true);
  }
  return new Uint8Array(buffer);
}
