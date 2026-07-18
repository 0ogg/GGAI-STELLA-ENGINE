/**
 * 전역 상수 모음.
 * 다른 단계에서 import 해서 쓸 수 있게 값만 보관.
 */

export const VIEW_TYPE_SIDEBAR = "ggai-stella-sidebar";

/** 세션 편집 뷰 (워크스페이스 메인). B1 부터 등록만, B2 에서 편집기 구현. */
export const VIEW_TYPE_SESSION = "ggai-stella-session";

/** 챗 모드 세션 뷰 (M6/C0) — 소설 세션뷰와 완전 별도. meta.mode === "chat" 세션 전용. */
export const VIEW_TYPE_CHAT_SESSION = "ggai-stella-chat-session";

export const VIEW_TYPE_DASHBOARD = "ggai-stella-dashboard";

/** 우측 사이드바 detail 뷰. R3 에서 뼈대 + 탭, R4/R5 에서 내용. */
export const VIEW_TYPE_DETAIL = "ggai-stella-detail";

/** 삽화 출력 전용 뷰 (L9) — 우측 사이드바 자체 아이콘, 활성 세션 최신 삽화 표시. */
export const VIEW_TYPE_ILLUSTRATION_OUTPUT = "ggai-stella-illustration";

/** 스텔라 폰 뷰 (PH1) — 문자/SNS. PC 는 폰 프레임 안, 모바일은 풀 화면. */
export const VIEW_TYPE_PHONE = "ggai-stella-phone";

// 시나리오/로어북/페르소나 편집기는 대시보드 내부 라우트(EditorRoute)로 편입됨 —
// 더 이상 별도 워크스페이스 뷰 타입이 아니다. (dashboard-view.ts EditorKind 참조)

/** vault 루트 기준 베이스 폴더 */
export const BASE_FOLDER = "GGAI";

/** BASE_FOLDER 아래에 자동 생성되는 하위 폴더들 */
export const SUBFOLDERS = [
  "SCENARIOS",
  "LOREBOOKS",
  "PROMPTS",
  "PRESETS",
  "USERS",
  "GROUPS",
  "PHONE",
] as const;

export type SubFolder = (typeof SUBFOLDERS)[number];
