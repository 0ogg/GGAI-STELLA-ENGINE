# QR 스펙.md — 빠른 답장(Quick Reply) 확정 설계

> 실리태번 Quick Reply v2 이식. QR 관련 작업 전 필독.
> 규칙 본문은 `CLAUDE.md`, 사고 교훈은 `회귀금지.md`, 배선 현황은 `구현현황.md`.

---

## 무엇인가

버튼 하나 = **실행할 내용 한 덩어리**. 세션 하단에 버튼 바로 떠 있고, 누르면 그 내용이 실행된다.

실리태번 QR 의 힘은 대부분 QR 확장이 아니라 그 밑의 **STscript 슬래시커맨드 엔진**에서 나온다.
이식 범위는 **범위 2** — 자주 쓰이는 코어 커맨드만 해석하고, 모르는 커맨드는 조용히 건너뛴다.

---

## 저장

`GGAI/QUICKREPLIES/<이름>.json` — 세트 하나 = 파일 하나 (프롬프트 세트와 같은 단일 JSON 정책).

파일 shape = **ST QR v2 export 그대로 + `stella` 메타만 추가**. 익스포트는 `stella` 만 떼면 되고,
임포트는 `stella` 만 주입하면 되므로 ST 왕복이 무손실이다.

```json
{
  "version": 2,
  "name": "내 세트",
  "disableSend": false,
  "placeBeforeInput": false,
  "injectInput": false,
  "color": "",
  "onlyBorderColor": false,
  "idIndex": 3,
  "qrList": [ /* 버튼들 */ ],
  "stella": { "id": "<uuid>", "favorite": false }
}
```

버튼(`qrList[]`) 필드는 **ST 이름 그대로** 쓴다 (CLAUDE.md 8 — 같은 것에 Stella 전용 식별자 금지):

`id`(number) · `icon` · `showLabel` · `label` · `title` · `message` · `contextList[]` ·
`preventAutoExecute` · `isHidden` · `executeOnStartup` · `executeOnUser` · `executeOnAi` ·
`executeOnChatChange` · `executeOnGroupMemberDraft` · `executeOnNewChat` ·
`executeBeforeGeneration` · `automationId`

`contextList[]` 항목 = `{ set: "<세트 이름>", isChained: bool }` — 세트를 **이름으로 참조**(ST 규칙).
이게 "QR 안의 QR"(하위 메뉴)이다. `isChained: true` 면 하위 버튼 명령이 부모 명령 **뒤에 이어붙어** 실행된다.

ST 파일에 있는 모르는 키는 라운드트립을 위해 그대로 보존한다.

---

## 활성화 (어느 세트가 켜져 있나)

- 세션별 = `ActiveSettings.quickReply.setIds[]` (다른 활성 설정과 같은 규칙 — 세션 meta / `PluginData.current`).
- 바 열림·닫힘 = `PluginData.quickReplyBarOpen` (전역 UI 선호, `branchShowTranslation` 과 같은 급).

세트를 켜고 끄는 곳은 **세션 QR 바**(사용), 세트를 만들고 고치는 곳은 **대시보드 탭**(라이브러리).
역할을 섞지 않는다.

---

## UI

### 세션 QR 바
하단 툴바 **바로 위 좌측**에 작은 `QR △` 토글. 누르면 버튼 바가 열린다(상태 영속).
바에는 활성 세트의 버튼들이 뜨고, 우측 끝 `⚙` 로 세트 켜기/끄기 + 대시보드 이동.
`contextList` 가 있는 버튼은 △ 표시 — 누르면 하위 메뉴가 위로 열린다.

### 대시보드 "빠른 답장" 탭
드롭다운 금지. **세트 = 폴더, 버튼 = 항목**인 트리를 한 화면에 편다.

- 항목 우측 꼬리표로 그 버튼이 뭘 하는지 표시 (`입력/전송` · `생성 전` · `하위메뉴 → <세트>`).
- **드래그**: 항목을 다른 폴더 위로 = 그 세트로 이동 / 같은 폴더 안 = 순서 변경 / 폴더끼리 = 세트 순서.
- 항목 **클릭 = 편집 페이지**(다른 탭과 동일한 `EditorRoute` 패턴, 뒤로가기로 복귀).
- 폴더 `⋮` = 이름 변경 / 내보내기 / 삭제 / 버튼 추가. 상단 툴바 = `새 세트` · `가져오기`.

