/**
 * SillyTavern 채팅 로그(.jsonl) 파서 — 순수 로직.
 *
 * ST 채팅은 줄 단위 JSON(JSONL)이다:
 *  - 1번째 줄  = 헤더 { user_name, character_name, create_date, chat_metadata }
 *  - 2번째 줄~ = 메시지 { name, is_user, is_system, mes, swipe_id, swipes[], swipe_info[], extra }
 *
 * 캐릭터 카드(설명/성격/first_mes)는 이 파일에 **없다** — character_name 문자열뿐.
 * 그래서 임포트 시 사용자가 붙일 시나리오를 골라야 한다(등록 UI).
 *
 * 스와이프 = 같은 메시지의 재생성 대안 → 스텔라 형제 노드로 보존한다.
 * 번역 익스텐션을 쓴 채팅은 `mes`/`swipes[i]` 가 표시(번역)본이고
 * `extra.original_text_for_translation` 가 원문이다. 이때 본문 = 원문, 번역 = 표시본.
 */

export interface StChatSwipe {
  /** 본문에 넣을 텍스트 (원문이 있으면 원문, 없으면 표시본). */
  source: string;
  /** 번역본 — 원문과 표시본이 다를 때만(번역 익스텐션 사용 턴). */
  translation?: string;
}

export interface StChatMessage {
  role: "user" | "assistant";
  swipes: StChatSwipe[];
  /** 활성(마지막에 보고 있던) 스와이프 인덱스. */
  activeIndex: number;
}

export interface ParsedStChat {
  userName: string;
  characterName: string;
  messages: StChatMessage[];
}

/** \r\n / \r → \n 로 정규화 (ST 는 \r\n 을 쓴다). 문단 토큰화·본문 일관성용. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function firstJsonObject(text: string): Record<string, any> | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      return obj && typeof obj === "object" ? obj : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * ST 채팅 JSONL 인지 판별한다. 첫 JSON 줄(헤더)에 character_name + (chat_metadata|user_name)
 * 이 있으면 ST 채팅으로 본다. 이 조합은 캐릭터카드/로어북/프리셋 어느 것과도 겹치지 않는다.
 */
export function isSillyTavernChat(text: string): boolean {
  const head = firstJsonObject(text);
  if (!head) return false;
  return (
    typeof head.character_name === "string" &&
    (!!head.chat_metadata || typeof head.user_name === "string")
  );
}

function toSwipe(original: string, display: string): StChatSwipe {
  const o = original.trim();
  const d = display.trim();
  if (o && o !== d) {
    return { source: normalizeNewlines(original), translation: normalizeNewlines(display) };
  }
  return { source: normalizeNewlines(display) };
}

function parseMessage(obj: Record<string, any>): StChatMessage {
  const role: "user" | "assistant" = obj.is_user === true ? "user" : "assistant";

  const rawSwipes: string[] =
    Array.isArray(obj.swipes) && obj.swipes.length > 0
      ? obj.swipes
      : [typeof obj.mes === "string" ? obj.mes : ""];

  const swipeInfo: any[] = Array.isArray(obj.swipe_info) ? obj.swipe_info : [];
  const activeIndex =
    typeof obj.swipe_id === "number" &&
    obj.swipe_id >= 0 &&
    obj.swipe_id < rawSwipes.length
      ? obj.swipe_id
      : 0;

  const swipes: StChatSwipe[] = rawSwipes.map((display, i) => {
    // 스와이프별 extra 는 swipe_info[i].extra, 없으면 활성 스와이프에 한해 top-level extra.
    const info =
      (swipeInfo[i] && swipeInfo[i].extra) ||
      (i === activeIndex ? obj.extra : undefined);
    const original =
      info && typeof info.original_text_for_translation === "string"
        ? info.original_text_for_translation
        : "";
    return toSwipe(original, typeof display === "string" ? display : "");
  });

  return { role, swipes, activeIndex };
}

export function parseSillyTavernChat(text: string): ParsedStChat {
  let userName = "User";
  let characterName = "Character";
  const messages: StChatMessage[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    // 헤더 줄 — chat_metadata + character_name.
    if (obj.chat_metadata && typeof obj.character_name === "string") {
      if (obj.character_name) characterName = obj.character_name;
      if (typeof obj.user_name === "string" && obj.user_name) userName = obj.user_name;
      continue;
    }

    // 시스템 메시지(UI 알림/노트)는 제외.
    if (obj.is_system === true) continue;
    // 메시지 판별 — mes 문자열 또는 swipes 배열.
    if (typeof obj.mes !== "string" && !Array.isArray(obj.swipes)) continue;

    messages.push(parseMessage(obj));
  }

  return { userName, characterName, messages };
}
