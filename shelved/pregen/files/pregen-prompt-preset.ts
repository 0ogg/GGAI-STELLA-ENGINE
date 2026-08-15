/**
 * 이중 생성 기본 프롬프트 세트 — "속마음".
 *
 * 구조는 `default-prompt-preset.ts` 의 Default 와 **의도적으로 같다**: 로어북(before/after),
 * 캐릭터 설명·성격·시나리오, 대화 예시, chatHistory 를 그대로 쓴다. 요약은 요약 확장이
 * 켜져 있으면 이어쓰기와 똑같이 자동으로 붙는다. 즉 "이어쓰기와 같은 재료, 지시문만 다름".
 *
 * 다른 것은 두 곳뿐:
 *  - `main` — 이번 호출이 이야기를 쓰는 게 아니라 내부 메모를 만드는 것임을 규정.
 *  - `jailbreak`(Post-History Instructions) — chatHistory **뒤**에 오는 실제 작업 지시.
 *    본문 뒤에 있어야 모델이 "직전 장면"을 기준으로 삼는다.
 *
 * 이건 어디까지나 **기본값**이다. 사용자가 편집기에서 고쳐 쓰는 것이 정상이고,
 * 코드가 이 내용을 다시 강제하거나 몰래 덧붙이지 않는다(숨은 프롬프트 금지).
 */

import type StellaEnginePlugin from "../main";
import { parseSillyTavernPromptPreset } from "../import/parse-sillytavern-prompt";
import { defaultPromptRaw } from "./default-prompt-preset";
import { StellaPromptPreset } from "../types/prompt";

/** 자동 생성되는 이중 생성 기본 세트의 이름. */
export const PREGEN_PRESET_NAME = "속마음 (이중 생성)";

/** 주입 틀에서 1차 결과가 들어갈 자리 (미디어 프롬프트·작가노트 틀과 같은 규약). */
export const PREGEN_RESULT_MACRO = "{{main}}";

/**
 * 1차 결과의 끝 = **닫는 대괄호**.
 *
 * 끝을 안 정해주면 모델이 목록을 마친 뒤 그대로 장면을 이어 써 토큰 제한까지 태운다(제보).
 * JSON 이 stop 없이도 제대로 멈췄던 이유는 스키마가 아니라 **닫는 기호 `]` 가 있어서**다.
 *
 * 그래서 여는 기호와 닫는 기호가 **서로 다른** 짝을 쓴다. 코드펜스는 안 된다 —
 * 여닫이가 같은 문자열(` ``` `)이라, 프롬프트가 펜스를 열어 두면 모델이 그 펜스를 한 번
 * 따라 쓰는 순간 stop 이 **첫 글자에서** 터져 응답이 통째로 비어 버린다(제보).
 * `[` 로 열고 `]` 로 닫으면 여는 쪽이 stop 을 건드릴 수 없다.
 */
export const PREGEN_END_MARKER = "]";

/**
 * 1차 호출에 거는 stop 문자열.
 *
 * 출력이 `이름: 생각` 줄이라 stop 없이도 파싱이 끊는다 — 이건 **토큰 절약용**이다.
 * 목록을 마치고 장면을 이어 쓰기 시작하면 그만큼 토큰을 태우기 때문에, 그 시작
 * 신호인 장면 구분선과 닫는 대괄호에서 끊는다. (빈 줄 `\n\n` 은 stop 으로 쓰지 않는다 —
 * 모델이 앵커 다음에 빈 줄부터 내면 첫 항목도 못 받고 끝난다.)
 *
 * **코드펜스는 stop 에 넣지 않는다.** 챗 모델이 목록을 제 판단으로 펜스에 감싸 시작하면
 * 그 여는 펜스에서 잘려 빈 응답이 된다. 펜스로 감싸 온 결과는 파서가 벗겨 낸다.
 */
