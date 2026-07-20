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
  lorebookSelect?: MediaPromptItem[];
  /** 로어북 자동 생성 — 새 인물/사건/고유명사 추출. */
  lorebookGen?: MediaPromptItem[];
  /** 스텔라 폰 — 문자 답장/선발신 (시나리오 캐릭터). */
  phoneText?: MediaPromptItem[];
  /** 스텔라 폰 — 모르는 번호(엑스트라) 문자. */
  phoneExtra?: MediaPromptItem[];
  /** 스텔라 폰 — SNS 피드 생성. */
  phoneSns?: MediaPromptItem[];
  /** 스텔라 폰 — 스텔라튜브 시청자 채팅 (v2). */
  phoneTube?: MediaPromptItem[];
  /** 작가노트 전용 프레이밍 프롬프트 — 작가노트를 {{MAIN}} 자리에 감싼다. */
  authorNote?: MediaPromptItem[];
  /** 집필 프로 — 한국어 입력을 영어판 문체를 이어받은 영어 문단으로 변환. */
  proConvert?: MediaPromptItem[];
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
  /**
   * 누적 요약 토큰 상한 — 합성된 요약이 이 토큰 수를 넘으면 오래된 상위 절반을
   * 한 덩어리로 압축한다(컴팩트). 0/미설정이면 압축하지 않는다.
   */
  maxTokens?: number;
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

/**
 * 로어북 확장 활성 설정 — 로어북 활성화 방식 제어.
 * 키워드/AI 매칭은 각각 독립 체크 — 둘 다 켜면 합집합(중복 없이), 둘 다 끄면
 * 상시(constant) 엔트리만 들어간다.
 */
export interface LorebookPlusActiveSettings {
  /** 키워드 매칭 사용. 생략 시 true (기존 동작). */
  keywordMatching?: boolean;
  /** AI 매칭 사용 — 생성 전 선별 모델이 필요한 엔트리를 고른다. 생략 시 false. */
  aiMatching?: boolean;
  /** AI 매칭 전용 모델 프로필. 없으면 기본 프로필. */
  modelProfileId?: string;
  /** 선별 프롬프트 id (mediaPrompts.lorebookSelect). 없으면 기본 프롬프트. */
  promptId?: string;
  /** 선별 모델에 첨부할 최근 본문 길이(자). 생략 시 4000. */
  contextChars?: number;
  /** true 면 같은 지점 재생성은 직전 선별 결과를 재사용 (새 AI 호출 없음). */
  reuseOnRegen?: boolean;
  /** AI 매칭을 로어북을 쓰는 다른 확장(번역/삽화 등)에도 적용. 생략 시 false. */
  applyToExtensions?: boolean;
  /** 확장용 선별 프롬프트 id (mediaPrompts.lorebookSelect). 없으면 확장 작업 기본 프롬프트. */
  taskPromptId?: string;
  /** 로어북 자동 생성 사용 — 세션 전용 로어북에 새 인물/사건/고유명사를 자동 기록. 생략 시 false. */
  autoGen?: boolean;
  /** 자동 생성 주기 — 마지막 스캔 이후 AI 생성 횟수. 생략 시 5. */
  autoGenInterval?: number;
  /** 자동 생성 전용 모델 프로필. 없으면 기본 프로필. */
  autoGenModelProfileId?: string;
  /** 자동 생성 프롬프트 id (mediaPrompts.lorebookGen). 없으면 기본 프롬프트. */
  autoGenPromptId?: string;
  /** 한 번에 스캔할 새 본문 상한(자) — 밀린 구간이 이보다 길면 최근 쪽만. 생략 시 16000. */
  autoGenMaxChars?: number;
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
  /** NAI 형식으로 보내기 — 텍스트 컴플리션 전송 시 역할 토큰으로 감싼다. */
  naiFormat?: boolean;
  /** 이어쓰기 이음새 보정 (챗 모델) — 마지막 문장 반복을 유도한 뒤 응답에서 제거. */
  continueAnchor?: boolean;
  /** 임포트 원본 등 라운드트립 보존용. sillytavernRaw 등. */
  extensions?: Record<string, unknown>;
}

/** 활성 설정 — 세션 또는 PluginData.current 에 박히는 형태. */
/**
 * 집필 프로(PRO) 활성 설정 — 한→영 집필 변환 파이프라인.
 * PRO 활성 환경의 "집필 프로" 패널에서만 노출·편집된다.
 */
export interface ProActiveSettings {
  /** 집필 변환 모델 프로필. 미지정 시 기본 생성 프로필. */
  modelProfileId?: string;
  /** proConvert 버킷 프롬프트 id. 미지정 시 기본 프롬프트. */
  promptId?: string;
  /** 문체 참조로 첨부할 영어판 꼬리 글자 수. 미지정 시 기본값. */
  styleTailChars?: number;
  /** 양방향 변환에 예시로 첨부할 문단 쌍(내 한국어↔영어판) 수. 0 = 끄기. */
  stylePairs?: number;
}

export interface ActiveSettings {
  modelProfileId?: string;
  params?: PromptPresetParams;
  promptSetId?: string;
  translation?: TranslationActiveSettings;
  illustration?: IllustrationActiveSettings;
  summarize?: SummaryActiveSettings;
  /** 로어북 확장 — 키워드/AI 매칭 스위치와 AI 선별 옵션. */
  lorebookPlus?: LorebookPlusActiveSettings;
  /** 집필 프로(PRO) — 한→영 집필 변환 설정. PRO 활성 환경에서만 쓰인다. */
  pro?: ProActiveSettings;
  /** NAI 형식으로 보내기 — 텍스트 컴플리션 전송 시 역할 토큰으로 감싼다. */
  naiFormat?: boolean;
  /** 이어쓰기 이음새 보정 (챗 모델) — 마지막 문장 반복을 유도한 뒤 응답에서 제거. */
  continueAnchor?: boolean;
}

/**
 * 프리셋 → 생성 1회용 전송 오버라이드 (프리셋 랜덤 순환 전용).
 * 활성 설정에는 저장하지 않고 planSessionRequest 의 settingsOverride 로만 쓴다.
 *  - 생성에 쓰는 값(모델/파라미터/프롬프트 세트/이어쓰기 보정)만 뽑는다 —
 *    미디어(번역/삽화/요약) 설정은 순환 대상이 아니다.
 *  - 프리셋이 모델을 바꾸면 naiFormat 은 프리셋 값(없으면 그 모델 종류의 기본값,
 *    resolveNaiFormat)으로 재유도 — 활성 설정의 스테일 체크 상태를 따라가지 않는다.
 *  - 프리셋에 없는 필드는 키를 만들지 않아 활성 설정 값이 그대로 유지된다.
 */
export function presetToGenerationOverride(preset: StellaPreset): ActiveSettings {
  const override: ActiveSettings = {};
  if (preset.modelProfileId) {
    override.modelProfileId = preset.modelProfileId;
    override.naiFormat = preset.naiFormat;
  }
  if (preset.params) override.params = { ...preset.params };
  if (preset.promptSetId) override.promptSetId = preset.promptSetId;
  if (preset.continueAnchor !== undefined) {
    override.continueAnchor = preset.continueAnchor;
  }
  return override;
}

/** 프리셋 → 활성 설정 으로 추출. */
export function presetToActiveSettings(preset: StellaPreset): ActiveSettings {
  return {
    modelProfileId: preset.modelProfileId,
    params: preset.params ? { ...preset.params } : undefined,
    promptSetId: preset.promptSetId,
    naiFormat: preset.naiFormat,
    continueAnchor: preset.continueAnchor,
  };
}
