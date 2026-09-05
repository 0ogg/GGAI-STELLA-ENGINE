# CLAUDE.md

> Claude Code와 Codex가 함께 쓰는 프로젝트 작업 가이드. 오래된 로드맵이나 폐기된 규칙을 남기지 않는다.
> Codex 진입점은 `AGENTS.md`(이 파일을 가리키는 얇은 문서). 규칙 본문은 이 파일이 단일 진실 소스다.
>
> **이 파일은 "항상 지켜야 하는 규칙"만 담는다.** 사고 교훈은 `회귀금지.md`, 기능별 구현 상태·배선은 `구현현황.md` — 해당 영역을 만질 때 그쪽을 읽는다. 이 파일에 날짜 붙은 서사·변경 이력을 쌓지 않는다.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 3.5 Preserve User Workflow

**A fix that destroys the user's working context is usually not a fix.**

Before changing UI, state flow, storage, generation, imports, or editor behavior:
- Identify the user's active workflow and the state they may have set up: scroll position, open tabs, collapsed sections, focus, draft input, selected node/session, filters, sort order, and unsaved edits.
- Do not solve synchronization, refresh, validation, migration, or display problems by wiping and rebuilding broad UI/state unless the user explicitly asked for that behavior or the underlying object was deleted.
- Prefer narrow update methods that preserve object identity and user-owned UI state. Add or use local `setActive...`, `refresh...`, `sync...`, or patch methods instead of replacing whole views.
- Do not add buttons, modes, panels, execution flows, or alternate display surfaces that were not requested, even if they seem useful for the feature.
- If the simple implementation would break user context, stop and choose a narrower implementation. If no narrow implementation is clear, report the tradeoff instead of guessing.
- Success criteria must include "the user's current workspace context is preserved", not only "build passes" or "the data updates".

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

# GGAI Stella Engine — 공통 작업 가이드

## 세션 시작과 공유 범위

- 새 세션은 이 파일을 읽고 `git status --short`로 기존 변경을 확인한 뒤, 요청 영역의 `회귀금지.md`·`구현현황.md`·스펙을 읽는다. 다른 세션이나 사용자의 미커밋 변경을 덮어쓰거나 되돌리지 않는다.
- 같은 프로젝트의 Claude Code는 `CLAUDE.md`, Codex는 `AGENTS.md`를 진입점으로 사용한다. 규칙 사본이나 도구별 인계 문서를 따로 만들지 않는다.
- 대화 기록과 도구별 개인 메모리는 공통 문서를 대신하지 않는다. 다음 세션에도 필요한 확정 결정·남은 작업·검증 여부는 해당 스펙 또는 `구현현황.md`의 기존 섹션에 최신 상태로 갱신한다. 날짜별 일지는 쌓지 않는다.
- 공유 지침·스펙은 Git 관리 대상이다. 같은 폴더의 세션은 저장한 내용을 읽을 수 있지만, 별도 worktree·클론·다른 PC에는 커밋을 반영해야 전달된다. 이미 진행 중인 세션도 변경된 지침을 작업 전에 다시 읽는다.
- `.claude/settings.local.json`의 개인 권한·훅과 환경변수는 로컬 설정이다. Codex에 자동 적용된다고 가정하지 않는다. 계정 전역 설정에 이 프로젝트의 규칙을 복사하지 않는다.
- 문서나 설정만 바꾼 작업은 링크·설정 구문·공유 대상 여부를 검증한다. 기능 변경이 없으면 커뮤니티 패치노트를 채우거나 vault 설치·수동 UI 검증을 완료했다고 기록하지 않는다.

## 프로젝트 개요

옵시디언 플러그인. NovelAI 홈페이지의 '스토리텔러' 서비스 형식의 소설 생성을 다양한 API로 할 수 있게 해주는 것이 목표. 실리태번/NovelAI 파일 임포트·익스포트, 브랜치 세션, 로어북, 에이전트를 제공한다.

**과거 두 번 실패한 프로젝트**. 이번에는 작게 쪼개 한 덩어리씩 완성하며 쌓아올린다. 무리하지 말고, 한 번에 한 단계만.

## 의존 플러그인

- **GGAI Core** (`../obsidian-ggai-core` 별도 레포, 이미 배포됨)
  - 이 플러그인의 모든 AI 호출은 GGAI Core API를 통해 한다 (`app.plugins.plugins["ggai-core"].api`)
  - 제공 기능: `generate()`, `chat()`, `chatStream()`, `image()`, `tts()`, `stt()`, `agent()`, `registerTool()`, `countTokens()`, `on("profiles-changed")`
  - 완전한 레퍼런스: Core 레포의 `PLUGIN-API-Guide for creater.md` (`../obsidian-ggai-core/`)
  - **이 플러그인에서 직접 API 키, 프로바이더 어댑터를 구현하지 않는다.** 전부 Core 경유.

---

## 작업 원칙 (모든 단계 공통)

