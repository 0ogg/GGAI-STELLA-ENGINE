/**
 * AIService — GGAI Core 의 AI API 진입점 래퍼.
 *
 * 책임:
 *  - `app.plugins.plugins["ggai-core"].api` 를 안전하게 가져와 보유 (Core 미설치 / 비활성 시 null)
 *  - 채팅 프로필 목록을 자체 캐시 + Core 의 "profiles-changed" 이벤트로 무효화
 *  - chat / chatStream / countTokens 호출 위임
 *
 * 호출자(SessionView 등)는 Core 의 타입을 직접 import 하지 않고 이 파일의 좁은 타입만 사용.
 * 의존 명세:
 *  - Core 가 활성화되어 있어야 정상 동작 (manifest.json dependencies 로 로드 순서 보장)
 *  - Core 가 없으면 모든 메서드는 throw 하지 않고 null/error 결과를 반환
 */

import { App, Events } from "obsidian";
/**
 * Core 가 외부 플러그인에 노출하는 게이트 가능 파라미터 키.
 * `topK / topP / minP` 만 게이트 대상. temperature / maxTokens / stopSequences 등은 항상 허용.
 * `allowedParams === undefined` → legacy 프로필, 모두 허용.
 */
export interface AllowedParams {
  topK?: boolean;
  topP?: boolean;
  minP?: boolean;
}

/** Core 의 PublicProfile 중 우리가 쓰는 필드만. chat / text 둘 다 포함. */
export interface GenerationProfileLite {
  id: string;
  name: string;
  /** chat = chat()/chatStream() 호출 가능, text = NAI text completion 등 generate()/text() 경유. */
  kind: "chat" | "text";
  provider: string;
  model: string;
  isDefault?: boolean;
  /** 외부 플러그인 paramsOverride 에서 어떤 샘플링 파라미터를 허용할지. undefined=모두 허용. */
  allowedParams?: AllowedParams;
  /** 프로필에 설정된 입력(프롬프트) 토큰 상한. 초과 시 Core 가 요청 자체를 거부하므로, Stella 의 Max Context 슬라이더 상한 클램프에 쓴다. undefined=제한 없음. */
  maxContextTokens?: number;
}

/** 호환을 위한 별칭. 점진 폐기 예정. */
export type ChatProfileLite = GenerationProfileLite;
export interface ImageProfileLite {
  id: string;
  name: string;
  kind: "image";
  provider: string;
  model: string;
  isDefault?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatRequest {
  profileId?: string;
  messages: ChatMessage[];
  paramsOverride?: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * 이 요청을 유발한 기능의 표시 이름(예: "번역", "이어쓰기").
   * Core 의 "생성 중" 토스트에 `라벨 (모델명)` 형태로 표시된다. 그대로 Core 로 전달.
   */
  label?: string;
}

export interface ChatResponse {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  /** 디버그용 — provider 원본 응답 (NAI choices, OpenAI body 등). */
  raw?: unknown;
}

export interface ImageGenRequest {
  profileId: string;
  prompt: string;
  negativePrompt?: string;
  n?: number;
  paramsOverride?: Record<string, unknown>;
  signal?: AbortSignal;
  /** "생성 중" 토스트에 표시할 기능 이름. @see ChatRequest.label */
  label?: string;
}

export interface ImageGenResult {
  images: Array<{ kind: "base64"; mediaType: string; data: string }>;
  raw?: unknown;
}

export type ChatStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "done"; response: ChatResponse }
  | { type: "error"; error: { message: string; code?: string } };

/**
 * Core 취소 계약 — provider 구현과 무관하게 취소는 항상 `code === "cancelled"`.
 * 스트리밍/에이전트 이벤트의 error 객체와 throw 된 에러 모두 이 필드를 갖는다.
 * (AbortError name 기반 판별은 폐기.)
 */
export function isCancelledError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "cancelled"
  );
}

/**
 * 외부 호출자가 알아야 할 이벤트:
 *   "profiles-changed" — Core 의 동일 이벤트를 그대로 중계. UI 가 프로필 드롭다운을 다시 그릴 때.
 *   "core-availability-changed" — Core 가 활성화/비활성화될 때 (간이 폴링).
 */
