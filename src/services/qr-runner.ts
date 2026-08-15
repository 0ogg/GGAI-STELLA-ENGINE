/**
 * 빠른 답장(QR) 스크립트 실행기 — 파서(`util/qr-script.ts`)가 만든 파이프라인을 돌린다.
 *
 * **모르는 커맨드는 조용히 건너뛰고 끝에 한 번만 안내한다** — 임포트한 세트가 지원 밖
 * 커맨드를 써도 버튼 전체가 죽지 않게.
 *
 * 상태:
 *  - 세션 변수는 `session.meta.variables`(변수 확장이 켜져 있으면 가지별 되짚기 기록),
 *    전역 변수는 `plugin.variables` — 매크로 맵에는 `global::` 접두로 얹힌다.
 *  - `{{pipe}}` 는 직전 커맨드의 결과. `||` 로 끊긴 자리에서 비워진다.
 *  - **본문(맨 인자)이 없는 커맨드는 `{{pipe}}` 를 본문으로 받는다** (ST 암묵적 파이프).
 *    `/gen … | /sendas name="{{char}}"` 처럼 결과를 그대로 넘기는 관용구가 이것에 기댄다.
 *
 * AI 호출은 전부 `plugin.ai` 경유, 저장은 전부 `plugin.store` 경유 (CLAUDE.md 6·7).
 */

import { Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { SessionNode, StellaSession } from "../types/session";
import { planSessionRequest } from "../util/build-session-context";
import { buildChatMessages, CHAT_MESSAGE_SEPARATOR } from "../util/chat-messages";
import { withoutOutputCap } from "../util/generation-params";
import { applyMacros, type MacroContext } from "../util/macros";
import {
  compareQrRule,
  parseDetailsBlock,
  parseMessageIndices,
  parseQrLabels,
  parseQrScript,
  runQrRegex,
  unquoteQrBody,
  type QrCommand,
} from "../util/qr-script";
import { buildSpans, spansToText } from "../util/session-text";
import {
  diffVariables,
  GLOBAL_VAR_PREFIX,
  withGlobalScope,
} from "../util/variables";
import { uuidv4 } from "../util/uuid";
import { ChoiceModal, PromptModal } from "../views/modals";
import { flushQrInjections, setQrInjection } from "./qr-injections";

/** 실행 호스트 — 커맨드가 아닌 텍스트를 세션에 넣는 방법(뷰마다 다르다). */
export interface QrRunHost {
  /** 세션 파일 경로. 없으면 세션이 필요한 커맨드는 건너뛴다. */
  sessionFile(): string | null;
  /** 입력/전송 — 커맨드가 아닌 평문 버튼과 같은 경로. */
  runText(text: string, send: boolean): void | Promise<void>;
  /**
   * `/trigger` — 유저 메시지 없이 생성 1회. 챗은 전송 버튼과 같은 경로,
   * 소설은 이어쓰기와 같은 경로다(별도 생성 경로를 만들지 않는다).
   * @param speaker 그룹 챗 발화자 지목 (멤버 이름 또는 순번). 없으면 평소 판정.
   */
  triggerGeneration?(speaker?: string): void | Promise<void>;
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
  /** 전역 변수 (접두 없는 이름 → 값). 끝에 한 번만 저장한다. */
  globals: Record<string, string>;
  macro: MacroContext;
  pipe: string;
  aborted: boolean;
  skipped: Set<string>;
  /** 변수를 실제로 건드렸는가 — 안 건드렸으면 세션을 저장하지 않는다. */
  varsDirty: boolean;
  globalsDirty: boolean;
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
    globals: plugin.variables.getGlobals(),
    macro: await buildQrMacroContext(plugin, sessionFile),
    pipe: "",
    aborted: false,
    skipped: new Set(),
    varsDirty: false,
    globalsDirty: false,
  };

  await runPipeline(state, parseQrScript(script));

  if (state.globalsDirty) {
    await plugin.variables.setGlobals(state.globals);
  }

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
  /**
   * 맨 인자(본문). **적혀 있지 않으면 `{{pipe}}` 가 그 자리에 온다** — ST 의 암묵적
   * 파이프다. 이게 없으면 `/gen … | /sendas name="X"` 처럼 앞 결과를 그대로 넘기는
   * 관용구가 빈 값으로 조용히 통과해 결과가 증발한다.
   * 적혀 있는데 매크로가 빈 값으로 풀린 경우(`{{pipe}}` 를 손으로 쓴 경우 포함)는
   * 그대로 빈 값이다 — "안 적음"과 "비어 있음"을 뭉개지 않는다.
   */
  const body = () => (cmd.body.trim() === "" ? state.pipe : expand(state, cmd.body));
  /**
   * 암묵적 파이프를 **적용하지 않는** 맨 인자 — 인자가 "내용"이 아니라 **대상 지정**인
   * 커맨드용(`/hide 2-5`, `/trigger 캐릭터명`, `/flushvar 이름`, `/flushinject id`,
   * `/getglobalvar 이름`). 여기에 앞 결과가 흘러들면 `/gen … | /hide` 가 엉뚱한 메시지를
   * 숨기고 `/gen … | /flushinject` 가 아무것도 못 지운다. `{{pipe}}` 를 손으로 쓰면 통한다.
   * (원본과 다른 점 — ST 는 모든 맨 인자에 파이프를 흘린다.)
   */
  const rawBody = () => expand(state, cmd.body);

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
      const key = (arg("key") || unquoteQrBody(rawBody())).trim();
      if (!key || state.vars[key] === undefined) return "";
      delete state.vars[key];
      state.varsDirty = true;
      return "";
    }

    case "addvar": {
      // `/addvar key=이름 증가량` — 숫자 더하기 (ST). 숫자가 아니면 0 으로 본다.
      const key = arg("key").trim();
      if (!key) return "";
      const prev = Number.parseFloat(state.vars[key] ?? "0");
      const add = Number.parseFloat(body().trim());
      const next = String(
        (Number.isFinite(prev) ? prev : 0) + (Number.isFinite(add) ? add : 0)
      );
      state.vars[key] = next;
      state.varsDirty = true;
      return next;
    }

    case "setglobalvar": {
      // `/setglobalvar key=이름 값` — 전역 값(모든 세션 공통). 세션 변수와 이름
      // 공간이 아예 다르다(ST 와 같은 의미) — 세션에 새어 들어가지 않는다.
      const key = arg("key").trim();
      if (!key) return "";
      const value = cmd.named.value !== undefined ? arg("value") : body();
      state.globals[key] = value;
      state.globalsDirty = true;
      return value;
    }

    case "getglobalvar": {
      const key = (arg("key") || unquoteQrBody(rawBody())).trim();
      return key ? state.globals[key] ?? "" : "";
    }

    case "rand":
      return runRand(state, cmd, arg);

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
      if (file) flushQrInjections(file, unquoteQrBody(rawBody()).trim() || undefined);
      return "";
    }

    case "sendas":
      return await runSendAs(state, arg("name").trim(), unquoteQrBody(body()));

    case "impersonate":
      return await runImpersonate(state, unquoteQrBody(body()));

    case "trigger":
      return await runTrigger(state, unquoteQrBody(rawBody()).trim());

    case "hide":
      return await runHide(state, unquoteQrBody(rawBody()), true);

    case "unhide":
      return await runHide(state, unquoteQrBody(rawBody()), false);

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
 * 챗 세션은 말풍선 하나, 소설 세션은 본문에 이어지는 한 문단이다.
 *
 * 이름 처리 두 갈래:
 *  - 그룹 멤버와 이름이 맞으면 발화자 귀속(`node.speaker`) — 라벨·아바타·다음 발화자
 *    판정이 일반 생성과 같아진다.
 *  - 멤버가 아니면(가십지·마법 신문 같은 **익명 발화자**) 이름을 `node-meta.json` 에
 *    이름표로 남긴다. 예전엔 이 이름이 그냥 버려져 캐릭터 본인의 말풍선으로 떴다.
 *    **본문에 `이름:` 접두어를 박지 않는다** — 본문은 문자 오프셋 기준이라 접두어가
 *    편집/번역/삽화 앵커를 전부 밀어낸다.
 */
