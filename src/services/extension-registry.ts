/**
 * StellaExtensionRegistry — 확장 모듈 등록/실행의 단일 진입점 (`plugin.extensions`).
 *
 * 스텔라의 "확장"은 옵시디언의 커뮤니티/기본 플러그인 관계와 같다: 내장 요약처럼
 * 스텔라가 직접 번들한 것도, 외부 플러그인이 꽂은 것도 **같은 API** 로 동작한다.
 * 확장은 기본 생성 과정에 끼어들어 두 가지 방식으로 개입한다:
 *
 *  1) 기여형(여럿 동시 가능) — 기본 흐름에 무언가를 보탠다.
 *     - `contributeContext` : 전송본에 컨텍스트를 채워 넣는다. 내장 슬롯(summary/
 *       phone) + 외부 확장 공용 `custom` 슬롯(배치 규칙 포함, 아래 타입 참조).
 *     - `onGenerationComplete` : 생성이 끝난 직후 자동 실행(자동 요약 등).
 *
 *  2) 대체형(이음새당 단일 소유) — 기본 알고리즘을 통째로 갈아끼운다.
 *     - `selectLorebooks` : 기본 키워드 매칭 대신 확장이 로어북을 고른다.
 *     - 생성 실행 대체(다중 검증 생성 등)는 RESERVED — 스테이지 4에서 연동한다.
 *
 * 컨텍스트 기여는 planSessionRequest 한 곳에서 수집되므로 전송본 미리보기
 * ("현재 컨텍스트 확인")에도 생성과 동일하게 반영된다. 최종 전송 내용의 진실
 * 소스는 GGAI Core 요청 로그.
 */

import type StellaEnginePlugin from "../main";
import type { GenerationProfileLite } from "./ai-service";
import type { ActiveSettings } from "../types/preset";
import type {
  StellaLorebook,
  LorebookPosition,
  LorebookRole,
} from "../types/lorebook";
import type { StellaScenario } from "../types/scenario";
import type { StellaSession } from "../types/session";

/**
 * 확장이 채우는 컨텍스트 기여.
 *
 *  - 내장 슬롯 `summary`/`phone`: 엔진이 위치·매크로를 이미 아는 자리 — 확장은
 *    값(text)만 제공한다. 새 내장 슬롯은 실제 소비자가 생길 때 추가한다.
 *  - `custom`: 외부 확장 공용 슬롯. 확장이 배치 규칙(position/depth/role/order)을
 *    함께 제공하면 엔진이 가상 로어북 상시 엔트리로 감싸 그 위치에 삽입한다
 *    (폰/그룹 멤버 프로필과 같은 기계 — 미리보기·생성·토큰 예산 자동 동일).
 *    외부 확장이 컨텍스트에 텍스트를 넣는 진입점은 이것 하나다 — 확장마다
 *    별도 삽입 경로를 만들지 않는다.
 */
export type ContextContribution =
  | {
      slot: "summary" | "phone";
      /** 슬롯에 채울 텍스트. 빈 문자열이면 무시된다. */
      text: string;
    }
  | CustomContextContribution;

/** 외부 확장 공용 컨텍스트 기여 — 배치 규칙을 확장이 직접 지정한다. */
export interface CustomContextContribution {
  slot: "custom";
  /** 삽입할 텍스트. 빈 문자열이면 무시된다. */
  text: string;
  /** 디버깅/로그 표시명. 생략 시 확장 id. */
  name?: string;
  /** 삽입 위치 (ST 로어북 position 의미 그대로). 기본 `after_char`. */
  position?: LorebookPosition;
  /** position=at_depth 일 때 히스토리 끝에서의 깊이. 기본 4. */
  depth?: number;
  /** position=at_depth 일 때 메시지 역할. 기본 `system`. */
  role?: LorebookRole;
  /** 같은 위치 내 정렬 — 큰 값이 우선. 같은 슬롯을 쓰는 확장 간 배치 조정용. 기본 100. */
  order?: number;
}

/** collectContext 가 기여에 출처 확장 id 를 얹어 반환하는 형태. */
export type CollectedContribution = ContextContribution & { sourceId: string };

/** 세션 조작 액션 실행 입력. */
export interface SessionActionInput {
  plugin: StellaEnginePlugin;
  /** 액션을 실행한 세션 파일 경로. */
  sessionFile: string;
}

/**
 * 확장이 세션창 하단 확장 버튼(퍼즐)의 트레이에 넣는 조작 액션.
 * 확장이 자체 조작 UI(버튼/툴바/모달)를 세션 화면에 직접 붙이는 대신 쓰는
 * 공용 진입점 — 또 하나의 선택지는 확장이 옵시디언 명령(addCommand)으로
 * 노출하고 사용자가 모바일 툴바/커맨더로 버튼을 배치하는 것.
 */
export interface StellaSessionAction {
  /** 확장 안에서 유일한 id. */
  id: string;
  /** 트레이에 표시할 이름. */
  title: string;
  /** Lucide 아이콘 이름. 생략 시 puzzle. */
  icon?: string;
  run(input: SessionActionInput): void | Promise<void>;
}

export interface ExtensionContextInput {
  plugin: StellaEnginePlugin;
  sessionFile: string;
  session: StellaSession;
  /** 컨텍스트를 만드는 리프(=이어쓰기가 보낼 지점). */
  leafId: string;
  settings: ActiveSettings;
}