### 1. 에이전트 실행 가능성 염두
새 함수를 쓸 때마다 "**나중에 GGAI Core의 `agent()` tool로 노출할 가치가 있는가?**"를 판단한다. 가치가 있다면: 순수 함수화(인자 → 결과), JSON-직렬화 가능한 입출력, 부작용은 명시적 인자로(vault 파라미터), 에러는 throw 대신 `{ ok, errors[] }` 결과 객체. 예시: `src/util/ensure-folders.ts` `ensureBaseFolders(vault)`.

### 2. 국소 완성
한 단계가 **빌드 → 테스트 vault 설치 → 수동 확인**까지 끝나야 다음 단계로 넘어간다. 여러 단계를 동시에 만들지 않는다.

### 3. 이전 실패 코드 탐색 금지
같은 구상의 이전 플러그인 코드가 다른 폴더에 있지만 **절대 뒤지지 않는다** (할당량 낭비 + 혼란). 이 레포 안의 정보만으로 판단.

### 4. 폴더명/식별자는 영어
사용자 노출 텍스트는 한국어 OK, 파일/폴더/변수는 영어.

### 5. 데이터 형식 선호
이미 JSON 스키마로 확정된 엔티티(session, scenario, prompt preset, lorebook, preset, media 등)는 JSON 단일 파일 정책을 유지한다. 새 데이터는 옵시디언에서 직접 편집 가능한 형식을 우선 고려하되, 라운드트립 보존·깊은 구조·외부 포맷 호환이 중요하면 JSON을 쓴다.

### 6. State 규약
모든 데이터 mutation 은 **`StellaStore` 경유**. View 에서 `vault.modify` / `vault.create` / `vault.trash` 등 직접 호출 **금지**.

- 조회: `await store.getScenarios()` / `getSessions(folder)` / `getSession(file)` (캐시 우선). 변경: store 메서드만. 임포트/복사도 예외 없음(`store.importFile`, `store.copyScenarioForSession`).
- 구독: `this.registerEvent(store.on("scenarios-changed" | "sessions-changed" | "session-changed" | …, cb))`.
- **session-changed 는 detail(kinds/origin)을 실어 나른다** — 자기 에코 skip과 settings-only 국소 갱신은 이 방식만 쓴다(`suppressOwn*` 수동 플래그 금지). 상세 배선은 `구현현황.md` "재렌더 아키텍처".
- 삭제/이동도 실시간 UI 반영이 기본: 열려 있는 session/scenario 가 외부에서 삭제되면 관련 뷰가 즉시 비우거나 다른 활성 상태로 전환. activeLeaf/sessionFile 고아 금지.
- UI 동기화는 **국소 갱신**이 원칙: 통짜 `empty()`/전체 reload 금지, 스크롤·접힘·포커스·편집 중 값 보존. 전체 렌더는 DOM 소유권이 실제로 바뀔 때만.
- 실시간 반영 구현 전에 기존 전파 경로(store 이벤트, `PluginData.current`, active settings plumbing, `setActive...`/`refresh...`/`sync...`)를 먼저 확인한다. "렌더링 때만 새로 읽는" 방식 금지.

### 7. AI 호출 규약
모든 AI 호출은 **`AIService` (`plugin.ai`) 경유**. View 에서 `app.plugins.plugins["ggai-core"]` 직접 접근 **금지**.

- 가용성 `ai.isAvailable()` 호출 전 체크. 프로필 `ai.listChatProfiles()`/`getDefaultChatProfile()`. 호출 `ai.chat(req)`/`chatStream(req)`. 토큰 `ai.countTokens()`(동기, 근사). 구독 `ai.on("profiles-changed" | "core-availability-changed", cb)`.
- **"생성 중" 토스트를 우리가 띄우지 않는다.** Core 가 Core 를 쓰는 모든 플러그인의 진행 토스트를 **자기가 책임지고** 띄운다 — 요청에 넘긴 `label` 과 실제로 요청을 보낸 모델명을 함께(`라벨 (모델명)`). 우리가 또 띄우면 같은 작업에 토스트가 두 개 뜬다. 새 AI 호출을 넣을 때 할 일은 **`label` 을 사람이 읽을 이름으로 채우는 것뿐**이고, `new Notice("…생성 중…")` 류로 감싸지 않는다.
  - 같은 서비스를 여러 화면이 공유하면 **`label` 로 구별**한다(예: `"번역 (스텔라 폰 SNS 피드)"`) — 토스트가 사라진 자리를 안내 문구가 아니라 라벨이 메운다. 호출자가 라벨을 넘길 수 있게 서비스 시그니처에 선택 인자를 둔다(`translation.translateItems(..., label?)`).
  - **예외 = 진행도**: `3/12` 처럼 Core 가 모르는 우리 쪽 진행 상황(청크 단위 일괄 번역 등)은 우리가 띄운다(`session-view` 의 `번역 중... done/total 문단`). 실패/결과 안내 Notice 도 우리 몫.
- 컨텍스트 조립: `src/util/context-builder.ts` `buildContext(ContextBuilderInputV2)` (순수 함수). 세션 연동 래퍼는 `src/util/build-session-context.ts`.
- **전송본 단일 진실 소스 (대전제, 절대 깨지 않음)**: 세션 → "API 에 보낼 그 내용"은 오직 `planSessionRequest()` 한 곳. 실제 생성과 미리보기는 같은 payload 를 쓰고, 미리보기는 전송본과 **byte 단위로 같아야** 한다. 빌드 전 열린 세션창의 미저장 편집 flush(`plugin.flushSessionEdits`). 전송 직전 가공을 추가하면 미리보기 경로에도 동일 반영.
- 새 view 는 plugin 인스턴스를 주입받아 `plugin.store` / `plugin.ai` 둘 다 접근.