async function runSendAs(
  state: QrRunState,
  name: string,
  text: string
): Promise<string> {
  const file = state.host.sessionFile();
  if (!file || !text.trim()) return text;
  const session = await appendSessionMessage(state, file, text);
  if (!session) return text;

  const nodeId = session.meta.activeLeafId;
  const speakerId = await resolveSpeakerId(state, session, name);
  if (speakerId) {
    session.nodes[nodeId].speaker = speakerId;
    await state.plugin.store.saveSession(file, session);
  } else if (name && name !== (state.macro.char ?? "")) {
    await state.plugin.store.patchSessionNodeMeta(file, nodeId, {
      speakerName: name,
    });
  }
  return text;
}

/**
 * 본문 끝에 AI 발화 노드 하나를 붙인다 (`/sendas` `/comment` 공용).
 * 저장까지 마친 세션 객체를 돌려준다 — 호출부가 그 노드에 더 얹을 게 있으면 이어서 쓴다.
 */
async function appendSessionMessage(
  state: QrRunState,
  file: string,
  text: string
): Promise<StellaSession | null> {
  const plugin = state.plugin;
  await plugin.flushSessionEdits(file);
  const session = await plugin.store.getSession(file).catch(() => null);
  if (!session) return null;

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
  session.nodes[node.id] = node;
  session.meta.activeLeafId = node.id;
  session.meta.modifiedAt = Date.now();
  await plugin.store.saveSession(file, session);
  return session;
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
 * `/comment <내용>` — 그 스토리 지점에 **본문으로** 남기되 AI 에는 안 보낸다
 * (ST: "adds a hidden comment that is displayed in the chat but is not visible to
 * the prompt"). 그래서 다른 발화와 똑같이 말풍선/문단으로 보이고, 전송본에서만 빠진다.
 *
 * 예전에는 본문 밖 노트(`notes.json`)로 남겼는데, 그러면 QR 을 "프롬프트 숏컷"으로 쓰는
 * 카드들이 기대하는 자리(대화 로그)에 결과가 없어 호환이 깨졌다. 이미 쌓인 노트는
 * 그대로 표시된다(레거시 유지) — 새로 만들지 않을 뿐이다.
 *
 * `<details><summary>` 는 원시 HTML 로 렌더하지 않고 제목/본문만 뽑는다(QR 스펙.md).
 */
async function runComment(state: QrRunState, text: string): Promise<string> {
  const file = state.host.sessionFile();
  if (!file || !text.trim()) return text;
  const { title, body } = parseDetailsBlock(text);
  const content = title ? `${title}\n${body}` : body;
  if (!content.trim()) return text;
  const session = await appendSessionMessage(state, file, content);
  if (!session) return text;
  await state.plugin.store.patchSessionNodeMeta(file, session.meta.activeLeafId, {
    hidden: true,
  });
  return text;
}

/**
 * `/trigger [발화자]` — 유저 메시지 없이 생성 1회 (ST: 전송 버튼을 누른 것과 같다).
 * 앞에 `/inject` 로 심어 둔 지시문이 이번 전송에 그대로 실린다.
 * 실행 경로는 뷰가 소유한다 — 챗은 전송, 소설은 이어쓰기. 별도 생성 경로를 만들지 않는다.
 */
async function runTrigger(state: QrRunState, speaker: string): Promise<string> {
  if (!state.host.sessionFile()) return "";
  if (!state.host.triggerGeneration) {
    // 세션창이 아닌 데서 실행된 경우 — 조용히 넘기지 않고 건너뜀 안내에 합류시킨다.
    state.skipped.add("trigger");
    return "";
  }
  await state.host.triggerGeneration(speaker || undefined);
  return "";
}

/**
 * `/hide <번호|시작-끝>` / `/unhide …` — 그 메시지를 화면에는 남기고 **전송본에서만**
 * 뺀다(ST 와 같은 의미, `node-meta.json`). 번호는 챗 메시지 순번(0부터, 음수는 끝에서).
 *
 * 우리 추가: **번호를 안 적으면 마지막으로 붙은 본문 덩어리**를 대상으로 한다 —
 * 소설 모드에는 메시지 번호 개념이 없어 이 형태가 유일한 진입점이다.
 * 번호를 적었는데 해석되는 메시지가 없으면 아무것도 하지 않는다.
 */
async function runHide(
  state: QrRunState,
  spec: string,
  hidden: boolean
): Promise<string> {
  const file = state.host.sessionFile();
  if (!file) return "";
  const plugin = state.plugin;
  await plugin.flushSessionEdits(file);
  const session = await plugin.store.getSession(file).catch(() => null);
  if (!session) return "";

  const trimmed = spec.trim();
  let targets: string[];
  if (!trimmed) {
    const msgs = buildChatMessages(session);
    targets = [msgs[msgs.length - 1]?.nodeId ?? session.meta.activeLeafId];
  } else {
    const msgs = buildChatMessages(session);
    targets = [
      ...new Set(
        parseMessageIndices(trimmed, msgs.length)
          .map((i) => msgs[i]?.nodeId)
          .filter((id): id is string => !!id)
      ),
    ];
  }
  for (const nodeId of targets) {
    await plugin.store.patchSessionNodeMeta(file, nodeId, { hidden });
  }
  return "";
}

/**
 * `/rand [round=round|ceil|floor] [from=0] [to=1] [최대값]` — ST 그대로.
 * 맨 인자 하나는 `to` 다(`/rand 10` = 0~10). 범위는 양끝 포함이고 기본은 소수다 —
 * 정수가 필요하면 `round=` 를 쓴다(ST 문서와 같은 규칙).
 */
function runRand(
  state: QrRunState,
  cmd: QrCommand,
  arg: (key: string) => string
): string {
  const num = (raw: string, fallback: number) => {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const bare = unquoteQrBody(expand(state, cmd.body)).trim();
  const from = num(arg("from"), 0);
  const to = num(arg("to"), bare ? num(bare, 1) : 1);
  const value = from + Math.random() * (to - from);
  switch (arg("round").trim().toLowerCase()) {
    case "ceil":
      return String(Math.ceil(value));
    case "floor":
      return String(Math.floor(value));
    case "round":
      return String(Math.round(value));
    default:
      return String(value);
  }
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
    // 전역 값은 `global::` 접두를 달고 얹힌다 — `{{getglobalvar::x}}` 가 이 자리를 읽는다.
    ...withGlobalScope(state.vars, state.globals),
    pipe: state.pipe,
    groupnotmuted: state.macro.char ?? "",
  };
  const out = applyMacros(text, { ...state.macro, variables });
  for (const [k, v] of Object.entries(variables)) {
    if (RUNTIME_MACRO_KEYS.has(k)) continue;
    // 전역 값은 세션 변수로 되돌려 쓰지 않는다 — 넣는 순간 `global::x` 라는 이름의
    // 세션 변수가 생겨 session.json 에 새어 들어간다.
    if (k.startsWith(GLOBAL_VAR_PREFIX)) continue;
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
