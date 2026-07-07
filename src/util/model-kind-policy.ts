import type { NovelChatRoleMode } from "../types/session";

/**
 * 챗/텍스트 모델의 동작 차이를 한 곳에 모은 정책 테이블.
 *
 * "챗 모델일 때랑 텍스트 모델일 때 뭐가 다른가?" 는 전부 여기서 시작한다.
 * 각 동작(전송본 조립, 파라미터 매핑, NAI 형식 토글 등)은 자기 파일에서 분기하지 말고
 * 이 테이블의 기본값과 resolve* 헬퍼를 불러 쓴다.
 *
 * 여기에 없는 차이(실제 Core 호출: text=generate / chat=chat·chatStream,
 * NAI 역할 토큰 문자열: `text-completion-prompt.ts`, 파라미터 키 매핑 규칙 자체:
 * `generation-params.ts`)는 각주로 위치를 남긴다 — 값은 그 파일이 소유하되
 * "무엇이 다른지"의 목록은 이 파일이 단일 인덱스다.
 */

export type ModelKind = "chat" | "text";

export interface ModelKindDefaults {
  /**
   * 전송 형식. 텍스트 모델은 NAI 역할 토큰으로 감싼 단일 문자열이 기본(ON),
   * 챗 모델은 메시지 배열을 그대로 보내므로 OFF.
   * 사용처: `build-session-context.ts`(전송본), `main.ts setNaiFormatForModel`(모델 선택 시 자동 토글).
   */
  naiFormat: boolean;
  /**
   * 소설 본문의 역할 처리. 텍스트는 항상 merged, 챗은 세션 설정을 따르되 기본 merged.
   * 사용처: `build-session-context.ts` → `context-builder.ts`.
   */
  roleMode: NovelChatRoleMode;
  /**
   * 생성 파라미터 키 표기. 텍스트=snake_case(top_p/max_tokens), 챗=camelCase(topP/maxTokens).
   * 실제 매핑 로직은 `generation-params.ts paramsToOverride` 가 이 플래그를 읽어 수행.
   */
  paramStyle: "snake" | "camel";
}

export const MODEL_KIND_DEFAULTS: Record<ModelKind, ModelKindDefaults> = {
  text: { naiFormat: true, roleMode: "merged", paramStyle: "snake" },
  chat: { naiFormat: false, roleMode: "merged", paramStyle: "camel" },
};

/** 명시 설정이 있으면 그 값, 없으면 모델 종류의 기본 NAI 형식 여부. */
export function resolveNaiFormat(
  kind: ModelKind,
  explicit: boolean | undefined
): boolean {
  return explicit ?? MODEL_KIND_DEFAULTS[kind].naiFormat;
}

/** 챗이면 세션 설정(없으면 merged), 텍스트면 항상 merged. */
export function resolveRoleMode(
  kind: ModelKind,
  sessionValue: NovelChatRoleMode | undefined
): NovelChatRoleMode {
  return kind === "chat"
    ? sessionValue ?? MODEL_KIND_DEFAULTS.chat.roleMode
    : MODEL_KIND_DEFAULTS.text.roleMode;
}