### 버튼 편집 페이지
`표시`(아이콘·라벨) → `동작`(입력·전송 ↔ 커맨드 토글 + 내용) → 접힌 `자동 실행 시점` → 접힌 `하위 메뉴`.
자동실행 8개 플래그를 평면 나열하지 않는다 — 접어 두고 요약만 보인다(ST 편집기가 복잡한 주원인).

---

## 실행 (범위 2)

`message` 가 `/` 로 시작하면 커맨드 파이프라인, 아니면 입력/전송.

**모르는 커맨드는 조용히 건너뛰고 알림만** — 임포트한 세트가 지원 밖 커맨드를 써도 버튼 전체가 죽지 않는다.

세트 플래그 해석 (ST `QuickReplySet.execute`):
`injectInput` 이면 입력창 텍스트와 `message` 를 합치고(`placeBeforeInput` 으로 앞/뒤),
`disableSend` 면 전송하지 않고 입력창에 넣기만 한다.

### 모드별 "입력/전송"
- **챗 모드**: 입력창에 넣고, `disableSend` 아니면 전송.
- **소설 모드**: 입력창이 없다 → 본문 끝에 `user-write` 노드로 붙이고, `disableSend` 아니면 이어쓰기.

### 생성 개입
`executeBeforeGeneration` 버튼은 `planSessionRequest` 앞단에서 실행된다.
컨텍스트에 넣는 길은 확장 공용 `custom` 슬롯 하나뿐 — QR 전용 삽입 배선을 새로 만들지 않는다
(구현현황.md "확장 시스템" 참조). **전송본 단일 진실 소스**는 깨지 않는다: 미리보기와 생성이 같은 payload.

---

## 실물 QR 조사 결과 (2026-07-25)

실제 배포되는 QR 파일 2종을 뜯어 얻은 실측. **추측이 아니라 이 수치를 기준으로 우선순위를 잡는다.**

조사 대상 (사용자 다운로드 폴더):
- `[QR] ⟡ EDEN UNIV [REMAKE] ⟡.json` — 복잡. 세트 1개 / 버튼 12개(그중 **6개가 `isHidden`** = 다른 버튼이 부르는 서브루틴). 12개 **전부** `/` 로 시작.
- `🏭 서사공장.qr.json` — 간단. **세트가 아니라 버튼 1개짜리 파일**(아래 gap 참조).

### 커맨드 사용 빈도 (두 파일 합산, 실제 실행 위치 기준)

| 커맨드 | 횟수 | 슬라이스 1 시점 계획 |
|---|---|---|
| `/if` | **106** | ❌ 누락 — 1위인데 계획에 없었음 |
| `/setvar` | 67 | ✅ |
| `/flushvar` | 50 | ❌ |
| `/echo` | 37 | ✅ |
| `/abort` | 33 | ❌ |
| `/setentryfield` | 28 | ❌ (로어북 **쓰기**) |
| `/gen` | 28 | ✅ |
| `/sendas` | 28 | ❌ |
| `/input` | 19 | ✅ |
| `/buttons` | 13 | ✅ |
| `/re-exec` | 7 | ❌ (버튼이 버튼 호출) |
| `/getat` | 7 | ❌ |
| `/inject` | 2 | ✅ |
| `/impersonate` | 1 | ❌ |
| `/comment` | 1 | ❌ |

원래 계획이 "모달·생성" 중심이었는데 **실제로는 조건 분기와 변수가 압도적**이다.

### 매크로 사용 빈도

| 매크로 | 횟수 | 우리 상태 |
|---|---|---|
| `{{getvar::x}}` | **160** | ❌ 없음 |
| `{{user}}` | 58 | ✅ `util/macros.ts` |
| `{{pipe}}` | 54 | ❌ 없음 |
| `{{groupnotmuted}}` | 27 | ❌ 없음 |
| `{{lastmessage}}` | 7 | ✅ |
| `{{char}}` `{{persona}}` | 6 | ✅ |
| `{{history}}` `{{tag}}` | 2 | ❌ 없음 |

### 커맨드보다 먼저 필요한 것 — 문법

커맨드를 하나씩 늘려서 되는 게 아니다. 이 파일들은 작은 스크립트 언어를 쓴다:

```
/if left={{getvar::role}} right="student" rule=neq {:
/echo color=#c23396 [접근 거부] 이 기능은 학생 역할만 이용 가능합니다.
|
/abort
:} ||
```