export class AIService extends Events {
  private profileCache: GenerationProfileLite[] | null = null;
  private imageProfileCache: ImageProfileLite[] | null = null;
  private unsubscribeProfilesChanged: (() => void) | null = null;
  /** 현재 구독이 붙어 있는 Core api 인스턴스. Core 리로드 시 인스턴스가 교체되므로 재구독 판단에 쓴다. */
  private boundApi: any | null = null;
  private lastApiAvailable: boolean | null = null;
  private availabilityPollHandle: number | null = null;

  constructor(private app: App) {
    super();
  }

  /** 플러그인 onload 에서 호출. Core 의 이벤트 구독 + 가용성 폴링 시작. */
  start(): void {
    this.bindToCore();
    this.lastApiAvailable = this.getApi() != null;
    // Core 가 stella 보다 늦게 로드될 가능성 + Core 리로드로 api 인스턴스가 교체될 가능성
    // 둘 다 가벼운 폴링으로 흡수한다. bindToCore 는 멱등이라 매 틱 불러도 안전.
    this.availabilityPollHandle = window.setInterval(() => {
      // api 가 새로 생겼거나(늦은 로드) 인스턴스가 교체됐으면(리로드) 여기서 재구독.
      this.bindToCore();
      const nowAvailable = this.getApi() != null;
      if (this.lastApiAvailable !== nowAvailable) {
        this.lastApiAvailable = nowAvailable;
        this.profileCache = null;
        this.imageProfileCache = null;
        this.trigger("core-availability-changed", nowAvailable);
        this.trigger("profiles-changed");
      }
    }, 3000);
  }

  /** onunload 에서 호출. */
  stop(): void {
    this.unsubscribeProfilesChanged?.();
    this.unsubscribeProfilesChanged = null;
    this.boundApi = null;
    if (this.availabilityPollHandle != null) {
      window.clearInterval(this.availabilityPollHandle);
      this.availabilityPollHandle = null;
    }
  }

  // ────── 가용성 / 프로필 ──────

  isAvailable(): boolean {
    return this.getApi() != null;
  }

