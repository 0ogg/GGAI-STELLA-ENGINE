/**
 * 스텔라 폰 설정 — 앱별 섹션 렌더러 (공용).
 *
 * 같은 렌더 코드를 두 곳이 쓴다:
 *  - 확장 탭 패널(`phone-extension`)은 **공통 설정만** 그린다(모델/언어/번역/
 *    갱신 타이밍/세션 연동).
 *  - 각 앱(문자·네트워크·방송)의 세부 설정은 폰 안 그 앱의 햄버거 → "설정"에서
 *    `PhoneAppSettingsModal` 이 이 함수들을 호출해 그린다.
 *
 * 설정 UI 는 공용 컨트롤 킷(`detail/setting-controls`)만 쓴다 — 새 컨트롤이
 * 필요하면 킷에 추가한다(CLAUDE.md §9).
 */
import type StellaEnginePlugin from "../main";
import {
  PHONE_DEFAULT_KEYWORDS,
  type PhonePluginData,
  type PhoneTriggerSettings,
} from "../types/phone";
import {
  renderMediaModelPicker,
  renderMediaPromptPicker,
} from "./detail/media-prompt-panel";
import {
  renderEnableToggle,
  renderNumberRow,
  renderTextAreaRow,
  renderTextRow,
} from "./detail/setting-controls";

export interface PhoneSettingsCtx {
  plugin: StellaEnginePlugin;
  parent: HTMLElement;
  /** 값 저장. 저장 후 다시 그리는 것은 호출자(patch 구현) 책임. */
  patch: (p: Partial<PhonePluginData>) => Promise<void>;
  /** 토글로 하위 항목이 나타나고 사라질 때 쓰는 재렌더. */
  rerender: () => void;
  /** 소제목. 패널은 구분선 소제목, 모달은 생략(단일 앱이라 제목이 곧 소제목). */
  section?: (title: string) => void;
}

const phoneOf = (ctx: PhoneSettingsCtx): PhonePluginData =>
  ctx.plugin.data.phone ?? {};

/** 문자 앱 세부 설정 — 프롬프트 + 답장 재료 분량 + 배달 속도. */
export function renderPhoneMessagesSettings(ctx: PhoneSettingsCtx): void {
  const { plugin, parent, patch, rerender } = ctx;
  const phone = phoneOf(ctx);
  ctx.section?.("문자 생성");
  renderMediaPromptPicker({
    plugin,
    parent,
    label: "캐릭터 문자 프롬프트 (답장·먼저 연락)",
    bucket: "phoneText",
    activeId: phone.textPromptId,
    onSelect: (textPromptId) => void patch({ textPromptId }),
    onChanged: rerender,
    onDeleted: () => void patch({ textPromptId: undefined }),
  });
  renderMediaPromptPicker({
    plugin,
    parent,
    label: "모르는 번호 프롬프트 (스팸·엑스트라)",
    bucket: "phoneExtra",
    activeId: phone.extraPromptId,
    onSelect: (extraPromptId) => void patch({ extraPromptId }),
    onChanged: rerender,
    onDeleted: () => void patch({ extraPromptId: undefined }),
  });
  renderNumberRow({
    parent,
    label: "답장 시 기억하는 과거 문자 (통)",
    value: phone.replyHistoryLimit ?? 60,
    fallback: 60,
    min: 1,
    integer: true,
    onChange: (replyHistoryLimit) => void patch({ replyHistoryLimit }),
  });
  renderNumberRow({
    parent,
    label: "답장 시 참고할 세션 장면 (토큰)",
    value: phone.sessionTailTokens ?? 2000,
    fallback: 2000,
    min: 100,
    integer: true,
    onChange: (sessionTailTokens) => void patch({ sessionTailTokens }),
  });
  renderNumberRow({
    parent,
    label: "답장 없는 문자가 이만큼 쌓이면 먼저 연락 안 함 (0=제한 없음)",
    value: phone.maxUnanswered ?? 2,
    fallback: 2,
    min: 0,
    integer: true,
    onChange: (maxUnanswered) => void patch({ maxUnanswered }),
  });
  renderNumberRow({
    parent,
    label: "답장 도착까지 최대 지연 (분, 0=바로 도착)",
    value: phone.maxReplyDelayMinutes ?? 10,
    fallback: 10,
    min: 0,
    integer: true,
    onChange: (maxReplyDelayMinutes) => void patch({ maxReplyDelayMinutes }),
  });
}

