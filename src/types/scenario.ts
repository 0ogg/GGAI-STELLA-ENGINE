/**
 * 시나리오 JSON 스키마.
 *
 * 캐릭터카드 V3 (CCv3) 표준을 그대로 따른다.
 * 플러그인 전용 메타데이터(id, favorite, lastPlayedAt, playCount, thumbnail)는
 * `data.extensions.stella` 에 담는다 — CCv3 의 "unknown field 보존" 규칙과 호환.
 *
 * 로어북은 별도 `GGAI/LOREBOOKS/[name]/` 폴더에 분해 저장한다.
 * `data.character_book` 은 익스포트 호환용이며, 편집은 로어북 폴더에서 한다.
 */

import type { StellaLorebook } from "./lorebook";

/** CCv3 character_book 엔트리 (원본 스펙 그대로 유지 — 익스포트용). */
export interface CCv3LorebookEntry {
  keys: string[];
  content: string;
  extensions: Record<string, any>;
  enabled: boolean;
  insertion_order: number;
  case_sensitive?: boolean;
  use_regex: boolean;
  constant?: boolean;
  name?: string;
  priority?: number;
  id?: number | string;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  position?: "before_char" | "after_char";
}

export interface CCv3Lorebook {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions: Record<string, any>;
  entries: CCv3LorebookEntry[];
}

export interface CCv3Asset {
  type: string;
  uri: string;
  name: string;
  ext: string;
}

/** 플러그인 전용 시나리오 메타. data.extensions.stella 로 저장. */
export interface StellaScenarioExtension {
  id: string;               // UUID — 이름 중복 구분용
  favorite: boolean;
  lastPlayedAt: number;     // epoch ms (0 = 미플레이)
  playCount: number;
  thumbnail: string | null; // assets 의 name (보통 'main') 또는 null

  /**
   * 시나리오의 "기본 로어북" — 캐릭터카드 임포트 시 character_book 에서 분리된 책을 자동 연결.
   * 사용자는 시나리오 편집에서 다른 로어북으로 갈아끼우거나 비울 수 있다.
   * 값은 StellaLorebookMeta.id (UUID).
   */
  defaultLorebookId?: string;

  /**
   * 시나리오에 추가로 붙는 로어북들 (UUID 배열).
   * AI 생성 시 default + extra 가 모두 활성. 세션이 일부를 끄거나 더 추가할 수 있다.
   */
  extraLorebookIds?: string[];

  /**
   * 번역 확장용 로어북 (UUID 배열) — **이 시나리오의 모든 세션이 공유**한다.
   * 번역 실행 시 활성 설정(세션/전역)의 번역 로어북과 합쳐(중복 제거) 적용된다.
   * 디테일뷰 시나리오 탭에서 선택 (번역 사용 중일 때만 노출).
   */
  translationLorebookIds?: string[];

  /**
   * 삽화 확장용 로어북 (UUID 배열) — **이 시나리오의 모든 세션이 공유**한다.
   * 삽화 프롬프트 생성 시 활성 설정의 삽화 로어북과 합쳐(중복 제거) 적용된다.
   * 디테일뷰 시나리오 탭에서 선택 (삽화 사용 중일 때만 노출).
   */
  illustrationLorebookIds?: string[];
}

export interface StellaScenario {
  spec: "chara_card_v3";
  spec_version: "3.0";
  data: {
    // --- V2 계승 필드 ---
    name: string;
    description: string;
    tags: string[];
    creator: string;
    character_version: string;
    mes_example: string;
    extensions: Record<string, any> & { stella?: StellaScenarioExtension };
    system_prompt: string;
    post_history_instructions: string;
    first_mes: string;
    alternate_greetings: string[];
    personality: string;
    scenario: string;

    // --- V3 추가 필드 ---
    creator_notes: string;
    character_book?: CCv3Lorebook;
    assets?: CCv3Asset[];
    nickname?: string;
    creator_notes_multilingual?: Record<string, string>;
    source?: string[];
    group_only_greetings: string[];
    creation_date?: number;      // 초 단위 Unix timestamp (UTC)
    modification_date?: number;  // 초 단위 Unix timestamp (UTC)
  };
}

/** 임포트 결과 결합형: 시나리오 + 파생 로어북(있다면). */
export interface ImportedScenario {
  scenario: StellaScenario;
  lorebook?: StellaLorebook;
}