/**
 * 1차 호출에 거는 stop 문자열.
 *
 * **멈춤은 stop 이 아니라 형식의 종결성이 만든다.** 출력이 JSON 객체라 모델은 `}` 로
 * 닫고 끝낸다 — JSON 으로 뽑을 때 stop 없이도 제대로 멈췄던 이유가 이것이다.
 * 여기 stop 은 장면 구분선 하나뿐이고, 만에 하나 본문을 이어 쓰기 시작하면 끊는 보조다.
 *
 * `"\n"` 은 넣지 않는다 — 모델이 JSON 을 여러 줄로 예쁘게 찍으면 `{` 하나만 받고 끝난다.
 * 같은 이유로 코드펜스도 안 넣는다(여는 펜스에서 첫 글자가 잘려 빈 응답이 된 적 있다).
 */
export function pregenStopSequences(_kind: "text" | "chat"): string[] {
  return ["***"];
}

const PREGEN_MAIN_PROMPT =
  "Below is a manuscript in progress. After it, the private thoughts of the characters at the moment it stops.";

/**
 * 본문(chatHistory) **뒤**에 붙는 양식 앵커.
 *
 * 텍스트 컴플리션에서도 그대로 성립해야 하므로 **지시문이 아니라 양식**으로 쓴다 —
 * 전송본 맨 끝에 제목줄과 한 줄 견본이 서 있으면, 모델은 지시를 해석하는 게 아니라
 * 그 형식을 이어 쓴다(챗 모델도 같은 형식을 따른다).
 *
 * "너는 소설을 쓰는 게 아니다" / "이건 독자에게 안 보인다" 류의 메타 설명은 넣지
 * 않는다. 컴플리션에서는 그런 문장이 오히려 이어질 텍스트의 소재가 된다.
 */