/** 스텔라 네트워크(SNS) 세부 설정 — 프롬프트 + 재료 분량 + 활동 상한. */
export function renderPhoneSnsSettings(ctx: PhoneSettingsCtx): void {
  const { plugin, parent, patch, rerender } = ctx;
  const phone = phoneOf(ctx);
  ctx.section?.("스텔라 네트워크");
  renderMediaPromptPicker({
    plugin,
    parent,
    label: "게시글·댓글 프롬프트",
    bucket: "phoneSns",
    activeId: phone.snsPromptId,
    onSelect: (snsPromptId) => void patch({ snsPromptId }),
    onChanged: rerender,
    onDeleted: () => void patch({ snsPromptId: undefined }),
  });
  renderEnableToggle({
    parent,
    label: "캐릭터가 사진 올리는 것 허용",
    checked: phone.snsPhotoEnabled !== false,
    onChange: (snsPhotoEnabled) => void patch({ snsPhotoEnabled }),
  });
  renderNumberRow({
    parent,
    label: "갱신마다 활동할 인물 수",
    value: phone.snsConfirmedCount ?? 3,
    fallback: 3,
    min: 1,
    integer: true,
    onChange: (snsConfirmedCount) => void patch({ snsConfirmedCount }),
  });
  renderNumberRow({
    parent,
    label: "인물당 참고할 세션 요약 (토큰)",
    value: phone.snsSummaryTokens ?? 2000,
    fallback: 2000,
    min: 0,
    integer: true,
    onChange: (snsSummaryTokens) => void patch({ snsSummaryTokens }),
  });
  renderNumberRow({
    parent,
    label: "인물당 참고할 세션 본문 (토큰)",
    value: phone.snsBodyTokens ?? 2000,
    fallback: 2000,
    min: 100,
    integer: true,
    onChange: (snsBodyTokens) => void patch({ snsBodyTokens }),
  });
  renderEnableToggle({
    parent,
    label: "세션 본문의 로어북도 참고",
    checked: phone.snsIncludeLore !== false,
    onChange: (snsIncludeLore) => void patch({ snsIncludeLore }),
  });
  renderEnableToggle({
    parent,
    label: "다른 세션 2개 랜덤 추가 참고 (분량 절반)",
    checked: phone.snsRandomSessions === true,
    onChange: (snsRandomSessions) => void patch({ snsRandomSessions }),
  });
  renderNumberRow({
    parent,
    label: "갱신당 글+댓글 최대 (0=SNS 자동 갱신 끔)",
    value: phone.snsPerRefresh ?? 10,
    fallback: 10,
    min: 0,
    integer: true,
    onChange: (snsPerRefresh) => void patch({ snsPerRefresh }),
  });
  renderNumberRow({
    parent,
    label: "갱신당 새 게시글 최소",
    value: phone.snsMinNewPosts ?? 2,
    fallback: 2,
    min: 0,
    integer: true,
    onChange: (snsMinNewPosts) => void patch({ snsMinNewPosts }),
  });
  renderNumberRow({
    parent,
    label: "갱신당 새 인물 등장 최대 (명)",
    value: phone.snsNewAccountCap ?? 3,
    fallback: 3,
    min: 0,
    integer: true,
    onChange: (snsNewAccountCap) => void patch({ snsNewAccountCap }),
  });
  renderNumberRow({
    parent,
    label: "작품 속 인물 비율 % (나머지만 엑스트라)",
    value: phone.snsNamedRatio ?? 70,
    fallback: 70,
    min: 0,
    max: 100,
    integer: true,
    onChange: (snsNamedRatio) => void patch({ snsNamedRatio }),
  });
  renderEnableToggle({
    parent,
    label: "로어북 속 인물을 자동으로 계정 등록",
    checked: phone.snsCastScan !== false,
    onChange: (snsCastScan) => void patch({ snsCastScan }),
  });
  if (phone.snsCastScan !== false) {
    renderMediaPromptPicker({
      plugin,
      parent,
      label: "인물 선별 프롬프트",
      bucket: "phoneCast",
      activeId: phone.castPromptId,
      onSelect: (castPromptId) => void patch({ castPromptId }),
      onChanged: rerender,
      onDeleted: () => void patch({ castPromptId: undefined }),
    });
    renderNumberRow({
      parent,
      label: "세계당 등록할 인물 최대 (명)",
      value: phone.snsCastCap ?? 12,
      fallback: 12,
      min: 1,
      integer: true,
      onChange: (snsCastCap) => void patch({ snsCastCap }),
    });
    renderNumberRow({
      parent,
      label: "인물 선별에 참고할 로어북 (토큰)",
      value: phone.snsCastTokens ?? 4000,
      fallback: 4000,
      min: 200,
      integer: true,
      onChange: (snsCastTokens) => void patch({ snsCastTokens }),
    });
  }
  renderNumberRow({
    parent,
    label: "일상글 비율 % (세션 사건과 무관한 생활글)",
    value: phone.snsDailyRatio ?? 70,
    fallback: 70,
    min: 0,
    max: 100,
    integer: true,
    onChange: (snsDailyRatio) => void patch({ snsDailyRatio }),
  });
  renderNumberRow({
    parent,
    label: "여파 글 최대 (사건을 못 본 사람이 겪은 파장)",
    value: phone.snsBystanderCap ?? 1,
    fallback: 1,
    min: 0,
    integer: true,
    onChange: (snsBystanderCap) => void patch({ snsBystanderCap }),
  });
}