- `|` 파이프 연결, 앞 명령 결과를 `{{pipe}}` 로 받음
- `{: ... :}` 클로저 블록 (조건문 몸통)
- `left=` `right=` `rule=` `key=` `color=` 이름붙은 인자
- `||` 는 **맨 인자 자동 주입만** 끊는다 (ST 원본). 파이프 **값은 남아서** 손으로 적은
  `{{pipe}}` 로 계속 읽힌다 — `/input … || /setvar key=x {{pipe}}` 관용구가 여기 기댄다.

**파서가 먼저 있어야 커맨드가 의미를 갖는다.**

### 우리에게 개념 자체가 없는 것

- **변수 저장소** (`setvar`/`getvar`/`flushvar`) — 세션에 딸린 임시 변수. EDEN 은 이걸로 역할·카스트·상태를 기억한다.
- **로어북 항목 쓰기** (`/setentryfield`) — EDEN 이 게임 상태를 **영구 저장**하는 방법. **지원하지 않기로 확정**(아래 2c).
- **특정 캐릭터로 발화** (`/sendas`), **AI 가 유저 대신 쓰기** (`/impersonate`)
- **버튼이 버튼 호출** (`/re-exec`) — EDEN 숨김 버튼 6개가 이 방식.

### 발견된 gap — 버튼 1개짜리 파일 임포트 불가 (버그)

`🏭 서사공장.qr.json` 은 `qrList` 없이 **버튼 객체 하나만** 들어 있다
(`{id, showLabel, label, title, message, contextList, ...}`).
현재 `import/detect.ts` 는 `Array.isArray(d.qrList)` 로만 QR 을 판별해 이 파일이 `unknown` 으로 튕긴다.
→ **단일 QR 객체(= `message` + `label` 이 있고 `qrList` 가 없음)도 QR 로 인식**해 세트 1개로 감싸 임포트해야 한다.

---

## 표시 확정 (`/echo` vs `/comment`)

실측에서 둘의 성격이 뚜렷이 갈렸다. **다르게 취급한다.**

### `/echo` → 옵시디언 Notice (토스트). 본문에 안 남긴다.
37회 전부 짧은 시스템 알림이다 — `[접근 거부] …` / `[오류] …` / `투표 작성이 취소되었습니다.` / `🎖️ 카스트 평가를 시작합니다...`.
`color=` 는 빨강(거부·취소) / 보라(진행) 두 갈래로만 쓴다. 본문에 남길 이유가 없다.

### `/comment` → **본문 노드 + "AI 에게 숨김"** (2026-08-05 정정)

원래는 본문 밖 노트(`notes.json`, 인라인 삽화와 같은 앵커 기계)로 남겼다. 요구 자체는 맞았지만
**있어야 할 자리가 틀렸다.** ST 문서의 정의는 이렇다:

> `/comment (text)` — adds a hidden comment that is displayed in the chat but is not visible to the prompt

즉 **결과는 항상 대화 로그에 남고**, 프롬프트에서만 빠진다("눈감기기"). QR 을 프롬프트 숏컷으로
쓰는 카드들은 그 자리에 결과가 있다고 가정하고 다음 커맨드를 잇는다 — 본문 밖 노트로 빼면
그 가정이 깨진다.

→ `/comment` 는 다른 발화와 똑같이 **본문 노드**로 붙고, `node-meta.json` 의 `hidden` 으로
전송본에서만 빠진다. `<details><summary>` 는 여전히 원시 HTML 로 렌더하지 않고 제목/본문만 뽑는다.
**이미 쌓인 노트는 그대로 보이고 지울 수 있다**(읽기·삭제만 남는 레거시).

### 노드 단위 "AI 에게 숨김" (`node-meta.json`)

`session.json` 은 건드리지 않는다. 세션 폴더의 곁파일 하나(`node-meta.json`)에
노드 id → `{ hidden?, speakerName? }` 만 담는다 — 파일을 지우면 도입 전과 완전히 같아진다
(illustrations/notes/variables 와 같은 급, 게임형 카드 지원 스펙.md 의 C급 금지 준수).

- 전송본 제외는 `planSessionRequest` 한 곳: 챗은 `buildChatMessages` 의 nodeId 로 걸러내고,
  소설은 `spansExcludingNodes`(노드 귀속 세그먼트)로 그 구간만 뺀 스팬을 쓴다.
  미리보기도 같은 경로라 자동으로 같은 결과다.
- 표시: 챗 = 말풍선 흐림 + 이름 옆 `eye-off`, 소설 = 그 구간 글자 흐림(점선 밑줄).
  **글자는 그대로 두고 클래스만 얹는다** — 본문 textContent 가 바뀌면 편집 diff·오프셋이 깨진다.
