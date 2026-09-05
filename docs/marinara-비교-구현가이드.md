# Marinara Engine 비교 기반 Stella Engine 구현 가이드

> Marinara Engine (v1.6, https://github.com/Pasta-Devs/Marinara-Engine) 의 구현을 분석해
> Stella Engine에 당장 도입할 수 있는 개선안을 정리한 문서.
>
> **구성**: 기존 기능 업그레이드(최우선) → 신규 기능 도입 → 참고 패턴

---

## Part 1. 기존 기능 업그레이드

### 1.1 컨텍스트 자르기 전략 개선 (context-builder.ts)

**현황**: `buildContext`는 토큰 예산 초과 시 히스토리를 **턴 단위로 통째 제거**한다. 오래된 턴부터 앞쪽을 버리는데, 한 턴이 길면 (예: AI가 2000토큰을 쓴 소설 단락) 예산이 크게 낭비된다.

**Marinara 방식**:
1. 각 메시지에 `contextKind: "prompt" | "history" | "injection"` 태그를 붙인다.
2. 자르기 우선순위: `history` → 비태그 → 시스템 → 가장 큰 메시지 부분 자르기.
3. 부분 자르기: 긴 메시지를 통째로 빼지 않고 **앞 65% + 뒤 35%**만 남기고 중간에 `[Truncated to fit context window]` 삽입.
4. maxTokens(출력 예산)을 동적으로 축소해 입력에 더 많은 공간 확보.

**Stella 적용 방안**:

#### 1.1a. ChatMessage에 contextKind 추가

```ts
// context-builder.ts — ChatMessage 확장
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  source?: ContextSource;
  /** 이 메시지가 어디서 왔는지 — 토큰 초과 시 자르기 우선순위 결정 */
  contextKind?: "prompt"   // 프롬프트/시나리오 — 최후까지 보존
                | "history"  // 채팅 히스토리 — 1순위 자르기 대상
                | "injection"; // 로어북 depth 삽입 — 2순위
};
```

현재 `source.type`이 있지만 이건 출처 라벨이지 자르기 정책이 아니다. `contextKind`를 추가하면 토큰 예산 루프가 명시적으로 판단할 수 있다.

**적용 지점**:
- `fixedMessages`에 push할 때: 프롬프트 text 항목 → `"prompt"`, 마커 치환 결과 → `"prompt"`
- `chatHistory`에서 온 메시지 → `"history"`
- at_depth 로어북 삽입 → `"injection"`

#### 1.1b. 부분 자르기 (Truncation)

현재 코드 (context-builder.ts 422-432행):
```ts
for (let i = chatHistory.length - 1; i >= 0; i--) {
  const m = chatHistory[i];
  const cost = count(m.content);
  if (cost > remaining) {
    droppedLogTurns = i + 1;
    break;  // ← 여기서 통째로 버림
  }
  includedHistory.unshift(m);
  remaining -= cost;
}
```

개선안 — 턴을 통째로 버리지 않고 잘라서 넣기:
```ts
for (let i = chatHistory.length - 1; i >= 0; i--) {
  const m = chatHistory[i];
  const cost = count(m.content);
  if (cost <= remaining) {
    includedHistory.unshift(m);
    remaining -= cost;
    continue;
  }
  // 통째로 넣을 수 없으면 부분 자르기 시도
  if (m.contextKind === "history" && remaining > 100) {
    const truncated = truncateContent(m.content, remaining, count);
    includedHistory.unshift({
      ...m,
      content: truncated,
      source: { ...m.source, detail: "truncated to fit budget" },
    });
    remaining = 0;
  }
  droppedLogTurns = i + 1;
  break;
}
```

`truncateContent` 함수:
```ts
function truncateContent(
  text: string,
  targetTokens: number,
  countTokens: (s: string) => number
): string {
  // 65% 머리 + 35% 꼬리 전략
  const totalChars = text.length;
  let headEnd = Math.floor(totalChars * 0.65);
  let tailStart = Math.floor(totalChars * 0.65);

  // 토큰 예산 안으로 조정
  while (countTokens(text.slice(0, headEnd) + text.slice(tailStart)) > targetTokens && headEnd > 100) {
    headEnd = Math.floor(headEnd * 0.9);
    tailStart = Math.floor(tailStart + (totalChars - tailStart) * 0.1);
  }

  return text.slice(0, headEnd) + "\n\n[...truncated...]\n\n" + text.slice(tailStart);
}
```

#### 1.1c. maxTokens 동적 축소

현재 `tokenBudget`은 입력만의 예산이다. Marinara는 출력 예산(maxTokens)까지 같이 관리한다.

적용: `buildContext` 입력에 `maxOutputTokens?: number`를 추가하고, 히스토리가 예산을 초과하면 maxOutputTokens를 줄여서 공간을 확보.

```ts
export interface ContextBuilderInputV2 {
  // ... 기존 필드 ...
  /** 출력 토큰 예산. 지정하면 초과 시 이것을 줄여서 입력 공간 확보. */
  maxOutputTokens?: number;
}
```

---

### 1.2 로어북 매칭 고도화 (lorebook-match.ts)

**현황**: 재귀 스캔, 확률 게이트, selective 논리, constant는 이미 구현되어 있다.
하지만 다음이 없다:
- **타이밍 상태** (sticky / cooldown / delay)
- **그룹 가중치 선택** (같은 그룹 내 하나만 활성화)

**Marinara 방식**:

#### 타이밍 상태
엔트리마다 이전 활성화 이력을 추적:
- **sticky**: 한 번 활성화되면 N턴 동안 강제 유지 (키워드 매칭 불필요)
- **cooldown**: 한 번 활성화되면 N턴 동안 재활성화 불가
- **delay**: 첫 N턴 동안 활성화 불가

Marinara는 이를 `EntryTimingState` 객체로 관리:
```ts
interface EntryTimingState {
  lastActivatedAt: number;   // 마지막 활성화 턴 (0-based)
  stickyCount: number;       // 남은 sticky 턴 수 (매 턴 -1)
  cooldownRemaining: number; // 남은 cooldown 턴 수
  delayRemaining: number;    // 남은 delay 턴 수
}
```

#### 그룹 가중치
같은 `group` 문자열을 가진 엔트리 중 `groupWeight`가 가장 높은 것만 활성화. 나머지는 무시.

#### Stella 적용 방안

**1단계 — 타입 확장** (`src/types/lorebook.ts`):

```ts
// StellaLorebookEntry에 추가:
/** 활성화 후 N턴 동안 강제 유지. 0=비활성. */
sticky?: number;
/** 활성화 후 N턴 동안 재활성화 금지. 0=비활성. */
cooldown?: number;
/** 첫 N턴 동안 활성화 금지. 0=비활성. */
delay?: number;
```

**2단계 — 매칭 컨텍스트에 타이밍 상태 추가** (`lorebook-match.ts`):

```ts
export interface LorebookMatchContext {
  recentMessages: string[];
  activeText?: string;
  defaultScanDepth?: number;
  /** 현재 턴 번호 (0-based). 타이밍 계산용. */
  turnNumber?: number;
  /** 엔트리별 타이밍 상태 — 호출부가 세션에 저장/복원. */
  timingStates?: Map<string, EntryTimingState>;
}

export interface EntryTimingState {
  lastActivatedAt: number;
  stickyRemaining: number;
  cooldownRemaining: number;
}

export interface LorebookMatchResult {
  matched: MatchedLorebookEntry[];
  /** 업데이트된 타이밍 상태 — 호출부가 다음 턴에 다시 전달. */
  updatedTimingStates: Map<string, EntryTimingState>;
}
```

**3단계 — 매칭 로직에 타이밍 게이트 추가**:

```ts
function passesTimingGate(
  entry: StellaLorebookEntry,
  entryKey: string,
  turnNumber: number,
  states: Map<string, EntryTimingState>
): { pass: boolean; isSticky: boolean } {
  const state = states.get(entryKey);

  // delay: 첫 N턴 동안 금지
  if (entry.delay && entry.delay > 0) {
    if (!state || state.lastActivatedAt === -1) {
      if (turnNumber < entry.delay) return { pass: false, isSticky: false };
    }
  }

  // sticky: 이전 활성화 후 아직 sticky 턴이 남아있으면 강제 활성화
  if (state && state.stickyRemaining > 0) {
    return { pass: true, isSticky: true };
  }

  // cooldown: 이전 활성화 후 아직 cooldown 턴이 남아있으면 금지
  if (state && state.cooldownRemaining > 0) {
    return { pass: false, isSticky: false };
  }

  return { pass: true, isSticky: false };
}
```

**4단계 — 그룹 가중치 선택 (후처리)**:

```ts
function applyGroupSelection(
  matched: MatchedLorebookEntry[]
): MatchedLorebookEntry[] {
  const groups = new Map<string, MatchedLorebookEntry[]>();
  const ungrouped: MatchedLorebookEntry[] = [];

  for (const m of matched) {
    if (!m.entry.group) { ungrouped.push(m); continue; }
    if (!groups.has(m.entry.group)) groups.set(m.entry.group, []);
    groups.get(m.entry.group)!.push(m);
  }

  const result: MatchedLorebookEntry[] = [...ungrouped];
  for (const [, members] of groups) {
    // groupWeight 높은 것 하나만 선택, 동점이면 order 큰 것
    members.sort((a, b) => b.entry.groupWeight - a.entry.groupWeight || b.entry.order - a.entry.order);
    result.push(members[0]);
  }
  return result;
}
```

**5단계 — 호출부(store/session-view)에서 타이밍 상태 유지**:

```ts
// session.meta에 추가:
timingStates?: Record<string, { lastActivatedAt: number; stickyRemaining: number; cooldownRemaining: number }>;

// session-view.ts의 runGeneration에서:
const result = matchLorebookEntries(books, { ... ctx, timingStates });
// result.updatedTimingStates를 session.meta.timingStates에 저장
// 매 생성 전 모든 stickyRemaining / cooldownRemaining을 1 감소
```

**사용자 편의**:
- 사이드바 로어북 편집기의 각 엔트리에 "지속(Sticky)", "쿨다운", "지연(Delay)" 숫자 입력 추가
- 그룹 입력 + 가중치 슬라이더 추가
- 이것들만으로 로어북의 "매번 똑같이 주입되는 단조로움"이 크게 해소됨

---

### 1.3 매크로 시스템 확장 (macros.ts)

**현황**: 10종 기본 치환 + date/time + 재귀 1회. 변수, 무작위, 주사위, 케이스 변환이 없다.

**Marinara 방식**: 순차 파이프라인으로 12단계 해결. 핵심은 **변수 시스템**과 **무작위/주사위**.

#### Stella 적용 방안

**MacroContext 확장**:

```ts
export interface MacroContext {
  // 기존 필드...
  char?: string;
  user?: string;
  scenario?: string;
  description?: string;
  personality?: string;
  first_message?: string;
  example_dialogue?: string;
  wiBefore?: string;
  wiAfter?: string;

  // 새 필드
  /** 읽기/쓰기 가능한 채팅 변수. setvar/getvar/addvar가 여기를 조작. */
  variables?: Record<string, string>;
}
```

**새 매크로 처리 순서** (replaceSingle 내부):

```ts
function replaceSingle(text: string, ctx: MacroContext): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const k = key.trim();

    // ── 주사위: {{roll:NdS}} ──
    const rollMatch = k.match(/^roll:(\d+)d(\d+)$/i);
    if (rollMatch) return rollDice(+rollMatch[1], +rollMatch[2]);

    // ── 무작위 범위: {{random:X:Y}} ──
    const rangeMatch = k.match(/^random:(-?\d+):(-?\d+)$/i);
    if (rangeMatch) return String(randomRange(+rangeMatch[1], +rangeMatch[2]));

    // ── 무작위 선택: {{random::A::B::C}} 또는 {{random::A@2::B@3}} ──
    if (k.startsWith("random::")) {
      const parts = k.slice(8).split("::");
      return weightedRandom(parts);
    }

    // ── 변수 쓰기: {{setvar::name::value}} ──
    const setvarMatch = k.match(/^setvar::([^:]+)::(.+)$/);
    if (setvarMatch && ctx.variables) {
      ctx.variables[setvarMatch[1]] = setvarMatch[2];
      return "";
    }

    // ── 변수 읽기: {{getvar::name}} ──
    const getvarMatch = k.match(/^getvar::(.+)$/);
    if (getvarMatch && ctx.variables) {
      return ctx.variables[getvarMatch[1]] ?? match;
    }

    // ── 변수 누적: {{addvar::name::value}} ──
    const addvarMatch = k.match(/^addvar::([^:]+)::(.+)$/);
    if (addvarMatch && ctx.variables) {
      const prev = parseFloat(ctx.variables[addvarMatch[1]] ?? "0");
      const add = parseFloat(addvarMatch[2]);
      ctx.variables[addvarMatch[1]] = String(prev + (isNaN(add) ? 0 : add));
      return "";
    }

    // ── 변수 증감: {{incvar::name}} / {{decvar::name}} ──
    const incMatch = k.match(/^incvar::(.+)$/);
    if (incMatch && ctx.variables) {
      const v = parseFloat(ctx.variables[incMatch[1]] ?? "0");
      ctx.variables[incMatch[1]] = String(v + 1);
      return "";
    }
    const decMatch = k.match(/^decvar::(.+)$/);
    if (decMatch && ctx.variables) {
      const v = parseFloat(ctx.variables[decMatch[1]] ?? "0");
      ctx.variables[decMatch[1]] = String(v - 1);
      return "";
    }

    // ── 코멘트 제거: {{// ...}} ──
    if (k.startsWith("//")) return "";

    // ── 기존 매크로 (char, user, date, time 등) ──
    if (k === "date") return new Date().toLocaleDateString();
    if (k === "time") return new Date().toLocaleTimeString();
    if (SUPPORTED_SET.has(k as keyof MacroContext)) {
      const val = ctx[k as keyof MacroContext];
      return val != null ? val : match;
    }

    // ── 알 수 없는 매크로: 변수에서 찾기 ──
    if (ctx.variables && k in ctx.variables) return ctx.variables[k];

    return match;
  });
}

// 헬퍼
function rollDice(count: number, sides: number): string {
  let total = 0;
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(Math.random() * sides) + 1;
    rolls.push(r);
    total += r;
  }
  return count === 1 ? String(total) : `${rolls.join("+")}=${total}`;
}

function randomRange(min: number, max: number): string {
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

function weightedRandom(parts: string[]): string {
  const options: { text: string; weight: number }[] = [];
  for (const p of parts) {
    const atIdx = p.lastIndexOf("@");
    if (atIdx > 0) {
      const w = parseFloat(p.slice(atIdx + 1));
      if (!isNaN(w) && w > 0) { options.push({ text: p.slice(0, atIdx), weight: w }); continue; }
    }
    options.push({ text: p, weight: 1 });
  }
  const totalWeight = options.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * totalWeight;
  for (const o of options) {
    r -= o.weight;
    if (r <= 0) return o.text;
  }
  return options[options.length - 1].text;
}
```

**사용자 편의**:
- 프롬프트 텍스트 안에서 `{{roll:1d20}}`로 주사위 → 소설에 무작위성 부여
- `{{setvar::chapter::3}}` / `{{getvar::chapter}}`로 이야기 진행 상태 추적
- `{{random::평온한@@3::긴장된@@2::절망적인@@1}}`로 장면 분위기 무작위 가중 선택
- `{{// 이 부분은 AI에게만 보이는 메모}}`로 주석
- 변수는 세션 레벨에서 유지: `session.meta.variables`에 저장

**데이터 저장**:
```ts
// session.ts — SessionMeta에 추가
/** 매크로 변수 — setvar/getvar가 조작. 세션 저장 시 함께 저장. */
variables?: Record<string, string>;
```

---

### 1.4 프롬프트 시스템 — contextKind 태깅 + 선택 블록

#### 1.4a. contextKind 태깅 (1.1에서 이미 다룸)

추가로: Marinara는 프롬프트 프리셋에 **선택 블록(Choice Block)**이라는 개념이 있다.

#### 1.4b. Choice Block (프리셋 변수)

**Marinara 방식**: 프리셋 수준에서 "POV 선택", "스타일 선택" 같은 변수를 정의. 각 변수는 여러 옵션을 가지고, 사용자가 UI에서 토글. 프롬프트 안에서 `{{choice:POV}}` 같은 매크로로 참조.

**Stella 적용 방안**:

```ts
// prompt.ts에 추가
export interface PromptChoiceBlock {
  id: string;
  name: string;          // "POV", "Writing Style" 등
  multiSelect: boolean;  // 단일 선택 vs 다중 선택
  random: boolean;       // 매 생성마다 무작위 선택
  options: PromptChoiceOption[];
}

export interface PromptChoiceOption {
  id: string;
  label: string;         // "1인칭", "3인칭" 등
  value: string;         // 프롬프트에 삽입될 실제 텍스트
  weight?: number;       // random=true일 때 가중치
}

// StellaPromptPreset에 추가
export interface StellaPromptPreset {
  meta: StellaPromptPresetMeta;
  prompts: StellaPromptItem[];
  /** 사용자 토글 변수. */
  choices?: PromptChoiceBlock[];
}
```

**매크로 연동**: `applyMacros`에서 `{{choice:POV}}` → 선택된 옵션의 value로 치환.

**사이드바 UI**:
- 프롬프트 섹션 아래에 "선택 변수" 접이식 섹션 추가
- 각 ChoiceBlock별로 라디오/체크박스 그룹 렌더
- 선택값은 활성 세션 meta에 저장 (`session.meta.choiceValues?: Record<string, string[]>`)

---

## Part 2. 신규 기능 도입

### 2.1 롤링 요약 (Rolling Summary)

**문제**: 세션이 길어지면 과거 본문이 컨텍스트 예산을 대부분 차지한다. 10만 토큰짜리 소설의 앞부분은 토큰 예산 때문에 잘려나가고, AI가 이전 내용을 잊어버린다.

**Marinara 방식**:
- 전용 에이전트(Automated Chat Summary)가 주기적으로 대화 요약
- 요약은 `chat_summary` 마커로 컨텍스트에 주입
- 일일/주간 요약, 꼬리 메시지 보존

**Stella 적용 방안**:

#### 2.1a. 세션 메타에 요약 필드 추가

```ts
// session.ts — SessionMeta에 추가
/** 이전 본문의 AI 요약. chatSummary 마커에서 참조. */
summary?: string;
/** 요약이 커버하는 범위 (시작 노드 id). 이 노드 이전의 본문은 summary로 대체. */
summaryUpTo?: string;
/** 마지막 요약 생성 시점 (epoch ms). 자동 요약 트리거용. */
summaryUpdatedAt?: number;
```

#### 2.1b. chatSummary 마커 추가

```ts
// prompt.ts — MarkerIdentifier에 추가
export type MarkerIdentifier =
  | ... // 기존 마커
  | "chatSummary";  // 요약 텍스트 삽입 지점

// context-builder.ts — markers 스위치에 케이스 추가
case "chatSummary": {
  const summary = input.summary;
  if (summary?.trim()) {
    fixedMessages.push({
      role: "system",
      content: applyMacros(summary, macroCtx),
      source: { type: "marker", label: "Chat Summary" },
      contextKind: "prompt",
    });
    trace.push({ id: item.id, identifier: item.identifier, included: true });
  } else {
    trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
  }
  break;
}
```

#### 2.1c. 요약 생성 함수

```ts
// src/util/generate-summary.ts (신규 파일)

export interface SummaryInput {
  /** 요약할 본문 텍스트 */
  text: string;
  /** AI 호출 함수 — AIService.chatStream 래핑 */
  generate: (prompt: string) => Promise<string>;
  /** 기존 요약 (누적 요약용) */
  previousSummary?: string;
  /** 최대 요약 길이 (토큰) */
  maxTokens?: number;
}

export async function generateSummary(input: SummaryInput): Promise<string> {
  const systemPrompt = `당신은 소설 요약 도우미입니다. 주어진 소설 본문을 간결하게 요약하세요.
중요한 규칙:
- 등장인물, 장소, 중요 사건, 감정적 전환점을 포함하세요.
- 현재 진행 중인 플롯 라인과 미해결 갈등을 명시하세요.
- 서술 스타일이나 분위기의 변화가 있다면 언급하세요.
${input.previousSummary ? `- 이전 요약도 참고하여 연속성을 유지하세요.\n- 이전 요약: ${input.previousSummary}` : ""}`;

  const userPrompt = `다음 소설 본문을 요약하세요:\n\n${input.text}`;

  return input.generate(`${systemPrompt}\n\n${userPrompt}`);
}
```

#### 2.1d. 자동 요약 트리거

```ts
// session-view.ts의 runGeneration 후반에 추가

// 요약 트리거 조건:
// - summary 마커가 활성 프리셋에 있고
// - 마지막 요약 이후 N턴 이상 누적되었고
// - 잘린 턴 수가 > 0 이면 (즉 컨텍스트에 다 안 들어감)
async function maybeUpdateSummary(session: StellaSession, store: StellaStore, ai: AIService) {
  const summaryTurnThreshold = 20; // 설정 가능하게
  const nodesSinceSummary = /* summaryUpTo 이후 노드 수 계산 */;

  if (nodesSinceSummary < summaryTurnThreshold) return;
  if (!droppedLogTurns || droppedLogTurns === 0) return; // 다 들어가면 요약 불필요

  // 요약 생성은 백그라운드로 (사용자 블로킹 방지)
  const textToSummarize = /* summaryUpTo부터 특정 지점까지의 본문 */;
  const summary = await generateSummary({
    text: textToSummarize,
    generate: (prompt) => ai.chat({ messages: [{ role: "user", content: prompt }] }),
    previousSummary: session.meta.summary,
  });

  session.meta.summary = summary;
  session.meta.summaryUpTo = /* 현재 시점 노드 id */;
  session.meta.summaryUpdatedAt = Date.now();
  await store.saveSession(sessionFile, session);
}
```

**사용자 편의**:
- 우측 사이드바 "기본" 탭에 **요약 섹션** 추가
  - 현재 요약 내용 표시 (읽기 전용 textarea)
  - "요약 갱신" 버튼 (수동 트리거)
  - 마지막 갱신 시간 표시
  - 자동 요약 토글 + 턴 임계값 설정
- 프롬프트 편집기에서 `chatSummary` 마커를 드래그해 원하는 위치에 배치

---

### 2.2 에이전트 시스템 v1

**Marinara 방식**: 25+ 내장 에이전트, 3단계 파이프라인:
1. **pre_generation**: 프롬프트 수정 (Prose Guardian, Narrative Director)
2. **parallel**: 메인 생성과 동시 실행 (Echo Chamber)
3. **post_processing**: 결과 분석/수정 (Expression Engine, Quest Tracker)

핵심 최적화: 같은 모델을 쓰는 에이전트들을 **하나의 LLM 호출로 합치고** XML로 결과 분리.

**Stella 적용 방안** (v1: 최소 2개 에이전트):

#### 2.2a. 에이전트 타입 정의

```ts
// src/types/agent.ts (신규 파일)

export type AgentPhase = "pre_generation" | "post_processing";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  phase: AgentPhase;
  enabledByDefault: boolean;
  /** 에이전트 시스템 프롬프트 템플릿. {{mainResponse}} 등의 플레이스홀더 포함. */
  promptTemplate: string;
}

export interface AgentResult {
  agentId: string;
  /** pre: 프롬프트에 주입할 텍스트. post: 분석 결과 텍스트. */
  output: string;
  tokensUsed: number;
}

export const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: "prose-guardian",
    name: "문체 수호자",
    description: "생성된 텍스트의 문체 품질을 검사하고 피드백을 제공합니다.",
    phase: "post_processing",
    enabledByDefault: false,
    promptTemplate: `당신은 소설 문체 편집자입니다. 다음 생성된 텍스트를 분석하세요:

<generated_text>
{{mainResponse}}
</generated_text>

다음 기준으로 평가하세요:
1. 반복 표현 (같은 단어/구문의 과도한 반복)
2. 비유/은유의 과도한 사용
3. 서술 리듬의 단조로움 (문장 길이 다양성)
4. 시점 일관성
5. "AI스러운" 클리셰 표현 (눈부시게, 미소를 지으며 등)

JSON 형식으로 응답:
{"score": 1-10, "issues": ["문제1", "문제2"], "suggestion": "개선 제안"}`,
  },
  {
    id: "continuity-checker",
    name: "연속성 검사",
    description: "이전 내용과의 모순을 감지합니다.",
    phase: "post_processing",
    enabledByDefault: false,
    promptTemplate: `당신은 소설 연속성 검사자입니다.

<recent_context>
{{recentContext}}
</recent_context>

<generated_text>
{{mainResponse}}
</generated_text>

생성된 텍스트가 최근 컨텍스트와 모순되는지 검사하세요:
- 등장인물 이름/외모/성격 일관성
- 시간/장소 논리
- 이전에 언급된 사실과 충돌
- 물리적 불가능한 상황

JSON 형식으로 응답:
{"consistent": true/false, "contradictions": ["모순1"], "severity": "none"|"minor"|"major"}`,
  },
  {
    id: "narrative-director",
    name: "서술 디렉터",
    description: "생성 전에 서술 방향을 안내하는 컨텍스트를 주입합니다.",
    phase: "pre_generation",
    enabledByDefault: false,
    promptTemplate: `현재 소설의 서술 상태를 분석하고, 다음 생성에 방향성을 제시하세요.

<recent_text>
{{recentContext}}
</recent_text>

<writing_style>
{{style}}
</writing_style>

다음을 고려하세요:
- 현재 장면의 긴장감 수준 (상승/유지/하강)
- 다음 장면 전환이 필요한지
- 미해결 갈등 상태
- 독자의 몰입을 위한 제안

한두 문장으로 다음 생성 방향을 제시하세요.`,
  },
];
```

#### 2.2b. 에이전트 실행기

```ts
// src/services/agent-runner.ts (신규 파일)

import type { AgentDefinition, AgentResult } from "../types/agent";
import type { AIService } from "./ai-service";

export interface AgentRunContext {
  /** post_processing용: 메인 AI 생성 결과 */
  mainResponse?: string;
  /** pre_generation/post_processing 공통: 최근 컨텍스트 (이전 본문) */
  recentContext?: string;
  /** 서술 스타일 (시나리오 description/personality 기반) */
  style?: string;
  /** 중단 시그널 */
  signal?: AbortSignal;
}

export async function runAgent(
  agent: AgentDefinition,
  ctx: AgentRunContext,
  ai: AIService,
  profileId?: string
): Promise<AgentResult> {
  // 템플릿 변수 치환
  let prompt = agent.promptTemplate
    .replace(/\{\{mainResponse\}\}/g, ctx.mainResponse ?? "")
    .replace(/\{\{recentContext\}\}/g, ctx.recentContext ?? "")
    .replace(/\{\{style\}\}/g, ctx.style ?? "");

  const response = await ai.chat({
    messages: [{ role: "user", content: prompt }],
    profileId,
    maxTokens: 500,   // 에이전트는 짧은 응답
    temperature: 0.3, // 낮은 온도로 일관성 유지
  });

  return {
    agentId: agent.id,
    output: response.content,
    tokensUsed: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
  };
}

/** 같은 모델을 쓰는 에이전트들을 하나의 호출로 합치기 (Marinara 배치 패턴) */
export async function runAgentBatch(
  agents: AgentDefinition[],
  ctx: AgentRunContext,
  ai: AIService,
  profileId?: string
): Promise<AgentResult[]> {
  if (agents.length === 1) {
    const result = await runAgent(agents[0], ctx, ai, profileId);
    return [result];
  }

  // 배치: 각 에이전트 프롬프트를 XML 섹션으로 구분
  const batchPrompt = agents.map((a) => {
    let p = a.promptTemplate
      .replace(/\{\{mainResponse\}\}/g, ctx.mainResponse ?? "")
      .replace(/\{\{recentContext\}\}/g, ctx.recentContext ?? "")
      .replace(/\{\{style\}\}/g, ctx.style ?? "");
    return `<agent_task id="${a.id}">\n${p}\n</agent_task>`;
  }).join("\n\n");

  const batchInstruction = `다음 ${agents.length}개의 에이전트 작업을 수행하세요.
각 작업의 결과를 <agent_output id="작업ID">...</agent_output> XML 태그로 감싸서 응답하세요.\n\n`;

  const response = await ai.chat({
    messages: [{ role: "user", content: batchInstruction + batchPrompt }],
    profileId,
    maxTokens: 500 * agents.length,
    temperature: 0.3,
  });

  // XML 파싱으로 개별 결과 분리
  return agents.map((a) => {
    const regex = new RegExp(`<agent_output id="${a.id}">([\\s\\S]*?)<\\/agent_output>`);
    const match = response.content.match(regex);
    return {
      agentId: a.id,
      output: match?.[1]?.trim() ?? response.content,
      tokensUsed: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
    };
  });
}
```

#### 2.2c. 생성 파이프라인에 에이전트 통합

```ts
// session-view.ts의 runGeneration 수정

async runGeneration() {
  const activeAgents = /* 활성 세션의 활성화된 에이전트 목록 */;
  const preAgents = activeAgents.filter(a => a.phase === "pre_generation");
  const postAgents = activeAgents.filter(a => a.phase === "post_processing");

  // 1. pre_generation 에이전트 실행
  let preInjection = "";
  if (preAgents.length > 0) {
    const results = await runAgentBatch(preAgents, {
      recentContext: getRecentText(5), // 최근 5턴
      style: `${scenario.description}\n${scenario.personality}`,
    }, this.plugin.ai);
    preInjection = results.map(r => r.output).join("\n\n");
    // → 이것을 buildContext 입력의 systemPrompts 끝에 추가
  }

  // 2. 메인 생성 (기존 로직)
  const context = buildContext({ ...input });
  if (preInjection) {
    context.messages.push({
      role: "system",
      content: preInjection,
      source: { type: "prompt", label: "Agent: narrative direction" },
    });
  }
  const mainResponse = await streamGenerate(context);

  // 3. post_processing 에이전트 실행 (백그라운드)
  if (postAgents.length > 0) {
    runAgentBatch(postAgents, {
      mainResponse,
      recentContext: getRecentText(5),
    }, this.plugin.ai).then(results => {
      // 결과를 우측 사이드바 "에이전트" 탭에 표시
      this.showAgentResults(results);
    });
  }
}
```

**사용자 편의**:
- 우측 사이드바에 **"에이전트" 탭** 추가 (또는 "기본" 탭 내 접이식 섹션)
  - 각 에이전트별 on/off 토글
  - post_processing 결과 표시 (문체 점수, 연속성 경고 등)
  - pre_generation 결과는 투명하게 작동 (방향성 주입)
- 에이전트 활성 상태는 활성 세션 meta에 저장
  ```ts
  // session.ts — SessionMeta에 추가
  enabledAgents?: string[]; // 활성화된 에이전트 id 목록
  ```

---

### 2.3 캐릭터 표현/초상화 시스템 (Expression System)

**Marinara 방식**: 캐릭터 카드에 "표정" 스프라이트 세트를 저장. Expression Engine 에이전트가 생성된 텍스트를 분석해 적절한 표정을 선택. UI에 캐릭터 초상화가 표정에 따라 바뀜.

**Stella 적용 방안** (간소화):

옵시디언에서 이미지 표시가 가능하므로, 캐릭터 초상화를 상황에 따라 바꾸는 기능을 구현할 수 있다.

#### 데이터 모델

```ts
// scenario.ts — extensions.stella에 추가
interface StellaScenarioExtension {
  // 기존 필드...
  /** 캐릭터 표정 세트. 폴더 내 상대 경로. */
  expressions?: Record<string, string>; // {"neutral": "expr/neutral.png", "happy": "expr/happy.png", ...}
  /** 현재 표정. */
  currentExpression?: string;
}
```

#### 구조

```
GGAI/SCENARIOS/[시나리오명]/
├── scenario.json
├── thumbnail.png
├── expr/
│   ├── neutral.png
│   ├── happy.png
│   ├── sad.png
│   └── angry.png
└── SESSIONS/
```

#### 자동 표정 선택 (에이전트 기반)

Expression Engine 에이전트를 추가:
```ts
{
  id: "expression-engine",
  name: "표현 엔진",
  phase: "post_processing",
  promptTemplate: `생성된 텍스트에서 캐릭터의 감정 상태를 파악하세요.

<generated_text>
{{mainResponse}}
</generated_text>

사용 가능한 표정: {{availableExpressions}}

JSON으로 응답: {"expression": "표정이름", "confidence": 0.0-1.0}`,
}
```

#### UI

- 세션 뷰 헤더의 썸네일이 표정에 따라 바뀜
- 우측 사이드바 시나리오 탭에서 표정 수동 선택 드롭다운

**우선순위**: 낮음. 있으면 좋지만 소설 생성 핵심 기능은 아님.

---

## Part 3. 참고: Marinara의 특이 패턴

### 3.1 에이전트 배치 (Agent Batching)

같은 LLM 공급자+모델을 쓰는 에이전트들을 하나의 API 호출로 합치는 기법:

```
에이전트 A (temperature=0.3, model=X)
에이전트 B (temperature=0.3, model=X)
에이전트 C (temperature=0.3, model=X)
→ 하나의 프롬프트로 합쳐서 1회 API 호출
→ 결과를 XML 태그로 분리
```

Stella에서 GGAI Core 경유로 에이전트를 실행할 때, Core의 `chat()` 호출 1번이 곧 API 요청 1번이므로, 여러 에이전트를 합치는 것이 비용/지연 최적화에 중요하다.

### 3.2 지연된 매크로 해결 (Deferred Macro Resolution)

Marinara는 `{{char}}` 등을 내부 제어 토큰(`\x1eMARINARA_DEFERRED_\x1f`)으로 치환해 두고, 화자가 확정된 후에 실제 값으로 치환하는 패턴을 쓴다.

→ Stella는 현재 단일 캐릭터만 다루므로 불필요. 향후 멀티캐릭터 지원 시 참고.

### 3.3 contextKind 기반 자르기 우선순위

Marinara의 자르기 정책:
1. `contextKind="history"` 메시지를 오래된 것부터 제거
2. 태그 없는 비시스템 메시지 제거
3. 시스템 메시지 제거 (인덱스 0은 항상 보존)
4. 가장 큰 메시지를 65:35로 자르기
5. maxTokens를 줄여서 입력 공간 확보

→ Part 1.1에서 이미 다룸.

---

## Part 4. 구현 순서 제안

### Phase 1 (기존 기능 업그레이드 — 작업량 적음)

| 순서 | 항목 | 파일 | 예상 규모 |
|---|---|---|---|
| 1 | 매크로 확장 (변수/무작위/주사위) | macros.ts + session.ts | ~100행 |
| 2 | 로어북 그룹 가중치 선택 | lorebook-match.ts | ~30행 |
| 3 | 로어북 타이밍 상태 | lorebook-match.ts + lorebook.ts + session.ts | ~120행 |
| 4 | contextKind 태깅 | context-builder.ts | ~50행 수정 |

### Phase 2 (기존 기능 업그레이드 — 작업량 보통)

| 순서 | 항목 | 파일 | 예상 규모 |
|---|---|---|---|
| 5 | 컨텍스트 부분 자르기 | context-builder.ts | ~80행 |
| 6 | maxTokens 동적 축소 | context-builder.ts | ~30행 |
| 7 | Choice Block | prompt.ts + macros.ts + 사이드바 UI | ~150행 + UI |

### Phase 3 (신규 기능)

| 순서 | 항목 | 파일 | 예상 규모 |
|---|---|---|---|
| 8 | 롤링 요약 — 마커 + 생성 함수 | prompt.ts + generate-summary.ts + context-builder.ts | ~100행 |
| 9 | 롤링 요약 — UI + 자동 트리거 | session-view.ts + 사이드바 UI | ~150행 + UI |
| 10 | 에이전트 v1 — 타입 + 실행기 | agent.ts + agent-runner.ts | ~200행 |
| 11 | 에이전트 v1 — 파이프라인 통합 + UI | session-view.ts + 사이드바 UI | ~200행 + UI |

### Phase 4 (선택)

| 순서 | 항목 |
|---|---|
| 12 | 캐릭터 표현 시스템 |
| 13 | CHARX 임포트 |
| 14 | 시맨틱 로어북 매칭 (GGAI Core 임베딩 API 필요) |

---

## 부록: Marinara vs Stella 기능 비교표

| 기능 | Marinara | Stella 현황 | 개선 필요도 |
|---|---|---|---|
| 세션 모델 | 평면 + 스와이프 | 델타/패치 트리 | — (Stella가 우위) |
| 토큰 정확도 | 4자=1토큰 근사 | 실제 토크나이저 | — (Stella가 우위) |
| 저장 방식 | SQLite | 파일 (JSON) | — (Stella가 우위) |
| CC 스펙 | V2 | V3 | — (Stella가 우위) |
| 로어북 재귀 | O (깊이 3) | O | — (동등) |
| 로어북 확률 | O | O | — (동등) |
| 로어북 selective | AND/NOT | AND/NOT | — (동등) |
| 로어북 타이밍 | sticky/cooldown/delay | X | **높음** |
| 로어북 그룹 가중치 | O | X (필드만 있고 로직 없음) | **높음** |
| 로어북 시맨틱 | O (임베딩) | X | 낮음 |
| 컨텍스트 자르기 | 부분 자르기 + contextKind | 턴 단위 통째 제거 | **높음** |
| maxTokens 동적 | O | X | 중간 |
| 매크로 변수 | setvar/getvar/addvar | X | **높음** |
| 매크로 무작위 | random/roll/dice | X | **높음** |
| Choice Block | O | X | 중간 |
| 롤링 요약 | O (에이전트) | X | **높음** |
| 에이전트 | 25+ (3단계) | X | **높음** (최소 2-3개) |
| 캐릭터 표현 | O (스프라이트) | X | 낮음 |
| 임포트 | ST + 봇브라우저 | ST + NAI + CC | — (충분) |