### 8. SillyTavern 호환 규칙

- ST 에 같은 역할의 macro, identifier, 프롬프트 개념, 동작이 이미 있으면 ST 호환 이름과 동작을 쓴다. 같은 것에 Stella 전용 식별자를 새로 만들지 않는다.
- 내부 파일 형식, prompt marker, macro 동작, 프롬프트 순서, 로어북 매칭 의미, import/export shape 는 ST 호환 우선.
- 사용자 노출 UI 용어는 Stella 의 `시나리오`, `로어북`, `세션`(내부 포맷이 character card/world info/chat 이어도 UI 명칭 불변).
- Stella 전용 prompt marker 금지(특히 `personaDescription`). 페르소나는 `{{persona}}` 매크로(명시 위치 존중, 재삽입 안 함) 또는 기본 위치(캐릭터 설명 앞) 자동 삽입.
- 유저 카드 일반 클릭 = 활성 유저 선택. 에디터 열기는 별도 편집 버튼/메뉴에서만.
- 새 prompt/docs 는 `{{loreBefore}}`/`{{loreAfter}}` 선호, `{{wiBefore}}`/`{{wiAfter}}` 는 backward-compatible alias 로만.
- **QR·슬래시 커맨드·매크로를 만지기 전에 원본 소스를 받아서 읽는다. 예외 없다.**
  기억이나 추론으로 동작을 정하지 않는다. 자료가 없으면 **그 자리에서 조사해 와서 이 규칙 아래에 추가한다**
  (앞으로 새로 추가되는 커맨드도 같다 — 조사 없이 구현 금지).
  - ST 본체: `SillyTavern/public/scripts/slash-commands.js`(대부분), `variables.js`(`/setvar` `/if` `/rand` 등 변수·연산),
    브랜치는 `release`. 커맨드 정의에 `namedArgumentList` / `unnamedArgumentList` / `helpString` /
    **`returns`(파이프에 무엇을 넘기는지)** 가 다 들어 있다 — 인자 목록과 기본값을 **눈으로 확인**한다.
  - 서드파티: LALib(`LenAnderson/SillyTavern-LALib`, `index.js` + README) — `/re-exec` `/re-replace`
    `/getat` `/setat` `/download` 등은 ST 본체가 아니라 여기다. 출처를 혼동하지 않는다.
  - 받는 법: `gh api repos/<owner>/<repo>/contents/<path> --jq '.download_url' | xargs curl -sL -o <파일>`
  - 확인할 것 4가지: **인자 이름·기본값 / 반환값 / 취소·실패 시 동작 / 결과가 어디에 남는가**(입력창·대화 로그·파이프).
  - 원본과 다르게 하기로 정했으면 **왜 다른지**를 `QR 스펙.md` 에 적는다. "우리 저장 구조 사정"과
    "원본에 없는 기능"은 다른 항목이다 — 섞어서 "차이점"이라고 쓰지 않는다.

- **서드파티 확장의 태그·매크로·커맨드는 원본을 확인하고 구현한다.** 카드 안 설명글이나 로어북 지시문만 보고 동작(경로 규칙, 매칭 방식 등)을 지어내지 않는다 — 남의 생태계와 맞물리는 부분이라 우리가 정한 규칙은 곧 호환 불가다. 확인이 불가능하면 사용자에게 출처를 묻는다. 원본과 일부러 다르게 했거나 일부만 구현했으면 `구현현황.md`/스펙 문서에 "원본에는 있음 / 우리 추가"로 명시한다.
- 사용자가 반복되는 프로젝트 규칙을 교정하면 기억에 의존하지 말고 이 파일(또는 회귀금지.md)을 즉시 갱신한다.

### 9. UI 범위와 함수 구조

- 사용자가 요구하지 않은 UI, 버튼, 탭, 모달, 툴바, 분할창, 표시 모드, 실행 플로우를 추가하지 않는다. 미싱링크로 새 UI 가 필요해 보이면 구현 전에 확인한다(스키마·순수 로직 먼저, UI 는 다음 단계 가능).
- 계획이 디테일하고 확실한 부분부터 구현한다. 문서의 최종 구상이 있어도 현재 요청 범위를 넘어 앞당기지 않는다.
- 같은 저장/조회/동기화/렌더 보조 로직을 다시 쓰지 않는다. 기존 store 메서드, util, section helper, event plumbing 을 먼저 찾아 재사용·확장. 요청 범위를 넘는 대형 리팩터링은 하지 않는다.
- **입력 중 재렌더 가드는 공용 `src/views/edit-guard.ts` `EditGuard` 만 쓴다.** 손 복붙 금지 — 사고 이력과 상세 규칙은 `회귀금지.md`.
- 세션창과 파생 표시(번역 보기 등)는 **직접 편집이 기본 모드** — 읽기 전용 표시/별도 편집 버튼·모달·모드 금지. 본문을 고치면 즉시 노드/variant 로 저장.
- 미디어(번역/삽화) 생성물은 저장(JSON)과 표시 계층을 분리한다. JSON 만으로 외부 UI 플러그인을 만들 수 있을 만큼 분리 유지.
- 설정 UI 는 공용 컨트롤 킷(`detail/setting-controls.ts`, 미디어류는 `detail/media-prompt-panel.ts`)으로 그린다. 새 컨트롤 종류는 킷에 추가해 재사용.
- 확장 시스템: 설정 패널은 `plugin.registerSettingsPanel(...)`(UI 면, `docs/확장 패널 스펙.md`), 생성 과정 개입은 `plugin.extensions.register(...)`(실행 면). 내장/외부 확장 모두 같은 API. 새 슬롯/이음새는 실제 소비자가 생길 때만 추가(투기적 일반화 금지). 배선 상세는 `구현현황.md` "확장 시스템".