- 조작: 챗 말풍선 메뉴 `AI 에게 숨기기 / 다시 보내기`, 어디서나 `/hide` `/unhide`.

### `<details>` / `<summary>` — 원시 HTML 을 렌더하지 않는다
현재 어디서도 처리되지 않는다. `util/chat-format.ts` `formatChatText` 는 `<` `>` 를 전부 이스케이프하고,
마크다운 렌더러도 안 쓴다. 그대로 넣으면 태그가 **글자로 보인다**.

그래도 원시 HTML 렌더를 도입하지 않는다. `<details><summary>제목</summary>본문</details>` 가 뜻하는 건
**"제목 달린 접이식 블록"** 하나뿐이므로, 내용에서 제목/본문만 뽑아 **우리 접이식 위젯**으로 그린다
(삽화 캐러셀이 네이티브 위젯인 것과 같은 방식). AI 생성물에 이상한 마크업이 섞여도 안전하다.

---

## 구현 순서 (실측 반영 개정)

슬라이스 1 시점의 "슬라이스 2 = 커맨드 몇 개" 계획은 **폐기**. 위 실측대로 다시 나눈다.

- **슬라이스 1 — 완료.** 그릇: 저장/스캔/store 배선, ST 임포트·익스포트, 대시보드 탭(트리+드래그+편집 페이지),
  세션 QR 바. 버튼 동작은 입력/전송만.

- **슬라이스 1.5 — 완료.** 단일 QR 객체 파일 임포트 (위 gap). `detect.ts` 가 `message`+`contextList[]`
  시그니처도 QR 로 보고, 감싸기는 `normalizeQuickReplySet` 한 곳에서 한다(세트 이름 = 버튼 `label`).

- **슬라이스 2a — 완료.** 합격 기준이던 "🏭 서사공장이 실제로 돌아간다"를 충족한다
  (실측: 서사공장은 건너뛰는 커맨드 0개, EDEN 은 지원 284회 / 미지원 136회로 위 표와 일치).
  문법 뼈대(파이프 `|` / `{{pipe}}` / 클로저 `{: :}` / 이름붙은 인자) = `util/qr-script.ts`,
  커맨드 7개 `/input` `/setvar` `/if` `/echo` `/abort` `/gen` `/comment` = `services/qr-runner.ts`,
  매크로 `{{pipe}}` `{{getvar::x}}`(변수는 `session.meta.variables` — 이미 있던 저장소 재사용).
  `/comment` 는 세션 노트(`notes.json`)로 남고 인라인 접이식 위젯으로 표시된다.
  `/setentryfield` 등 무거운 것은 손대지 않았다(로어북 쓰기 미접촉).

- **슬라이스 2b — 완료.** `/flushvar` `/buttons` `/re-exec` `/inject`(+`/flushinject`) `/sendas` `/impersonate`.
  `isChained` 체인 실행은 2a 시점에 바에서 이미 붙었다.
  **실물 파일 확인으로 정정된 것**: `/re-exec` 는 "버튼이 버튼 호출"이 아니라 **정규식 실행**
  (`/re-exec first= find="/pattern/" {{lastMessage}}` — AI 응답에서 값 뽑기)이다. 배선은 `구현현황.md`.

- **슬라이스 2c — 상태 영속. 지원하지 않는다 (확정, 재검토 대상 아님).**
  `/setentryfield`(로어북 쓰기) `/getat`. 버튼이 로어북 파일을 직접 고쳐 쓰기 시작하면
  노드·가지와 로어북 수명이 얽혀 **사용자가 무엇이 언제 바뀌었는지 제어할 수 없다**.
  게임 상태 영속은 변수 저장소(`/setvar` `/setglobalvar` — 가지별 되짚기가 되는 쪽)가 맡는다.
  이 커맨드를 쓰는 카드는 그 줄만 조용히 무시된다.