const PREGEN_POST_HISTORY = [
  "***",
  "",
  "You are recording the private thoughts of the characters in the manuscript above.",
  "Look ONLY at the last scene. Output ONE JSON object.",
  "",
  // **형식은 JSON 객체 — 이름이 키다.**
  //  - 종결: 모델은 `}` 로 닫고 끝낸다. JSON 으로 뽑을 때 멈춤이 정상이었던 이유가
  //    스키마가 아니라 **닫는 기호가 있는 학습된 형식**이라서다. `이름: 생각 | …` 은
  //    종결이 없는 임의 패턴이라 무한히 이어졌다(제보: 한 줄 2000자).
  //  - 중복: JSON 객체의 키는 유일하다 → "각 인물 한 번씩"이 **형식으로** 강제된다.
  //    지시문으로 부탁할 일이 아니다(제보: 대본처럼 인물을 계속 돌았다).
  //  - 토큰: 배열-오브젝트(`{"name":…,"thought":…},` ≈ 11토큰/인물)의 절반 이하
  //    (`"":"",` ≈ 5토큰/인물). 이름이 키라 name/thought 라벨 자체가 사라진다.
  // ── **완성 예시를 두지 않는다.** 실제 생각 문장을 예시로 보여 주면 분량만이 아니라
  //    소재·문체·사고방식까지 그 예시 쪽으로 끌린다(사용자 지적 — 예시 속 문장이 생성에
  //    스며든다). 분량은 예시 대신 세 겹으로 못 박는다:
  //    ① 스키마 자리표시자 **안에** 분량을 박는다 — 모델이 복사할 모양 자체에 "two to
  //       five sentences" 가 들어 있다.
  //    ② LENGTH 절의 수치 규칙 (hard limits, "Count them").
  //    ③ NOW DO IT 에서 마지막으로 반복 (모델은 마지막에 읽은 걸 따른다).
  //    종결은 예시가 아니라 JSON 이라는 **학습된 형식**이 만든다(`}` 로 닫고 멈춤) —
  //    stop 시퀀스가 보조.
  "=========================================",
  "OUTPUT FORMAT — copy this shape exactly",
  "=========================================",
  '{"<name>": "<that character\'s unspoken thought, two to five sentences>", "<name>": "<...>"}',
  "",
  "- ONE JSON object. The key is the character's name, the value is that character's thought.",
  "- One key per character physically present in the last scene, in the order they appear.",
  // **한 순간의 스냅샷임을 형식 규칙으로 박는다** — "시간이 흐르는 장면"으로 읽는 순간
  // 인물이 생각하고, 또 생각하고, 서로에게 반응하는 대본이 된다(제보: 한 줄 2000자).
  "- Keys are unique: each character thinks EXACTLY ONCE. This is one frozen instant — the moment the manuscript stops. Nobody thinks, then thinks again. Nobody reacts to another's thought.",
  "- Each thought is one JSON string: spaces, not raw line breaks.",
  "- Close with } and stop. Nothing before the { and nothing after the }.",
  "",
  // ── 슬롯별 정의 — 형용사가 아니라 "그 자리에 무엇이 들어가는가"를 못 박는다.
  //    실패 유형은 실문장 BAD 예시 대신 **추상 금지 목록**으로 적는다(같은 이유 —
  //    실문장은 내용을 끈다).
  "=========================================",
  "KEY (the name)",
  "=========================================",
  // 견본 이름 자리에 `{{char}}` 를 쓰지 않는 이유는 이 엔진에서 그게 **시나리오(카드)
  // 이름** = 작품 제목으로 풀리기 때문. 그래서 규칙으로 못 박는다.
  "- Exactly the name the manuscript uses for that character. Nothing else.",
  "- Never a role, never a title, never the title of the work.",
  "- A character only mentioned, remembered, or named but NOT physically in the last scene gets no key.",
  "",
  "=========================================",
  "VALUE (the thought)",
  "=========================================",
  "First person, present tense, unspoken, in the language of the manuscript.",
  // **깊이의 정의** — "하나만 골라 써라"가 초단문 실패의 원인이었다(제보: 넣는 의미가
  // 없을 만큼 짧음). 이 결과의 소비자는 본 생성이고, 필요한 건 한 줄 리액션이 아니라
  // "이 인물이 지금 무엇에 붙들려 있고 어디로 기울어 있는가"다.
  "What the character is REALLY thinking at this instant — the version they would never say out loud.",
  "Each thought must do both:",
  "  - name what has their attention right now, and what it stirs up in them — a want, a fear, a memory, a suspicion",
  "  - land somewhere: what they now intend, resist, or refuse to admit",
  "A thought is NONE of these:",
  "  - a one-word label of their mood",
  "  - narration or description of the scene",
  "  - a recap of the situation so far",
  "  - a script of what happens next",
  "",
  "=========================================",
  "LENGTH — hard limits",
  "=========================================",
  // 수치로 못 박고 세게 반복한다. "one or two words" 를 정상 사례로 두면 전원이 그
  // 길이로 수렴했다(제보) — 한 단어는 짐승·유아 예외로만 남긴다.
  "- Every thought: TWO to FIVE sentences. Count them.",
  "- One exception: a mind that is truly blank — an animal, an infant — may be a single word or fragment.",
  "- Vary the lengths. Not every character gets the same number of sentences.",
  "",
  "=========================================",
  "LANGUAGE RULES",
  "=========================================",
  "- the character's own voice: their vocabulary, their rhythm. a blunt one thinks in blunt fragments, a guarded one circles the point, a playful one jokes even now.",
  "- with the names removed, the voices alone should tell them apart.",
  "- no prose, no sensory description, no third person, no narration.",
  "- never explain, never summarize, never moralize.",
  "",
  "=========================================",
  "NOW DO IT",
  "=========================================",
  // 마지막에 제약을 다시 못 박는다 — 위에서 아무리 설명해도 모델은 **마지막에 읽은
  // 것**을 따라간다. 분량 반복(②③ 의 ③)이 이 줄에 있다.
  "Output ONLY the JSON object in the format above. Start with {. Each thought two to five sentences. Close with } and stop. Nothing else.",
  "",
  // **출력의 시작을 유도한다** — 라벨로 끝내 컴플리션이 곧바로 `{` 부터 쓰게 한다
  // (삽화 `Response: offscreen:` / 번역 `번역: ```json` / 로어북 `Selection:` 과 같은 장치).
  // 여는 `{` 를 여기 미리 찍지 않는다 — 미리 찍으면 파서가 볼 수 없는 자리에서 형식이
  // 갈린다(파서는 응답 안의 첫 `{` 부터 읽는다).
  // 라벨까지 영어인 이유: 이 텍스트는 AI 에게만 가고, 한글 라벨은 원고가 영어일 때
  // 출력 언어를 한국어 쪽으로 끌 수 있다.
  "Private thoughts: ",
].join("\n");