/** 스텔라튜브(방송) 세부 설정 — 사용 여부 + 자동 시작 판정 + 프롬프트. */
export function renderPhoneTubeSettings(ctx: PhoneSettingsCtx): void {
  const { plugin, parent, patch, rerender } = ctx;
  const phone = phoneOf(ctx);
  ctx.section?.("방송 (스텔라튜브)");
  renderEnableToggle({
    parent,
    label: "방송 기능 사용 (생중계·시청자 채팅)",
    checked: phone.tubeEnabled !== false,
    onChange: (tubeEnabled) => void patch({ tubeEnabled }),
  });
  if (phone.tubeEnabled === false) return;
  renderEnableToggle({
    parent,
    label: "세션에 방송 장면이 나오면 자동으로 방송 시작",
    checked: phone.streamAutoDetect === true,
    onChange: (streamAutoDetect) => void patch({ streamAutoDetect }),
  });
  if (phone.streamAutoDetect === true) {
    renderMediaPromptPicker({
      plugin,
      parent,
      label: "방송 시작 판정 프롬프트",
      bucket: "phoneStreamDetect",
      activeId: phone.streamDetectPromptId,
      onSelect: (streamDetectPromptId) => void patch({ streamDetectPromptId }),
      onChanged: rerender,
      onDeleted: () => void patch({ streamDetectPromptId: undefined }),
    });
  }
  renderMediaPromptPicker({
    plugin,
    parent,
    label: "시청자 채팅 프롬프트",
    bucket: "phoneTube",
    activeId: phone.tubePromptId,
    onSelect: (tubePromptId) => void patch({ tubePromptId }),
    onChanged: rerender,
    onDeleted: () => void patch({ tubePromptId: undefined }),
  });
}

/**
 * 공통 설정 — 확장 탭 패널이 그리는 부분. 앱을 가리지 않는 것만 둔다:
 * 모델/언어/앱 간 공유, 폰 번역, 자동 갱신 타이밍, 세션 연동.
 */