- **슬라이스 2d — 완료.** 결과가 조용히 증발하던 원인 3종 + 게임형 카드용 커맨드 4종.
  - **암묵적 파이프**: 맨 인자가 **적혀 있지 않으면** `{{pipe}}` 가 그 자리에 온다(ST 규칙).
    `/gen … | /sendas name="{{char}}"` 같은 관용구가 빈 값으로 통과해 가십지·자동사냥·
    마법 신문·비밀 일기장·극대본이 전부 결과 없이 끝나던 원인.
    예외: 인자가 **대상 지정**인 커맨드(`/hide` `/unhide` `/trigger` `/flushvar`
    `/flushinject` `/getglobalvar`)는 파이프를 흘리지 않는다 — 원본과 다른 점이고,
    `/gen … | /hide` 가 엉뚱한 메시지를 숨기는 사고를 막는다.
  - **`/sendas` 이름표**: `name=` 이 그룹 멤버가 아니면 예전엔 이름이 버려져 캐릭터 본인의
    말풍선으로 떴다. 이제 익명 발화자로 남는다 — 챗은 이니셜 아바타 + 그 이름(다음 발화자
    순번에서 제외), 소설은 문단 앞 이름표 위젯(글자 0개 원자 블록, 전송본·내보내기 무영향).
    **본문에 `이름:` 접두어를 박지 않는다** — 본문은 문자 오프셋 기준이라 편집/번역/삽화
    앵커가 전부 밀린다.
  - **`/trigger`**: 유저 메시지 없이 생성 1회. 챗=전송, 소설=이어쓰기 **같은 경로**를 탄다.
    앞의 `/inject` 가 이번 전송에 실린다. 인자로 그룹 멤버 이름/순번을 주면 그 멤버가 답한다.
  - **`/comment` 정정 + `/hide` `/unhide`**: 위 "표시 확정" 절.
  - **`/setglobalvar` `/getglobalvar` `/rand` `/addvar`**: ST 문서 그대로.
    `/rand` 는 `from`(기본 0) `to`(기본 1, 맨 인자 하나 = `to`) `round=round|ceil|floor`,
    범위는 양끝 포함이고 기본은 소수다. QR 스크립트 안에서 `{{getglobalvar::x}}` 도
    이제 풀린다(예전엔 전역 값이 매크로 맵에 없어 원형 그대로 남았다).

- **슬라이스 2e — 완료. QR 산출물도 이어쓰기와 같은 마무리 파이프를 탄다.**
  요청 쪽은 이미 단일 경로였지만(`planSessionRequest`) **결과 쪽이 갈라져** 있었다 —
  소설 뷰·챗 뷰·선채팅만 (1) 저장 원문 정규식 (2) `extensions.runGenerationComplete`
  를 돌려서, QR 이 남긴 글에는 정규식도 자동 번역·자동 삽화·자동 요약·로어북 자동 생성·
  반복 표현·폰·알림도 붙지 않았다.
  - 진입점은 `services/qr-runner.ts` 의 `appendSessionMessage` + `runGenerationPipe`
    **한 쌍뿐**이다(선채팅과 같은 규약 — 확장마다 별도 실행 경로를 만들지 않는다).
  - 적용: `/sendas` `/comment` `/impersonate`(AI 발화). `/send` 는 유저 발화라
    `runUserText` 쪽 — 뷰의 입력 경로와 같다.
  - 정규식은 **저장 전에** 돈다(AI 발화만). 치환 결과가 비면 노드를 만들지 않는다.
  - `/comment` 처럼 숨긴 노드도 파이프를 통과시킨다: 숨김은 "전송본에서 빼기"라
    요약·로어북 자동 생성은 본문 통로에서 알아서 빠지고, 화면에 보이는 번역·삽화만 붙는다.
  - **`/impersonate`(대필)은 유저 초고가 아니라 AI 생성 노드**로 남는다 — 프롬프트만
    다를 뿐 이어쓰기와 같은 생성이므로 재생성·분기 대상이 된다. 챗에서는 말풍선이
    캐릭터 쪽에 서므로 `speakerName` 이름표로 누구의 말인지 남긴다(`/sendas` 와 같은 기계).
  - 소설에서 "외전을 AI 에게 안 보이게 남기기" = `/comment` 또는 `/sendas … || /hide`
    (번호 없는 `/hide` = 방금 붙은 덩어리). 소설 뷰가 숨김 구간을 흐리게 그린다.

- **슬라이스 3 — 완료.** 자동실행 훅 6종. 선별은 순수 함수(`collectAutoQuickReplies`),
  실행은 **누른 것과 같은 경로**(바의 `execute()`), 시점은 기존 확장 훅(`onUserText`/`onGenerationComplete`)과
  뷰의 `setState`/`runGeneration` 에 얹었다. `숨김` 버튼도 자동 실행 대상이고 `preventAutoExecute` 는 게이트가 아니다.
  배선·판단 근거는 `구현현황.md` "자동 실행".