export interface GenerationCompleteInput {
  plugin: StellaEnginePlugin;
  sessionFile: string;
  /** 새로 만들어진 원문(AI) 노드 id. */
  nodeId: string;
  /** 생성된 가시 텍스트. */
  generatedText: string;
  /** 생성 시작 지점(부모)까지의 본문. */
  parentText: string;
  profile: GenerationProfileLite;
}

/** 로어북 선택 대체 이음새 입력. */
export interface LorebookSelectorInput {
  plugin: StellaEnginePlugin;
  sessionFile: string;
  session: StellaSession;
  scenario: StellaScenario | null;
  /** 컨텍스트를 만드는 리프. */
  leafId: string;
}

/** 로어북 선택 대체 — 등록되면 기본 키워드 매칭 대신 이 함수가 활성 로어북을 고른다. */
export type LorebookSelector = (
  input: LorebookSelectorInput
) => Promise<StellaLorebook[]>;

export interface StellaExtension {
  /**
   * 다른 확장과 충돌하지 않는 고유 id. 외부 플러그인은 자기 id 로 네임스페이스한다
   * (예: `"my-plugin:foo"`). 내장 확장은 `"stella:"` 접두사를 쓴다.
   */
  id: string;
  /** 전송본에 컨텍스트를 기여한다. planSessionRequest 에서 수집(미리보기 포함). */
  contributeContext?(
    input: ExtensionContextInput
  ): ContextContribution[] | Promise<ContextContribution[]>;
  /** 생성 완료 직후 자동 실행. 에러는 격리되어 다른 확장/생성 저장을 막지 않는다. */
  onGenerationComplete?(input: GenerationCompleteInput): void | Promise<void>;
  /**
   * 로어북 선택 대체(단일 소유). 여러 확장이 등록하면 마지막 등록이 이긴다(경고 로그).
   * 없으면 기본 키워드 매칭.
   */
  selectLorebooks?: LorebookSelector;
  /**
   * 세션창 하단 확장 버튼 트레이에 넣을 조작 액션들. 확장별 자체 조작 UI 를
   * 만들지 않기 위한 공용 진입점(트레이 또는 옵시디언 명령, 두 선택지만).
   */
  sessionActions?: StellaSessionAction[];
}

export class StellaExtensionRegistry {
  private extensions = new Map<string, StellaExtension>();

  constructor(private plugin: StellaEnginePlugin) {}

  /** 확장을 등록한다. 반환된 함수를 호출하면 해제된다. */
  register(ext: StellaExtension): () => void {
    this.extensions.set(ext.id, ext);
    return () => this.unregister(ext.id);
  }

  unregister(id: string): void {
    this.extensions.delete(id);
  }

  list(): StellaExtension[] {
    return [...this.extensions.values()];
  }

  /**
   * 모든 확장의 컨텍스트 기여를 모은다. 한 확장이 실패해도 나머지는 진행한다.
   * planSessionRequest(생성·미리보기 공통)에서만 호출한다.
   */
  async collectContext(
    input: Omit<ExtensionContextInput, "plugin">
  ): Promise<CollectedContribution[]> {
    const out: CollectedContribution[] = [];
    for (const ext of this.extensions.values()) {
      if (!ext.contributeContext) continue;
      try {
        const parts = await ext.contributeContext({ plugin: this.plugin, ...input });
        for (const p of parts) if (p.text.trim()) out.push({ ...p, sourceId: ext.id });
      } catch (err) {
        console.warn(`[GGAI Stella] 확장 컨텍스트 기여 실패 (${ext.id}):`, err);
      }
    }
    return out;
  }

  /** 내장 슬롯의 기여 텍스트를 합친다(여러 확장이 같은 슬롯을 채우면 이어붙인다). */
  pickSlot(contributions: ContextContribution[], slot: "summary" | "phone"): string {
    return contributions
      .filter((c) => c.slot === slot)
      .map((c) => c.text)
      .filter((t) => t.trim())
      .join("\n\n");
  }

  /**
   * 생성 완료 훅을 모두 실행한다. 각 확장 에러는 격리(생성 저장을 막지 않음).
   * 훅들은 서로 독립(번역/삽화/요약 등)이므로 **병렬** 실행한다 — 각각 AI 호출이라
   * 순차로 돌리면 생성 후 대기가 배로 길어진다.
   */
  async runGenerationComplete(
    input: Omit<GenerationCompleteInput, "plugin">
  ): Promise<void> {
    await Promise.all(
      [...this.extensions.values()]
        .filter((ext) => ext.onGenerationComplete)
        .map(async (ext) => {
          try {
            await ext.onGenerationComplete!({ plugin: this.plugin, ...input });
          } catch (err) {
            console.warn(`[GGAI Stella] 확장 생성-완료 훅 실패 (${ext.id}):`, err);
          }
        })
    );
  }

  /** 등록 순서대로 모든 확장의 세션 조작 액션을 평탄화해 반환. */
  listSessionActions(): StellaSessionAction[] {
    const out: StellaSessionAction[] = [];
    for (const ext of this.extensions.values()) {
      for (const action of ext.sessionActions ?? []) out.push(action);
    }
    return out;
  }

  /** 로어북 선택 대체를 등록한 확장이 있으면 그 선택 함수, 없으면 null(기본 매칭). */
  getLorebookSelector(): LorebookSelector | null {
    let found: LorebookSelector | null = null;
    for (const ext of this.extensions.values()) {
      if (!ext.selectLorebooks) continue;
      if (found) {
        console.warn(
          `[GGAI Stella] 로어북 선택 대체가 둘 이상 등록됨 — 마지막(${ext.id})만 적용.`
        );
      }
      found = ext.selectLorebooks;
    }
    return found;
  }
}