export function renderPhoneCommonSettings(ctx: PhoneSettingsCtx): void {
  const { plugin, parent, patch, rerender } = ctx;
  const phone = phoneOf(ctx);

  ctx.section?.("기본");
  renderMediaModelPicker({
    plugin,
    parent,
    label: "글 생성 모델 (문자·SNS·방송 공용)",
    profiles: plugin.ai.listGenerationProfiles().filter((p) => p.kind === "chat"),
    activeId: phone.modelProfileId,
    onSelect: (modelProfileId) => void patch({ modelProfileId }),
    emptyText: "Core 챗 모델이 없습니다.",
  });
  renderMediaModelPicker({
    plugin,
    parent,
    label: "사진 생성 모델 (문자 사진·SNS 사진)",
    profiles: plugin.ai.listImageProfiles(),
    activeId: phone.imageProfileId,
    onSelect: (imageProfileId) => void patch({ imageProfileId }),
    emptyText: "Core 이미지 프로필이 없습니다 (SNS 사진은 캡션으로만 표시).",
  });
  // 사진 읽기 (v2 §5 출처 D) — 첨부 사진의 캡션이 곧 다른 모델에게는 그 사진의
  // 전부다. 모델을 고르지 않으면 이 기능 자체가 돌지 않는다.
  renderMediaModelPicker({
    plugin,
    parent,
    label: "사진 읽기 모델 (첨부 사진 보기 — 비전 지원 모델)",
    profiles: plugin.ai.listGenerationProfiles().filter((p) => p.kind === "chat"),
    activeId: phone.visionProfileId,
    onSelect: (visionProfileId) => void patch({ visionProfileId }),
    emptyText: "Core 챗 모델이 없습니다.",
  });
  if (phone.visionProfileId) {
    renderEnableToggle({
      parent,
      label: "찍은 사진·업로드 사진 읽기",
      checked: phone.visionForPhotos !== false,
      onChange: (visionForPhotos) => void patch({ visionForPhotos }),
    });
    renderEnableToggle({
      parent,
      label: "AI 그림도 다시 읽기 (끄면 그림에 담긴 생성 프롬프트를 사용)",
      checked: phone.visionForAiImages === true,
      onChange: (visionForAiImages) => void patch({ visionForAiImages }),
    });
    renderMediaPromptPicker({
      plugin,
      parent,
      label: "사진 읽기 프롬프트",
      bucket: "phoneVision",
      activeId: phone.visionPromptId,
      onSelect: (visionPromptId) => void patch({ visionPromptId }),
      onChanged: rerender,
      onDeleted: () => void patch({ visionPromptId: undefined }),
    });
  }
  renderTextRow({
    parent,
    label: "생성 언어 (비우면 자동)",
    value: phone.language ?? "",
    placeholder: "예: 한국어",
    onChange: (language) => void patch({ language }),
  });
  renderEnableToggle({
    parent,
    label: "앱끼리 소식 공유 (문자·SNS·방송이 서로의 최근 일을 참고)",
    checked: phone.sharedContextEnabled !== false,
    onChange: (sharedContextEnabled) => void patch({ sharedContextEnabled }),
  });
  if (phone.sharedContextEnabled !== false) {
    renderNumberRow({
      parent,
      label: "공유 소식 참고 분량 (토큰)",
      value: phone.sharedContextTokens ?? 1000,
      fallback: 1000,
      min: 0,
      integer: true,
      onChange: (sharedContextTokens) => void patch({ sharedContextTokens }),
    });
  }

  // ── 폰 안 번역 — 켜면 곧 자동 번역(별도 옵션 없음). 프롬프트/모델/로어북은
  //    전역 번역 설정을 그대로 쓴다. ──
  ctx.section?.("번역 (폰 화면)");
  const translation = phone.translation ?? {};
  renderEnableToggle({
    parent,
    label: "폰 화면 번역 사용 — 문자·SNS·방송이 생성되면 자동 번역",
    checked: translation.enabled === true,
    onChange: (enabled) => void patch({ translation: { enabled } }),
  });

  // ── 갱신 타이밍 — 문자·SNS 공용. ──
  ctx.section?.("자동 갱신 (캐릭터가 먼저 문자·SNS 활동하는 때)");
  const triggers = phone.triggers ?? {};
  const patchTriggers = (p: Partial<PhoneTriggerSettings>) =>
    patch({ triggers: { ...triggers, ...p } });
  renderEnableToggle({
    parent,
    label: "폰을 켰을 때",
    checked: triggers.onOpen !== false,
    onChange: (onOpen) => void patchTriggers({ onOpen }),
  });
  renderEnableToggle({
    parent,
    label: "세션 플레이 중 랜덤 (5~30분)",
    checked: triggers.randomInSession === true,
    onChange: (randomInSession) => void patchTriggers({ randomInSession }),
  });
  renderEnableToggle({
    parent,
    label: "일정 간격마다 (옵시디언 켜져 있는 동안)",
    checked: triggers.periodic === true,
    onChange: (periodic) => void patchTriggers({ periodic }),
  });
  if (triggers.periodic === true) {
    renderNumberRow({
      parent,
      label: "간격 (분)",
      value: triggers.periodicMinutes ?? 60,
      fallback: 60,
      min: 5,
      integer: true,
      onChange: (periodicMinutes) => void patchTriggers({ periodicMinutes }),
    });
  }
  renderEnableToggle({
    parent,
    label: "세션에 폰 관련 키워드가 나왔을 때",
    checked: triggers.keyword === true,
    onChange: (keyword) => void patchTriggers({ keyword }),
  });
  if (triggers.keyword === true) {
    renderTextAreaRow({
      parent,
      label: "추가 키워드",
      value: (triggers.customKeywords ?? []).join(", "),
      placeholder: "쉼표 또는 줄바꿈으로 구분",
      rows: 3,
      // 기본 사전은 접히지 않는 안내로 전부 보여준다 — 무엇을 더 넣어야 하는지
      // 알려면 이미 걸리는 말이 보여야 한다.
      hint: `기본 키워드 (항상 적용): ${PHONE_DEFAULT_KEYWORDS.join(", ")}`,
      onChange: (raw) =>
        void patchTriggers({
          customKeywords: raw
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
    });
  }

  // ── 세션 연동 — 폰에서 있었던 일을 세션 속 캐릭터가 기억할지. ──
  ctx.section?.("세션 연동 (폰 내용을 캐릭터 기억에)");
  renderEnableToggle({
    parent,
    label: "문자 내용을 세션에 반영",
    checked: phone.enabled !== false,
    onChange: (enabled) => void patch({ enabled }),
  });
  renderEnableToggle({
    parent,
    label: "SNS 내용을 세션에 반영",
    checked: phone.snsEnabled !== false,
    onChange: (snsEnabled) => void patch({ snsEnabled }),
  });
  void rerender;
}
