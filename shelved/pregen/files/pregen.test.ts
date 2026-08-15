/**
 * 이중 생성 1차 응답 처리 — 파싱과 주입 틀. (`이중 생성 스펙.md`)
 *
 * 못 박는 것 세 가지.
 *
 * 1) **끝을 지킨다** — 모델은 목록을 마친 뒤 그대로 장면을 이어 쓰려 한다. 배열 뒤에
 *    무엇이 붙어 오든 배열까지만 남아야 한다(제보로 확인된 실패).
 * 2) **깨져도 버리지 않는다** — JSON 이 어긋났다고 1차 호출을 통째로 낭비하지 않는다.
 *    펜스/장면 구분선에서 잘라 원문을 그대로 쓴다.
 * 3) **감쌀 문구는 코드가 소유하지 않는다** — 설정의 틀만 적용한다. 틀이 비면 결과 그대로.
 */

import assert from "node:assert/strict";
import {
  applyPregenInjectTemplate,
  parsePregenResult,
  DEFAULT_PREGEN_INJECT_TEMPLATE,
  PREGEN_RESULT_MACRO,
} from "../src/util/pregen-prompt-preset";

// 0. **기본 형식 = 이름을 키로 쓰는 JSON 객체.** 닫는 `}` 가 종결을 만들고,
//    키가 유일해서 "각 인물 한 번씩"이 형식으로 강제된다.
{
  const out = parsePregenResult(
    '{"Mira": "it moved.", "Doren": "not the chain. me.", "Kit": "warm."}'
  );
  assert.equal(out, "Mira: it moved.\nDoren: not the chain. me.\nKit: warm.");
}

// 0b. 객체 뒤에 본문을 이어 써도 객체까지만 — `}` 로 끝난다.
{
  const out = parsePregenResult(
    '{"라온": "손이 떨린다"}\n\n라온은 문을 열었다. 복도는 비어 있었다.'
  );
  assert.equal(out, "라온: 손이 떨린다");
}

// 0c. 값이 문자열이 아닌 키는 버린다. 건질 게 없으면 빈 문자열(생 JSON 주입 금지).
{
  assert.equal(parsePregenResult('{"라온": 3, "세아": ""}'), "");
}

// 1. 구 형식 호환 — JSON 배열도 `이름: 생각` 줄로 펴진다.
{
  const out = parsePregenResult(
    '[{"name":"라온","thought":"손이 떨린다"},{"name":"세아","thought":"들켰나"}]'
  );
  assert.equal(out, "라온: 손이 떨린다\n세아: 들켰나");
}

// 2. 코드펜스로 감싸 와도 같은 결과 (프롬프트가 ```json 으로 시작을 유도한다).
{
  const out = parsePregenResult('```json\n[{"name":"라온","thought":"도망칠까"}]\n```');
  assert.equal(out, "라온: 도망칠까");
}

// 3. **배열 뒤에 장면을 이어 쓴 경우** — 배열까지만 남는다.
{
  const out = parsePregenResult(
    '[{"name":"라온","thought":"무섭다"}]\n```\n\n***\n\n라온은 문을 열었다. 복도는 비어 있었다.'
  );
  assert.equal(out, "라온: 무섭다");
}

// 4. 이름/생각이 아닌 항목은 버리고, 빈 배열이면 빈 문자열.
{
  assert.equal(parsePregenResult('[{"name":"라온"},{"foo":1}]'), "");
  assert.equal(parsePregenResult("[]"), "");
}

// 5. **기본 형식 = 한 줄** (`이름: 생각 | 이름: 생각`) — 삽화 프롬프트와 같은 모양.
{
  const out = parsePregenResult("라온: 손이 떨린다 | 세아: 들켰나 | 민우: 상관없어");
  assert.equal(out, "라온: 손이 떨린다\n세아: 들켰나\n민우: 상관없어");
}

// 5b. **대본으로 새면 인물당 첫 등장까지만** — 줄 형식이 채팅 로그와 생김새가 같아
//     모델이 수백 줄짜리 대화를 쏟아낸 적이 있다(제보). 같은 이름 재등장 = 대화 시작.
{
  const out = parsePregenResult(
    [
      "라온: 손이 떨린다",
      "세아: 들켰나",
      "라온: 지금 아니면 안 돼",
      "세아: 뭐야 저 표정",
      "라온: 도망칠까",
    ].join("\n")
  );
  assert.equal(out, "라온: 손이 떨린다\n세아: 들켰나");
}

