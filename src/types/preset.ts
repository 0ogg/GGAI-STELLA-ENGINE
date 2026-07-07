/**
 * StellaPreset — 모델/파라미터/프롬프트 세트의 묶음 "북마크".
 *
 * 저장 위치: `GGAI/PRESETS/<이름>.json` (단일 파일, 폴더 X).
 *
 * 프리셋은 데이터의 진실 소스가 아니다 — 모델/파라미터/프롬프트 세트의 활성값은
 * 활성 세션의 `meta.modelProfileId / params / promptSetId` 에 박히고, 세션이 없으면
 * `PluginData.current` 에 박힌다. 프리셋은 그 묶음을 한 번에 활성 설정에 복사하는
 * 단축키 역할만 한다.
 *
 * 따라서 프리셋을 안 쓰는 워크플로(매번 손으로 모델/파라미터 박기)도 정상 동작.
 */

import type { PromptPresetParams } from "./prompt";

export interface MediaPromptItem {
  id: string;
  title: string;
  prompt: string;
}

export interface MediaPromptLibrary {
  translation?: MediaPromptItem[];
  illustrationPromptGen?: MediaPromptItem[];
  paragraphRegen?: MediaPromptItem[];
  summary?: MediaPromptItem[];
}

/**
 * 번역 출력 방식 — translations.json 의 문단별 번역을 "어디에 어떻게" 보여줄지.
 * replace = 세션창 원문 치환(토글), split-h = 좌우 2분할(드래그 분할바).
 * 세로 2분할 / 별도 번역 탭은 의도적으로 제거됨.
 */
export type TranslationOutputMode = "replace" | "split-h";

export interface TranslationActiveSettings {
  /** 번역 사용 on/off — 마스터 스위치. off 면 세션 번역 버튼이 비활성화된다. */
  enabled?: boolean;
  /** 자동 번역 on/off — 새 본문 생성 후 자동 실행. 세션 번역 버튼 꾹 누르기로 토글. */
  auto?: boolean;
  /** 번역 출력 방식. 생략 시 replace. */
  output?: TranslationOutputMode;
  modelProfileId?: string;
  promptId?: string;
  /** 번역용 로어북(용어집) id 목록. `{{lorebook}}` 매크로/기본 위치로 프롬프트에 삽입. */
  lorebookIds?: string[];
  /** 번역 오류(호출 실패/형식 깨짐) 시 자동 재시도. 같은 실행에서 누적 10회면 중단. */
  retryOnFormatError?: boolean;
}

/**
 * 요약 활성 설정 — 세션 요약(summaries.json, 노드 앵커 누적)의 실행 조건.
 * 요약은 생성 완료 후 자동 실행이 기본이라 별도 auto 플래그가 없다.
 */
export interface SummaryActiveSettings {
  /** 요약 사용 on/off — 마스터 스위치. off 면 자동 요약이 돌지 않는다. */
  enabled?: boolean;
  modelProfileId?: string;
  promptId?: string;
  /** 요약 주기 — 경로상 마지막 앵커 이후 AI 생성이 이 횟수만큼 쌓이면 요약. 생략 시 5. */
  threshold?: number;
}

/**
 * 삽화 출력 위치. panel = 삽화 출력 전용 뷰(우측 사이드바 자체 아이콘, 활성 세션 최신
 * 삽화), inline = 본문 인라인(번역 보기·2분할 포함, 앵커는 렌더 시점 계산 —
 * illustration-anchors.ts; 2분할이면 넓은 쪽 패널에만 배치).
 * 레거시 "top"(구 상단 고정)은 panel 로, "source-inline"/"translation-inline"(구
 * 원문/번역 인라인 분리)은 inline 으로 정규화한다 — resolveIllustrationOutput.
 */
export type IllustrationOutputPosition = "panel" | "inline";

export interface IllustrationActiveSettings {
  /** 삽화 사용 on/off — 마스터 스위치. off 면 세션 삽화 버튼이 비활성화된다. */
  enabled?: boolean;
  /** 자동 생성 on/off — 새 원문 노드 생성 후 자동 실행. 삽화 버튼 꾹 누르기로 토글. */
  auto?: boolean;
  /** 출력 위치. 생략 시 panel. */
  output?: IllustrationOutputPosition;
  imageProfileId?: string;
  promptGenModelProfileId?: string;
  promptGenPromptId?: string;
  contextChars?: number;
  /** 삽화 프롬프트 생성용 로어북 id 목록. `{{lorebook}}` 매크로/기본 위치로 삽입. */
  lorebookIds?: string[];
  /**
   * 자동 생성 주기 — 마지막 삽화 앵커 이후 완성 문단이 이 개수 이상 쌓였을 때만
   * 자동 생성(출력 위치와 무관). 0 이면 매 이어쓰기 완료마다 생성. 생략 시 5.
   */
  autoMinParagraphs?: number;
}

export interface StellaPreset {
  /** UUID v4 — 라운드트립 고유 식별자. */
  id: string;
  name: string;
  favorite: boolean;
  modelProfileId?: string;
  params?: PromptPresetParams;
  /** 연결된 프롬프트 세트의 id (StellaPromptPreset.meta.id 참조). */
  promptSetId?: string;
  translation?: TranslationActiveSettings;
  illustration?: IllustrationActiveSettings;
  summarize?: SummaryActiveSettings;
  /** NAI 형식으로 보내기 — 텍스트 컴플리션 전송 시 역할 토큰으로 감싼다. */
  naiFormat?: boolean;
  /** 이어쓰기 이음새 보정 (챗 모델) — 마지막 문장 반복을 유도한 뒤 응답에서 제거. */
  continueAnchor?: boolean;
  /** 임포트 원본 등 라운드트립 보존용. sillytavernRaw 등. */
  extensions?: Record<string, unknown>;
}

/** 활성 설정 — 세션 또는 PluginData.current 에 박히는 형태. */
export interface ActiveSettings {
  modelProfileId?: string;
  params?: PromptPresetParams;
  promptSetId?: string;
  translation?: TranslationActiveSettings;
  illustration?: IllustrationActiveSettings;
  summarize?: SummaryActiveSettings;
  /** NAI 형식으로 보내기 — 텍스트 컴플리션 전송 시 역할 토큰으로 감싼다. */
  naiFormat?: boolean;
  /** 이어쓰기 이음새 보정 (챗 모델) — 마지막 문장 반복을 유도한 뒤 응답에서 제거. */
  continueAnchor?: boolean;
}

/** 프리셋 → 활성 설정 으로 추출. */
export function presetToActiveSettings(preset: StellaPreset): ActiveSettings {
  return {
    modelProfileId: preset.modelProfileId,
    params: preset.params ? { ...preset.params } : undefined,
    promptSetId: preset.promptSetId,
    translation: preset.translation ? { ...preset.translation } : undefined,
    illustration: preset.illustration ? { ...preset.illustration } : undefined,
    summarize: preset.summarize ? { ...preset.summarize } : undefined,
    naiFormat: preset.naiFormat,
    continueAnchor: preset.continueAnchor,
  };
}
