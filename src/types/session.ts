/**
 * 세션 JSON 스키마 — Phase B1.
 *
 * 설계 원칙:
 *  - 세션은 "하나로 이어진 소설 텍스트" 이지만 내부적으로는 턴(노드) 트리다.
 *  - 각 노드는 이전 노드로부터의 **패치(delta)** 만 저장한다. 스냅샷을 쌓지 않는다.
 *    → 100k 토큰까지 커져도 파일은 누적 편집 기록 크기만 늘어난다.
 *  - 활성 본문은 `rootId` → ... → `activeLeafId` 경로의 노드 패치를 순서대로 적용한 결과.
 *  - 재생성은 같은 parent 밑의 sibling 노드로 파생 → 과거 분기가 사라지지 않는다.
 *  - 즐겨찾기는 노드 단위 (세이브 파일처럼 사용).
 *  - 모드는 소설/텍스트게임/챗 확장 여지만 열어두되 지금은 "novel" 만 구현.
 *
 * author 구분:
 *  - "ai"   : AI 가 생성한 텍스트
 *  - "user" : 사용자가 직접 입력/수정한 텍스트
 *  두 저자가 한 줄에 섞일 수 있으므로 span 배열로 관리한다.
 */

import type { PromptPresetParams } from "./prompt";
import type {
  IllustrationActiveSettings,
  SummaryActiveSettings,
  TranslationActiveSettings,
} from "./preset";
import type { AgentResult } from "./agent";

/** 향후 확장을 위한 모드. 지금은 novel 만 사용. */
export type SessionMode = "novel" | "textgame" | "chat";

export type NovelChatRoleMode = "merged" | "split";

/** 연속 텍스트 조각 — 한 저자의 텍스트 한 덩어리. */
export interface Span {
  author: "ai" | "user";
  text: string;
}

/**
 * 노드가 부모로부터 이어받는 본문에 가하는 연산.
 * from / to 는 "부모 본문을 평문 문자열로 펼친 뒤" 의 문자 인덱스(UTF-16 code unit).
 *
 *  - append  : 본문 끝에 spans 를 덧붙임 (이어쓰기 / 재생성의 기본)
 *  - replace : [from, to) 구간을 spans 로 치환 (국소 수정)
 *  - delete  : [from, to) 구간 제거 (뒷부분 잘라내기 포함)
 */
export type Patch =
  | { op: "append"; spans: Span[] }
  | { op: "replace"; from: number; to: number; spans: Span[] }
  | { op: "delete"; from: number; to: number };

/** 노드가 "왜" 만들어졌는지 — 브랜치 분기 판단용. */
export type TurnKind =
  | "root"         // 시나리오 초기 상태 (빈 본문 또는 first_mes 씨드)
  | "ai-continue"  // 이어쓰기 생성
  | "ai-regen"     // 재생성 (같은 parent 밑 sibling)
  | "user-write"   // 사용자가 직접 덧붙임
  | "user-edit";   // 사용자가 기존 구간 수정/삭제

export interface SessionGenMeta {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** 이 생성에 사용된 프로필 이름 (Core 프로필). */
  profile?: string;
}

export interface SessionNode {
  id: string;
  /** 루트는 null. */
  parent: string | null;
  kind: TurnKind;
  patches: Patch[];
  /** epoch ms. */
  createdAt: number;
  /** 세이브 포인트 표시. 없으면 false 로 간주. */
  favorite?: boolean;
  /** 사용자 메모 — UI 에서 노드에 이름 붙일 때. */
  label?: string;
  /** AI 생성 노드에만 존재. */
  gen?: SessionGenMeta;
}