### 10. 사용자 커뮤니케이션

사용자는 비개발자다. 설명·제안은 항상 기능과 실사용 UX 중심으로 한다.

- 무엇을 바꿀지보다 **사용자가 무엇을 할 수 있게 되는지**를 먼저 말한다.
- 코드 구조, 파일명, 타입명, 내부 구현 설명은 요청받지 않으면 꺼내지 않는다.
- 선택지는 기술 방식이 아니라 UX 차이로 설명한다.
- 구현(파일 선택, 방식 결정, store/ai 규약 준수, 빌드/테스트 판단)은 조용히 책임지고 처리한다.

---

## 문서 내비게이션

durable 규칙은 이 파일이 기준. 아래 문서는 해당 작업을 만질 때만 참조한다.

**배치 규칙**: 루트 = 상시 문서 + **진행 중인 트랙**의 스펙. `docs/` = 구현이 끝난 기능 스펙과 외부 포맷 레퍼런스(계속 필독 대상, 눈에서만 치운 것). 한 트랙이 끝나면 그 스펙을 `docs/` 로 옮기고 여기 목록의 줄도 아래 구역으로 옮긴다. **목록 자체는 지우지 않는다** — "이 영역 만지기 전 필독" 체크리스트라서 검색으로 대체되지 않는다.

### 상시

- `회귀금지.md`: **코드 수정 전, 만지는 영역의 항목 확인 필수.** 재발 사고 교훈 모음.
- `구현현황.md`: 도메인별 구현 상태·진입점·배선. 기존 기능을 수정/확장하기 전에 그 도메인 섹션을 읽는다.
- `AGENTS.md`: Codex 진입점(이 파일을 가리키는 얇은 문서).
- `README.md`: 공개 레포 소개. 사용자용 요약/설치 안내만 갱신.
- `패치노트.md`: 커뮤니티 게시용. **누적 이력 아님** — 기능별 "가장 최신 상태"만 기록(사용자가 릴리즈 후 게시글에 첨부하고 나면 내용을 비움). 작업 마칠 때마다 갱신 규칙은 아래 체크리스트 참조.

### 진행 중 (루트)

- `게임형 카드 지원 스펙.md`: 상태창·선택지·수치가 있는 게임형 봇카드 지원(변수/조건부 로어북/표시).
  **1부 롤백 경계는 구현 중 지키는 계약** — 착수 전·각 단계 완료 시 확인 필수.
- `QR 스펙.md`: 빠른 답장(Quick Reply) 확정 설계 + ST QR v2 호환. QR 관련 작업 전 필독.
- `집필 프로 스펙.md`: 동시 집필 모드(소설 PRO) 확정 설계. PRO 관련 작업 전 필독.
- `양방향 번역 스펙.md`: 반영 대기함 구조 + 이중 원고 파이프라인의 '양방향 번역'(번역 확장) 이관 설계. 대기함/집필 변환/이관 작업 전 필독.
- `미디어 확장 스펙.md`: 번역/삽화 저장·표시 설계와 단계 가드레일. media 관련 변경 전 필독.
- `반복 표현 감지 스펙.md`: 「반복 표현」 확장 설계. 1차 구현 완료(수동 검증 남음). 집계 규칙 변경 전 필독.
- `제작 도구 스펙.md`: 대화로 시나리오·로어북·프롬프트를 만들고 고치는 트랙(어시스턴트 + 도구 + 작업 이력). 도구 이름·인자는 AI 와의 계약이라 확정 후 변경 금지 — 관련 작업 전 필독.

### 완료·레퍼런스 (`docs/`)

