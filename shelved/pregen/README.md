# 이중 생성 (pregen) — 보류 보관함

폐기했지만 **되살릴 수 있게** 통째로 격리해 둔 것. 빌드에서 완전히 빠져 있다
(`tsconfig.json` 은 `src/**/*.ts` 만 컴파일하고, `scripts/run-harness.mjs` 는 이 테스트를
더 이상 부르지 않는다). 지금 플러그인에는 이중 생성의 흔적이 없다 — 확장 목록에도,
전송본 조립에도, 세션/활성 설정 스키마에도 없다.

## 무엇이었나

본 생성 직전에 **다른 프롬프트 세트로 한 번 더 호출**해서, 그 결과를 전송본에 끼워 넣는
확장. 기본 세트로 「속마음 (이중 생성)」이 자동 생성돼, 직전 장면 인물들의 속마음을
한 줄씩 뽑아 다음 이어쓰기 문맥에 넣었다. 용도는 프롬프트 세트가 정하는 구조라
장면 계획·복선 점검 같은 다른 쓰임도 가능했다.

폐기 이유: 생성이 두 번 나가 시간·비용이 두 배.

## 들어 있는 것

| 파일 | 내용 |
|---|---|
| `files/pregen-service.ts` | 1차 호출 실행기 (`plugin.pregen`) |
| `files/pregen-extension.ts` | 확장 등록 — 컨텍스트 기여 시점에 1차 호출 |
| `files/pregen-prompt-preset.ts` | 기본 프롬프트 세트(속마음) + 1차 응답 파싱·주입 틀 |
| `files/pregen-panel.ts` | 확장 탭 설정 패널 |
| `files/pregen.test.ts` | 1차 응답 파싱·주입 틀 하네스 |
| `wiring.patch` | 본체 배선 되살리기 패치 (아래) |
| `이중 생성 스펙.md` | 설계·경계 문서 |

## 되살리는 법

1. `files/` 의 파일을 원래 자리로 되돌린다.
   - `pregen-service.ts` → `src/services/`
   - `pregen-extension.ts` → `src/extensions/`
   - `pregen-prompt-preset.ts` → `src/util/`
   - `pregen-panel.ts` → `src/views/detail/panels/`
   - `pregen.test.ts` → `tests/`
2. 본체 배선을 되살린다: `git apply shelved/pregen/wiring.patch`
   (main.ts / types(preset·session) / build-session-context / context-builder / macros /
   extension-registry / run-harness / session-view-logic.test 의 pregen 부분만 담긴 패치다.
   주변 코드가 많이 바뀐 뒤라면 거절될 수 있는데, 그때는 패치를 읽고 손으로 옮기면 된다 —
   접점은 위 8개 파일뿐이고 전부 "한 줄 추가" 수준이다.)
3. 스펙 문서를 루트로 옮기고 `CLAUDE.md` 로드맵·문서 목록에 다시 올린다.

## 남아 있는 데이터

이미 쓴 vault 에는 흔적이 남아 있을 수 있다. **지워도 되고 둬도 무해하다.**

- `GGAI/PROMPTS/속마음 (이중 생성).json` — 자동 생성됐던 프롬프트 세트.
  이제 아무도 안 부르지만 일반 프롬프트 세트라 그냥 골라 쓸 수도 있다.
- 세션 `session.json` 의 `meta.pregen` — 타입에서 뺐을 뿐 파일에 남아 있으면 그대로 있다.
  되살리면 그 설정이 다시 잡힌다.