/**
 * **기본 세트("속마음")를 켤 때 설정에 넣어 주는 초기 틀.** 코드가 주입 시점에
 * 몰래 얹는 값이 아니다 — 설정에 실제 문자열로 들어가 사용자가 보고 고친다
 * (반복 표현 확장의 기본 지시문과 같은 방식).
 *
 * 이 확장은 속마음 전용이 아니므로, **사용자가 자기 프롬프트 세트를 고르면 이 문구는
 * 따라가지 않는다** — 그때 틀은 빈 칸에서 시작한다(용도는 그 세트가 정한다).
 *
 * 속마음 용도에서 날것으로 넣으면 두 가지가 깨진다: ① 모델이 그 줄들을 대사·서술로
 * 읽어 그대로 뱉는다 ② 모든 인물의 속마음이 한자리에 있으니 서로의 속을 꿰뚫어 본
 * 것처럼 쓴다. 그래서 "무엇인지"와 "누가 알 수 있는지"를 함께 박아 둔다.
 */
export const DEFAULT_PREGEN_INJECT_TEMPLATE = [
  "[Inner thoughts at this moment — unspoken and private to each character.",
  "No one perceives anyone else's. Never render them as dialogue or narration,",
  // 표현 유출 금지 — 본문이 이 줄들의 어휘를 그대로 베끼면 속마음이 대사로 새어 나온다.
  // 이건 1차가 아니라 **본 생성**에게 할 말이라 틀 쪽에 둔다.
  "and never reuse their wording in the prose.]",
  PREGEN_RESULT_MACRO,
].join("\n");

/**
 * 1차 결과를 틀에 끼워 넣는다 (`{{main}}` 자리).
 *
 * **틀이 비면 결과만 그대로 넣는다** — 코드가 대신 문구를 얹지 않는다. 무엇을 어떻게
 * 감쌀지는 전부 설정의 이 문자열이 정한다(용도를 코드가 모르는 확장이라서).
 * 자리표시자가 없는 틀이면 틀 아래에 결과를 붙인다(자리표시자를 지운 사용자 구제).
 */
export function applyPregenInjectTemplate(
  template: string | undefined,
  result: string
): string {
  const body = result.trim();
  if (!body) return "";
  const tpl = (template ?? "").trim();
  if (!tpl) return body;
  return PREGEN_RESULT_PLACEHOLDER.test(tpl)
    ? tpl.replace(PREGEN_RESULT_PLACEHOLDER, body)
    : `${tpl}\n${body}`;
}

/**
 * 1차 결과가 들어갈 자리 — 미디어 프롬프트·작가노트 틀과 같은 `{{main}}` 규약.
 * `{{result}}` 는 먼저 쓰던 이름이라 계속 받아 준다.
 */
const PREGEN_RESULT_PLACEHOLDER = /\{\{\s*(?:main|result)\s*\}\}/gi;

/**
 * 1차 응답 → 주입할 텍스트.
 *
 * 기본 형식은 **한 줄**(`이름: 생각 | 이름: 생각`)이다. 여러 줄로 나눠 온 것과 JSON 도
 * 계속 읽어 준다 — 사용자가 세트를 그렇게 고쳐 쓸 수 있다. 어느 쪽이든 결과는 같은
 * `이름: 생각` 줄 묶음이라 주입 형태는 변하지 않는다.
 */
