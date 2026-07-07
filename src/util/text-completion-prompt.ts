import type { ChatMessage } from "./context-builder";

/**
 * 텍스트 컴플리션 최종 프롬프트 — 순수 함수.
 *
 * 컨텍스트 빌더가 만든 메시지 배열을 한 문자열로 잇는다. 미리보기에서 파트별로
 * 색을 칠할 수 있도록, 먼저 "세그먼트"(텍스트 + 파트)로 만들고 그것을 이어 문자열을
 * 만든다 — 그래서 화면에 칠해 보이는 색과 실제 전송 문자열이 항상 일치한다.
 */

/** 미리보기 색칠용 파트 분류. */
export type PromptPart =
  | "token"
  | "system"
  | "scenario"
  | "description"
  | "personality"
  | "lorebook"
  | "memory"
  | "examples"
  | "body"
  | "authornote"
  | "other";

export interface PromptSegment {
  text: string;
  part: PromptPart;
}

/** 메시지를 색칠 파트로 분류. */
function partOf(m: ChatMessage): PromptPart {
  const src = m.source;
  if (src?.type === "authorNote") return "authornote";
  if (src?.type === "summary") return "other";
  if (m.contextKind === "history" || m.contextKind === "injection") return "body";
  if (src?.type === "lorebook" || src?.type === "fallback") return "lorebook";
  if (src?.type === "memory") return "memory";
  if (src?.type === "scenario") {
    const l = (src.label || "").toLowerCase();
    if (l.includes("description")) return "description";
    if (l.includes("personality")) return "personality";
    if (l.includes("dialogue") || l.includes("example")) return "examples";
    return "scenario";
  }
  if (src?.type === "marker") {
    const l = (src.label || "").toLowerCase();
    if (l.includes("chat history")) return "body";
    return "other";
  }
  if (src?.type === "prompt") return "system";
  return "other";
}

function nonEmpty(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.content && m.content.length > 0);
}

/** 마지막(본문 끝)은 줄바꿈 보존(이어쓰기), 그 외는 끝 줄바꿈 정리. */
function trimForJoin(content: string, isLast: boolean): string {
  return isLast ? content : content.replace(/\n+$/, "");
}

/** 본문 영역의 시작으로 볼 메시지 — 스토리/주입/작가노트/요약. */
function isBodyMessage(m: ChatMessage): boolean {
  return (
    m.contextKind === "history" ||
    m.contextKind === "injection" ||
    m.source?.type === "authorNote" ||
    m.source?.type === "summary"
  );
}

/**
 * "NAI 형식으로 보내기"를 쓰지 않을 때, 메모리 등 배경 설정과 실제 세션 본문을
 * 모델이 구분하도록 본문 직전에 끼우는 마커. NAI 형식은 같은 자리에 자체 구분자
 * (`NAI_BODY_SEPARATOR`)를 쓰므로 이 마커는 넣지 않는다.
 */
export const SESSION_START_MARKER = "[Start the new session]";

// ─────────────────────────── 평문(NAI 끔) ───────────────────────────

/**
 * 슬롯 사이에 빈 줄을 넣지 않고 한 줄(\n)로만 잇는다. 본문 끝은 보존.
 */
export function buildTextCompletionSegments(
  messages: ChatMessage[]
): PromptSegment[] {
  const parts = nonEmpty(messages);
  const bodyStart = parts.findIndex(isBodyMessage);
  if (bodyStart >= 0) {
    parts.splice(bodyStart, 0, {
      role: "system",
      content: SESSION_START_MARKER,
      source: { type: "marker", label: "Session start marker" },
      contextKind: "prompt",
    });
  }
  const segs: PromptSegment[] = [];
  parts.forEach((m, i) => {
    if (i > 0) segs.push({ text: "\n", part: "token" });
    segs.push({ text: trimForJoin(m.content, i === parts.length - 1), part: partOf(m) });
  });
  return segs;
}

// ─────────────────────────── NAI 형식 ───────────────────────────

type NaiTurn = "system" | "user" | "assistant";

const NAI_TOKEN: Record<NaiTurn, string> = {
  system: "<|system|>",
  user: "<|user|>",
  assistant: "<|assistant|> <think></think>",
};

/**
 * 메시지를 NAI 역할 턴으로 분류.
 *  - 작가노트/요약 → system (개입)
 *  - 본문(chat history / 깊이 주입) → assistant
 *  - 일반 text 프롬프트 → 그 역할(system/user/assistant)
 *  - 그 외(시나리오/로어북/메모리/마커 등 컨텍스트) → user
 */
function naiTurnOf(m: ChatMessage): NaiTurn {
  if (m.source?.type === "authorNote" || m.source?.type === "summary") {
    return "system";
  }
  if (m.contextKind === "history" || m.contextKind === "injection") {
    return "assistant";
  }
  if (m.source?.type === "prompt") {
    return m.role === "assistant"
      ? "assistant"
      : m.role === "user"
        ? "user"
        : "system";
  }
  return "user";
}

/**
 * NovelAI 구분자 — "NAI 형식으로 보내기"가 켜지면 본문(스토리) 직전에 삽입한다.
 * 프롬프트 세트가 아니라 이 가공 규칙의 소관이다 (체크박스 = 역할 토큰 + 이 구분자).
 */
export const NAI_BODY_SEPARATOR = "*** \nWrite./nothink";

/**
 * "NAI 형식으로 보내기" 세그먼트.
 *
 * `[gMASK]<sop>` 로 시작하고, 역할이 바뀔 때만 토큰을 새로 연다(같은 역할은 묶음).
 * 그래서 어시스턴트 오프너는 어시스턴트가 실제로 글을 시작하는 자리에만 들어가고,
 * 작가노트(system) 개입 뒤엔 다시 열린다. 토큰 앞에는 (첫 토큰 빼고) 줄바꿈을 둔다.
 * 본문이 있으면 그 직전에 NovelAI 구분자(`***`/`Write./nothink`)를 user 턴으로 끼운다.
 */
export function buildNaiFormatSegments(messages: ChatMessage[]): PromptSegment[] {
  const parts = nonEmpty(messages);
  const bodyStart = parts.findIndex(isBodyMessage);
  if (bodyStart >= 0) {
    parts.splice(bodyStart, 0, {
      role: "user",
      content: NAI_BODY_SEPARATOR,
      source: { type: "marker", label: "NovelAI separator" },
      contextKind: "prompt",
    });
  }
  const segs: PromptSegment[] = [];
  let prev: NaiTurn | null = null;
  let first = true;
  parts.forEach((m, i) => {
    const turn = naiTurnOf(m);
    const content = trimForJoin(m.content, i === parts.length - 1);
    if (turn !== prev) {
      const lead = first ? "[gMASK]<sop>" : "\n";
      segs.push({ text: lead + NAI_TOKEN[turn] + "\n", part: "token" });
      prev = turn;
      first = false;
    } else {
      segs.push({ text: "\n", part: "token" });
    }
    segs.push({ text: content, part: partOf(m) });
  });
  return segs;
}

// ─────────────────────────── 문자열 ───────────────────────────

export function segmentsToString(segs: PromptSegment[]): string {
  return segs.map((s) => s.text).join("");
}

export function buildTextCompletionPrompt(messages: ChatMessage[]): string {
  return segmentsToString(buildTextCompletionSegments(messages));
}

export function buildNaiFormatPrompt(messages: ChatMessage[]): string {
  return segmentsToString(buildNaiFormatSegments(messages));
}
