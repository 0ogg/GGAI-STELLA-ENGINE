import { Notice } from "obsidian";
import type StellaEnginePlugin from "../../main";
import type { AllowedParams } from "../../services/ai-service";
import type { PromptPresetParams } from "../../types/prompt";
import { renderCollapsibleShell, renderSliderRow } from "./setting-controls";

const DEBOUNCE_MS = 50;

interface ParamSpec {
  key: keyof PromptPresetParams;
  label: string;
  min: number;
  max: number;
  step: number;
  fallback: number;
  integer?: boolean;
  /**
   * Core 의 게이트 키. 있으면 활성 모델의 `allowedParams[gate] === false` 일 때 슬라이더 미노출.
   * 없으면 항상 노출 (temperature / maxContext / maxOutputTokens 등).
   */
  gate?: keyof AllowedParams;
}

const SPECS: ParamSpec[] = [
  { key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.05, fallback: 1 },
  { key: "topK", label: "Top K", min: 0, max: 200, step: 1, fallback: 0, integer: true, gate: "topK" },
  { key: "topP", label: "Top P", min: 0, max: 1, step: 0.01, fallback: 1, gate: "topP" },
  { key: "minP", label: "Min P", min: 0, max: 1, step: 0.01, fallback: 0, gate: "minP" },
  { key: "maxContext", label: "Max Context", min: 1024, max: 200000, step: 1024, fallback: 8192, integer: true },
  { key: "maxOutputTokens", label: "Max Output Tokens", min: 64, max: 3000, step: 1, fallback: 1024, integer: true },
];

/**
 * ParamsSection — 활성 파라미터 슬라이더 6 종.
 *
 *  - 슬라이더 변경 → debounced (200ms) 로 patchActiveSettings.
 *  - 활성 세션 있으면 그 세션 메타에, 없으면 PluginData.current 에 저장.
 *  - 미설정(undefined) 값은 fallback 위치 + 라벨/슬라이더 흐릿. 만지면 값이 박힘.
 *
 * 호스트:
 *  - `setActive(params, sessionFile)` — 활성값 갱신.
 */
export class ParamsSection {
  private root: HTMLElement;
  private bodyEl!: HTMLElement;
  private collapsed = false;
  private setCollapsedFn: ((v: boolean) => void) | null = null;

  private params: PromptPresetParams = {};
  private activeSessionFile: string | null = null;
  /** 활성 모델 프로필 id — 게이트 룩업용. */
  private activeModelProfileId: string | undefined;
  /** 같은 프로필의 max input tokens 값이 Core 쪽에서 바뀐 것도 감지하기 위한 이전값. */
  private lastProfileMaxContextTokens: number | undefined;

