/**
 * 반복 표현 설정 패널 — 무엇을 반복으로 볼지, 어떻게 말해줄지를 사람이 정한다.
 * (설계는 `반복 표현 감지 스펙.md` §5)
 *
 * 값은 전역(모든 세션 공통) `PluginData.repetition` 한 곳에 산다 — 세션 스키마를
 * 건드리지 않는 게 이 확장의 롤백 경계다.
 *
 * 재렌더 규칙 — 입력칸은 change(blur) 시점에만 저장하고 다시 그리지 않는다.
 * 버튼 선택(집계 단위)만 표시 갱신을 위해 재렌더한다(회귀금지: 입력 중 재렌더).
 */

import type { SettingsPanel } from "../../../services/settings-panel-registry";
import {
  REPETITION_DEFAULTS,
  REPETITION_LIST_MACRO,
  normalizeRepetitionSettings,
  type RepetitionSettings,
  type RepetitionUnit,
} from "../../../util/repetition";
import {
  renderNumberRow,
  renderOptionGrid,
  renderTextAreaRow,
  renderTextRow,
} from "../setting-controls";

export function createRepetitionSettingsPanel(): SettingsPanel {
  return {
    id: "stella:repetition",
    title: "반복 표현",
    order: 7, // 변수(6) 뒤.
    render(body, ctx) {
      const settings = normalizeRepetitionSettings(ctx.plugin.data.repetition);
      const save = (patch: Partial<RepetitionSettings>): Promise<void> =>
        ctx.plugin.savePluginData({ repetition: { ...settings, ...patch } });

      body.createDiv({
        cls: "ggai-regex-section-hint",
        text:
          "최근 진행분에서 AI가 되풀이한 표현을 세어, 다음 생성 때 \"이건 다르게 써 달라\"고 알려줍니다. " +
          "AI를 따로 부르지 않으니 생성이 느려지지 않습니다. 사용자가 직접 쓴 문장은 세지 않습니다.",
      });

      renderNumberRow({
        parent: body,
        label: "감시 범위 (최근 노드)",
        value: settings.windowNodes,
        fallback: REPETITION_DEFAULTS.windowNodes,
        min: 1,
        max: 500,
        integer: true,
        onChange: (v) => void save({ windowNodes: v }),
      });

      renderOptionGrid<RepetitionUnit>({
        parent: body,
        label: "집계 단위",
        options: [
          { id: "auto", label: "자동" },
          { id: "word", label: "단어 단위" },
          { id: "char", label: "글자 단위" },
        ],
        activeId: settings.unit,
        onSelect: (id) => void save({ unit: id }).then(() => ctx.rerender()),
      });
      body.createDiv({
        cls: "ggai-regex-section-hint",
        text:
          "자동이면 띄어쓰기가 있는 언어(영어·한국어 등)는 단어 단위로, " +
          "띄어쓰기 없이 이어 쓰는 언어(중국어·일본어 등)는 글자 단위로 셉니다.",
      });

      renderNumberRow({
        parent: body,
        label: "최소 반복 횟수",
        value: settings.minCount,
        fallback: REPETITION_DEFAULTS.minCount,
        min: 2,
        max: 50,
        integer: true,
        onChange: (v) => void save({ minCount: v }),
      });

      renderNumberRow({
        parent: body,
        label: "목록 최대 개수",
        value: settings.maxItems,
        fallback: REPETITION_DEFAULTS.maxItems,
        min: 1,
        max: 100,
        integer: true,
        onChange: (v) => void save({ maxItems: v }),
      });

      renderNumberRow({
        parent: body,
        label: "흔한 표현 무시 강도 (%)",
        value: settings.commonRatio,
        fallback: REPETITION_DEFAULTS.commonRatio,
        min: 0,
        max: 90,
        integer: true,
        onChange: (v) => void save({ commonRatio: v }),
      });
      body.createDiv({
        cls: "ggai-regex-section-hint",
        text:
          "그 세션에서 가장 자주 나온 낱말 상위 몇 %를 \"흔한 말\"로 보고 목록에서 빼는지입니다. " +
          "the·그녀는 같은 게 목록을 채우면 올리고, 쓸 만한 표현까지 빠지면 내리세요.",
      });

      renderTextAreaRow({
        parent: body,
        label: "지시문",
        value: settings.template,
        rows: 5,
        hint: `${REPETITION_LIST_MACRO} 자리에 걸린 표현 목록이 들어갑니다. 원고 언어에 맞게 고쳐 쓰세요.`,
        onChange: (v) => void save({ template: v }),
      });

      renderTextRow({
        parent: body,
        label: "제외 단어",
        value: settings.excludes.join(", "),
        placeholder: "쉼표로 구분",
        onChange: (v) =>
          void save({
            excludes: v
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          }),
      });
      body.createDiv({
        cls: "ggai-regex-section-hint",
        text: "캐릭터·페르소나·그룹 멤버 이름은 적지 않아도 자동으로 빠집니다.",
      });

      // 지금 무엇이 걸렸는지는 전송본 미리보기에 그대로 보인다(별도 표시 UI 없음 — 스펙 §6).
      body.createDiv({
        cls: "ggai-regex-section-hint",
        text: "지금 무엇이 걸렸는지는 세션창의 \"현재 컨텍스트 확인\"에서 그대로 볼 수 있습니다.",
      });
    },
  };
}
