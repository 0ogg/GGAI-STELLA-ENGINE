/**
 * 그룹 멤버 프로필 → 가상 로어북 (G1).
 *
 * 그룹 세션의 멤버(호스트 시나리오 제외) 카드를 로어북 엔트리로 변환해 기존
 * 로어북 매칭 파이프라인에 태운다 — 별도 컨텍스트 주입 경로를 만들지 않아
 * 미리보기·생성·토큰 예산이 자동으로 동일하게 적용된다.
 *
 * G1 정책: 멤버 전원 **상시 포함**(constant) — 초대 직후 본문에 이름이 아직 없어도
 * AI 가 새 캐릭터의 존재를 알아야 하고, 소설 그룹은 멤버 수가 적어 토큰 부담이 작다.
 * "활성 발화자=풀 카드, 나머지=압축 프로필" 최적화는 G2 에서 얹는다.
 */
import type { StellaGroup } from "../types/group";
import type { StellaScenario } from "../types/scenario";
import {
  defaultLorebookEntry,
  defaultLorebookMeta,
  type StellaLorebook,
} from "../types/lorebook";

/**
 * 멤버 카드들을 가상 로어북 하나로 만든다 (순수 — 디스크 접근 없음).
 * 호스트 시나리오는 제외한다 (이미 charDescription 마커로 컨텍스트에 있음).
 * 멤버가 없거나 전부 해석 실패면 null.
 */
export function buildGroupMemberLorebook(
  group: StellaGroup,
  scenarios: StellaScenario[],
  hostScenarioId: string
): StellaLorebook | null {
  const byId = new Map<string, StellaScenario>();
  for (const sc of scenarios) {
    const id = sc.data?.extensions?.stella?.id;
    if (id) byId.set(id, sc);
  }

  const book: StellaLorebook = {
    meta: defaultLorebookMeta(
      "charactercard",
      `그룹: ${group.name}`,
      `group:${group.id}`
    ),
    entries: [],
  };

  let order = 100;
  for (const member of group.members) {
    if (member.scenarioId === hostScenarioId) continue;
    const sc = byId.get(member.scenarioId);
    if (!sc) continue;
    const d = sc.data;
    const name = d.name?.trim();
    if (!name) continue;

    const parts: string[] = [`[Character joining this story: ${name}]`];
    const description = substituteSelf(d.description, name);
    if (description) parts.push(description);
    const personality = substituteSelf(d.personality, name);
    if (personality) parts.push(`${name}'s personality: ${personality}`);

    book.entries.push({
      ...defaultLorebookEntry("charactercard"),
      uid: `group-member:${member.scenarioId}`,
      name,
      keys: [name],
      content: parts.join("\n"),
      constant: true,
      position: "before_char",
      order: order--,
    });
  }

  return book.entries.length > 0 ? book : null;
}

/**
 * 멤버 카드 본문의 {{char}} 를 그 멤버의 이름으로 치환.
 * 그대로 두면 매크로 단계에서 호스트 캐릭터 이름으로 풀려 프로필이 오염된다.
 */
function substituteSelf(text: string | undefined, name: string): string {
  return (text ?? "").replace(/\{\{\s*char\s*\}\}/gi, name).trim();
}