- `docs/챗 모드 스펙.md`: 챗 모드(M6) 확정 설계. 챗 모드 변경 전 필독.
- `docs/스텔라폰 스펙.md` / `docs/스텔라폰 v2 설계.md`: 스텔라 폰(문자/SNS) 확정 설계. 폰 관련 작업 전 필독.
- `docs/선채팅-그룹챗 남은작업.md`: 선채팅/그룹 트랙 상세(남은 건 그룹 전용 목록 필요 여부뿐).
- `docs/로어북 관리 개선안.md`: 자동 생성 로어북 소속·정리·보호 + 양방향 연결 보기. 로어북 목록/수명 작업 전 참조.
- `docs/확장 패널 스펙.md`: 확장 탭 설정 패널 등록 규약(UI 면). 확장 연동 변경 전 필독.
- `docs/프롬프트 스펙.md`: 프롬프트 세트 스키마 + ST 프리셋 호환. marker/macro/순서 변경 전 필독.
- `docs/로어북 스펙.md`: 로어북 스키마. 저장/에디터/매칭/import-export 변경 전 필독.
- `docs/실리태번 월드인포 정보.md`: ST world-info 동작 참조. ST 호환 매칭/recursion/position 변경 전 필독.
- `docs/캐릭터카드 V3 스펙.md`: CCv3 참조. 카드 파싱/썸네일/assets 변경 전 필독.
- `docs/지침 스펙.md`: ST 프롬프트 export 원본 shape 가 필요할 때만.
- `docs/marinara-비교-구현가이드.md`: 기능 비교 참고용. **코드를 캐오거나 이 기준으로 리팩터링하지 않는다.**

---

## 로드맵

진행 상태 기록이지 현재 요청 범위를 확장하는 지시가 아니다. 완료 항목의 구현 상세는 `구현현황.md`.

```
완료:
  [x] Phase A/B/R/L1-L8: 기본 아키텍처, 사이드바, 브랜치 세션, 스트리밍, 컨텍스트 빌더 v2,
      디테일 뷰, 프리셋/프롬프트/미디어 설정, Users, 전용 에디터(대시보드 편입), Dashboard
  [x] M6 챗 모드 (C0~C6)
  [x] N0 안 읽음·알림 기반 / P1 선채팅(스케줄러 + 복귀 독촉 포함)
  [x] G1 슬라이스 1-3: 그룹 엔티티 + 세션 초대(사이드바 우클릭) + 멤버 디스크립션 주입 + 멤버 관리 팝업

남음:
  [ ] L9 Media 확장 v2 잔여: variant 정리(다이어트) UI (구상은 미디어 확장 스펙.md)
  [ ] M1/M2 제작 도구(구 Built-in Agents): 대화로 시나리오·로어북·프롬프트를 만들고 고친다.
      설계 확정(제작 도구 스펙.md), S1~S4 전부 미착수. **착수 전 그 문서 필독.**
      — 이전 시도의 실행기(src/services/agent-runner.ts)는 어디에도 배선되지 않은 죽은
        코드라 삭제했다. 되살리지 말 것 — 새 설계는 스펙 문서가 진실 소스다.
        src/types/agent.ts 는 남아 있다 — SessionMeta.agentResults 가 참조 중이라
        (enabledAgents 와 함께) 같은 롤백 잔재지만, 세션 스키마 손질은 별건이다.
  [ ] M3 CHARX import UX 마무리
  [ ] M4 좌측 사이드바 우클릭 메뉴 고도화 (기본 rename 은 이미 구현됨)
  [ ] M5 설정 탭 고도화
  [ ] M7 커스텀 테마 / 모바일 UX / Dashboard 고도화
  [x] 그룹: G2 발화자 시스템 + G3(상한 설정/발화자 재판결 재생성/talkativeness 편집) + 멤버
      로어북 합집합 + 생성 소설/채팅 선택 + 그룹 선채팅 완료. 남은 건 그룹 전용 목록/탭 필요
      여부(실물 보며 결정)뿐 (상세는 docs/선채팅-그룹챗 남은작업.md)
  [ ] 스텔라 폰: PH1~PH5(문자/트리거/SNS/방송/이미지/번역) + v2(V2-0~V2-6) + v3(V3-1~V3-7,
      V3-7 = 리스트가 독립 서버) + V2-7(사진 읽기 = 비전) + V2-8(디자인) 구현 완료, 잔여 = 전체 수동 검증
      (상세는 docs/스텔라폰 스펙.md·docs/스텔라폰 v2 설계.md, 배선은 구현현황.md)
  [ ] 빠른 답장(QR): 슬라이스 1(그릇) + 1.5(단일 QR 객체 임포트) + 2a(스크립트 파서 + 커맨드 7종
      + 세션 노트 표시) + 2b(`/flushvar` `/buttons` `/re-exec` `/inject` `/flushinject` `/sendas`
      `/impersonate` + 체인) + 3 자동실행 훅(`executeOn*` 6종)
      + 2d(암묵적 파이프 + `/sendas` 익명 발화자 이름표 + `/trigger` + 노드 단위 "AI에게 숨김"
      (`node-meta.json`) + `/comment` 를 본문 노드로 + `/hide` `/unhide`
      + `/setglobalvar` `/getglobalvar` `/rand` `/addvar`) 완료.
      **2c(로어북 쓰기 `/setentryfield` `/getat`)는 지원하지 않기로 확정** — 노드·가지와
      로어북 수명이 얽혀 제어 불가. 게임 상태 영속은 변수 저장소가 맡는다.
      **착수 전 QR 스펙.md 필독(실물 QR 실측 수치 기준).**
  [ ] 익스포트(자료 공유 / 실리태번 왕복): 시나리오 캐릭터카드(PNG·JSON, 로어북 동봉) +
      로어북(ST 월드인포) + 정규식 스크립트 파일(임포트도 함께) 완료.
      남음 = 챗 세션 .jsonl / 설정 묶음(저장된 AI 프롬프트 전체, 가져오기는 합치기).
      배선은 구현현황.md "익스포트" + "정규식 스크립트".
  [ ] textgame 세션 모드: SessionMode 타입에 예약만 돼 있고 실사용 없음(구현 예정, 현재 novel/chat 만 동작)
  [ ] 집필 프로(PRO): P0~P6 완료(휴면 게이트/라우팅 + 이중 원고 파이프라인 + 대기 문단 직접 집필 + 문단 쌍 문체 예시 + 원고 조회 API + 집중 디테일뷰 + 번역 용어집 자동 수집), 남음 = P7 타임라인 (상세는 집필 프로 스펙.md)
  [ ] 양방향 번역: 대기함 + 출력 언어=원고 언어 + 토글/? 도움말 + 설정 공유/용어집 연동 +
      챗 양방향(입력란 전송 + 말풍선 수정 반영) 완료.
      남음 = 슬라이스 4(실패 배지/대기함 다이어트) (상세는 양방향 번역 스펙.md)
  [x] 로어북 관리: 소속 메타 + 목록 3구역(내 서재/자동 생성/고아) + 고아 일괄 정리 +
      보관·승격 + 양방향 연결 보기(세션↔로어북, 편집기 바로가기) 완료
  [ ] 게임형 카드 지원: U1(값 저장소 + 전역 값 + 가지 되짚기 + 변수 패널) +
      U3(조건부 로어북 — JS 실행 없는 제한 문법) + U4 챗(카드 HTML 안전 표시 +
      {{img::}} 이미지 태그) 완료.
      **여기서 동결** — 남은 U2(답변에서 값 읽기) / U4 소설 모드는 착수하지 않는다.
      재개하려면 사용자 지시가 있어야 한다.
      U5(QR 커맨드 보강)는 `/setglobalvar` `/getglobalvar` `/rand` `/addvar` `/trigger` `/hide`
      까지 QR 슬라이스 2d 에서 처리됨. **착수 전 게임형 카드 지원 스펙.md 1부(롤백 경계) 확인 필수.**
  [ ] 반복 표현: 1차 구현 완료(다국어 집계 + custom 슬롯 주입 + 확장 패널 + 패널 온/오프,
      기본 꺼짐), 남음 = 실사용 수동 검증 및 어형 변화 보정 필요 여부 판단
      (상세는 반복 표현 감지 스펙.md)
  [x] 이중 생성: **폐기** — 생성 두 번 = 시간·비용 두 배. 코드는 `shelved/pregen/` 으로
      격리(빌드 제외), 되살리는 절차는 `shelved/pregen/README.md`. 다시 만들지 말 것.
  [ ] 장기: 대규모 세션 성능, SillyTavern 호환 전체 내보내기
```

