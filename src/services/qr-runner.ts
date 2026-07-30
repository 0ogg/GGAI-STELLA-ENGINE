/**
 * 빠른 답장(QR) 스크립트 실행기 — 파서(`util/qr-script.ts`)가 만든 파이프라인을 돌린다.
 *
 * 범위(QR 스펙.md 슬라이스 2a): `/input` `/setvar` `/if` `/echo` `/abort` `/gen` `/comment`.
 * **모르는 커맨드는 조용히 건너뛰고 끝에 한 번만 안내한다** — 임포트한 세트가 지원 밖
 * 커맨드를 써도 버튼 전체가 죽지 않게.
 *
 * 상태:
 *  - 변수는 `session.meta.variables` — 이미 컨텍스트 빌더가 `{{getvar::x}}` 로 읽는 그 저장소다
 *    (QR 전용 변수 저장소를 새로 만들지 않는다).
 *  - `{{pipe}}` 는 직전 커맨드의 결과. `||` 로 끊긴 자리에서 비워진다.
 *
 * AI 호출은 전부 `plugin.ai` 경유, 저장은 전부 `plugin.store` 경유 (CLAUDE.md 6·7).
 */

import { Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { SessionNode } from "../types/session";
import { planSessionRequest } from "../util/build-session-context";
import { CHAT_MESSAGE_SEPARATOR } from "../util/chat-messages";
import { withoutOutputCap } from "../util/generation-params";
import { applyMacros, type MacroContext } from "../util/macros";
import {
  compareQrRule,
  parseDetailsBlock,
  parseQrLabels,
  parseQrScript,
  runQrRegex,
  unquoteQrBody,
  type QrCommand,
} from "../util/qr-script";
import { buildSpans, spansToText } from "../util/session-text";
import { diffVariables } from "../util/variables";
import { uuidv4 } from "../util/uuid";
import { ChoiceModal, PromptModal } from "../views/modals";
import { flushQrInjections, setQrInjection } from "./qr-injections";

/** 실행 호스트 — 커맨드가 아닌 텍스트를 세션에 넣는 방법(뷰마다 다르다). */
export interface QrRunHost {
  /** 세션 파일 경로. 없으면 세션이 필요한 커맨드는 건너뛴다. */
  sessionFile(): string | null;
  /** 입력/전송 — 커맨드가 아닌 평문 버튼과 같은 경로. */
  runText(text: string, send: boolean): void | Promise<void>;
}

export interface QrRunResult {
  /** `/abort` 로 중단됐는가. */
  aborted: boolean;
  /** 건너뛴(모르는) 커맨드 이름들. */
  skipped: string[];
}

/** 실행 중 공유 상태. */
interface QrRunState {
  plugin: StellaEnginePlugin;
  host: QrRunHost;
  vars: Record<string, string>;
  macro: MacroContext;
  pipe: string;
  aborted: boolean;
  skipped: Set<string>;
  /** 변수를 실제로 건드렸는가 — 안 건드렸으면 세션을 저장하지 않는다. */
  varsDirty: boolean;
}

/** 스크립트 하나 실행. 예외는 삼키지 않고 호출자(바)가 안내한다. */
export async function runQuickReplyScript(
  plugin: StellaEnginePlugin,
  host: QrRunHost,
  script: string
): Promise<QrRunResult> {
  const sessionFile = host.sessionFile();
  const session = sessionFile
    ? await plugin.store.getSession(sessionFile).catch(() => null)
    : null;

  // 변수 확장이 켜져 있으면 **지금 지점의 값**을 읽고, 바뀐 만큼만 그 지점에 기록한다
  // (게임형 카드 지원 스펙.md U1). 과거로 되돌아간 상태에서 QR 이 미래 값을 보면 안 되고,
  // QR 이 meta.variables 에 직접 쓰면 되짚기 기록과 어긋나 전송본에서 값이 사라진다.
  // 꺼져 있으면 예전 그대로 meta.variables 를 읽고 쓴다(롤백 경계).
  const useVariableLog =
    !!session && !!sessionFile && plugin.isExtensionEnabled("stella:variables");
  const initialVars =
    useVariableLog && session && sessionFile
      ? plugin.variables.resolveFor(
          session,
          await plugin.variables.getLog(sessionFile)
        )
      : { ...(session?.meta.variables ?? {}) };

  const state: QrRunState = {
    plugin,
    host,
    vars: { ...initialVars },
    macro: await buildQrMacroContext(plugin, sessionFile),
    pipe: "",
    aborted: false,
    skipped: new Set(),
    varsDirty: false,
  };

  await runPipeline(state, parseQrScript(script));

  if (state.varsDirty && sessionFile) {
    if (useVariableLog) {
      await plugin.variables.setSessionVars(
        sessionFile,
        diffVariables(initialVars, state.vars)
      );
    } else {
      // 저장 직전에 다시 읽는다 — 실행 중(모달 대기 / AI 생성) 세션이 바뀌었을 수 있다.
      const fresh = await plugin.store.getSession(sessionFile).catch(() => null);
      if (fresh) {
        fresh.meta.variables = state.vars;
        await plugin.store.saveSession(sessionFile, fresh, { kinds: ["settings"] });
      }
    }
  }

  if (state.skipped.size > 0) {
    new Notice(
      `지원하지 않는 커맨드는 건너뛰었습니다: ${[...state.skipped]
        .map((n) => `/${n}`)
        .join(" ")}`
    );
  }
  return { aborted: state.aborted, skipped: [...state.skipped] };
}

/** 파이프라인 하나 — 마지막 커맨드 결과를 반환한다(클로저의 반환값). */
async function runPipeline(
  state: QrRunState,
  commands: QrCommand[]
): Promise<string> {
  let last = "";
  for (const cmd of commands) {
    if (state.aborted) break;
    last = await runCommand(state, cmd);
    state.pipe = cmd.breaksPipe ? "" : last;
  }
  return last;
}

/** 커맨드 하나. 반환값이 곧 다음 커맨드의 `{{pipe}}`. */
async function runCommand(state: QrRunState, cmd: QrCommand): Promise<string> {
  if (!cmd.name) return "";
  const arg = (key: string): string =>
    cmd.named[key] === undefined ? "" : expand(state, cmd.named[key]);
  const body = () => expand(state, cmd.body);

  switch (cmd.name) {
    case "abort":
      state.aborted = true;
      return "";

    case "echo": {
      const text = unquoteQrBody(body());
      if (text) new Notice(text, 5000);
      return text;
    }

    case "comment":
      return await runComment(state, unquoteQrBody(body()));

    case "input":
      return await runInput(state, unquoteQrBody(body()), arg("default"));

    case "setvar": {
      const key = arg("key").trim();
      if (!key) return "";
      const hasValueArg = cmd.named.value !== undefined;
      const value = hasValueArg ? arg("value") : body();
      // 값 인자 자체가 없으면 대입하지 않는다 (ST 동작).
      // `/setvar key=소재 {{pipe}}` 는 pipe 가 비면 `/setvar key=소재` — 즉 값 인자가
      // 사라진 형태다. 이때 ""(빈 문자열)로 덮어쓰면 아직 한 번도 안 정해진 변수와
      // "비워둔 변수"가 구별되지 않아, `{{getvar::소재}}` 가 ""로 풀리며 스크립트의
      // 취소 판정(`rule=eq right=""`)이 잘못 발동한다. 비우는 건 `/flushvar` 담당.
      if (!hasValueArg && value === "") return "";
      state.vars[key] = value;
      state.varsDirty = true;
      return value;
    }

    case "flushvar": {
      // `/flushvar 이름` — 변수를 지운다(빈 값으로 덮는 게 아니라 없앤다).
      // 이름이 없으면 아무것도 하지 않는다 — 전부 지우는 사고를 막는다.
      const key = (arg("key") || unquoteQrBody(body())).trim();
      if (!key || state.vars[key] === undefined) return "";
      delete state.vars[key];
      state.varsDirty = true;
      return "";
    }

    case "if":
      return await runIf(state, cmd, arg);

    case "gen":
      return await runGen(state, body());

    case "buttons":
      return await runButtons(state, cmd, unquoteQrBody(body()));

    case "re-exec": {
      // 정규식 실행 — AI 응답에서 값을 뽑는 용도. `first=` 는 값 없는 플래그다.
      const find = cmd.named.find === undefined ? "" : expand(state, cmd.named.find);
      return runQrRegex(find, body(), cmd.named.first !== undefined);
    }

    case "inject":
      return runInject(state, cmd, arg, body());

    case "flushinject": {
      const file = state.host.sessionFile();
      if (file) flushQrInjections(file, unquoteQrBody(body()).trim() || undefined);
      return "";
    }

    case "sendas":
      return await runSendAs(state, arg("name").trim(), unquoteQrBody(body()));

    case "impersonate":
      return await runImpersonate(state, unquoteQrBody(body()));

    default:
      state.skipped.add(cmd.name);
      return "";
  }
}

/** `/if left= right= rule= {: 참 :} {: 거짓 :}` — 클로저는 같은 변수/중단 상태를 공유한다. */
async function runIf(
  state: QrRunState,
  cmd: QrCommand,
  arg: (key: string) => string
): Promise<string> {
  const rule = (cmd.named.rule ?? "eq").toLowerCase();
  const verdict = compareQrRule(arg("left"), arg("right"), rule);
  if (verdict === null) {
    // 모르는 비교 규칙 — 조건 자체를 건너뛴다(몸통을 잘못 실행하는 것보다 안전).
    state.skipped.add(`if(rule=${rule})`);
    return "";
  }
  const branch = verdict ? cmd.closures[0] : cmd.closures[1];
  if (!branch) return "";
  return await runPipeline(state, parseQrScript(branch));
}

/**
 * `/input <질문>` — ST 동작 그대로 **확인과 취소를 구별한다**.
 *  - 확인: 적은 값을 반환. **비워 둔 채 확인해도 스크립트는 계속 간다**(빈 값이 곧 답).
 *  - 취소(Esc/닫기/취소 버튼): 스크립트 전체를 중단한다. 뒤 커맨드를 돌리지 않는다.
 *
 * 둘 다 ""로 뭉개면 "안 적고 확인"과 "그만두기"가 같아져, 확인을 눌러도 취소처럼
 * 끝나 버린다.
 */
function runInput(
  state: QrRunState,
  question: string,
  initial: string
): Promise<string> {
  return new Promise((resolve) => {
    new PromptModal(
      state.plugin.app,
      question || "입력",
      "",
      initial,
      (value) => {
        if (value === null) state.aborted = true;
        resolve(value ?? "");
      }
    ).open();
  });
}

/**
 * `/buttons labels=["A","B"] <질문>` — 버튼 팝업을 띄우고 **누른 버튼의 라벨**을
 * 돌려준다. 취소/닫기는 ""(스크립트는 계속) — 실물 QR 은 그 뒤 `/if` 로 빈 값을
 * 판정하는 구조라 여기서 중단하면 취소 안내가 안 뜬다(`/input` 과 다른 점).
 */
function runButtons(
  state: QrRunState,
  cmd: QrCommand,
  question: string
): Promise<string> {
  const labels = parseQrLabels(
    cmd.named.labels === undefined ? "" : expand(state, cmd.named.labels)
  );
  if (labels.length === 0) return Promise.resolve("");
  return new Promise((resolve) => {
    new ChoiceModal(
      state.plugin.app,
      question || "선택",
      "",
      labels.map((text) => ({ text, value: text })),
      (value) => resolve(value ?? "")
    ).open();
  });
}

/**
 * `/inject id= position= depth= role= ephemeral= <텍스트>` — 다음 생성에 얹을
 * 지시문을 심는다. 삽입 자체는 `planSessionRequest` 가 확장 custom 슬롯과 같은
 * 기계로 처리한다(QR 전용 삽입 경로 없음). 메모리 전용이라 껐다 켜면 사라진다.
 */
function runInject(
  state: QrRunState,
  cmd: QrCommand,
  arg: (key: string) => string,
  text: string
): string {
  const file = state.host.sessionFile();
  if (!file) return "";
  const pos = arg("position").trim().toLowerCase();
  const depthArg = Number.parseInt(arg("depth"), 10);
  const roleArg = arg("role").trim().toLowerCase();
  setQrInjection(file, {
    id: arg("id").trim() || "qr",
    text,
    // ST `position=chat` = 히스토리 안 depth 위치. 그 외는 캐릭터 설명 뒤.
    position: pos === "chat" ? "at_depth" : "after_char",
    depth: Number.isFinite(depthArg) ? Math.max(0, depthArg) : 0,
    role: roleArg === "user" || roleArg === "assistant" ? roleArg : "system",
    // ST 기본은 지속. `ephemeral=true` 면 다음 생성 한 번 뒤 사라진다.
    ephemeral: /^(true|1)$/i.test(arg("ephemeral").trim()),
  });
  return text;
}

/**
 * `/sendas name="X" <내용>` — 그 인물의 발화로 세션에 남긴다(AI 호출 없음).
 * 챗 세션은 말풍선 하나, 소설 세션은 본문에 이어지는 한 문단이다. 그룹 세션이면
 * 이름을 멤버와 맞춰 발화자 귀속(`node.speaker`)까지 해 준다 — 라벨·아바타·다음
 * 발화자 판정이 일반 생성과 같아진다.
 */
async function runSendAs(
  state: QrRunState,
  name: string,
  text: string
): Promise<string> {
  const file = state.host.sessionFile();
  if (!file || !text.trim()) return text;
  const plugin = state.plugin;
  await plugin.flushSessionEdits(file);
  const session = await plugin.store.getSession(file).catch(() => null);
  if (!session) return text;

  const parentId = session.meta.activeLeafId;
  const parentText = spansToText(buildSpans(session, parentId));
  const sep =
    parentText.length === 0
      ? ""
      : session.meta.mode === "chat"
        ? CHAT_MESSAGE_SEPARATOR
        : "\n";
  const node: SessionNode = {
    id: uuidv4(),
    parent: parentId,
    kind: "ai-continue",
    patches: [{ op: "append", spans: [{ author: "ai", text: sep + text }] }],
    createdAt: Date.now(),
  };
  const speakerId = await resolveSpeakerId(state, session, name);
  if (speakerId) node.speaker = speakerId;
  session.nodes[node.id] = node;
  session.meta.activeLeafId = node.id;
  session.meta.modifiedAt = Date.now();
  await plugin.store.saveSession(file, session);
  return text;
}

/** `/sendas name=` 의 이름 → 그룹 멤버 시나리오 id (아니면 null = 호스트 발화). */
async function resolveSpeakerId(
  state: QrRunState,
  session: { meta: { groupId?: string } },
  name: string
): Promise<string | null> {
  const groupId = session.meta.groupId;
  if (!groupId || !name) return null;
  const group = await state.plugin.store.getGroupById(groupId).catch(() => null);
  if (!group) return null;
  const scenarios = await state.plugin.store.getScenarios().catch(() => []);
  const lower = name.trim().toLowerCase();
  for (const member of group.group.members) {
    const sc = scenarios.find(
      (i) => i.scenario.data.extensions?.stella?.id === member.scenarioId
    );
    if ((sc?.scenario.data.name ?? "").trim().toLowerCase() === lower) {
      return member.scenarioId;
    }
  }
  return null;
}

/**
 * `/impersonate <지시>` — AI 가 **유저 대신** 다음 발언을 써 준다. 결과는 바로
 * 보내지 않고 유저 입력 경로(`runText(send=false)`)로 넘긴다 — 챗은 입력창에,
 * 소설은 본문 끝 유저 문단으로. 마음에 안 들면 지우면 되는 자리에 놓는 것이다.
 */
async function runImpersonate(state: QrRunState, extra: string): Promise<string> {
  const macro = state.macro;
  const who = macro.user || "the user";
  const text = await runGen(
    state,
    `[Write the next message as ${who} (the user), in their voice — one message ` +
      `only, no narration about them, no quotation of this instruction.` +
      (extra ? ` ${extra}` : "") +
      `]`
  );
  if (!text) return "";
  await state.host.runText(text, false);
  return text;
}

/**
 * `/comment <내용>` — 그 스토리 지점에 노트로 남긴다(AI 에는 안 간다).
 * `<details><summary>` 는 원시 HTML 로 렌더하지 않고 제목/본문만 뽑는다.
 */
async function runComment(state: QrRunState, text: string): Promise<string> {
  const file = state.host.sessionFile();
  if (!file || !text.trim()) return text;
  const session = await state.plugin.store.getSession(file).catch(() => null);
  if (!session) return text;
  const { title, body } = parseDetailsBlock(text);
  await state.plugin.store.addSessionNote(file, {
    id: uuidv4(),
    nodeId: session.meta.activeLeafId,
    title,
    body,
    createdAt: Date.now(),
  });
  return text;
}

/**
 * `/gen <지시문>` — 세션의 평소 컨텍스트 뒤에 지시문을 얹어 한 번 생성한다.
 * 결과는 세션에 저장하지 않고 파이프로만 넘긴다(ST `/gen` 과 같은 성격).
 * 전송본은 `planSessionRequest` 단일 경로 — 미리보기와 같은 payload 를 그대로 쓴다.
 */
async function runGen(state: QrRunState, prompt: string): Promise<string> {
  const file = state.host.sessionFile();
  if (!file || !prompt.trim()) return "";
  const plugin = state.plugin;
  if (!plugin.ai.isAvailable()) {
    new Notice("GGAI Core 가 활성화되어 있지 않습니다.");
    state.aborted = true;
    return "";
  }
  // 열린 세션창의 미저장 편집 커밋 — 방금 쓴 본문이 컨텍스트에서 빠지지 않게.
  await plugin.flushSessionEdits(file);
  const plan = await planSessionRequest(plugin, file);
  if ("error" in plan) {
    new Notice(plan.error);
    state.aborted = true;
    return "";
  }

  // 본문 출력 제한은 물려받지 않는다 — 그건 "본문을 한 번에 이만큼만 써라"는
  // 분량 설정이고, /gen 은 용도가 다른 부산물이라 긴 결과가 중간에 잘린다.
  // 샘플링(temperature 등)은 세션 느낌을 유지하려고 그대로 쓴다.
  const params = withoutOutputCap(plan.paramsOverride);

  // "생성 중" 토스트는 만들지 않는다 — Core 가 `label` + 모델명으로 띄운다(CLAUDE.md 7).
  const res =
    plan.payload.kind === "chat"
      ? await plugin.ai.chat({
          profileId: plan.profile.id,
          messages: [...plan.payload.messages, { role: "user", content: prompt }],
          paramsOverride: params,
          label: "빠른 답장 /gen",
        })
      : // 텍스트 컴플리션 프로필 — 전송본 문자열 뒤에 지시문을 이어 붙인다.
        await plugin.ai.generate({
          profileId: plan.profile.id,
          prompt: `${plan.payload.prompt}\n\n${prompt}`,
          paramsOverride: params,
          label: "빠른 답장 /gen",
        });
  return (res.text ?? "").trim();
}

/**
 * 매크로 치환 — 현재 변수 + 실행 시점 값. `{{setvar::}}` 로 바뀐 값도 되돌려 받는다.
 *
 * 실행 시점 값(`{{pipe}}` / `{{groupnotmuted}}`)은 변수처럼 넘기되 **세션 변수로
 * 되돌려 쓰지 않는다** — 스크립트가 저장하지 않은 값이 변수 목록에 눌러앉으면 안 된다.
 * `{{groupnotmuted}}`(ST: 지금 말할 차례인 멤버)는 실물 QR 이 `/sendas name=` 에 쓴다 —
 * 우리는 그 세션의 캐릭터 이름으로 푼다(그룹이면 호스트).
 */
const RUNTIME_MACRO_KEYS = new Set(["pipe", "groupnotmuted"]);

function expand(state: QrRunState, text: string): string {
  if (!text) return "";
  const variables: Record<string, string> = {
    ...state.vars,
    pipe: state.pipe,
    groupnotmuted: state.macro.char ?? "",
  };
  const out = applyMacros(text, { ...state.macro, variables });
  for (const [k, v] of Object.entries(variables)) {
    if (RUNTIME_MACRO_KEYS.has(k)) continue;
    if (state.vars[k] !== v) {
      state.vars[k] = v;
      state.varsDirty = true;
    }
  }
  return out;
}

/** 이름 매크로 재료 — `{{user}}` / `{{char}}` 만 있으면 실측 QR 은 충분히 돈다. */
async function buildQrMacroContext(
  plugin: StellaEnginePlugin,
  sessionFile: string | null
): Promise<MacroContext> {
  const { profile: user } = await plugin.resolveActiveUserProfile();
  const ctx: MacroContext = {
    user: user?.name?.trim() || "User",
    persona: user?.description ?? "",
  };
  if (!sessionFile) return ctx;
  const scenarioFile = scenarioFileOfSessionFile(sessionFile);
  if (!scenarioFile) return ctx;
  const scenarios = await plugin.store.getScenarios().catch(() => []);
  const item = scenarios.find((i) => i.scenarioFile === scenarioFile);
  const data = item?.scenario.data;
  if (data) {
    ctx.char = (data.name ?? "").trim() || "Character";
    ctx.description = data.description ?? "";
    ctx.personality = data.personality ?? "";
    ctx.scenario = data.scenario ?? "";
  }
  return ctx;
}

/** GGAI/SCENARIOS/X/SESSIONS/Y/session.json → GGAI/SCENARIOS/X/scenario.json */
function scenarioFileOfSessionFile(sessionFile: string): string | null {
  const parts = sessionFile.split("/");
  if (parts.length < 6 || parts[parts.length - 3] !== "SESSIONS") return null;
  return parts.slice(0, -3).join("/") + "/scenario.json";
}
