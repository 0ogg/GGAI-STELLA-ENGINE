import type { IllustrationVariant } from "../types/media";

export interface DashboardNsfwProtection {
  /** 다른 조건과 무관하게 항상 숨긴다. */
  always?: boolean;
  /** Obsidian 모바일 앱에서 숨긴다. */
  mobile?: boolean;
  /** 지정한 현지 시간 구간에 숨긴다. */
  schedule?: boolean;
  scheduleStartHour?: number;
  scheduleEndHour?: number;
  /** 앱 창이 포커스를 잃은 동안 숨긴다. */
  unfocused?: boolean;
}

export interface DashboardSafetyContext {
  isMobile: boolean;
  isFocused: boolean;
  /** 현지 시각의 시간(0~23). */
  hour: number;
}

const normalizeHour = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(23, Math.floor(value!))) : fallback;

/** 시작 시각 포함, 종료 시각 미포함. 시작=종료면 하루 종일이다. */
export function isHourInRange(hour: number, start: number, end: number): boolean {
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 선택한 조건은 OR로 합친다. 아무 조건도 고르지 않으면 보호하지 않는다. */
export function shouldHideDashboardNsfw(
  settings: DashboardNsfwProtection | undefined,
  context: DashboardSafetyContext
): boolean {
  if (!settings) return false;
  if (settings.always) return true;
  if (settings.mobile && context.isMobile) return true;
  if (settings.unfocused && !context.isFocused) return true;
  if (settings.schedule) {
    const start = normalizeHour(settings.scheduleStartHour, 9);
    const end = normalizeHour(settings.scheduleEndHour, 18);
    if (isHourInRange(context.hour, start, end)) return true;
  }
  return false;
}

const NSFW_TAG = /(?:^|[^a-z0-9_])nsfw(?:$|[^a-z0-9_])/i;

/** 새 데이터의 tags와 구 데이터의 프롬프트 태그를 모두 인식한다. */
export function hasNsfwTag(tags: string[] | undefined, fallbackText = ""): boolean {
  if (tags?.some((tag) => tag.trim().toLowerCase() === "nsfw")) return true;
  return NSFW_TAG.test(fallbackText);
}

export function isNsfwIllustration(variant: IllustrationVariant): boolean {
  return hasNsfwTag(variant.tags, variant.prompt ?? "");
}