export function parsePregenResult(text: string): string {
  // 추론 블록을 먼저 걷어낸다 — 안 걷으면 그 안의 `이름: …` 이 항목으로 잡힌다.
  const trimmed = text.replace(THINK_BLOCK_RE, "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();

  // 기본 형식 — 이름을 키로 쓰는 JSON 객체. 키가 유일해서 인물 중복이 형식으로 막힌다.
  // **바깥이 배열이면 이 경로로 들어오면 안 된다** — 배열 안의 첫 오브젝트를 잡아
  // `name: 라온 / thought: …` 로 펴 버린다(하네스가 잡은 실패).
  const objStart = candidate.indexOf("{");
  const objEnd = candidate.lastIndexOf("}");
  const arrStart = candidate.indexOf("[");
  const objectIsOutermost = objStart >= 0 && (arrStart < 0 || objStart < arrStart);
  if (objectIsOutermost && objEnd > objStart) {
    try {
      const parsed = JSON.parse(candidate.slice(objStart, objEnd + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // **객체로 읽혔으면 여기서 끝낸다** — 건질 게 없다고 원문 폴백으로 내려가면
        // 생 JSON 이 그대로 본 생성 컨텍스트에 주입된다(배열 경로와 같은 이유).
        return Object.entries(parsed as Record<string, unknown>)
          .map(([name, thought]) =>
            typeof thought === "string" && thought.trim() && name.trim()
              ? `${name.trim()}: ${thought.trim()}`
              : null
          )
          .filter((line): line is string => line !== null)
          .join("\n");
      }
    } catch {
      // 배열/줄 형식으로 내려간다.
    }
  }
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        // **배열로 읽혔으면 여기서 끝낸다.** 유효 항목이 하나도 없다고 원문 폴백으로
        // 내려가면 생 JSON 이 그대로 본 생성 컨텍스트에 주입된다(하네스 케이스 4).
        // 건질 게 없으면 빈 값이 맞다 — 그러면 이번 턴만 주입 없이 지나간다.
        return parsed
          .map(readPregenItem)
          .filter((line): line is string => line !== null)
          .join("\n");
      }
    } catch {
      // 줄 형식으로 내려간다.
    }
  }
  // 한 줄 형식이 기본. 인물이 둘 이상 잡히면 그걸 쓴다.
  const oneLine = readPregenEntries(candidate.split("\n")[0] ?? "");
  if (oneLine.includes("\n")) return oneLine;
  // 여러 줄로 나눠 왔거나 인물이 하나뿐인 경우 — 줄 단위로 읽는다.
  const multi = readPregenLines(candidate);
  return multi || oneLine;
}

/** `이름:` 으로 시작하는 조각. 이름 자리는 짧고 콜론이 없어야 한다(본문 문장 오인 방지). */
const PREGEN_LINE_RE = /^\s*([^:：\n|]{1,40})\s*[:：]\s*(\S.*)$/;

/** 추론 블록 — 일부 모델이 `<think>…</think>` 를 앞에 흘린다(제보). */
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;

/**
 * 한 줄 형식(`이름: 생각 | 이름: 생각`) 읽기.
 *
 * **인물당 한 번만 남긴다.** 줄 형식이 대본과 생김새가 같아, 모델이 목록 대신 주고받는
 * 대화를 수백 줄 쏟아낸 적이 있다(제보). 같은 이름이 다시 나오면 그건 목록이 아니라
 * 대화가 시작된 것이므로 **첫 등장만 취하고 거기서 끝낸다.**
 */
function readPregenEntries(text: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of text.split("|")) {
    const m = chunk.trim().match(PREGEN_LINE_RE);
    if (!m) continue;
    const name = m[1].trim();
    const thought = m[2].trim();
    if (!name || !thought) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) break; // 두 번째 등장 = 대화로 넘어간 것
    seen.add(key);
    out.push(`${name}: ${thought}`);
  }
  return out.join("\n");
}

/**
 * `이름: 생각` 줄 읽기.
 *
 * **형식에 안 맞는 줄이 나오면 거기서 끝낸다** — 목록을 마치고 장면을 이어 쓰는 게
 * 이 호출의 대표적 실패라, 뒤에 붙은 산문을 생각으로 주워 담으면 안 된다.
 * 시작 전의 머리말(빈 줄·`속마음:` 같은 라벨 반복)은 건너뛴다.
 */
function readPregenLines(text: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of stripAfterPregenEnd(text).split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (out.length > 0) break; // 목록이 끝났다
      continue; // 아직 시작 전
    }
    const m = line.match(PREGEN_LINE_RE);
    if (!m) {
      if (out.length > 0) break;
      continue;
    }
    const name = m[1].trim();
    const thought = m[2].trim();
    if (!thought) continue;
    // 같은 이름이 다시 나오면 목록이 아니라 **대화**가 시작된 것이다 — 거기서 끝낸다.
    const key = name.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    out.push(`${name}: ${thought}`);
  }
  return out.join("\n");
}

/**
 * 항목 하나 → `이름: 생각`. 우리가 정한 스키마지만 **키 이름은 관대하게** 읽는다
 * (요약이 문자열/배열을 함께 받아주는 것과 같은 태도) — 모델이 name 을 character 로
 * 쓴 정도로 결과를 통째로 버릴 이유는 없다.
 */