// 5c. 한 줄 안에서 대화로 새어도 같다.
{
  const out = parsePregenResult("라온: 무섭다 | 세아: 뭐야 | 라온: 도망칠까");
  assert.equal(out, "라온: 무섭다\n세아: 뭐야");
}

// 5d. 추론 블록(`<think>…</think>`)은 걷어낸다 — 안 걷으면 그 안의 줄이 항목이 된다.
{
  const out = parsePregenResult(
    "<think>Hazama: 어쩌지\nYuri: 궁금하다</think>\n라온: 손이 떨린다 | 세아: 들켰나"
  );
  assert.equal(out, "라온: 손이 떨린다\n세아: 들켰나");
}

// 6. 줄 형식 — 머리말/펜스는 건너뛰고, 장면 구분선에서 끊는다.
{
  const out = parsePregenResult(
    "```\n라온: 손이 떨린다\n세아: 들켰나\n```\n\n***\n\n이어지는 장면"
  );
  assert.equal(out, "라온: 손이 떨린다\n세아: 들켰나");
}

// 7. **목록 뒤에 장면을 이어 써도** 형식에 안 맞는 줄에서 끝난다 (구분선이 없어도).
{
  const out = parsePregenResult(
    "라온: 무섭다\n세아: 들켰나\n\n라온은 문을 열었다. 복도는 비어 있었다."
  );
  assert.equal(out, "라온: 무섭다\n세아: 들켰나");
}

// 8. 생각 안에 콜론이 또 있어도 **첫 콜론**에서만 가른다.
{
  const out = parsePregenResult("라온: 이건 분명해: 도망쳐야 한다");
  assert.equal(out, "라온: 이건 분명해: 도망쳐야 한다");
}

// 9. 콜론이 없는 산문만 오면 아무것도 건지지 않는다 (본문이 주입되는 것보다 낫다).
{
  assert.equal(parsePregenResult("라온은 문을 열었다. 복도는 비어 있었다."), "");
}

// 10. 주입 틀 — {{main}} 치환 (미디어 프롬프트·작가노트 틀과 같은 규약).
{
  const out = applyPregenInjectTemplate("[참고 자료]\n{{main}}", "라온: 무섭다");
  assert.equal(out, "[참고 자료]\n라온: 무섭다");
  // 먼저 쓰던 {{result}} 도 계속 받아 준다 (이미 저장된 틀 구제).
  assert.equal(
    applyPregenInjectTemplate("[참고 자료]\n{{result}}", "라온: 무섭다"),
    "[참고 자료]\n라온: 무섭다"
  );
}

// 11. 자리표시자를 지운 틀이면 틀 아래에 붙인다 (사용자 구제).
{
  const out = applyPregenInjectTemplate("[속마음]", "라온: 무섭다");
  assert.equal(out, "[속마음]\n라온: 무섭다");
}

// 12. 빈 틀 = 감싸지 않음. 결과가 비면 무조건 빈 문자열(빈 틀만 주입되는 일 없음).
{
  assert.equal(applyPregenInjectTemplate("", "라온: 무섭다"), "라온: 무섭다");
  assert.equal(applyPregenInjectTemplate("[참고 자료]\n{{main}}", "   "), "");
}

// 13. 틀이 없으면 결과만 들어간다 — **코드가 문구를 얹지 않는다.**
//     감쌀 말은 전부 설정의 입력란이 소유한다(용도를 코드가 모르는 확장이라서).
{
  assert.equal(applyPregenInjectTemplate(undefined, "라온: 무섭다"), "라온: 무섭다");
}

// 14. 기본 틀(설정 초기값)은 {{main}} 자리를 갖는다 — 켤 때 이 문자열이 입력란에 들어간다.
{
  assert.ok(DEFAULT_PREGEN_INJECT_TEMPLATE.includes(PREGEN_RESULT_MACRO));
  assert.equal(
    applyPregenInjectTemplate(DEFAULT_PREGEN_INJECT_TEMPLATE, "라온: 무섭다").endsWith(
      "라온: 무섭다"
    ),
    true
  );
}

console.log("pregen tests passed");
