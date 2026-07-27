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
} from "../types/phone";
import { sawSnsPost } from "../util/phone-knows";
import type { SettingsPanel } from "../services/settings-panel-registry";
import { renderPhoneCommonSettings } from "../views/phone-settings-sections";

/** 기억 주입에 넣는 최근 문자 수 (스레드 끝에서부터). */
const INJECT_MESSAGE_LIMIT = 12;
/** 기억 주입에 넣는 SNS 게시글 상한. */
const SNS_INJECT_LIMIT = 5;

export function registerPhoneExtension(plugin: StellaEnginePlugin): () => void {
  const disposeExt = plugin.extensions.register({
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
    async contributeContext({ session }) {
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
        // 시간차 배달 폐지(2026-07-27) — 저장된 문자는 곧 도착한 문자다.
        const recent = thread.messages.slice(-INJECT_MESSAGE_LIMIT);
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

      // ── SNS 기억 (PH3 + v2 §8.2) — 직접 작성/답글 = 100%, 나머지는 이슈
      // 등급별 확률로 "봤는지" 판정(결정적 해시 — Math.random 이면 미리보기·생성
      // byte 동일 대전제가 깨진다). 캐릭터(scenarioId) 기준이라 재생성해도 같은
      // 글은 봤거나 못 봤거나 일관된다. ──
      const feed = snsOn
        ? await plugin.store.getSnsFeed().catch(() => null)
        : null;
      if (feed && feed.posts.length > 0) {
        const scenarioId = session.meta.scenarioId;
        const recentPosts = feed.posts.slice(-20);
        const chosen = recentPosts.filter((p) => sawSnsPost(p, scenarioId));
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
      await runPhoneTextTriggers(plugin, sessionFile, generatedText);
      // 스텔라튜브 노드 반응 (v2 §7.3) — 이 세션이 방송 중이면 새 노드마다
      // 시청자 채팅 배치. 세션 생성 흐름을 막지 않게 백그라운드로.
      if (plugin.phone.isSessionLive(sessionFile)) {
        void plugin.phone
          .onSessionNodeGenerated(sessionFile)
          .catch((err) =>
            console.warn("[GGAI Stella] 스텔라튜브 반응 실패:", err)
          );
      }
    },

    // 사용자가 직접 쓴 전개도 같은 자격 — "내가 방송을 켰다"처럼 사용자 입력이
    // 상황을 만드는 경우가 오히려 흔하다. 방송 노드 반응은 여기서 돌리지 않는다
    // (반응 대상은 AI 생성 장면이고, 사용자 발화 직후엔 곧 생성이 이어진다).
    async onUserText({ sessionFile, text }) {
      await runPhoneTextTriggers(plugin, sessionFile, text);
    },
  });

  const disposePanel = plugin.registerSettingsPanel(createPhoneSettingsPanel());
  return () => {
    disposeExt();
    disposePanel();
  };
}

/**
 * 새 이야기 텍스트(AI 생성 또는 사용자 입력)에 대한 폰 키워드 트리거.
 * 두 훅이 같은 판정을 쓰도록 한 곳에 둔다 — 사용자 입력이 배제되어 있던 것이
 * 방송 자동 시작이 안 걸리던 원인 중 하나였다.
 */
async function runPhoneTextTriggers(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  text: string
): Promise<void> {
  const phone = plugin.data.phone;
  // 방송 자동 감지 (키워드 경로) — 키워드는 **판정 요청 신호**일 뿐이다.
  // 실제 시작 여부와 스트리머(장면 속 인물)는 모델이 장면을 읽고 판정한다.
  if (
    phone?.streamAutoDetect === true &&
    !plugin.phone.isSessionLive(sessionFile) &&
    matchesStreamKeywords(text)
  ) {
    await plugin.phone
      .tryAutoStartStream(sessionFile)
      .catch((err) =>
        console.warn("[GGAI Stella] 방송 자동 시작 판정 실패:", err)
      );
  }
  const t = phone?.triggers;
  if (t?.keyword !== true) return;
  if (!matchesPhoneKeywords(text, t.customKeywords)) return;
  await plugin.phone.refresh("keyword");
}

function createPhoneSettingsPanel(): SettingsPanel {
  return {
    id: "stella:phone",
    title: "스텔라 폰 (개발중)",
    order: 4,
    render(body, ctx) {
      const { plugin } = ctx;
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

      // 앱 전용 세부 설정(문자·네트워크·방송)은 폰 홈의 "설정" 앱으로 옮겼다 —
      // 여기는 앱을 가리지 않는 공통 설정만 둔다(같은 렌더러를 공유).
      renderPhoneCommonSettings({
        plugin,
        parent: body,
        patch,
        rerender: () => ctx.rerender(),
        section,
      });

      body.createDiv({
        cls: "ggai-media-hint",
        text:
          "문자·스텔라 네트워크·방송의 세부 설정(프롬프트, 참고 분량, 활동 상한 등)은 " +
          "폰 홈 화면의 [설정] 앱에 있습니다. 여기 있는 공통 설정도 그 앱에서 함께 " +
          "볼 수 있습니다.",
      });
    },
  };
}