function readPregenItem(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const pick = (keys: string[]): string =>
    keys.map((k) => obj[k]).find((v) => typeof v === "string" && v.trim())?.toString().trim() ??
    "";
  const name = pick(["name", "character", "speaker"]);
  const thought = pick(["thought", "thoughts", "text"]);
  if (!thought) return null;
  return name ? `${name}: ${thought}` : thought;
}

/**
 * 폴백 절단 — 끝 표시 뒤를 버린다. 끝은 닫는 대괄호지만, 펜스로 감싸 온 결과(모델이
 * 제 판단으로 감싸거나 사용자가 세트를 그렇게 고쳐 쓴 경우)도 있어 닫는 펜스를 함께
 * 본다. 끝 표시를 아예 안 내고 장면을 이어 쓰기 시작한 경우를 위해 장면 구분선(`***`)도
 * 끝으로 본다.
 */
function stripAfterPregenEnd(text: string): string {
  let out = text.replace(/^```(?:json)?\s*/i, "");
  const end = [PREGEN_END_MARKER, "```"]
    .map((marker) => out.indexOf(marker))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (end !== undefined) out = out.slice(0, end);
  const divider = out.search(/^\s*\*\*\*\s*$/m);
  if (divider >= 0) out = out.slice(0, divider);
  return out.trim();
}

/** 이중 생성 기본 세트 (메모리 객체) 빌드. */
export function buildPregenPromptPreset(name: string): StellaPromptPreset {
  const raw = defaultPromptRaw();
  const main = raw.prompts.find((p: any) => p.identifier === "main");
  if (main) main.content = PREGEN_MAIN_PROMPT;
  const jailbreak = raw.prompts.find((p: any) => p.identifier === "jailbreak");
  if (jailbreak) jailbreak.content = PREGEN_POST_HISTORY;
  return parseSillyTavernPromptPreset(raw, name);
}

/**
 * 이중 생성이 쓸 프롬프트 세트 id 를 확정한다. 순서대로:
 *
 *  1. 지금 지정된 id 가 **아직 존재하면** 그대로 둔다 (사용자가 고른 세트를 안 바꾼다).
 *  2. 없으면 같은 이름의 기본 세트를 찾아 쓴다 (고쳐 둔 내용을 덮지 않는다).
 *  3. 그것도 없으면 새로 만든다.
 *
 * 2·3 이 필요한 이유: 세트를 지워도 설정에는 **지워진 id 가 그대로 남는다.** 이때
 * "고른 게 없을 때만 만든다"로 판정하면 영영 다시 만들어지지 않아, 사용자가 껐다 켜도
 * 아무 일도 일어나지 않는다(제보). 가리키는 대상이 사라진 id 는 선택이 아니라 유령이다.
 */
export async function resolvePregenPromptSet(
  plugin: StellaEnginePlugin,
  currentId: string | undefined
): Promise<PregenPromptSetChoice | null> {
  try {
    const list = await plugin.store.getPromptPresets();
    if (currentId && list.some((item) => item.preset.meta.id === currentId)) {
      return { id: currentId, builtinDefault: false };
    }
    const found = list.find((item) => item.preset.meta.name === PREGEN_PRESET_NAME);
    if (found) return { id: found.preset.meta.id, builtinDefault: true };
    const created = await plugin.store.createPromptPreset(
      PREGEN_PRESET_NAME,
      buildPregenPromptPreset(PREGEN_PRESET_NAME)
    );
    return { id: created.preset.meta.id, builtinDefault: true };
  } catch (err) {
    console.warn("[GGAI Stella] 이중 생성 기본 프롬프트 세트 준비 실패:", err);
    return currentId ? { id: currentId, builtinDefault: false } : null;
  }
}

export interface PregenPromptSetChoice {
  id: string;
  /**
   * 내장 기본 세트("속마음")로 떨어졌는가. 이때만 그 세트에 맞는 **초기 주입 틀**을
   * 함께 넣어 준다 — 사용자가 자기 세트를 고른 경우엔 용도를 모르므로 틀도 비운다.
   */
  builtinDefault: boolean;
}
