/**
 * 그룹 챗 다음 발화자 결정 — 순수 로직 (G2).
 *
 * 우선순위 (선채팅-그룹챗 남은작업.md):
 *  1. 직전 메시지에 이름이 불린 멤버 (여럿이면 그 안에서 가중 랜덤)
 *  2. 가중 랜덤 — 수다스러움(ST talkativeness 호환, 0~1, 기본 0.5)
 *  3. 최근 말 안 한 멤버 보정 (가중치 가산)
 *
 * ST 호환: talkativeness 0 인 멤버는 랜덤 후보에서 빠진다(이름이 불리면 말한다).
 * 직전 발화자는 다른 후보가 있으면 연속 지목하지 않는다.
 */

export interface GroupSpeakerCandidate {
  /** 멤버 시나리오의 stella.id. */
  scenarioId: string;
  name: string;
  /** ST talkativeness (0~1). 없으면 0.5. */
  talkativeness?: number;
}

export interface PickNextSpeakerInput {
  candidates: GroupSpeakerCandidate[];
  /** 직전 메시지 본문 — 이름 지목 판정 대상. */
  lastMessageText?: string;
  /** 직전 메시지가 AI 발화면 그 발화자 id — 연속 발화 상한 판정 기준. */
  lastSpeakerId?: string | null;
  /** 직전 발화자가 끝에서 연속으로 말한 횟수 (1 = 방금 처음). */
  lastSpeakerStreak?: number;
  /**
   * 같은 캐릭터가 연속으로 말할 수 있는 최대 횟수 (중복 발화 상한).
   * 기본 1(연속 금지 = 매번 다른 캐릭터). streak 이 이 값에 도달하면 직전 발화자를
   * 후보에서 뺀다. 2 이상이면 몰아 말하기/말싸움 가능.
   */
  maxConsecutiveSame?: number;
  /** 최근 AI 발화자 id 들 (오래된 → 최신) — 여기 없는 멤버는 가중치 보정. */
  recentSpeakerIds?: string[];
  /** 주입 가능한 난수 (테스트용). 기본 Math.random. */
  random?: () => number;
}

/** 최근 말 안 한 멤버에게 더해 주는 가중치. */
const IDLE_BOOST = 0.5;

/** 다음 발화자의 scenarioId. 후보가 없으면 null. */
export function pickNextSpeaker(input: PickNextSpeakerInput): string | null {
  const all = input.candidates.filter((c) => c.name.trim().length > 0);
  if (all.length === 0) return null;
  if (all.length === 1) return all[0].scenarioId;

  // 직전 발화자 제외 — 연속 발화 상한(maxConsecutiveSame)에 도달했을 때만.
  // 상한 미만이면 후보에 남겨 두어(가중치는 미발화 멤버가 유리) 몰아 말하기 가능.
  let pool = all;
  const cap = Math.max(1, Math.floor(input.maxConsecutiveSame ?? 1));
  if (input.lastSpeakerId && (input.lastSpeakerStreak ?? 1) >= cap) {
    const rest = all.filter((c) => c.scenarioId !== input.lastSpeakerId);
    if (rest.length > 0) pool = rest;
  }

  const rand = input.random ?? Math.random;

  // 1) 이름 지목 — 직전 메시지에 이름이 등장한 멤버 우선.
  const text = (input.lastMessageText ?? "").toLowerCase();
  if (text) {
    const mentioned = pool.filter((c) =>
      text.includes(c.name.trim().toLowerCase())
    );
    if (mentioned.length === 1) return mentioned[0].scenarioId;
    if (mentioned.length > 1) return weightedPick(mentioned, input, rand);
  }

  // 2) 가중 랜덤 + 3) 최근 미발화 보정.
  return weightedPick(pool, input, rand);
}

function weightedPick(
  pool: GroupSpeakerCandidate[],
  input: PickNextSpeakerInput,
  rand: () => number
): string {
  const recent = new Set(input.recentSpeakerIds ?? []);
  // talkativeness 0 은 랜덤 후보에서 제외 (ST 호환). 전부 0 이면 균등.
  const speakable = pool.filter((c) => clamp01(c.talkativeness ?? 0.5) > 0);
  const effective = speakable.length > 0 ? speakable : pool;

  const weights = effective.map((c) => {
    const base =
      speakable.length > 0 ? clamp01(c.talkativeness ?? 0.5) : 1;
    return base + (recent.has(c.scenarioId) ? 0 : IDLE_BOOST);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  for (let i = 0; i < effective.length; i++) {
    roll -= weights[i];
    if (roll < 0) return effective[i].scenarioId;
  }
  return effective[effective.length - 1].scenarioId;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

/** 카드의 ST talkativeness 값(문자열/숫자)을 0~1 숫자로. 없으면 0.5. */
export function parseTalkativeness(raw: unknown): number {
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}