  /**
   * 텍스트 생성 가능 프로필 (chat + text). Core 미설치 시 빈 배열.
   * 정렬: isDefault 가 앞, 그 안에서는 chat → text, 같은 kind 안에서는 name 알파벳.
   */
  listGenerationProfiles(): GenerationProfileLite[] {
    if (this.profileCache) return this.profileCache;
    const api = this.getApi();
    if (!api) {
      this.profileCache = [];
      return this.profileCache;
    }
    try {
      const raw = [
        ...((api.listProfiles?.("chat") ?? []) as any[]),
        ...((api.listProfiles?.("text") ?? []) as any[]),
      ];
      const mapped: GenerationProfileLite[] = raw.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind === "text" ? "text" : "chat",
        provider: p.provider,
        model: p.model,
        isDefault: p.isDefault,
        allowedParams:
          p.allowedParams && typeof p.allowedParams === "object"
            ? {
                topK: !!p.allowedParams.topK,
                topP: !!p.allowedParams.topP,
                minP: !!p.allowedParams.minP,
              }
            : undefined,
        maxContextTokens:
          typeof p.params?.maxContextTokens === "number" ? p.params.maxContextTokens : undefined,
      }));
      mapped.sort(compareGenerationProfiles);
      this.profileCache = mapped;
      return this.profileCache;
    } catch (err) {
      console.warn("[GGAI Stella] listProfiles 실패:", err);
      this.profileCache = [];
      return this.profileCache;
    }
  }

  listImageProfiles(): ImageProfileLite[] {
    if (this.imageProfileCache) return this.imageProfileCache;
    const api = this.getApi();
    if (!api) {
      this.imageProfileCache = [];
      return this.imageProfileCache;
    }
    try {
      const raw = (api.listProfiles?.("image") ?? []) as any[];
      const mapped: ImageProfileLite[] = raw.map((p) => ({
        id: p.id,
        name: p.name,
        kind: "image",
        provider: p.provider,
        model: p.model,
        isDefault: p.isDefault,
      }));
      mapped.sort(compareImageProfiles);
      this.imageProfileCache = mapped;
      return this.imageProfileCache;
    } catch (err) {
      console.warn("[GGAI Stella] list image profiles failed:", err);
      this.imageProfileCache = [];
      return this.imageProfileCache;
    }
  }

  /** 호환 — 이름은 유지하되 chat + text 합쳐서 반환. */
  listChatProfiles(): GenerationProfileLite[] {
    return this.listGenerationProfiles();
  }

  /** 기본 chat 프로필 (chat 한정 — chat()/chatStream() 호출에 안전). */
  getDefaultChatProfile(): GenerationProfileLite | null {
    const list = this.listGenerationProfiles().filter((p) => p.kind === "chat");
    return list.find((p) => p.isDefault) ?? list[0] ?? null;
  }

  /**
   * 기본 텍스트 생성 프로필 (chat + text 통합). 모델을 고르지 않았을 때의 폴백.
   * Stella 는 텍스트 컴플리션 모델 사용을 전제하므로, 기본 프로필이 text 이면
   * text 프로필을 그대로 돌려준다 (chat 한정 폴백은 text-only 환경에서 null 이 된다).
   * 우선순위: isDefault → 목록 첫 항목(정렬상 chat 우선). generate()/chat() 는
   * 호출자가 kind 로 분기하므로 어느 kind 든 안전하다.
   */
  getDefaultGenerationProfile(): GenerationProfileLite | null {
    const list = this.listGenerationProfiles();
    return list.find((p) => p.isDefault) ?? list[0] ?? null;
  }

  /** id 로 단일 프로필 조회 (캐시 이용). 못 찾으면 null. */
  getProfileById(id: string | undefined): GenerationProfileLite | null {
    if (!id) return null;
    return this.listGenerationProfiles().find((p) => p.id === id) ?? null;
  }

  // ────── 호출 ──────

  /** 단발 chat. Core 미설치면 throw. */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const api = this.requireApi();
    const r = await api.chat(req);
    return normalizeChatResponse(r);
  }

  /**
   * 단발 텍스트 생성 — chat / text 프로필 둘 다 수용 (Core 가 자동 분기).
   * 스트리밍 X. text 프로필(NovelAI 등) 사용 시 호출.
   */
  async generate(req: {
    profileId: string;
    prompt: string;
    paramsOverride?: Record<string, unknown>;
    signal?: AbortSignal;
    /** "생성 중" 토스트에 표시할 기능 이름. @see ChatRequest.label */
    label?: string;
  }): Promise<ChatResponse> {
    const api = this.requireApi();
    const r = await api.generate(req);
    return normalizeChatResponse(r);
  }

  /** 이미지 생성 (NovelAI 이미지 프로필 전용). Core 미설치면 throw. */
  async image(req: ImageGenRequest): Promise<ImageGenResult> {
    const api = this.requireApi();
    const r = await api.image(req);
    const images = Array.isArray(r?.images)
      ? r.images
          .filter((img: any) => img?.kind === "base64" && typeof img.data === "string")
          .map((img: any) => ({
            kind: "base64" as const,
            mediaType: typeof img.mediaType === "string" ? img.mediaType : "image/png",
            data: img.data as string,
          }))
      : [];
    return { images, raw: r?.raw };
  }

  /** 스트리밍 chat. Core 미설치면 즉시 error 이벤트만 한 번 yield. */
  async *chatStream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const api = this.getApi();
    if (!api) {
      yield {
        type: "error",
        error: { message: "GGAI Core 가 설치/활성화되어 있지 않습니다." },
      };
      return;
    }
    try {
      // Core 의 chatStream 은 AsyncIterable<ChatEvent> — 우리가 모르는 이벤트는 무시.
      const it = api.chatStream(req) as AsyncIterable<any>;
      for await (const ev of it) {
        if (ev?.type === "text-delta" && typeof ev.delta === "string") {
          yield { type: "text-delta", delta: ev.delta };
        } else if (ev?.type === "done") {
          yield {
            type: "done",
            response: normalizeChatResponse(ev.response),
          };
        } else if (ev?.type === "error") {
          yield {
            type: "error",
            error: {
              message: ev.error?.message ?? String(ev.error ?? "unknown"),
              code: ev.error?.code,
            },
          };
        }
        // tool-call-* 등은 현재 사용 안 함.
      }
    } catch (err: any) {
      // 취소는 호출자가 catch 해서 자체 처리하도록 그대로 던진다.
      if (isCancelledError(err)) throw err;
      yield {
        type: "error",
        error: { message: err?.message ?? String(err) },
      };
    }
  }

  /** 토큰 수 근사. Core 미설치면 글자수 / 4 로 폴백. */
  countTokens(input: string | ChatMessage[], profileId?: string): number {
    const api = this.getApi();
    if (!api) {
      const text =
        typeof input === "string"
          ? input
          : input.map((m) => m.content).join("\n");
      return Math.ceil(text.length / 4);
    }
    try {
      return api.countTokens(input as any, profileId ? { profileId } : undefined);
    } catch (err) {
      console.warn("[GGAI Stella] countTokens 실패:", err);
      return 0;
    }
  }

  /**
   * Core 의 프로필 편집 모달을 연다 (롱프레스 등에서 호출).
   * Core 미설치/미지원/프로필 미존재 시 false.
   */
  editProfile(profileId: string): boolean {
    const core = (this.app as any).plugins?.plugins?.["ggai-core"];
    if (!core || typeof core.openProfileEditor !== "function") return false;
    try {
      return core.openProfileEditor(profileId) === true;
    } catch (err) {
      console.warn("[GGAI Stella] openProfileEditor 실패:", err);
      return false;
    }
  }

  // ────── internal ──────

  /** Core 의 API 객체. Core 미설치/비활성 시 null. */
  private getApi(): any | null {
    const plugin = (this.app as any).plugins?.plugins?.["ggai-core"];
    return plugin?.api ?? null;
  }

  private requireApi(): any {
    const api = this.getApi();
    if (!api) {
      throw new Error("GGAI Core 가 설치/활성화되어 있지 않습니다.");
    }
    return api;
  }

  /**
   * Core 의 "profiles-changed" 에 구독한다. 멱등:
   *  - 이미 현재 api 인스턴스에 붙어 있으면 아무것도 안 함.
   *  - api 가 사라졌거나(리로드 중) 다른 인스턴스로 교체됐으면 옛 구독을 끊고 새로 붙는다.
   * (예전엔 한 번 구독하면 재구독을 막아, Core 리로드 후 죽은 인스턴스에 남는 버그가 있었다.)
   */
  private bindToCore(): void {
    const api = this.getApi();
    // 같은 인스턴스에 이미 붙어 있음 → 그대로.
    if (api && this.boundApi === api && this.unsubscribeProfilesChanged) return;
    // api 가 없어졌거나 교체됨 → 기존 구독 정리.
    if (this.unsubscribeProfilesChanged) {
      try {
        this.unsubscribeProfilesChanged();
      } catch {
        // 옛 인스턴스가 이미 파괴됐을 수 있음 — 무시.
      }
      this.unsubscribeProfilesChanged = null;
      this.boundApi = null;
      // 구독이 끊긴 동안 프로필이 바뀌었을 수 있으니 캐시를 비운다.
      this.profileCache = null;
      this.imageProfileCache = null;
    }
    if (!api?.on) return;
    try {
      this.unsubscribeProfilesChanged = api.on("profiles-changed", () => {
        this.profileCache = null;
        this.imageProfileCache = null;
        this.trigger("profiles-changed");
      });
      this.boundApi = api;
      this.lastApiAvailable = true;
    } catch (err) {
      console.warn("[GGAI Stella] Core profiles-changed 구독 실패:", err);
    }
  }
}

function normalizeChatResponse(r: any): ChatResponse {
  return {
    text: r?.text ?? "",
    stopReason: r?.stopReason ?? "end",
    usage: {
      inputTokens: r?.usage?.inputTokens ?? 0,
      outputTokens: r?.usage?.outputTokens ?? 0,
    },
    raw: r?.raw,
  };
}

function compareGenerationProfiles(
  a: GenerationProfileLite,
  b: GenerationProfileLite
): number {
  const da = a.isDefault ? 0 : 1;
  const db = b.isDefault ? 0 : 1;
  if (da !== db) return da - db;
  // chat 먼저, 그 다음 text — UI 일관성을 위해.
  const ka = a.kind === "chat" ? 0 : 1;
  const kb = b.kind === "chat" ? 0 : 1;
  if (ka !== kb) return ka - kb;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

function compareImageProfiles(a: ImageProfileLite, b: ImageProfileLite): number {
  const da = a.isDefault ? 0 : 1;
  const db = b.isDefault ? 0 : 1;
  if (da !== db) return da - db;
  return (a.name ?? "").localeCompare(b.name ?? "");
}
