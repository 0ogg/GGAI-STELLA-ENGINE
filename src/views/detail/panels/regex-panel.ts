import { setIcon } from "obsidian";
import type { SettingsPanel, SettingsPanelContext } from "../../../services/settings-panel-registry";
import type { StellaScenario } from "../../../types/scenario";
import type { RegexExtensionTarget, RegexScript } from "../../../types/regex";
import { createBlankRegexScript, REGEX_PLACEMENT, timingOf } from "../../../types/regex";
import { readScenarioRegexScripts, writeScenarioRegexScripts } from "../../../util/regex-scripts";
import { scenarioFileOfSessionFile } from "../../../util/build-session-context";
import { uuidv4 } from "../../../util/uuid";
import { RegexEditModal } from "../../regex-edit-modal";

/** 목록 종류 — full = 본문(대상/시점 있음), post = 확장 후가공(받자마자 무조건 적용). */
type ListMode = "full" | "post";

/** 확장 후가공 섹션 정의 — 새 확장 대상이 생기면 여기에 한 줄 추가. */
const EXTENSION_SECTIONS: { target: RegexExtensionTarget; title: string; hint: string }[] = [
  {
    target: "translation",
    title: "번역문 후가공",
    hint: "받은 번역문을 저장/표시 전에 가공합니다.",
  },
  {
    target: "illustration",
    title: "삽화 프롬프트 후가공",
    hint: "AI가 만든 삽화 프롬프트를 이미지 생성 전에 가공합니다.",
  },
];

/**
 * 정규식 치환 설정 — 확장 탭 내장 패널. 전역(모든 세션 공통) 목록 + 확장별
 * "받은 결과 후가공" 목록 + 현재 시나리오 전용 목록(카드 `extensions.regex_scripts`,
 * ST 라운드트립)을 관리한다. 시나리오 전용 스크립트는 사용자가 "실행 허용"을 켠
 * 시나리오에서만 돈다(임포트한 카드에 심긴 치환 무단 실행 방지 — ST 동일).
 */
export function createRegexSettingsPanel(): SettingsPanel {
  // 비동기(시나리오 로드) 결과가 옛 렌더에 꽂히지 않게 하는 카운터 (확장 패널 스펙.md).
  let renderSeq = 0;
  return {
    id: "stella:regex",
    title: "정규식 치환",
    order: 3, // 번역(0)/삽화(1)/요약(2) 다음.
    render(body, ctx) {
      const { plugin } = ctx;

      // ── 전역 스크립트 (모든 세션 공통) ──
      const globalSection = body.createDiv({ cls: "ggai-regex-section" });
      globalSection.createDiv({
        cls: "ggai-regex-section-title",
        text: "모든 세션 공통",
      });
      const globalScripts = plugin.data.regexScripts ?? [];
      const saveGlobal = async (scripts: RegexScript[]) => {
        await plugin.savePluginData({ regexScripts: scripts });
        ctx.rerender();
      };
      renderScriptList(globalSection, ctx, globalScripts, saveGlobal, "full");

      // ── 확장별 후가공 (받은 결과를 받자마자 가공) ──
      for (const def of EXTENSION_SECTIONS) {
        const section = body.createDiv({ cls: "ggai-regex-section" });
        section.createDiv({ cls: "ggai-regex-section-title", text: def.title });
        section.createDiv({ cls: "ggai-regex-section-hint", text: def.hint });
        const scripts = plugin.data.extensionRegex?.[def.target] ?? [];
        const savePost = async (next: RegexScript[]) => {
          await plugin.savePluginData({
            extensionRegex: { ...plugin.data.extensionRegex, [def.target]: next },
          });
          ctx.rerender();
        };
        renderScriptList(section, ctx, scripts, savePost, "post");
      }

      // ── 시나리오 전용 스크립트 (비동기 로드) ──
      const scopedSection = body.createDiv({ cls: "ggai-regex-section" });
      const seq = ++renderSeq;
      void (async () => {
        const scenarioFile = ctx.activeSessionFile
          ? scenarioFileOfSessionFile(ctx.activeSessionFile)
          : null;
        if (!scenarioFile) return;
        const scenarios = await plugin.store.getScenarios();
        if (seq !== renderSeq || !scopedSection.isConnected) return;
        const item = scenarios.find((i) => i.scenarioFile === scenarioFile);
        if (!item) return;
        renderScopedSection(scopedSection, ctx, scenarioFile, item.scenario);
      })();
    },
  };
}