---

## 확정 결정 사항

| 항목 | 값 |
|---|---|
| 플러그인 ID | `ggai-stella-engine` |
| manifest name | `GGAI Stella Engine` |
| 빌드 | esbuild + TypeScript (옵시디언 샘플 표준) |
| 좌측 뷰 타입 ID | `ggai-stella-sidebar` |
| 세션 뷰 타입 ID | `ggai-stella-session` |
| 챗 세션 뷰 타입 ID | `ggai-stella-chat-session` (`meta.mode==="chat"` 전용, 라우팅은 `src/views/session-host.ts`) |
| 우측 뷰 타입 ID | `ggai-stella-detail` |
| 삽화 출력 뷰 타입 ID | `ggai-stella-illustration` |
| 스텔라 폰 뷰 타입 ID | `ggai-stella-phone` (진입: 명령 "스텔라 폰 열기") |
| 대시보드 뷰 타입 ID | `ggai-stella-dashboard` — 전용 에디터 5종(시나리오/로어북/페르소나/프롬프트/QR 버튼)은 대시보드 내부 페이지(EditorRoute)라 별도 뷰 타입 없음 |
| 리본 아이콘 | Lucide `sparkles` (임시) |

### 폴더 레이아웃 (vault 루트)

```
GGAI/
├── SCENARIOS/   # 시나리오 폴더들 (scenario.json + SESSIONS/)
├── LOREBOOKS/   # 로어북 폴더들 (lorebook.json)
├── PROMPTS/     # 프롬프트 세트 단일 JSON
├── PRESETS/     # 프리셋(북마크) 단일 JSON
├── USERS/       # 유저(페르소나) 프로필 단일 JSON
├── GROUPS/      # 그룹 폴더들 (group.json)
├── PHONE/       # 스텔라 폰 (<personaId>/messages.json)
├── QUICKREPLIES/ # 빠른 답장(QR) 세트 단일 JSON
└── DOWNLOADS/   # QR `/download` 산출물 (처음 쓸 때 생성, 멱등 생성 대상 아님)
```

멱등 생성: `src/util/ensure-folders.ts` (`GGAI` 먼저 체크/생성 후 하위 — `vault.createFolder` 가 중간 경로를 자동 생성하지 않는 버전 대응).

