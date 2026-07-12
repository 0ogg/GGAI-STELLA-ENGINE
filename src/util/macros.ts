/**
 * 매크로 치환 — {{char}}, {{user}}, {{description}} 등 ST 표준 텍스트 치환.
 *
 * 알 수 없는 매크로는 원형 그대로 남긴다.
 * 재귀 1회 — 치환된 값 안에 또 매크로가 있으면 한 번 더 풀어준다.
 */

export interface MacroContext {
  char?: string;
  user?: string;
  persona?: string;
  scenario?: string;
  description?: string;
  personality?: string;
  first_message?: string;
  charFirstMessage?: string;
  example_dialogue?: string;
  mesExamples?: string;
  mesExamplesRaw?: string;
  wiBefore?: string;
  wiAfter?: string;
  loreBefore?: string;
  loreAfter?: string;
  anchorBefore?: string;
  anchorAfter?: string;
  system?: string;
  summary?: string;
  charPrompt?: string;
  charInstruction?: string;
  charDepthPrompt?: string;
  charCreatorNotes?: string;
  charVersion?: string;
  lastMessage?: string;
  /** 마지막 노드 이후 경과 표현 (예: "3 hours") — ST {{idle_duration}} 호환. */
  idleDuration?: string;
  variables?: Record<string, string>;
  choices?: Record<string, string>;
}

export interface MacroRange {
  displayFrom: number;
  displayTo: number;
  rawFrom: number;
  rawTo: number;
}

export interface MacroRender {
  text: string;
  displayToRaw: number[];
  macroRanges: MacroRange[];
}

const SUPPORTED_MACROS: ReadonlyArray<keyof MacroContext> = [
  "char",
  "user",
  "persona",
  "scenario",
  "description",
  "personality",
  "first_message",
  "charFirstMessage",
  "example_dialogue",
  "mesExamples",
  "mesExamplesRaw",
  "wiBefore",
  "wiAfter",
  "loreBefore",
  "loreAfter",
  "anchorBefore",
  "anchorAfter",
  "system",
  "summary",
  "charPrompt",
  "charInstruction",
  "charDepthPrompt",
  "charCreatorNotes",
  "charVersion",
  "lastMessage",
  "idleDuration",
];
const SUPPORTED_SET = new Set<string>(SUPPORTED_MACROS);
const MACRO_ALIASES: ReadonlyMap<string, keyof MacroContext> = new Map([
  ...SUPPORTED_MACROS.map((key) => [key.toLowerCase(), key] as const),
  ["charfirstmessage", "charFirstMessage"],
  ["mesexamples", "mesExamples"],
  ["mesexamplesraw", "mesExamplesRaw"],
  ["wibefore", "wiBefore"],
  ["wiafter", "wiAfter"],
  ["lorebefore", "loreBefore"],
  ["loreafter", "loreAfter"],
  ["anchorbefore", "anchorBefore"],
  ["anchorafter", "anchorAfter"],
  ["charprompt", "charPrompt"],
  ["charinstruction", "charInstruction"],
  ["chardepthprompt", "charDepthPrompt"],
  ["charcreatornotes", "charCreatorNotes"],
  ["charversion", "charVersion"],
  ["lastmessage", "lastMessage"],
  ["idle_duration", "idleDuration"],
]);

