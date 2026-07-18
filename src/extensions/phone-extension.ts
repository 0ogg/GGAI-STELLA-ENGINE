/**
 * 스텔라 폰 확장 (PH1) — 문자 기억 주입 훅 + 확장 탭 설정 패널.
 *
 * 기억 주입: 세션 생성 시(미리보기 포함, planSessionRequest 경유) 그 세션의
 * 페르소나와 그 캐릭터가 주고받은 최근 문자를 `phone` 슬롯으로 기여한다.
 * 엔진이 가상 로어북(상시/at_depth)으로 감싸 히스토리 근처에 삽입한다 —
 * "아까 문자로 아이스크림 얘기했지"가 세션에서 이어지는 경로.
 *
 * 폰 설정은 전역(`PluginData.phone`)이다 — 폰은 세션 소속이 아니라 페르소나
 * 소속이므로 세션별 ActiveSettings 를 쓰지 않는다.
 */
import type StellaEnginePlugin from "../main";
import {
  matchesPhoneKeywords,
  matchesStreamKeywords,
  type PhonePluginData,
  type PhoneTriggerSettings,
  type SnsAuthor,
  type SnsPost,
} from "../types/phone";
import type { SettingsPanel } from "../services/settings-panel-registry";
import {
  renderMediaLorebookPicker,
  renderMediaModelPicker,
  renderMediaPromptPicker,
} from "../views/detail/media-prompt-panel";
import {
  renderEnableToggle,
  renderNumberRow,
  renderTextRow,
} from "../views/detail/setting-controls";
import { ScenarioSelectModal } from "../views/scenario-select-modal";

/** 기억 주입에 넣는 최근 문자 수 (스레드 끝에서부터). */
const INJECT_MESSAGE_LIMIT = 12;
/** 직접 관여하지 않은 SNS 글을 "지나가다 봤을" 확률 (결정적 샘플). */
const SNS_BROWSE_CHANCE = 0.3;
/** 기억 주입에 넣는 SNS 게시글 상한. */
const SNS_INJECT_LIMIT = 5;