  /** 누적된 슬라이더 변경. flush 시 한 번에 patch. */
  private pendingPatch: PromptPresetParams = {};
  private saveHandle: number | null = null;

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    collapsed = false
  ) {
    this.root = container.createDiv({ cls: "ggai-params-section ggai-collapsible" });
    this.collapsed = collapsed;
    this.renderShell();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  setCollapsed(v: boolean): void {
    this.setCollapsedFn?.(v);
  }

  setActive(
    params: PromptPresetParams | undefined,
    sessionFile: string | null,
    modelProfileId?: string | undefined
  ): void {
    this.flush();
    const next = params ? { ...params } : {};
    const sameValues = paramsEqual(this.params, next);
    const sameSession = this.activeSessionFile === sessionFile;
    const sameModel = this.activeModelProfileId === modelProfileId;
    this.params = next;
    this.activeSessionFile = sessionFile;
    this.activeModelProfileId = modelProfileId;
    // 모델 id 는 그대로여도 Core 쪽에서 그 프로필의 max input tokens 값이 바뀌었을 수 있다
    // (프로필 편집 → profiles-changed → refreshActiveSettings, modelProfileId 자체는 불변).
    const profileMaxContextTokens = this.activeProfileMaxTokens();
    const sameProfileLimit = this.lastProfileMaxContextTokens === profileMaxContextTokens;
    this.lastProfileMaxContextTokens = profileMaxContextTokens;
    // 자기 저장으로 돌아온 setActive 는 슬라이더 DOM 을 파괴하지 않는다 (드래그 중 mouseup 손실 방지).
    if (!(sameValues && sameSession && sameModel && sameProfileLimit)) this.render();
  }

  /** 미적용 debounce 가 있으면 즉시 저장. */
  flush(): void {
    if (this.saveHandle == null) return;
    window.clearTimeout(this.saveHandle);
    this.saveHandle = null;
    void this.persistNow();
  }

  // ─── render ──────────────────────────────────────────────────────────

  private renderShell(): void {
    const { body, setCollapsed } = renderCollapsibleShell({
      container: this.root,
      title: "파라미터",
      bodyCls: "ggai-params-body",
      collapsed: this.collapsed,
      onToggle: (c) => (this.collapsed = c),
    });
    this.bodyEl = body;
    this.setCollapsedFn = setCollapsed;
    this.render();
  }

  private render(): void {
    this.bodyEl.empty();
    const allowed = this.activeAllowedParams();
    const visible = SPECS.filter((s) => isSpecAllowed(s, allowed));
    if (visible.length === 0) {
      this.bodyEl.createDiv({
        cls: "ggai-detail-empty",
        text: "이 모델에 허용된 파라미터가 없습니다.",
      });
      return;
    }
    const profileMaxContext = this.activeProfileMaxTokens();
    for (const spec of visible) this.renderRow(spec, spec.key === "maxContext" ? profileMaxContext : undefined);
  }

  /** 활성 모델 프로필의 allowedParams. 모델 미지정 또는 legacy 면 undefined (=모두 허용). */
  private activeAllowedParams(): AllowedParams | undefined {
    const p = this.plugin.ai.getProfileById(this.activeModelProfileId);
    return p?.allowedParams;
  }

  /** 활성 모델 프로필의 입력 토큰 상한. 초과 시 Core 가 요청을 거부하므로 Max Context 슬라이더 상한으로 쓴다. */
  private activeProfileMaxTokens(): number | undefined {
    const p = this.plugin.ai.getProfileById(this.activeModelProfileId);
    return p?.maxContextTokens;
  }

  private renderRow(spec: ParamSpec, maxOverride?: number): void {
    // Core 가 외부 입력보다 프로필의 max tokens(=Stella Max Context)를 우선하므로,
    // 슬라이더 상한 자체를 프로필 값으로 낮춰 실제 전송 시 에러/무음 클램프를 방지한다.
    const effSpec: ParamSpec =
      maxOverride != null ? { ...spec, max: Math.min(spec.max, maxOverride) } : spec;
    const stored = this.params[spec.key];
    const isSet = stored != null;
    // fallback(미설정 표시값)도 프로필 상한을 넘으면 안 되므로 항상 effSpec 으로 클램프한다.
    const display = normalizeParamValue(isSet ? (stored as number) : spec.fallback, effSpec);
    // 프로필 제한으로 저장값이 잘렸으면 조용히 재저장해 다음 전송부터 반영한다.
    if (isSet && display !== stored) this.scheduleSave(spec.key, display);

    renderSliderRow({
      parent: this.bodyEl,
      label: spec.label,
      min: effSpec.min,
      max: effSpec.max,
      step: effSpec.step,
      value: display,
      unset: !isSet,
      format: (v) => formatValue(v, effSpec),
      normalize: (raw) => normalizeParamValue(raw, effSpec),
      onChange: (v) => this.scheduleSave(spec.key, v),
      onCommit: () => this.flush(),
    });
  }

  private scheduleSave(key: keyof PromptPresetParams, value: number): void {
    (this.params as any)[key] = value;
    (this.pendingPatch as any)[key] = value;
    if (this.saveHandle != null) window.clearTimeout(this.saveHandle);
    this.saveHandle = window.setTimeout(() => {
      this.saveHandle = null;
      void this.persistNow();
    }, DEBOUNCE_MS);
  }

  private async persistNow(): Promise<void> {
    if (Object.keys(this.pendingPatch).length === 0) return;
    const patch = { ...this.pendingPatch };
    this.pendingPatch = {};
    const snapshot = { ...this.params };
    console.log("[GGAI Stella] params persist", {
      target: this.activeSessionFile ?? "PluginData.current",
      patch,
      paramsAtSave: snapshot,
    });
    try {
      // 누적 patch 만 받아서, 활성 컨테이너의 기존 params 위에 머지하여 저장.
      await this.plugin.patchActiveSettings(
        { params: snapshot },
        this.activeSessionFile
      );
    } catch (err) {
      console.error("[GGAI Stella] 파라미터 저장 실패:", err);
      new Notice(
        `파라미터 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
      // 저장 실패한 patch 는 다음 차례에 재시도하도록 복원.
      Object.assign(this.pendingPatch, patch);
    }
  }
}

function formatValue(v: number, spec: ParamSpec): string {
  if (spec.integer) return String(Math.round(v));
  return v.toFixed(2);
}

function normalizeParamValue(raw: number, spec: ParamSpec): number {
  const fallback = spec.integer ? Math.round(spec.fallback) : spec.fallback;
  const finite = Number.isFinite(raw) ? raw : fallback;
  const clamped = Math.min(spec.max, Math.max(spec.min, finite));
  return spec.integer ? Math.round(clamped) : clamped;
}

/** 게이트 키가 없는 spec 은 항상 통과. allowed === undefined → legacy → 모두 허용. */
function isSpecAllowed(
  spec: ParamSpec,
  allowed: AllowedParams | undefined
): boolean {
  if (!spec.gate) return true;
  if (!allowed) return true;
  return !!allowed[spec.gate];
}

function paramsEqual(
  a: PromptPresetParams,
  b: PromptPresetParams
): boolean {
  const keys: (keyof PromptPresetParams)[] = [
    "temperature",
    "topP",
    "topK",
    "minP",
    "maxContext",
    "maxOutputTokens",
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