function resolveMacro(match: string, key: string, ctx: MacroContext): string {
  const k = key.trim();

  const rollMatch = k.match(/^(?:roll|dice):(\d+)d(\d+)$/i);
  if (rollMatch) return rollDice(Number(rollMatch[1]), Number(rollMatch[2]));

  const rangeMatch = k.match(/^random:(-?\d+):(-?\d+)$/i);
  if (rangeMatch) return randomRange(Number(rangeMatch[1]), Number(rangeMatch[2]));

  if (k.startsWith("random::")) {
    return weightedRandom(k.slice("random::".length).split("::"));
  }

  const choiceMatch = k.match(/^choice:(.+)$/);
  if (choiceMatch && ctx.choices) {
    const name = choiceMatch[1].trim();
    return ctx.choices[name] ?? match;
  }

  const setvarMatch = k.match(/^setvar::([^:]+)::([\s\S]*)$/);
  if (setvarMatch && ctx.variables) {
    ctx.variables[setvarMatch[1].trim()] = setvarMatch[2];
    return "";
  }

  const getvarMatch = k.match(/^getvar::(.+)$/);
  if (getvarMatch && ctx.variables) {
    const name = getvarMatch[1].trim();
    return ctx.variables[name] ?? match;
  }

  const addvarMatch = k.match(/^addvar::([^:]+)::(.+)$/);
  if (addvarMatch && ctx.variables) {
    const name = addvarMatch[1].trim();
    const prev = Number.parseFloat(ctx.variables[name] ?? "0");
    const add = Number.parseFloat(addvarMatch[2]);
    ctx.variables[name] = String((Number.isFinite(prev) ? prev : 0) + (Number.isFinite(add) ? add : 0));
    return "";
  }

  const incMatch = k.match(/^incvar::(.+)$/);
  if (incMatch && ctx.variables) {
    const name = incMatch[1].trim();
    const prev = Number.parseFloat(ctx.variables[name] ?? "0");
    ctx.variables[name] = String((Number.isFinite(prev) ? prev : 0) + 1);
    return "";
  }

  const decMatch = k.match(/^decvar::(.+)$/);
  if (decMatch && ctx.variables) {
    const name = decMatch[1].trim();
    const prev = Number.parseFloat(ctx.variables[name] ?? "0");
    ctx.variables[name] = String((Number.isFinite(prev) ? prev : 0) - 1);
    return "";
  }

  if (k.startsWith("//")) return "";

  // ── 시간·날짜 매크로 (ST 호환) ──
  // {{date}}/{{time}} = 로케일 표기, {{weekday}} = 요일 전체 이름,
  // {{isodate}}/{{isotime}} = ISO 형식(로컬 시간대) YYYY-MM-DD / HH:mm:ss.
  if (k === "date") return new Date().toLocaleDateString();
  if (k === "time") return new Date().toLocaleTimeString();
  if (k === "weekday") {
    return new Date().toLocaleDateString(undefined, { weekday: "long" });
  }
  if (k === "isodate") {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (k === "isotime") {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  const macroKey = MACRO_ALIASES.get(k.toLowerCase());
  if (macroKey && SUPPORTED_SET.has(macroKey)) {
    const val = ctx[macroKey];
    return typeof val === "string" ? val : match;
  }
  if (ctx.variables && k in ctx.variables) return ctx.variables[k];
  return match;
}

function replaceSingle(text: string, ctx: MacroContext): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (match, key: string) =>
    resolveMacro(match, key, ctx)
  );
}

function replaceSingleMapped(state: MacroRender, ctx: MacroContext): MacroRender {
  const source = state.text;
  const re = /\{\{([^}]+)\}\}/g;
  let out = "";
  const displayToRaw: number[] = [state.displayToRaw[0] ?? 0];
  const macroRanges: MacroRange[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  const appendUnchanged = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      out += source[i];
      displayToRaw.push(state.displayToRaw[i + 1] ?? state.displayToRaw[i] ?? 0);
    }
  };

  while ((match = re.exec(source))) {
    const from = match.index;
    const to = from + match[0].length;
    appendUnchanged(last, from);

    const rawFrom = state.displayToRaw[from] ?? 0;
    const rawTo = state.displayToRaw[to] ?? rawFrom;
    const replacement = resolveMacro(match[0], match[1], ctx);
    const displayFrom = out.length;
    for (let i = 0; i < replacement.length; i++) {
      out += replacement[i];
      displayToRaw.push(i === replacement.length - 1 ? rawTo : rawFrom);
    }
    macroRanges.push({
      displayFrom,
      displayTo: out.length,
      rawFrom,
      rawTo,
    });
    last = to;
  }

  appendUnchanged(last, source.length);
  return {
    text: out,
    displayToRaw,
    macroRanges: [...state.macroRanges, ...macroRanges],
  };
}

export function applyMacros(text: string, ctx: MacroContext): string {
  return replaceSingle(replaceSingle(text, ctx), ctx);
}

export function renderMacrosWithMap(text: string, ctx: MacroContext): MacroRender {
  const initial: MacroRender = {
    text,
    displayToRaw: Array.from({ length: text.length + 1 }, (_, i) => i),
    macroRanges: [],
  };
  return replaceSingleMapped(replaceSingleMapped(initial, ctx), ctx);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function rollDice(count: number, sides: number): string {
  let total = 0;
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    const roll = Math.floor(Math.random() * sides) + 1;
    rolls.push(roll);
    total += roll;
  }
  return count === 1 ? String(total) : `${rolls.join("+")}=${total}`;
}

function randomRange(a: number, b: number): string {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

function weightedRandom(parts: string[]): string {
  const options = parts
    .map((part) => {
      const atIdx = part.lastIndexOf("@");
      if (atIdx > 0) {
        const weight = Number.parseFloat(part.slice(atIdx + 1));
        if (Number.isFinite(weight) && weight > 0) {
          return { text: part.slice(0, atIdx), weight };
        }
      }
      return { text: part, weight: 1 };
    })
    .filter((option) => option.text.length > 0);

  if (options.length === 0) return "";
  const totalWeight = options.reduce((sum, option) => sum + option.weight, 0);
  let pick = Math.random() * totalWeight;
  for (const option of options) {
    pick -= option.weight;
    if (pick <= 0) return option.text;
  }
  return options[options.length - 1].text;
}
