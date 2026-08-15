/**
 * 이중 생성 설정 — 확장 탭 패널. (설계는 `이중 생성 스펙.md`)
 *
 * 무엇을 뽑을지는 전적으로 **프롬프트 세트**가 정한다. 그래서 이 패널은 지시문을
 * 직접 편집하지 않고 세트 선택 + 편집기 바로가기만 둔다 — 지시문을 코드나 패널에
 * 따로 두면 세트와 진실 소스가 갈린다.
 *
 * 예외가 하나: **1차 결과를 감쌀 틀**. 이건 1차에게 하는 말이 아니라 본 생성에게
 * 하는 말이라 세트에 넣을 자리가 없다. 그래서 여기 입력란이 소유하고, 코드는
 * 주입 시점에 아무 문구도 얹지 않는다(속마음 전용 확장이 아니다).
 */

import { Notice } from "obsidian";
import type {
  SettingsPanel,
  SettingsPanelContext,
} from "../../../services/settings-panel-registry";
import type { PregenActiveSettings, PregenPosition } from "../../../types/preset";
import {
  DEFAULT_PREGEN_INJECT_TEMPLATE,
  PREGEN_RESULT_MACRO,
  resolvePregenPromptSet,
} from "../../../util/pregen-prompt-preset";
import { renderMediaModelPicker } from "../media-prompt-panel";
import {
  renderEnableToggle,
  renderOptionGrid,
  renderPromptSetPicker,
  renderTextAreaRow,
} from "../setting-controls";

const POSITION_OPTIONS: Array<{ id: PregenPosition; label: string }> = [
  { id: "contextEnd", label: "컨텍스트 끝" },
  { id: "authorNote", label: "작가노트 위" },
  { id: "memory", label: "메모리 위" },
];

export function createPregenSettingsPanel(): SettingsPanel {
  // 렌더 간 경합 방지 — 비동기로 읽은 목록이 돌아왔을 때 이미 다시 그려졌으면 버린다.
  let renderToken = 0;

  return {
    id: "stella:pregen",
    title: "이중 생성 설정",
    order: 8, // 반복 표현(7) 뒤.
    render(body, ctx) {
      const { plugin, settings } = ctx;
      const pregen = settings.pregen ?? {};
      const token = ++renderToken;

      renderEnableToggle({
        parent: body,
        label: "이중 생성 사용",
        checked: pregen.enabled === true,
        onChange: (enabled) => void patchPregen(ctx, { enabled }),
        help:
          "본문을 쓰기 전에, 아래에서 고른 프롬프트 세트로 한 번 더 물어봅니다. " +
          "그 답을 문맥에 넣은 채로 본문을 쓰므로 생성이 두 번 나갑니다(시간·비용도 두 배). " +
          "무엇을 물어볼지는 그 프롬프트 세트가 정합니다.",
      });

      // 프롬프트 세트 — 목록은 비동기라 자리를 먼저 잡고 채운다.
      const setSlot = body.createDiv();
      void (async () => {
        const list = await plugin.store.getPromptPresets().catch(() => []);
        if (token !== renderToken || !setSlot.isConnected) return;
        renderPromptSetPicker({
          parent: setSlot,
          label: "프롬프트 세트",
          sets: list.map((item) => ({
            id: item.preset.meta.id,
            name: item.preset.meta.name,
          })),
          activeId: pregen.promptSetId,
          placeholder: "(고르지 않음 — 동작 안 함)",
          emptyText: "프롬프트 세트가 없습니다.",
          onSelect: (id) =>
            void patchPregen(ctx, { promptSetId: id || undefined }),
          onEdit: (id) => {
            const target = list.find((item) => item.preset.meta.id === id);
            if (!target) {
              new Notice("그 프롬프트 세트를 찾을 수 없습니다.");
              return;
            }
            void plugin.openStellaEditor("prompt", target.presetFile);
          },
        });
      })();

      renderMediaModelPicker({
        plugin,
        parent: body,
        label: "모델 (비우면 세션 모델)",
        profiles: plugin.ai.listGenerationProfiles(),
        activeId: pregen.modelProfileId,
        onSelect: (modelProfileId) => void patchPregen(ctx, { modelProfileId }),
        emptyText: "Core 텍스트 모델이 없습니다.",
      });

      renderOptionGrid<PregenPosition>({
        parent: body,
        label: "넣을 자리",
        options: POSITION_OPTIONS,
        activeId: pregen.position ?? "contextEnd",
        onSelect: (position) => void patchPregen(ctx, { position }),
      });
      body.createDiv({
        cls: "ggai-media-hint",
        text:
          "프롬프트 어딘가에 {{pregen}} 을 쓰면 이 설정 대신 그 자리에 들어갑니다.",
      });

      // 1차 결과를 어떻게 가공해서 넣을지는 **전부 이 칸이 정한다.** 코드는 문구를
      // 하나도 얹지 않는다 — 이 확장은 용도를 모르기 때문(속마음 전용이 아니다).
      renderTextAreaRow({
        parent: body,
        label: "넣을 때 감쌀 틀",
        value: pregen.injectTemplate ?? "",
        rows: 6,
        placeholder: `[이 아래는 참고 자료다.]\n${PREGEN_RESULT_MACRO}`,
        hint:
          `${PREGEN_RESULT_MACRO} 자리에 1차 결과가 들어갑니다. 비우면 결과만 그대로 들어갑니다. ` +
          "본 생성이 결과를 대사나 서술로 착각하지 않도록, 이게 무엇인지 여기에 적으세요.",
        onChange: (injectTemplate) => void patchPregen(ctx, { injectTemplate }),
      });

      // 「결과 확인 버튼 표시」 토글은 그 버튼(💭)을 만드는 단계에서 함께 넣는다 —
      // 지금 그리면 눌러도 아무 일이 없는 컨트롤이 된다. 값(showMarker)은 이미 있다.
    },
  };
}

async function patchPregen(
  ctx: SettingsPanelContext,
  patch: Partial<PregenActiveSettings>
): Promise<void> {
  let pregen = { ...(ctx.settings.pregen ?? {}), ...patch };
  // 켤 때 쓸 세트를 확정한다 — 고른 게 없거나, 골라 둔 세트가 **지워졌으면** 기본
  // 세트("속마음")를 찾거나 만들어 붙인다. 살아 있는 선택은 그대로 둔다.
  if (pregen.enabled) {
    const choice = await resolvePregenPromptSet(ctx.plugin, pregen.promptSetId);
    if (choice) {
      pregen = { ...pregen, promptSetId: choice.id };
      // 기본 세트로 떨어졌을 때만 그 세트에 맞는 틀을 **설정에 채워 넣는다** —
      // 코드가 주입 시점에 몰래 얹는 대신, 입력란에 글자로 들어가 눈에 보이고
      // 고칠 수 있게. 이미 값이 있으면(빈 문자열 포함) 건드리지 않는다.
      if (choice.builtinDefault && pregen.injectTemplate === undefined) {
        pregen = { ...pregen, injectTemplate: DEFAULT_PREGEN_INJECT_TEMPLATE };
      }
    }
  }
  await ctx.patchSettings({ pregen });
}
