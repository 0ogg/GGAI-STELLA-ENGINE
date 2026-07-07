import type { StellaLorebook } from "../types/lorebook";
import type { StellaScenario } from "../types/scenario";
import type { StellaSession } from "../types/session";
import type { StellaStore } from "../state/store";

/**
 * 활성 로어북 해석.
 *
 * 적용 규칙:
 *   activeIds = (시나리오.default + 시나리오.extra - 세션.disabled) ∪ 세션.extra
 *
 * 시나리오/세션이 없는 경우는 빈 배열 반환 (무차별 적용 절대 금지).
 * id 가 가리키는 책이 사라졌으면 조용히 스킵.
 */
export async function resolveActiveLorebooks(
  store: StellaStore,
  scenario: StellaScenario | null,
  session: StellaSession | null
): Promise<StellaLorebook[]> {
  const ids = new Set<string>();

  const stella = scenario?.data?.extensions?.stella;
  if (stella) {
    if (stella.defaultLorebookId) ids.add(stella.defaultLorebookId);
    for (const id of stella.extraLorebookIds ?? []) ids.add(id);
  }

  if (session) {
    for (const id of session.meta.disabledScenarioLorebookIds ?? []) ids.delete(id);
    for (const id of session.meta.extraLorebookIds ?? []) ids.add(id);
  }

  const out: StellaLorebook[] = [];
  for (const id of ids) {
    const item = await store.getLorebookById(id);
    if (item) out.push(item.lorebook);
  }
  return out;
}
