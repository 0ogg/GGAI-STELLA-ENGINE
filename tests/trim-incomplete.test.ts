/**
 * 미완성 문장 자르기 — 못 박는 것 다섯 가지.
 *
 * 1) 완결된 응답은 한 글자도 건드리지 않는다(마크다운 지문 표기 포함).
 * 2) 끊긴 문장·닫히지 않은 대사는 마지막 완결 지점까지만 남는다.
 * 3) **판정은 마지막 문단에서만** — 앞 문단의 따옴표는 세지 않는다.
 * 4) 따옴표가 있다고 무조건 대사가 아니다 — 축약형/소유격/강조 표기는 그냥 글자다.
 * 5) 완결 지점이 없으면 그 문단만 버리고, 문단이 하나뿐이면 원문을 그대로 둔다.
 */

import assert from "node:assert/strict";
import { trimIncompleteTail } from "../src/util/trim-incomplete";

const eq = (input: string, expected: string, msg: string) =>
  assert.equal(trimIncompleteTail(input), expected, msg);

// 1) 완결된 응답 — 무변경.
eq("그는 문을 열었다.", "그는 문을 열었다.", "평범한 완결");
eq(
  "\u201C안녕.\u201D 그가 웃었다.",
  "\u201C안녕.\u201D 그가 웃었다.",
  "닫힌 대사"
);
eq('그가 말했다. "안녕."', '그가 말했다. "안녕."', "닫힌 곧은 따옴표");
eq("*그는 웃었다.*", "*그는 웃었다.*", "지문 표기");
eq("끝났다.\n\n", "끝났다.\n\n", "끝 공백 보존");

// 2) 끊긴 꼬리 제거.
eq("그는 문을 열었다. 복도에는 아무도", "그는 문을 열었다.", "끊긴 문장");
eq("그가 돌아섰다. \u201C잠깐만, 그건", "그가 돌아섰다.", "안 닫힌 대사");
eq('그가 돌아섰다. "잠깐만, 그건', "그가 돌아섰다.", "안 닫힌 곧은 따옴표");
eq("그가 돌아섰다. '잠깐만, 그건", "그가 돌아섰다.", "안 닫힌 작은따옴표");
eq("*그는 웃었다.* 그리고 천천히", "*그는 웃었다.*", "지문 뒤 끊김");

// 3) 판정은 마지막 문단에서만.
eq(
  "첫 문단이다.\n\n두 번째 문단은 여기서 끊",
  "첫 문단이다.",
  "마지막 문단만 잘림"
);
eq(
  // 앞 문단의 따옴표 셈이 어긋나 있어도(홑 따옴표 하나) 뒤 문단은 멀쩡히 완결.
  '그는 "혼잣말을 했다.\n\n그리고 문을 닫았다.',
  '그는 "혼잣말을 했다.\n\n그리고 문을 닫았다.',
  "앞 문단 따옴표는 안 센다"
);
eq(
  "첫 문단이다.\n\n\u201C대사만 열린 문단",
  "첫 문단이다.",
  "미완성 문단 통째 제거"
);

// 4) 따옴표가 있다고 무조건 대사가 아니다.
eq("He said it wasn't done.", "He said it wasn't done.", "축약형 don't");
eq("The dogs' bowls were empty.", "The dogs' bowls were empty.", "소유격");
eq(
  "It wasn't over. She kept",
  "It wasn't over.",
  "축약형 뒤의 끊긴 문장은 잘린다"
);
eq("'강조'된 말이었다.", "'강조'된 말이었다.", "따옴표 강조 표기");

// 5) 완결 지점이 없으면 원문 유지(문단 하나).
eq("아직 아무것도 끝나지 않았", "아직 아무것도 끝나지 않았", "완결 지점 없음");
eq("", "", "빈 문자열");

// 6) ST trimToEndSentence 에서 가져온 것 — 이모지·닫는 표시로 끝나면 완결,
//    앞이 공백인 종결 문자는 "열다 만 표시"로 보고 종결로 세지 않는다.
eq("\uc798 \uc794\uc5b4? \uc624\ub298 \ubb50\ud574 \u{1F60A}", "\uc798 \uc794\uc5b4? \uc624\ub298 \ubb50\ud574 \u{1F60A}", "\uc774\ubaa8\uc9c0\ub85c \ub05d\ub0a8");
eq("\ub05d\ub0ac\ub2e4. *\uadf8\ub294", "\ub05d\ub0ac\ub2e4.", "\uc5f4\ub2e4 \ub9cc \ubcc4\ud45c");
eq("**\uc0c1\ud0dc\ucc3d**", "**\uc0c1\ud0dc\ucc3d**", "\ubcc4\ud45c\ub85c \ub2eb\ud78c \uc904");
eq("\uadf8\uac00 \uc6c3\uc5c8\ub2e4 (\uc870\uc6a9\ud788)", "\uadf8\uac00 \uc6c3\uc5c8\ub2e4 (\uc870\uc6a9\ud788)", "\uad04\ud638\ub85c \ub2eb\ud78c \uc904");
eq("\ucf54\ub4dc\ub294 `main.ts` \uc600\ub2e4. \uadf8\ub7f0\ub370", "\ucf54\ub4dc\ub294 `main.ts` \uc600\ub2e4.", "\ubc31\ud2f1 \ub4a4 \ub04a\uae40");

console.log("trim-incomplete: ok");