/** 시나리오 전용 영역 — 실행 허용 토글 + 목록. */
function renderScopedSection(
  section: HTMLElement,
  ctx: SettingsPanelContext,
  scenarioFile: string,
  scenario: StellaScenario
): void {
  const { plugin } = ctx;
  const stellaId = scenario.data?.extensions?.stella?.id;
  const scenarioName = scenario.data?.name?.trim() || "이 시나리오";
  section.createDiv({
    cls: "ggai-regex-section-title",
    text: `${scenarioName} 전용`,
  });

  // 실행 허용 토글 — 꺼져 있으면 아래 스크립트가 있어도 돌지 않는다.
  if (stellaId) {
    const allowed = (plugin.data.regexScriptsAllowedScenarios ?? []).includes(stellaId);
    const row = section.createEl("label", { cls: "ggai-regex-check ggai-regex-allow" });
    const cb = row.createEl("input", { type: "checkbox" });
    cb.checked = allowed;
    cb.addEventListener("change", () => {
      const rest = (plugin.data.regexScriptsAllowedScenarios ?? []).filter(
        (id) => id !== stellaId
      );
      void plugin
        .savePluginData({
          regexScriptsAllowedScenarios: cb.checked ? [...rest, stellaId] : rest,
        })
        .then(() => ctx.rerender());
    });
    row.createEl("span", { text: "이 시나리오의 정규식 실행 허용" });
  }

  const scripts = readScenarioRegexScripts(scenario);
  const saveScoped = async (next: RegexScript[]) => {
    // 저장 직전에 최신 시나리오를 다시 읽어 다른 필드 변경을 덮어쓰지 않는다.
    const scenarios = await plugin.store.getScenarios();
    const fresh = scenarios.find((i) => i.scenarioFile === scenarioFile);
    if (!fresh) return;
    writeScenarioRegexScripts(fresh.scenario, next);
    await plugin.store.saveScenario(scenarioFile, fresh.scenario);
    ctx.rerender();
  };
  renderScriptList(section, ctx, scripts, saveScoped, "full");
}

/** 스크립트 목록 + [정규식 추가] — 전역/후가공/시나리오 공용. */
function renderScriptList(
  parent: HTMLElement,
  ctx: SettingsPanelContext,
  scripts: RegexScript[],
  save: (next: RegexScript[]) => Promise<void>,
  mode: ListMode
): void {
  const list = parent.createDiv({ cls: "ggai-regex-list" });
  if (scripts.length === 0) {
    list.createDiv({ cls: "ggai-regex-empty", text: "등록된 정규식이 없습니다." });
  }
  scripts.forEach((script, index) => {
    const row = list.createDiv({ cls: "ggai-regex-row" });

    const toggle = row.createEl("input", {
      cls: "ggai-form-checkbox",
      type: "checkbox",
      attr: { "aria-label": "켜기/끄기" },
    });
    toggle.checked = !script.disabled;
    toggle.addEventListener("change", () => {
      const next = scripts.map((s, i) =>
        i === index ? { ...s, disabled: !toggle.checked } : s
      );
      void save(next);
    });

    const info = row.createDiv({ cls: "ggai-regex-row-info" });
    info.createDiv({
      cls: "ggai-regex-row-name",
      text: script.scriptName || "(이름 없음)",
    });
    info.createDiv({ cls: "ggai-regex-row-meta", text: describeScript(script, mode) });
    info.addEventListener("click", () => openEditor(ctx, scripts, index, save, mode));

    const editBtn = row.createEl("button", {
      cls: "ggai-btn ggai-regex-row-btn",
      attr: { "aria-label": "편집" },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", () => openEditor(ctx, scripts, index, save, mode));

    const delBtn = row.createEl("button", {
      cls: "ggai-btn ggai-regex-row-btn",
      attr: { "aria-label": "삭제" },
    });
    setIcon(delBtn, "trash-2");
    delBtn.addEventListener("click", () => {
      void save(scripts.filter((_, i) => i !== index));
    });
  });

  const addBtn = parent.createEl("button", { cls: "ggai-btn ggai-regex-add" });
  setIcon(addBtn.createSpan(), "plus");
  addBtn.createSpan({ text: "정규식 추가" });
  addBtn.addEventListener("click", () => openEditor(ctx, scripts, -1, save, mode));
}

/** index >= 0 이면 그 스크립트 편집, -1 이면 새로 추가. */
function openEditor(
  ctx: SettingsPanelContext,
  scripts: RegexScript[],
  index: number,
  save: (next: RegexScript[]) => Promise<void>,
  mode: ListMode
): void {
  const target = index >= 0 ? scripts[index] : createBlankRegexScript(uuidv4());
  new RegexEditModal(
    ctx.plugin.app,
    target,
    async (edited) => {
      const next =
        index >= 0
          ? scripts.map((s, i) => (i === index ? edited : s))
          : [...scripts, edited];
      await save(next);
    },
    mode
  ).open();
}

/** 목록 한 줄 요약 — 본문은 대상 · 적용 시점, 후가공은 찾을 정규식 미리보기. */
function describeScript(script: RegexScript, mode: ListMode): string {
  if (mode === "post") return script.findRegex || "(찾을 정규식 없음)";
  const targets: string[] = [];
  if (script.placement.includes(REGEX_PLACEMENT.AI_OUTPUT)) targets.push("AI 응답");
  if (script.placement.includes(REGEX_PLACEMENT.USER_INPUT)) targets.push("내 입력");
  if (targets.length === 0) targets.push("기타");
  const timing = { prompt: "전송본", raw: "저장 원문", display: "표시" }[timingOf(script)];
  return `${targets.join("+")} · ${timing}`;
}
