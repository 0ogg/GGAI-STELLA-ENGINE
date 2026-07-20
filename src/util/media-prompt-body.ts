/**
 * 미디어 프롬프트(번역 / 삽화 프롬프트 생성)에 "본문"과 "로어북"을 결합하는 순수 함수.
 *
 * 사용자가 지침(프롬프트) 안에 매크로를 써서 삽입 위치를 직접 정한다.
 *  - `{{main}}`     → 본문(번역 대상 / 장면 발췌)이 그 자리에 치환된다.
 *  - `{{lorebook}}` → 매칭된 로어북(용어집) 내용이 그 자리에 치환된다.
 *  - `{{pairs}}`    → 집필 프로의 문단 쌍 문체 예시(있을 때만)가 그 자리에 치환된다.
 *
 * 치환은 앞뒤로 줄바꿈을 붙이지 않으므로 `({{main}})` 처럼 괄호 안에도 자연스럽게
 * 들어간다. 매크로를 안 쓰면 본문은 맨 앞에, 로어북/문체 예시는 본문 바로 뒤(지침 앞)에
 * 순서대로 붙는다.
 */

/** 본문/로어북 매크로가 의미 있는(=결합 대상인) 프롬프트인지 빠르게 판별. */
export function hasMediaMacro(instruction: string): boolean {
  return /\{\{\s*(main|lorebook)\s*\}\}/i.test(instruction);
}

/**
 * 지침에 본문/로어북을 결합한다.
 *  - 매크로가 있으면 그 자리에 치환 (앞뒤 줄바꿈 없음).
 *  - `{{main}}` 이 없으면 본문을 맨 앞에 붙인다.
 *  - `{{lorebook}}` 이 없으면 로어북을 본문 다음(지침 앞)에 붙인다 (로어북이 있을 때만).
 */
export function composeMediaPrompt(
  instruction: string,
  body: string,
  lorebook = "",
  pairs = ""
): string {
  const hasMain = /\{\{\s*main\s*\}\}/i.test(instruction);
  const hasLore = /\{\{\s*lorebook\s*\}\}/i.test(instruction);
  const hasPairs = /\{\{\s*pairs\s*\}\}/i.test(instruction);

  let text = instruction;
  // 함수 replacer — 치환 내용에 $& 같은 특수 패턴이 있어도 그대로 들어가게.
  if (hasLore) text = text.replace(/\{\{\s*lorebook\s*\}\}/gi, () => lorebook);
  if (hasPairs) text = text.replace(/\{\{\s*pairs\s*\}\}/gi, () => pairs);
  if (hasMain) text = text.replace(/\{\{\s*main\s*\}\}/gi, () => body);

  const front: string[] = [];
  if (!hasMain) front.push(body);
  if (!hasLore && lorebook) front.push(lorebook);
  if (!hasPairs && pairs) front.push(pairs);
  const prefix = front.join("\n\n");

  if (!prefix) return text;
  return text ? `${prefix}\n\n${text}` : prefix;
}