/** 문자열 → 0~1 결정적 해시 비율 (FNV-1a) — 미리보기·생성 byte 동일 유지용. */
function hashRatio(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

export function registerPhoneExtension(plugin: StellaEnginePlugin): void {
  plugin.extensions.register({
    id: "stella:phone",
    // 세션창 하단 확장 트레이(퍼즐)에서 폰을 켠다.
    sessionActions: [
      {
        id: "stella:phone:open",
        title: "스텔라 폰",
        icon: "smartphone",
        run: async () => {
          await plugin.openStellaPhone();
        },
      },
    ],
    async contributeContext({ session, leafId }) {
      const phone = plugin.data.phone;
      // 문자/SNS 연동은 별개 토글 — 둘 다 꺼져 있으면 기여 없음.
      const textOn = phone?.enabled !== false;
      const snsOn = phone?.snsEnabled !== false;
      if (!textOn && !snsOn) return [];
      const personaFile = session.meta.personaFile;
      if (!personaFile) return [];
      const persona = await plugin.store.getUserProfile(personaFile);
      if (!persona) return [];

      const scenarios = await plugin.store
        .getScenarios()
        .catch((): Awaited<ReturnType<typeof plugin.store.getScenarios>> => []);
      const charName =
        scenarios
          .find(
            (i) =>
              i.scenario.data?.extensions?.stella?.id === session.meta.scenarioId
          )
          ?.scenario.data?.name?.trim() || "Character";
      const userName = persona.name?.trim() || "User";
      const parts: string[] = [];

      // ── 문자 기억 (PH1) — 이 페르소나 × 이 캐릭터의 최근 문자. ──
      const data = textOn
        ? await plugin.store.getPhoneMessages(persona.id)
        : null;
      const thread = data?.threads.find(
        (t) => t.kind === "scenario" && t.scenarioId === session.meta.scenarioId
      );
      if (thread && thread.messages.length > 0) {
        // 미배달 문자(deliverAt 미래, v2 시간차 배달)는 아직 "일어나지 않은"
        // 문자 — 세션 기억에서 제외.
        const delivered = thread.messages.filter(
          (m) => !m.deliverAt || m.deliverAt <= Date.now()
        );
        const recent = delivered.slice(-INJECT_MESSAGE_LIMIT);
        const lines = recent.map((m) => {
          const photo = m.image ? ` [photo: ${m.image.caption || "attached photo"}]` : "";
          return `${m.from === "persona" ? userName : charName}: ${m.text}${photo}`;
        });
        if (lines.length > 0) {
          parts.push(
            `[Recent text messages ${charName} and ${userName} exchanged on their ` +
              `phones — both remember this conversation, but anything not written ` +
              `here was never communicated by text:]\n` +
              lines.join("\n")
          );
        }
      }

      // ── SNS 기억 (PH3) — 직접 작성/답글 = 100%, 나머지는 확률적(결정적
      // 샘플 — 같은 leaf 면 미리보기와 생성이 byte 동일해야 하므로 Math.random
      // 대신 post.id+leafId 해시를 쓴다). ──
      const feed = snsOn
        ? await plugin.store.getSnsFeed().catch(() => null)
        : null;
      if (feed && feed.posts.length > 0) {
        const isChar = (a: SnsAuthor) =>
          (a.kind === "character" || a.kind === "scenario") &&
          a.id === session.meta.scenarioId;
        const involved = (p: SnsPost) =>
          isChar(p.author) || p.replies.some((r) => isChar(r.author));
        const recentPosts = feed.posts.slice(-20);
        const chosen = recentPosts.filter(
          (p) =>
            involved(p) ||
            hashRatio(`${p.id}:${leafId}`) < SNS_BROWSE_CHANCE
        );
        const picked = chosen.slice(-SNS_INJECT_LIMIT);
        if (picked.length > 0) {
          const lines = picked.map((p) => {
            const replies = p.replies
              .slice(-3)
              .map((r) => `    ↳ ${r.author.name}: ${r.text}`)
              .join("\n");
            const photo = p.image ? ` [attached photo: ${p.image.caption}]` : "";
            return `- ${p.author.name}: ${p.text}${photo}${replies ? `\n${replies}` : ""}`;
          });
          parts.push(
            `[Posts on the shared social feed that ${charName} has seen ` +
              `recently — ${charName} clearly remembers the ones they wrote or ` +
              `replied to, and vaguely remembers merely scrolling past the rest:]\n` +
            lines.join("\n")
          );
        }
      }

      if (parts.length === 0) return [];
      return [{ slot: "phone", text: parts.join("\n\n") }];
    },

    // 키워드 트리거 (PH2) + 방송 자동 감지 (PH4).
    // refresh 가 게이트(트리거 켜짐/스로틀/상한)를 전부 판정하므로 여기선 매칭만.
    async onGenerationComplete({ sessionFile, generatedText }) {
      const phone = plugin.data.phone;
      // 방송 자동 감지 (키워드 경로) — 생성문에 방송 정황이 보이면 생중계 시작.
      if (
        phone?.streamAutoDetect === true &&
        !plugin.phone.isSessionLive(sessionFile) &&
        matchesStreamKeywords(generatedText)
      ) {
        const result = await plugin.phone.startStream(sessionFile);
        // "이미 진행 중인 방송" 등은 조용히 넘어간다 (자동 경로).
        if (!result.ok) console.debug("[GGAI Stella] 방송 자동 시작 보류:", result.error);
      }
      // 스텔라튜브 노드 반응 (v2 §7.3) — 이 세션이 방송 중이면 새 노드마다
      // 시청자 채팅 배치. 세션 생성 흐름을 막지 않게 백그라운드로.
      if (plugin.phone.isSessionLive(sessionFile)) {
        void plugin.phone
          .onSessionNodeGenerated(sessionFile)
          .catch((err) =>
            console.warn("[GGAI Stella] 스텔라튜브 반응 실패:", err)
          );
      }
      const t = phone?.triggers;
      if (t?.keyword !== true) return;
      if (!matchesPhoneKeywords(generatedText, t.customKeywords)) return;
      await plugin.phone.refresh("keyword");
    },
  });

  plugin.registerSettingsPanel(createPhoneSettingsPanel());
}

/**
 * SNS 참가 시나리오 픽커 (v2, 사용자 결정) — 체크 해제 = 그 시나리오를 SNS 의
 * **인물(계정)로 등장시키지 않는다** (확정 참가·로스터·작성자 귀속 제외).
 * 세션 장면 재료와는 별개 축 — 그 시나리오에서 플레이한 세션 내용은 여전히
 * 피드의 사건 재료로 들어간다. 저장은 제외 목록(`snsExcludedScenarioIds`),
 * 새 시나리오는 자동 참가(기본 전체 참가).
 */
function renderSnsParticipantsPicker(
  plugin: StellaEnginePlugin,
  parent: HTMLElement,
  phone: PhonePluginData,
  patch: (p: Partial<PhonePluginData>) => Promise<void>
): void {
  const block = parent.createDiv({ cls: "ggai-media-block" });
  block.createDiv({ cls: "ggai-media-label", text: "SNS 참가 시나리오" });
  const btn = block.createEl("button", {
    cls: "ggai-preset-btn ggai-media-lorebook-btn",
    text: "전체 참가",
  });
  const excluded = phone.snsExcludedScenarioIds ?? [];
  const applyCount = (excludedCount: number) => {
    btn.setText(excludedCount > 0 ? `${excludedCount}개 제외됨` : "전체 참가");
    btn.toggleClass("is-active", excludedCount > 0);
  };
  const loadCandidateIds = async () => {
    const list = await plugin.store.getScenarios().catch(() => []);
    return list
      .map((i) => i.scenario.data?.extensions?.stella?.id)
      .filter((id): id is string => !!id);
  };
  // 삭제된 시나리오의 잔여 제외 id 는 세지 않는다 (로어북 픽커와 같은 이유).
  applyCount(excluded.length);
  void loadCandidateIds().then((ids) => {
    const existing = new Set(ids);
    applyCount(excluded.filter((id) => existing.has(id)).length);
  });
  btn.addEventListener("click", () => {
    void (async () => {
      const candidates = await loadCandidateIds();
      const excludedSet = new Set(phone.snsExcludedScenarioIds ?? []);
      const selected = candidates.filter((id) => !excludedSet.has(id));
      const result = await ScenarioSelectModal.open(plugin, selected, {
        title: "SNS 참가 시나리오 (체크 해제 = 제외)",
      });
      if (!result) return;
      const picked = new Set(result);
      await patch({
        snsExcludedScenarioIds: candidates.filter((id) => !picked.has(id)),
      });
    })();
  });
}

function createPhoneSettingsPanel(): SettingsPanel {
  return {
    id: "stella:phone",
    title: "스텔라 폰 (개발중)",
    order: 4,
    render(body, ctx) {
      const { plugin } = ctx;
      const phone = plugin.data.phone ?? {};
      const patch = async (p: Partial<PhonePluginData>) => {
        await plugin.savePluginData({
          phone: { ...(plugin.data.phone ?? {}), ...p },
        });
        ctx.rerender();
      };

      // 카테고리 소제목 — 필드 라벨과 구분되게 상단 구분선 + 굵은 제목.
      let firstSection = true;
      const section = (title: string) => {
        const el = body.createDiv({ cls: "ggai-phone-subhead", text: title });
        if (firstSection) el.addClass("is-first");
        firstSection = false;
      };

      // ── 기본 — 폰 전체가 쓰는 AI 모델과 언어. ──
      section("기본");
      renderMediaModelPicker({
        plugin,
        parent: body,
        label: "글 생성 모델 (문자·SNS·방송 공용)",
        profiles: plugin.ai
          .listGenerationProfiles()
          .filter((p) => p.kind === "chat"),
        activeId: phone.modelProfileId,
        onSelect: (modelProfileId) => void patch({ modelProfileId }),
        emptyText: "Core 챗 모델이 없습니다.",
      });
      renderMediaModelPicker({
        plugin,
        parent: body,
        label: "사진 생성 모델 (문자 사진·SNS 사진)",
        profiles: plugin.ai.listImageProfiles(),
        activeId: phone.imageProfileId,
        onSelect: (imageProfileId) => void patch({ imageProfileId }),
        emptyText: "Core 이미지 프로필이 없습니다 (SNS 사진은 캡션으로만 표시).",
      });
      renderTextRow({
        parent: body,
        label: "생성 언어 (비우면 자동)",
        value: phone.language ?? "",
        placeholder: "예: 한국어",
        onChange: (language) => void patch({ language }),
      });

      // ── 문자 — 프롬프트 + 답장에 붙일 재료 분량 (문자 전용). ──
      section("문자");
      renderMediaPromptPicker({
        plugin,
        parent: body,
        label: "캐릭터 문자 프롬프트 (답장·먼저 연락)",
        bucket: "phoneText",
        activeId: phone.textPromptId,
        onSelect: (textPromptId) => void patch({ textPromptId }),
        onChanged: () => ctx.rerender(),
        onDeleted: () => void patch({ textPromptId: undefined }),
      });
      renderMediaPromptPicker({
        plugin,
        parent: body,
        label: "모르는 번호 프롬프트 (스팸·엑스트라)",
        bucket: "phoneExtra",
        activeId: phone.extraPromptId,
        onSelect: (extraPromptId) => void patch({ extraPromptId }),
        onChanged: () => ctx.rerender(),
        onDeleted: () => void patch({ extraPromptId: undefined }),
      });
      renderNumberRow({
        parent: body,
        label: "답장 시 기억하는 과거 문자 (통)",
        value: phone.replyHistoryLimit ?? 60,
        fallback: 60,
        min: 1,
        integer: true,
        onChange: (replyHistoryLimit) => void patch({ replyHistoryLimit }),
      });
      renderNumberRow({
        parent: body,
        label: "답장 시 참고할 세션 장면 (토큰)",
        value: phone.sessionTailTokens ?? 2000,
        fallback: 2000,
        min: 100,
        integer: true,
        onChange: (sessionTailTokens) => void patch({ sessionTailTokens }),
      });
      renderNumberRow({
        parent: body,
        label: "답장 없는 문자가 이만큼 쌓이면 먼저 연락 안 함 (0=제한 없음)",
        value: phone.maxUnanswered ?? 2,
        fallback: 2,
        min: 0,
        integer: true,
        onChange: (maxUnanswered) => void patch({ maxUnanswered }),
      });
      renderNumberRow({
        parent: body,
        label: "답장 도착까지 최대 지연 (분, 0=바로 도착)",
        value: phone.maxReplyDelayMinutes ?? 10,
        fallback: 10,
        min: 0,
        integer: true,
        onChange: (maxReplyDelayMinutes) => void patch({ maxReplyDelayMinutes }),
      });

      // ── SNS — 프롬프트 + 참가 재료 분량 + 갱신 활동 상한 (SNS 전용). ──
      section("SNS (스텔라 네트워크)");
      renderMediaPromptPicker({
        plugin,
        parent: body,
        label: "게시글·댓글 프롬프트",
        bucket: "phoneSns",
        activeId: phone.snsPromptId,
        onSelect: (snsPromptId) => void patch({ snsPromptId }),
        onChanged: () => ctx.rerender(),
        onDeleted: () => void patch({ snsPromptId: undefined }),
      });
      renderEnableToggle({
        parent: body,
        label: "캐릭터가 사진 올리는 것 허용",
        checked: phone.snsPhotoEnabled !== false,
        onChange: (snsPhotoEnabled) => void patch({ snsPhotoEnabled }),
      });
      renderSnsParticipantsPicker(plugin, body, phone, patch);
      renderNumberRow({
        parent: body,
        label: "갱신마다 활동할 인물 수",
        value: phone.snsConfirmedCount ?? 3,
        fallback: 3,
        min: 1,
        integer: true,
        onChange: (snsConfirmedCount) => void patch({ snsConfirmedCount }),
      });
      renderNumberRow({
        parent: body,
        label: "인물당 참고할 세션 요약 (토큰)",
        value: phone.snsSummaryTokens ?? 2000,
        fallback: 2000,
        min: 0,
        integer: true,
        onChange: (snsSummaryTokens) => void patch({ snsSummaryTokens }),
      });
      renderNumberRow({
        parent: body,
        label: "인물당 참고할 세션 본문 (토큰)",
        value: phone.snsBodyTokens ?? 2000,
        fallback: 2000,
        min: 100,
        integer: true,
        onChange: (snsBodyTokens) => void patch({ snsBodyTokens }),
      });
      renderEnableToggle({
        parent: body,
        label: "세션 본문의 로어북도 참고",
        checked: phone.snsIncludeLore !== false,
        onChange: (snsIncludeLore) => void patch({ snsIncludeLore }),
      });
      renderEnableToggle({
        parent: body,
        label: "다른 세션 2개 랜덤 추가 참고 (분량 절반)",
        checked: phone.snsRandomSessions === true,
        onChange: (snsRandomSessions) => void patch({ snsRandomSessions }),
      });
      renderNumberRow({
        parent: body,
        label: "갱신당 글+댓글 최대 (0=SNS 자동 갱신 끔)",
        value: phone.snsPerRefresh ?? 10,
        fallback: 10,
        min: 0,
        integer: true,
        onChange: (snsPerRefresh) => void patch({ snsPerRefresh }),
      });
      renderNumberRow({
        parent: body,
        label: "갱신당 새 게시글 최소",
        value: phone.snsMinNewPosts ?? 2,
        fallback: 2,
        min: 0,
        integer: true,
        onChange: (snsMinNewPosts) => void patch({ snsMinNewPosts }),
      });
      renderNumberRow({
        parent: body,
        label: "갱신당 새 인물 등장 최대 (명)",
        value: phone.snsNewAccountCap ?? 3,
        fallback: 3,
        min: 0,
        integer: true,
        onChange: (snsNewAccountCap) => void patch({ snsNewAccountCap }),
      });

      // ── 스텔라튜브 (v2 §7) — 세션 장면 생중계 + 실시간 채팅. ──
      section("방송 (스텔라튜브)");
      renderEnableToggle({
        parent: body,
        label: "방송 기능 사용 (생중계·시청자 채팅)",
        checked: phone.tubeEnabled !== false,
        onChange: (tubeEnabled) => void patch({ tubeEnabled }),
      });
      if (phone.tubeEnabled !== false) {
        renderEnableToggle({
          parent: body,
          label: "세션에 방송 장면이 나오면 자동으로 방송 시작",
          checked: phone.streamAutoDetect === true,
          onChange: (streamAutoDetect) => void patch({ streamAutoDetect }),
        });
        renderMediaPromptPicker({
          plugin,
          parent: body,
          label: "시청자 채팅 프롬프트",
          bucket: "phoneTube",
          activeId: phone.tubePromptId,
          onSelect: (tubePromptId) => void patch({ tubePromptId }),
          onChanged: () => ctx.rerender(),
          onDeleted: () => void patch({ tubePromptId: undefined }),
        });
      }

      // ── 폰 안 번역 (PH5) — 세션 번역 설정과 독립 (모델/프롬프트는 번역 탭 재사용). ──
      section("번역 (폰 화면)");
      const translation = phone.translation ?? {};
      const patchTranslation = (
        p: Partial<NonNullable<PhonePluginData["translation"]>>
      ) => patch({ translation: { ...translation, ...p } });
      renderEnableToggle({
        parent: body,
        label: "폰 화면 번역 사용",
        checked: translation.enabled !== false,
        onChange: (enabled) => void patchTranslation({ enabled }),
      });
      if (translation.enabled !== false) {
        renderEnableToggle({
          parent: body,
          label: "문자·SNS 생성되면 자동 번역",
          checked: translation.auto === true,
          onChange: (auto) => void patchTranslation({ auto }),
        });
        renderMediaLorebookPicker({
          plugin,
          parent: body,
          label: "번역 로어북 (폰 전용)",
          selectedIds: translation.lorebookIds ?? [],
          onToggle: (lorebookIds) => void patchTranslation({ lorebookIds }),
        });
      }

      // ── 갱신 타이밍 (PH2) — 캐릭터/엑스트라가 먼저 문자·SNS를 갱신하는 타이밍(공용). ──
      section("자동 갱신 (캐릭터가 먼저 문자·SNS 활동하는 때)");
      const triggers = phone.triggers ?? {};
      const patchTriggers = (p: Partial<PhoneTriggerSettings>) =>
        patch({ triggers: { ...triggers, ...p } });

      renderEnableToggle({
        parent: body,
        label: "폰을 켰을 때",
        checked: triggers.onOpen !== false,
        onChange: (onOpen) => void patchTriggers({ onOpen }),
      });
      renderEnableToggle({
        parent: body,
        label: "세션 플레이 중 랜덤 (5~30분)",
        checked: triggers.randomInSession === true,
        onChange: (randomInSession) => void patchTriggers({ randomInSession }),
      });
      renderEnableToggle({
        parent: body,
        label: "일정 간격마다 (옵시디언 켜져 있는 동안)",
        checked: triggers.periodic === true,
        onChange: (periodic) => void patchTriggers({ periodic }),
      });
      if (triggers.periodic === true) {
        renderNumberRow({
          parent: body,
          label: "간격 (분)",
          value: triggers.periodicMinutes ?? 60,
          fallback: 60,
          min: 5,
          integer: true,
          onChange: (periodicMinutes) => void patchTriggers({ periodicMinutes }),
        });
      }
      renderEnableToggle({
        parent: body,
        label: "세션에 폰 관련 키워드가 나왔을 때",
        checked: triggers.keyword === true,
        onChange: (keyword) => void patchTriggers({ keyword }),
      });
      if (triggers.keyword === true) {
        renderTextRow({
          parent: body,
          label: "추가 키워드",
          value: (triggers.customKeywords ?? []).join(", "),
          placeholder: "쉼표로 구분 (기본: 폰/문자/카메라… 한·영·일)",
          onChange: (raw) =>
            void patchTriggers({
              customKeywords: raw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            }),
        });
      }

      // ── 세션 연동 — 폰에서 있었던 일을 세션 속 캐릭터가 기억할지. ──
      section("세션 연동 (폰 내용을 캐릭터 기억에)");
      renderEnableToggle({
        parent: body,
        label: "문자 내용을 세션에 반영",
        checked: phone.enabled !== false,
        onChange: (enabled) => void patch({ enabled }),
      });
      renderEnableToggle({
        parent: body,
        label: "SNS 내용을 세션에 반영",
        checked: phone.snsEnabled !== false,
        onChange: (snsEnabled) => void patch({ snsEnabled }),
      });
    },
  };
}
