/**
 * SessionViewStyle — 세션창 본문 표시 스타일 (이북 뷰어류 "보기 설정"). 전역 값으로
 * PluginData.viewStyle 에 저장하며, 모든 세션창에 공통 적용된다.
 *
 *  - paragraphGap: 문단 사이에 "추가로" 얹는 여백(px). 0 = 기본 줄바꿈 간격 그대로.
 *    문단 내부 줄바꿈(line-height)에는 영향을 주지 않는다 — CSS 가 줄바꿈 span 의
 *    line-height 를 기본 줄 높이 + 이 값으로 계산한다.
 *  - indent: 각 문단 첫 줄 들여쓰기(em). 문단 시작 지점에 빈 span 을 넣고 padding-left 로 적용.
 *  - maxWidth: 본문 최대 폭(px). 소설 세션창 전용.
 *  - fontScale: 옵시디언 기본 노트 폰트 크기(--font-text-size)에 곱하는 배율.
 *  - chatAvatarSize: 챗 세션창 말풍선 옆 아바타(프로필 아이콘) 크기(px). 0 = 숨김.
 */
export interface SessionViewStyle {
  paragraphGap: number;
  indent: number;
  maxWidth: number;
  fontScale: number;
  chatAvatarSize: number;
}

export const DEFAULT_SESSION_VIEW_STYLE: SessionViewStyle = {
  paragraphGap: 0,
  indent: 0.5,
  maxWidth: 550,
  fontScale: 1,
  chatAvatarSize: 80,
};

export const SESSION_VIEW_STYLE_LIMITS: Record<
  keyof SessionViewStyle,
  { min: number; max: number; step: number }
> = {
  paragraphGap: { min: 0, max: 80, step: 1 },
  indent: { min: 0, max: 3, step: 0.1 },
  maxWidth: { min: 480, max: 1200, step: 10 },
  fontScale: { min: 0.8, max: 1.6, step: 0.05 },
  chatAvatarSize: { min: 0, max: 160, step: 4 },
};

function clampField(key: keyof SessionViewStyle, value: number): number {
  const lim = SESSION_VIEW_STYLE_LIMITS[key];
  if (!Number.isFinite(value)) return DEFAULT_SESSION_VIEW_STYLE[key];
  return Math.min(lim.max, Math.max(lim.min, value));
}

export function clampSessionViewStyle(
  style: Partial<SessionViewStyle> | undefined
): SessionViewStyle {
  const merged = { ...DEFAULT_SESSION_VIEW_STYLE, ...style };
  return {
    paragraphGap: clampField("paragraphGap", merged.paragraphGap),
    indent: clampField("indent", merged.indent),
    maxWidth: clampField("maxWidth", merged.maxWidth),
    fontScale: clampField("fontScale", merged.fontScale),
    chatAvatarSize: clampField("chatAvatarSize", merged.chatAvatarSize),
  };
}
