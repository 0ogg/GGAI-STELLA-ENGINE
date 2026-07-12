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

// ─────────────────────── 챗 세션 이름 턴 (M6) ───────────────────────
//
// 챗 모드 세션을 텍스트 컴플리션 모델로 보낼 때의 SillyTavern 호환 가공.
// (ST script.js: formatMessageHistoryItem = `이름: 내용`, modifyLastPromptLine =
//  끝에 `\n{{char}}:` 오프너, getStoppingStrings = `\n{{user}}:` 스탑,
//  cleanUpMessage = 출력에서 유저 턴 절단 + 캐릭터 라벨 제거)

export interface ChatCompletionNames {
  /** 유저(페르소나) 이름 — {{user}}. */
  user: string;
  /** 캐릭터(시나리오) 이름 — {{char}}. 그룹 챗은 이번 발화자 이름. */
  char: string;
  /**
   * 그룹 챗 — 발화자를 뺀 나머지 멤버 이름들. 이들의 `이름:` 턴 시작도
   * 유저 턴과 똑같이 스탑(절단) 대상이 된다 (남의 대사를 쓰면 잘라낸다).
   */
  others?: string[];
}

/**
 * 챗 히스토리 메시지에 `이름: ` 프리픽스를 붙이고, 끝에 `{{char}}:` 오프너
 * 메시지를 추가한다 — 평문/NAI 형식 평탄화 직전에 적용 (원본 배열 불변).
 * 히스토리 사이에 낀 주입/메모리/작가노트(비 chat 소스)는 건드리지 않는다.
 * 그룹 챗은 로그 조립 단계에서 발화자별 이름이 이미 붙어 있으므로
 * `historyAlreadyNamed` 로 프리픽스를 건너뛰고 오프너만 연다.
 */
export function applyChatTurnNames(
  messages: ChatMessage[],
  names: ChatCompletionNames,
  opts?: { historyAlreadyNamed?: boolean }
): ChatMessage[] {
  const named: ChatMessage[] = opts?.historyAlreadyNamed
    ? [...messages]
    : messages.map((m) => {
        if (m.contextKind !== "history" || m.source?.type !== "chat") return m;
        const name = m.role === "user" ? names.user : names.char;
        return { ...m, content: `${name}: ${m.content}` };
      });
  named.push({
    role: "assistant",
    content: `${names.char}:`,
    source: { type: "marker", label: "Chat history opener" },
    contextKind: "history",
  });
  return named;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 문단 하나가 문장으로 끝나 완결됐는가 — 종결부호 또는 닫는 따옴표/괄호로 끝나면 완결. */
function isCompleteParagraph(p: string): boolean {
  const t = p.replace(/\s+$/, "");
  if (!t) return false;
  return /[.!?…。！？~"'”’」』）)\]]$/.test(t);
}

/**
 * 유저 턴을 만나지 못하고 생성이 끝난 경우(자연 종료/토큰 컷), 잘려버린 마지막
 * 문단이 미완성이면 그 문단만 제거한다. 단, 앞에 다른 문단이 남아 있을 때만 —
 * 문단이 하나뿐인 짧은 응답은 미완성이라도 통째로 지우지 않는다(빈 응답 무산 방지).
 */
function dropIncompleteTailParagraph(text: string): string {
  const parts = text.split(/(\n\s*\n)/); // 구분자 보존: [문단, 구분자, 문단, ...]
  if (parts.length < 3) return text; // 문단 하나뿐 — 건드리지 않는다.
  const last = parts[parts.length - 1];
  if (last.trim() && !isCompleteParagraph(last)) {
    return parts.slice(0, -2).join(""); // 마지막 문단 + 그 앞 구분자 제거.
  }
  return text;
}

/**
 * 텍스트 컴플리션 출력 후처리 — ST cleanUpMessage 참조.
 * 스탑 이름 = 유저 + (그룹 챗이면) 발화자 외 다른 멤버 전원.
 *  1) 끝에 반쯤 잘린 `\n이름:` 스탑 스트링 제거 (max_tokens 컷 대비)
 *  2) 응답이 통째로 남의 턴이면 폐기 ("" — 빈 응답 경로로 무산)
 *  3) 첫 `\n이름:` 턴부터 끝까지 절단
 *  4) 줄 앞 `{{char}}:` 라벨 제거 (오프너 에코 + 반복 라벨)
 *  5) 남의 턴을 못 만나고 끝났으면(생성 자연 종료/토큰 컷) 미완성 마지막 문단 제거
 *     — 챗 컴플리션(그룹 절단만 필요) 경로는 `dropIncompleteTail: false` 로 끈다.
 */
export function trimChatCompletionOutput(
  text: string,
  names: ChatCompletionNames,
  opts?: { dropIncompleteTail?: boolean }
): string {
  let out = text;
  const stopNames = [names.user, ...(names.others ?? [])].filter(
    (n) => n.trim().length > 0
  );
  // 1) 끝의 부분 스탑 제거 — 가장 길게 걸리는 것 하나.
  let partialCut = 0;
  for (const name of stopNames) {
    const stop = `\n${name}:`;
    for (let j = stop.length; j > partialCut; j--) {
      if (out.endsWith(stop.slice(0, j))) {
        partialCut = j;
        break;
      }
    }
  }
  if (partialCut > 0) out = out.slice(0, -partialCut);

  const head = out.trimStart();
  if (stopNames.some((n) => head.startsWith(`${n}:`))) return "";

  // 3) 가장 먼저 나오는 스탑 턴에서 절단.
  let stopIdx = -1;
  for (const name of stopNames) {
    const idx = out.indexOf(`\n${name}:`);
    if (idx >= 0 && (stopIdx < 0 || idx < stopIdx)) stopIdx = idx;
  }
  // 스탑 턴을 만났는가 = 발화자 턴이 완결됐다는 신호. 못 만나면 잘린 것.
  const hitStopTurn = stopIdx >= 0;
  if (hitStopTurn) out = out.slice(0, stopIdx);
  out = out.replace(
    new RegExp(`(^|\\n)${escapeRegExp(names.char)}:[ \\t]*`, "g"),
    "$1"
  );
  if (!hitStopTurn && opts?.dropIncompleteTail !== false) {
    out = dropIncompleteTailParagraph(out);
  }
  return out.trim();
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