---

## 데이터 형식 요약

스키마 상세는 각 타입 파일과 스펙 문서가 진실 소스. 여기는 구조 요약만.

### 시나리오 — 폴더
`GGAI/SCENARIOS/<이름>/scenario.json` + `SESSIONS/`. CCv3 스펙 그대로, 플러그인 메타는 `data.extensions.stella`({id, favorite, lastPlayedAt, playCount, thumbnail, translationLorebookIds?, illustrationLorebookIds?, …})에 격리. 이름 중복 허용(id 로 구분). 타입: `src/types/scenario.ts`.

### 로어북 — 폴더 + 단일 JSON
`GGAI/LOREBOOKS/<이름>/lorebook.json`. ST 월드인포 기준 통합 스키마(NAI·CCv3 임포트도 이 형태로 정규화, 라운드트립 100% 보장이 단일 JSON 채택 이유). position/depth 는 ST 규칙 그대로(0=before_char, 1=after_char, 2=before_examples, 3=after_examples, 4=at_depth) — 프롬프트 빌더도 이 의미로 해석. 타입: `src/types/lorebook.ts`. 상세: `docs/로어북 스펙.md`.

### 세션 — 폴더 + session.json
`GGAI/SCENARIOS/<시나리오>/SESSIONS/<세션>/session.json` + `assets/` + 미디어 JSON(translations/illustrations/summaries).

**핵심 설계**: 본문을 스냅샷으로 쌓지 않는다. 각 노드는 부모로부터의 **patch(delta)** 만 저장(`append`/`replace`/`delete`, 문자 offset 기준), 활성 본문은 root → activeLeaf 경로의 patch 를 순서대로 적용해 재구성(`src/util/session-text.ts` `buildSpans`).

- meta: id/name/scenarioId/mode(novel|chat)/rootId/activeLeafId/favorite + 활성 설정(modelProfileId/params/promptSetId/translation/illustration/summarize/proactive/personaFile/series/groupId …)
- 노드 kind: `root` | `ai-continue` | `ai-regen` | `user-write` | `user-edit`. AI 노드는 `gen` 메타. `proactive:true` = 선채팅 발화.
- **분기 규칙**: 이어쓰기 = activeLeaf 의 자식(append) / 재생성 = parent 밑 sibling(과거 결과 보존) / 국소 수정 = replace 패치 노드 / 과거 노드에서 이어쓰기 = 그 노드의 새 자식(다른 루트 생존).
- 타입: `src/types/session.ts`. 생성: `src/util/new-session.ts` `createBlankSession`(first_mes 를 root AI 발화로, 2000자 초과 씨드는 문단 경계 체인 분할 — 이어붙이면 바이트 동일). 트리: `session-tree.ts`. diff: `session-diff.ts`.

### 프롬프트 세트 — 단일 JSON
`GGAI/PROMPTS/<이름>.json`. ST 호환 raw JSON 최대 보존 + `stella: {id, favorite}` 메타만 추가. 런타임은 `prompts[]` + `prompt_order[character_id=100000].order[]` 를 `StellaPromptPreset` 으로 복원 — 단일 평탄 배열(순서 = 조립 순서), 항목은 `text`(role/content/enabled/identifier) 또는 `marker`(chatHistory/worldInfoBefore/worldInfoAfter/charDescription/charPersonality/scenario/dialogueExamples/memory/authorNote/enhanceDefinitions). 파일 안의 모델/파라미터 값은 보존용일 뿐 활성 동작에 쓰지 않는다. 레거시 폴더형(`<name>/preset.json`)은 읽기만. 타입: `src/types/prompt.ts`. 상세: `docs/프롬프트 스펙.md`.

### 프리셋 (북마크) — 단일 JSON
`GGAI/PRESETS/<이름>.json` = `StellaPreset`(id/name/favorite/modelProfileId?/params?/promptSetId?/translation?/illustration?/summarize? + extensions 라운드트립). 모델/파라미터/프롬프트 세트 묶음을 한 클릭에 활성 설정으로 적용하는 단축키 — **진실 소스가 아님**(활성 설정 = 세션 meta 또는 세션 없을 때 `PluginData.current`). ST 임포트 대상 아님(사용자가 `+` 로 생성). 타입: `src/types/preset.ts`.

### 빠른 답장(QR) — 단일 JSON
`GGAI/QUICKREPLIES/<이름>.json` = ST QR v2 export shape 그대로 + `stella`(id/favorite) 메타. 익스포트는 `stella` 만 제거, 임포트는 `stella` 만 주입 → ST 왕복 무손실. 버튼 필드는 ST 이름 그대로(`qrList[]`: id/icon/label/message/contextList/executeOn\*/…), 하위 메뉴(`contextList`)는 세트를 **이름으로** 참조. 활성 세트 = `ActiveSettings.quickReply.setIds`. 타입: `src/types/quick-reply.ts`. 상세: `QR 스펙.md`.

### 유저(페르소나) 프로필 — 단일 JSON
`GGAI/USERS/<이름>.json` = `StellaUserProfile`(id/name/description/thumbnail?/aliases?/scenarioIds?). 활성 유저 = `plugin.data.activeUserProfileFile`. UI 용어는 "페르소나". 타입: `src/types/user.ts`.

