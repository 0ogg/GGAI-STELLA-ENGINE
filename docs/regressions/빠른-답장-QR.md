# 빠른 답장(QR) 회귀 방지 규칙

> 이 영역을 수정할 때만 읽는다. 규칙은 실제 사고에서 얻은 불변식이며, 구현이 바뀌면 현재의 올바른 경로만 남도록 갱신한다.

- **`||` 는 파이프 값을 지우는 게 아니다.** — ST 원본에서 `||` 가 막는 것은 "맨 인자를 안 적었을 때 앞 결과를 자동으로 끼워 넣기"뿐이고, 손으로 적은 `{{pipe}}` 는 값을 그대로 읽는다. 우리는 `state.pipe` 를 통째로 비웠고, 그래서 `/input … || /setvar key=x {{pipe}} || /if left={{getvar::x}} right="" rule=eq {: /abort :}` 라는 **가장 흔한 대필/입력 QR 관용구**가 항상 "취소"로 빠졌다(입력값이 저장 전에 증발). → 파이프 값은 항상 이어지고, `breaksPipe` 는 `implicitPipe` 플래그로 **자동 주입만** 끈다(`services/qr-runner.ts`). 남의 문법을 우리 직관으로 요약하지 말고 원본 문서를 확인한다(CLAUDE.md 8).

- **세션에 글을 남기는 새 경로를 만들면 "마무리 파이프"를 반드시 같이 태운다.** — 생성이 끝날 때 도는 후처리는 (1) 저장 원문 정규식 `applyRawRegexToGeneration` (2) `extensions.runGenerationComplete`(자동 번역·삽화·요약·로어북 자동 생성·반복 표현·폰·알림) 두 단계인데, 오랫동안 **소설 뷰·챗 뷰·선채팅 세 곳에만** 복사돼 있었다. 그래서 QR 이 남긴 글(`/sendas` `/comment` `/impersonate`)은 요청 쪽은 같은 `planSessionRequest` 를 쓰면서 결과 쪽만 통째로 갈라져, 마법 신문·가십지·대필에 정규식도 번역도 삽화도 붙지 않았다. → QR 쪽 진입점은 `qr-runner.ts` 의 `appendSessionMessage` + `runGenerationPipe` **한 쌍**. 앞으로 "본문에 글을 붙이는" 경로를 새로 만들면 이 두 단계를 빼먹지 않았는지부터 확인한다. 확장마다 별도 실행 경로를 만들지 않는다.

