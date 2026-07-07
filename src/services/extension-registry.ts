/**
 * StellaExtensionRegistry — 확장 모듈 등록/실행의 단일 진입점 (`plugin.extensions`).
 *
 * 스텔라의 "확장"은 옵시디언의 커뮤니티/기본 플러그인 관계와 같다: 내장 요약처럼
 * 스텔라가 직접 번들한 것도, 외부 플러그인이 꽂은 것도 **같은 API** 로 동작한다.
 * 확장은 기본 생성 과정에 끼어들어 두 가지 방식으로 개입한다:
 *
 *  1) 기여형(여럿 동시 가능) — 기본 흐름에 무언가를 보탠다.
 *     - `contributeContext` : 전송본에 컨텍스트(요약 등)를 채워 넣는다.
 *     - `onGenerationComplete` : 생성이 끝난 직후 자동 실행(자동 요약 등).
 *
 *  2) 대체형(이음새당 단일 소유) — 기본 알고리즘을 통째로 갈아끼운다.
 *     - `selectLorebooks` : 기본 키워드 매칭 대신 확장이 로어북을 고른다.
 *     - 생성 실행 대체(다중 검증 생성 등)는 RESERVED — 스테이지 4에서 연동한다.
 *
 * 전송본 미리보기("현재 컨텍스트 확인")는 엔진 기본 조립만 그린다. 외부 확장의
 * 기여를 일일이 미리보기에 반영하지는 않으며, 실제 전송된 내용은 GGAI Core 로그가
 * 단일 진실 소스다.
 */

import type StellaEnginePlugin from "../main";
import type { GenerationProfileLite } from "./ai-service";
import type { ActiveSettings } from "../types/preset";
import type { StellaLorebook } from "../types/lorebook";
import type { StellaScenario } from "../types/scenario";
import type { StellaSession } from "../types/session";

/**
 * 확장이 채우는 엔진 정의 컨텍스트 슬롯. 슬롯은 엔진이 위치·매크로를 이미 아는
 * 자리다 — 확장은 값(text)만 제공하고, 삽입 위치와 `{{매크로}}` 처리는 엔진이 한다.
 * 현재 슬롯: `summary`(작가노트 바로 위 자동 삽입 / `{{summary}}` 매크로 / chatSummary 마커).
 * 새 슬롯은 실제 소비자가 생길 때 추가한다(투기적 일반화 금지).
 */
export interface ContextContribution {
  slot: "summary";
  /** 슬롯에 채울 텍스트. 빈 문자열이면 무시된다. */
  text: string;
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
  ): Promise<ContextContribution[]> {
    const out: ContextContribution[] = [];
    for (const ext of this.extensions.values()) {
      if (!ext.contributeContext) continue;
      try {
        const parts = await ext.contributeContext({ plugin: this.plugin, ...input });
        for (const p of parts) if (p.text.trim()) out.push(p);
      } catch (err) {
        console.warn(`[GGAI Stella] 확장 컨텍스트 기여 실패 (${ext.id}):`, err);
      }
    }
    return out;
  }

  /** 특정 슬롯의 기여 텍스트를 합친다(여러 확장이 같은 슬롯을 채우면 이어붙인다). */
  pickSlot(contributions: ContextContribution[], slot: ContextContribution["slot"]): string {
    return contributions
      .filter((c) => c.slot === slot)
      .map((c) => c.text)
      .filter((t) => t.trim())
      .join("\n\n");
  }

  /** 생성 완료 훅을 모두 실행한다. 각 확장 에러는 격리(생성 저장을 막지 않음). */
  async runGenerationComplete(
    input: Omit<GenerationCompleteInput, "plugin">
  ): Promise<void> {
    for (const ext of this.extensions.values()) {
      if (!ext.onGenerationComplete) continue;
      try {
        await ext.onGenerationComplete({ plugin: this.plugin, ...input });
      } catch (err) {
        console.warn(`[GGAI Stella] 확장 생성-완료 훅 실패 (${ext.id}):`, err);
      }
    }
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