export interface SessionMeta {
  /** 세션 고유 UUID. */
  id: string;
  /** 표시용 이름. 폴더명과 독립. */
  name: string;
  /** First-generation title suggestion has already been applied or attempted. */
  autoTitleGenerated?: boolean;
  /** 소속 시나리오의 stella.id. 시나리오 이동/이름변경에 강건하게. */
  scenarioId: string;
  /**
   * 이 세션이 기억하는 페르소나 프로필 파일 경로(GGAI/USERS/*.json).
   * 세션 시작 시 그 시점의 활성 페르소나를 기록하고, 플레이 중 사이드바에서 페르소나를
   * 바꾸면 마지막 선택으로 덮어쓴다. 세션을 열면 이 페르소나로 활성 전환된다(전용 시나리오보다 우선).
   */
  personaFile?: string;
  mode: SessionMode;
  createdAt: number;
  modifiedAt: number;
  lastPlayedAt: number;
  favorite: boolean;
  rootId: string;
  /** 현재 편집 중인 리프. 본문 재구성의 목적지. */
  activeLeafId: string;
  /**
   * @deprecated R4e 부터 의미 변경 — promptSetId 를 사용. 호환을 위해 필드 자체는 유지.
   *  R4e 이전 세션이 가진 값은 promptSetId 가 비어있을 때 fallback 으로 읽힌다.
   */
  promptPresetId?: string;
  /** 활성 모델 프로필 (Core). R4e 부터 세션이 직접 보유. */
  modelProfileId?: string;
  /** 활성 파라미터. R4e 부터 세션이 직접 보유. */
  params?: PromptPresetParams;
  /** 활성 프롬프트 세트 id (StellaPromptPreset.meta.id 참조). R4e 부터 세션이 직접 보유. */
  promptSetId?: string;
  translation?: TranslationActiveSettings;
  illustration?: IllustrationActiveSettings;
  /** 요약 활성 설정 — 자동 요약(summaries.json 노드 앵커 누적)의 실행 조건. */
  summarize?: SummaryActiveSettings;
  /** NAI 형식으로 보내기 — 텍스트 컴플리션 전송 시 <|system|>/<|user|>/<|assistant|> 턴으로 감싼다. */
  naiFormat?: boolean;
  /** 이어쓰기 이음새 보정 (챗 모델) — 마지막 문장 반복을 유도한 뒤 응답에서 제거. */
  continueAnchor?: boolean;
  /** 즉석 메모리 — chatHistory 앞에 system 으로 삽입. */
  memory?: string;
  /** 작가노트 — chatHistory 끝에서 3 메시지 앞에 system 으로 삽입. */
  authorNote?: string;
  /** @deprecated 세션 요약은 summaries.json (노드 앵커 누적) 으로 대체됨. 읽지 않는다. */
  summary?: string;
  /** @deprecated summaries.json 으로 대체됨. */
  summaryUpTo?: string;
  /** @deprecated summaries.json 으로 대체됨. */
  summaryUpdatedAt?: number;
  /** 매크로 변수 — setvar/getvar/addvar/incvar/decvar 가 세션 단위로 유지한다. */
  variables?: Record<string, string>;
  /** 프롬프트 Choice Block 선택값. key = choice block id, value = option id 목록. */
  choiceValues?: Record<string, string[]>;
  /** 활성화된 내장 에이전트 id 목록. */
  enabledAgents?: string[];
  /** 마지막 post-processing 에이전트 결과. */
  agentResults?: AgentResult[];
  /** 로어북 sticky/cooldown 상태. key = `${lorebookId}:${entryUid}`. */
  timingStates?: Record<string, {
    lastActivatedAt: number;
    stickyRemaining: number;
    cooldownRemaining: number;
  }>;
  /** Chat completion profiles can receive NovelAI-style merged story text or split assistant/user spans. */
  novelChatRoleMode?: NovelChatRoleMode;

  /**
   * 시나리오에 붙은 로어북 중 "이번 세션에서만 끄고 싶은" id 목록.
   * 컨텍스트 빌드 시 시나리오의 default + extra 에서 이 id 들을 제외한다.
   */
  disabledScenarioLorebookIds?: string[];

  /**
   * 시나리오와 무관하게 이 세션에만 추가로 적용할 로어북 id 목록.
   */
  extraLorebookIds?: string[];
}

export interface StellaSession {
  schemaVersion: 1;
  meta: SessionMeta;
  /** id → 노드. 트리는 parent 링크로 재구성. */
  nodes: Record<string, SessionNode>;
}