### 그룹 — 폴더 + 단일 JSON
`GGAI/GROUPS/<이름>/group.json` = `StellaGroup`(멤버는 시나리오 stella.id 참조). 세션은 호스트 시나리오 폴더에 그대로 두고 `meta.groupId` 로 링크(회귀금지.md 참조). 타입: `src/types/group.ts`.

---

## 코드 구조 (개관)

```
src/
├── main.ts              # view 등록, store/ai 주입, PluginData, SettingTab, 확장 등록
├── constants.ts         # VIEW_TYPE 상수 + BASE_FOLDER/SUBFOLDERS
├── state/store.ts       # StellaStore — 모든 엔티티 읽기/쓰기/이벤트 진실 소스
├── services/            # ai-service / extension-registry / translation / illustration /
│                        #   summary / paragraph-regen / proactive / phone / pro / qr-runner
├── extensions/          # 내장 확장: translation / illustration / summary / notification
├── types/               # scenario / session / lorebook / prompt / preset / user / group / media / summary / agent
├── import/              # importFile 디스패처 + 포맷별 파서 (detect / ST / NAI / CCv3 / PNG / CHARX / .story / .jsonl)
├── util/                # 순수 로직: session-text / session-diff / session-tree / context-builder /
│                        #   build-session-context / macros / lorebook-match / translate-paragraphs /
│                        #   summarize-session / illustrations / read-* / scan-* 등
└── views/               # sidebar / session-view / chat-session-view / session-host / detail-view /
                         #   detail/ 섹션들 / dashboard-view / *-editor-section / 모달·캐러셀·갤러리 등
tests/                   # architecture-rules.mjs (store 우회 금지 검사) + 로직 테스트
```

정확한 파일 위치는 Glob/Grep 으로 찾는다 — 이 트리는 방향 안내용.

---

## 빌드 & 설치 루틴

```bash
npm run dev      # 개발 (watch)
npm run build    # TypeScript 검사 + 프로덕션 번들 → main.js
```

테스트 vault 설치: `<vault>/.obsidian/plugins/ggai-stella-engine/` 에 3개 파일 복사 → 옵시디언 재시작 → 활성화. 배포는 `npm run deploy`(푸시 + GitHub Release).

- 새 체크아웃에서는 `npm ci`로 잠금 파일 기준 의존성을 설치한다. `node`, `npm`이 필요하고 정식 배포에는 로그인된 `gh`도 필요하다.
- `npm run build`는 TypeScript 검사 후 `main.js`를 생성한다. `manifest.json`과 `styles.css`는 기존 파일을 사용한다.
- `STELLA_DEPLOY_TARGET`이 설정돼 있으면 dev/build 성공 시 세 파일을 **그 플러그인 폴더에 자동 복사**한다(`esbuild.config.mjs`). 검증만 할 때는 해당 프로세스의 변수를 비운다. 경로는 PC별 환경변수로 관리하고 공통 문서에 개인 절대 경로를 고정하지 않는다.
- `npm run release`는 빌드 후 `release/obsidian-ggai-stella-engine/`에 산출물을 모은다. `npm run deploy`는 현재 브랜치 push와 GitHub Release 생성/자산 덮어쓰기까지 수행하므로 배포 요청이 있을 때만 실행한다. 세션 종료 훅으로 실행하지 않는다.
- 빌드·하네스 성공과 Obsidian 수동 확인은 별개다. vault에 접근하거나 수동 확인할 수 없으면 미검증으로 남긴다.

---

## 단계 완료 시 체크리스트

1. 빌드 성공 (`npm run build`)
2. 하네스 성공 (`npm run test:harness`) — 특히 View/main 의 store 우회 파일 쓰기 금지 규칙
3. 테스트 vault 수동 검증
4. **문서 갱신 규칙 (비대화 방지)**:
   - 로드맵 상태 변화 → 이 파일의 체크박스 **한 줄**만
   - 기능 구현 상태·배선 변화 → `구현현황.md` 해당 도메인 섹션
   - 사고에서 얻은 교훈 → `회귀금지.md` 에 한 항목
   - 이 파일에는 규칙 변경만 반영. 날짜 붙은 서사·변경 이력을 이 파일에 쌓지 않는다.
   - **커뮤니티 패치노트** → `패치노트.md` 갱신. 이번 작업으로 추가/수정된 기능을
     "기능명 — 한 줄 사용법" 형식으로 반영한다. 누적 이력이 아니라 기능별 최신 상태이므로,
     같은 기능을 다시 고치면 새 줄을 추가하지 말고 기존 줄을 덮어쓴다. 절대 긴 설명서를 쓰지 않는다.
     파일이 비어 있어도(사용자가 게시 후 비움) 정상이니 새로 시작하듯 채운다.
5. 확정 결정/데이터 형식이 바뀌었으면 해당 표·요약 갱신

---

## 주의 사항

- 코드 수정 전 `회귀금지.md` 의 해당 영역 항목을 확인한다.
- 사용자 노출 텍스트는 한국어, 코드 식별자는 영어.
