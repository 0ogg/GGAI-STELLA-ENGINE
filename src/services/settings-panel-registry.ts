import type StellaEnginePlugin from "../main";
import type { ActiveSettings } from "../types/preset";

/**
 * 확장 탭(우측 디테일 `확장`)에 꽂히는 설정 패널 하나가 받는 컨텍스트.
 *
 *  - `settings` / `patchSettings` — 스텔라의 공용 활성 설정(`ActiveSettings`: 모델/파라미터/
 *    프롬프트 세트/번역/삽화/요약)을 읽고 쓴다. **스텔라 내장 패널 전용**이다 — 외부 확장이
 *    이 필드들을 건드리면 다른 확장(번역/삽화/요약)과 충돌할 수 있으니 쓰지 않는다.
 *  - `getPanelData` / `setPanelData` — 이 패널 전용, 다른 패널과 격리된 저장 칸. 외부 확장은
 *    항상 이쪽을 쓴다. 활성 세션이 있으면 그 세션 기준, 없으면 전역(vault 공통) 기준으로
 *    자동 분리된다(스텔라 내장 설정과 같은 "세션 있으면 세션에, 없으면 전역에" 규칙).
 *  - `rerender` — 이 패널의 본문만 다시 그린다 (패널 밖 UI, 다른 패널에는 영향 없음).
 */
export interface SettingsPanelContext {
  plugin: StellaEnginePlugin;
  activeSessionFile: string | null;
  /** 렌더 시점의 스텔라 활성 설정 스냅샷. */
  settings: ActiveSettings;
  /** 스텔라 활성 설정 부분 갱신 + 자동 재조회 + 이 패널 재렌더. 내장 패널 전용. */
  patchSettings: (patch: Partial<ActiveSettings>) => Promise<ActiveSettings>;
  /** 이 패널 전용 저장 칸에서 읽기. 다른 패널·스텔라 본체 설정과 격리됨. */
  getPanelData: <T = unknown>() => T | undefined;
  /** 이 패널 전용 저장 칸에 병합 저장 + 이 패널 재렌더. */
  setPanelData: (patch: Record<string, unknown>) => Promise<void>;
  /** 이 패널 본문을 처음부터 다시 그린다 (라이브러리 변경 등 settings 와 무관한 갱신). */
  rerender: () => void;
}

export interface SettingsPanel {
  /**
   * 다른 확장과 충돌하지 않는 고유 id. 외부 플러그인은 자기 플러그인 id 로 네임스페이스한다
   * (예: `"my-plugin:foo"`). 내장 패널은 `"stella:"` 접두사를 쓴다.
   */
  id: string;
  title: string;
  /** 낮을수록 위. 기본 0. 내장 패널은 0~99 범위를 쓴다. */
  order?: number;
  render(body: HTMLElement, ctx: SettingsPanelContext): void;
}

/**
 * 확장 탭에 등록된 설정 패널 목록. 등록/해제는 순서 무관하게 언제든 가능하며,
 * 변경 시 `onChange` 콜백으로 호스트(ExpandSection)에 다시 그리라고 알린다.
 */
export class SettingsPanelRegistry {
  private panels = new Map<string, SettingsPanel>();

  constructor(private onChange: () => void) {}

  /** 패널을 등록한다. 반환된 함수를 호출하면 해제된다. */
  register(panel: SettingsPanel): () => void {
    this.panels.set(panel.id, panel);
    this.onChange();
    return () => this.unregister(panel.id);
  }

  unregister(id: string): void {
    if (this.panels.delete(id)) this.onChange();
  }

  /** order 오름차순으로 정렬된 목록. */
  list(): SettingsPanel[] {
    return [...this.panels.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
}
